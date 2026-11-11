import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { TaskError } from "@silvermoon-work/task-protocol";
import { CarRequestError, serveCar, wantsCar } from "./car-gateway.js";

const media = "application/vnd.ipld.raw";
export interface RawGatewayOptions {
  access: "disabled" | "public" | "token";
  token?: string;
  maxConcurrent: number;
  maxBlockBytes: number;
  timeoutMs: number;
  maxTraversalBlocks?: number;
  maxCarBytes?: number;
}
export type LocalRead = (
  cid: CID,
  options: { signal: AbortSignal; maxBytes: number },
) => Promise<Uint8Array>;

function acceptsRaw(value: string): boolean {
  let specificity = -1;
  let quality = 0;
  for (const range of value.split(",")) {
    const [type, ...parameters] = range.trim().toLowerCase().split(";");
    const name = type?.trim();
    const rank = name === media ? 2 : name === "application/*" ? 1 : name === "*/*" ? 0 : -1;
    let q = 1;
    let supported = true;
    for (const parameter of parameters) {
      const part = parameter.trim();
      if (/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(part)) q = Number(part.slice(2));
      else supported = false;
    }
    if (rank >= 0 && supported && rank >= specificity) {
      quality = rank === specificity ? Math.max(quality, q) : q;
      specificity = rank;
    }
  }
  return quality > 0;
}
function matches(value: string | undefined, etag: string, weak: boolean): boolean {
  return !!value?.split(",").some((part) => {
    const tag = part.trim();
    return tag === "*" || (weak ? tag.replace(/^W\//, "") : tag) === etag;
  });
}

// This adapter receives only a local read capability, never GatewayClient.block.get.
export function createRawGateway(options: RawGatewayOptions, local: LocalRead) {
  if (
    !["disabled", "public", "token"].includes(options.access) ||
    ![
      options.maxConcurrent,
      options.maxBlockBytes,
      options.timeoutMs,
      options.maxTraversalBlocks ?? 128,
      options.maxCarBytes ?? 67_108_864,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    options.maxBlockBytes > 2_147_483_646 ||
    options.timeoutMs > 2_147_483_647
  )
    throw new TaskError("INVALID_CONFIG_VALUE", "Invalid local raw gateway policy or budget.");
  if (options.access === "token" && !/^[A-Za-z0-9_-]{32,256}$/.test(options.token ?? ""))
    throw new TaskError("INVALID_CONFIG_VALUE", "Token gateway requires a rawGatewayToken.");
  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let closing = false;
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const end = (status: number) => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(status, { "cache-control": "no-store", "content-length": "0" });
        response.end();
      }
    };
    if (options.access === "disabled") return end(404);
    if (options.access === "token") {
      const expected = Buffer.from(`Bearer ${options.token}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.setHeader("www-authenticate", "Bearer");
        return end(401);
      }
    }
    if (closing) return end(503);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      return end(405);
    }
    if (active.size >= options.maxConcurrent) {
      response.setHeader("retry-after", "1");
      return end(429);
    }
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    let timedOut = false;
    const stop = () => {
      if (!response.writableFinished && !timedOut) response.destroy();
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      if (response.headersSent) response.destroy();
      else end(504);
      controller.abort();
    }, options.timeoutMs);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (wantsCar(url, request.headers.accept ?? "")) {
        await serveCar(request, response, url, options, local, controller.signal);
        return;
      }
      const name = /^\/ipfs\/([^/]+)$/.exec(url.pathname)?.[1];
      if (!name || name.length > 2048) return end(400);
      let cid: CID;
      try {
        cid = CID.parse(decodeURIComponent(name));
      } catch {
        return end(400);
      }
      const formats = url.searchParams.getAll("format");
      const filenames = url.searchParams.getAll("filename");
      if (
        filenames.length > 1 ||
        (filenames[0] &&
          (filenames[0].length > 256 ||
            [...filenames[0]].some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )))
      )
        return end(400);
      if (url.searchParams.has("dag-scope") || url.searchParams.has("entity-bytes"))
        return end(400);
      if (formats.length > 1) return end(400);
      if (formats.length ? formats[0] !== "raw" : !request.headers.accept)
        return end(formats.length ? 406 : 400);
      if (!formats.length && !acceptsRaw(request.headers.accept ?? "")) return end(406);
      if (cid.multihash.code !== 0 && cid.multihash.code !== sha256.code) return end(501);
      if (cid.multihash.code === sha256.code && cid.multihash.size !== 32) return end(400);
      let bytes: Uint8Array;
      if (cid.multihash.code === 0) {
        bytes = cid.multihash.digest;
        if (bytes.length > options.maxBlockBytes) return end(413);
      } else {
        try {
          bytes = await local(cid, {
            signal: controller.signal,
            maxBytes: options.maxBlockBytes,
          });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT")
            return end(
              request.headers["cache-control"]
                ?.split(",")
                .some((part) => part.trim().toLowerCase() === "only-if-cached")
                ? 412
                : 404,
            );
          return end(code === "BLOCK_TOO_LARGE" ? 413 : 500);
        }
      }
      if (controller.signal.aborted) return;
      const canonical = cid.toV1().toString();
      const etag = `"${canonical}.raw"`;
      response.setHeader("etag", etag);
      response.setHeader("vary", "Accept");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("x-ipfs-path", `/ipfs/${cid}`);
      response.setHeader("ipfs-uri", `ipfs://${cid}`);
      url.searchParams.set("format", "raw");
      response.setHeader("content-location", `${url.pathname}${url.search}`);
      response.setHeader("accept-ranges", "none");
      response.setHeader(
        "cache-control",
        options.access === "public"
          ? "public, max-age=29030400, immutable"
          : "private, max-age=29030400, immutable",
      );
      if (request.headers["if-match"] && !matches(request.headers["if-match"], etag, false))
        return end(412);
      if (matches(request.headers["if-none-match"], etag, true)) {
        response.writeHead(304);
        response.end();
        return;
      }
      response.setHeader("content-type", media);
      const filename = filenames[0] || `${canonical}.bin`;
      const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encoded = encodeURIComponent(filename).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      response.setHeader(
        "content-disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      );
      response.setHeader("content-length", bytes.byteLength);
      response.writeHead(200);
      await new Promise<void>((resolve) => {
        response.once("close", resolve);
        response.end(request.method === "HEAD" ? undefined : bytes, resolve);
      });
    } catch (error) {
      if (response.headersSent) response.destroy();
      else {
        const code = (error as NodeJS.ErrnoException).code;
        const onlyCached = request.headers["cache-control"]
          ?.split(",")
          .some((part) => part.trim().toLowerCase() === "only-if-cached");
        end(
          error instanceof CarRequestError
            ? error.status
            : code === "ENOENT" || code === "ERR_NOT_FOUND"
              ? onlyCached
                ? 412
                : 404
              : code === "BLOCK_TOO_LARGE"
                ? 413
                : 500,
        );
      }
    } finally {
      clearTimeout(timer);
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
      controller.signal.removeEventListener("abort", stop);
      controllers.delete(controller);
    }
  };
  return {
    handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const operation = serve(request, response);
      active.add(operation);
      void operation.finally(() => active.delete(operation));
      return operation;
    },
    async close() {
      closing = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...active]);
    },
  };
}
