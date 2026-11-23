import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { TaskError } from "@silvermoon-work/task-protocol";
import { CarRequestError, serveCar, wantsCar } from "./car-gateway.js";
import { serveIpnsRecord, type IpnsRecordSource } from "./ipns-gateway.js";
import {
  createRecursiveGateway,
  recursiveHopHeader,
  type RecursiveGatewayOptions,
} from "./recursive-gateway.js";

const media = "application/vnd.ipld.raw";
export interface RawGatewayOptions {
  access: "disabled" | "public" | "token";
  token?: string;
  maxConcurrent: number;
  maxBlockBytes: number;
  timeoutMs: number;
  maxTraversalBlocks?: number;
  maxCarBytes?: number;
  recursive?: RecursiveGatewayOptions;
}
export type LocalRead = (
  cid: CID,
  options: { signal: AbortSignal; maxBytes: number },
) => Promise<Uint8Array>;

export function acceptsMedia(value: string, media: string): boolean {
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
export function matches(value: string | undefined, etag: string, weak: boolean): boolean {
  return !!value?.split(",").some((part) => {
    const tag = part.trim();
    return tag === "*" || (weak ? tag.replace(/^W\//, "") : tag) === etag;
  });
}

// Task-facing block.get is intentionally never a gateway acquisition capability.
export function createRawGateway(
  options: RawGatewayOptions,
  local: LocalRead,
  persist?: (cid: CID, bytes: Uint8Array, signal: AbortSignal) => Promise<void>,
  ipns?: IpnsRecordSource,
) {
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
  if (options.recursive && !persist)
    throw new TaskError("INVALID_CONFIG_VALUE", "Recursive gateway requires verified persistence.");
  const recursive =
    options.recursive && persist
      ? createRecursiveGateway(options.recursive, local, persist)
      : undefined;
  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const metrics = {
    requests: 0,
    hits: 0,
    misses: 0,
    outputBytes: 0,
    failures: 0,
    storageErrors: 0,
    cancellations: 0,
    timeouts: 0,
    rejected: 0,
    peakActive: 0,
  };
  let closing = false;
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    metrics.requests++;
    let completed = false;
    const written = (chunk: unknown, encoding?: unknown) => {
      if (typeof chunk === "string")
        metrics.outputBytes += Buffer.byteLength(
          chunk,
          typeof encoding === "string" ? (encoding as BufferEncoding) : undefined,
        );
      else if (chunk instanceof Uint8Array) metrics.outputBytes += chunk.byteLength;
    };
    const originalWrite = response.write;
    const originalEnd = response.end;
    response.write = function (this: ServerResponse, chunk: unknown, ...args: unknown[]) {
      written(chunk, args[0]);
      return Reflect.apply(originalWrite, this, [chunk, ...args]);
    } as typeof response.write;
    response.end = function (this: ServerResponse, chunk?: unknown, ...args: unknown[]) {
      written(chunk, args[0]);
      return Reflect.apply(originalEnd, this, [chunk, ...args]);
    } as typeof response.end;
    response.once("finish", () => {
      completed = true;
      if (response.statusCode >= 400) metrics.failures++;
    });
    response.once("close", () => {
      if (!completed) metrics.failures++;
    });
    const end = (status: number) => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(status, { "cache-control": "no-store", "content-length": "0" });
        response.end();
      }
    };
    if (options.access === "disabled") return end(404);
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "Authorization, Accept, Content-Type, Range, User-Agent, X-Requested-With, If-Match, If-None-Match, Cache-Control",
    );
    response.setHeader(
      "access-control-expose-headers",
      "Content-Type, Content-Range, Content-Length, Content-Disposition, Content-Location, ETag, Cache-Control, Accept-Ranges, X-Ipfs-Path, X-Ipfs-Roots, Ipfs-Uri, Retry-After",
    );
    // Preflight carries header names, not the bearer credential. Reads still authenticate below.
    if (request.method === "OPTIONS") {
      const method = request.headers["access-control-request-method"];
      const headers = request.headers["access-control-request-headers"] ?? "";
      const allowed = new Set(
        String(response.getHeader("access-control-allow-headers")).toLowerCase().split(/,\s*/),
      );
      if (
        (method && method !== "GET" && method !== "HEAD") ||
        headers
          .split(",")
          .some((header) => header.trim() && !allowed.has(header.trim().toLowerCase()))
      )
        return end(403);
      return end(204);
    }
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
      response.setHeader("allow", "GET, HEAD, OPTIONS");
      return end(405);
    }
    if (controllers.size >= options.maxConcurrent) {
      metrics.rejected++;
      response.setHeader("retry-after", "1");
      return end(429);
    }
    const controller = new AbortController();
    controllers.add(controller);
    metrics.peakActive = Math.max(metrics.peakActive, controllers.size);
    const abort = () => {
      if (!response.writableFinished && !controller.signal.aborted) {
        metrics.cancellations++;
        controller.abort();
      }
    };
    request.once("aborted", abort);
    response.once("close", abort);
    let timedOut = false;
    const stop = () => {
      if (!response.writableFinished && !timedOut) response.destroy();
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      metrics.timeouts++;
      if (response.headersSent) response.destroy();
      else end(504);
      controller.abort();
    }, options.timeoutMs);
    const read: LocalRead = async (cid, readOptions) => {
      try {
        const onlyCached = request.headers["cache-control"]
          ?.split(",")
          .some((part) => part.trim().toLowerCase() === "only-if-cached");
        const bytes =
          recursive && !onlyCached
            ? await recursive.read(cid, readOptions, request.headers[recursiveHopHeader])
            : await local(cid, readOptions);
        metrics.hits++;
        return bytes;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ERR_NOT_FOUND") metrics.misses++;
        else if (
          !controller.signal.aborted &&
          code !== "BLOCK_TOO_LARGE" &&
          !code?.startsWith("RECURSIVE_")
        )
          metrics.storageErrors++;
        throw error;
      }
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/ipns" || url.pathname.startsWith("/ipns/")) {
        await serveIpnsRecord(request, response, url, options.access, controller.signal, ipns);
        return;
      }
      if (wantsCar(url, request.headers.accept ?? "")) {
        await serveCar(request, response, url, options, read, controller);
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
      if (!formats.length && !acceptsMedia(request.headers.accept ?? "", media)) return end(406);
      if (cid.multihash.code !== 0 && cid.multihash.code !== sha256.code) return end(501);
      if (cid.multihash.code === sha256.code && cid.multihash.size !== 32) return end(400);
      let bytes: Uint8Array;
      if (cid.multihash.code === 0) {
        bytes = cid.multihash.digest;
        if (bytes.length > options.maxBlockBytes) return end(413);
      } else {
        try {
          bytes = await read(cid, {
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
          return end(
            code === "BLOCK_TOO_LARGE"
              ? 413
              : code === "RECURSIVE_BUSY"
                ? 429
                : code === "RECURSIVE_TIMEOUT"
                  ? 504
                  : code?.startsWith("RECURSIVE_")
                    ? 502
                    : 500,
          );
        }
      }
      if (controller.signal.aborted) return;
      const canonical = cid.toV1().toString();
      const etag = `"${canonical}.raw"`;
      response.setHeader("etag", etag);
      response.setHeader("vary", "Accept");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("x-ipfs-path", `/ipfs/${cid}`);
      response.setHeader("x-ipfs-roots", cid.toString());
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
      if ((error as NodeJS.ErrnoException).code === "ERR_NOT_FOUND") {
        metrics.misses++;
        if (response.headersSent) metrics.failures++;
      }
      if (response.headersSent) {
        if (!response.writableEnded) controller.abort(error);
      } else {
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
                : code === "RECURSIVE_BUSY"
                  ? 429
                  : code === "RECURSIVE_TIMEOUT"
                    ? 504
                    : code?.startsWith("RECURSIVE_")
                      ? 502
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
    snapshot() {
      return {
        ...metrics,
        active: controllers.size,
        ...(recursive ? { recursive: recursive.snapshot() } : {}),
      };
    },
    handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const operation = serve(request, response);
      active.add(operation);
      void operation.finally(() => active.delete(operation));
      return operation;
    },
    async close() {
      closing = true;
      for (const controller of controllers) {
        if (!controller.signal.aborted) metrics.cancellations++;
        controller.abort();
      }
      await recursive?.close();
      await Promise.allSettled([...active]);
    },
  };
}
