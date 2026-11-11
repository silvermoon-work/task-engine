import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CarWriter } from "@ipld/car/writer";
import { blockLength, headerLength } from "@ipld/car/buffer-writer";
import { exporter, walkPath } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { LocalRead, RawGatewayOptions } from "./raw-gateway.js";

const media = "application/vnd.ipld.car";
const variant = { version: "1", order: "dfs", dups: "n" } as const;
export const carContentType = `${media}; version=1; order=dfs; dups=n`;

function hasControl(value: string) {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export class CarRequestError extends Error {
  constructor(readonly status: number) {
    super(`CAR request failed (${status}).`);
  }
}

function quality(accept: string, type: string, url: URL): number {
  let specificity = -1;
  let parameterCount = -1;
  let result = 0;
  for (const range of accept.toLowerCase().split(",")) {
    const [name, ...parts] = range.trim().split(";");
    const rank =
      name?.trim() === type
        ? 2
        : name?.trim() === "application/*"
          ? 1
          : name?.trim() === "*/*"
            ? 0
            : -1;
    if (rank < 0) continue;
    let q = 1;
    let supported = true;
    const parameters = new Map<string, string>();
    for (const part of parts) {
      const match = /^\s*([\w-]+)\s*=\s*(?:"([^"]*)"|([^\s"]+))\s*$/.exec(part);
      if (!match || parameters.has(match[1]!)) {
        supported = false;
        break;
      }
      parameters.set(match[1]!, match[2] ?? match[3]!);
    }
    for (const [key, value] of parameters) {
      if (key === "q") {
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) supported = false;
        else q = Number(value);
      } else if (
        type !== media ||
        !Object.hasOwn(variant, key) ||
        (url.searchParams.get(`car-${key}`) ?? value) !== variant[key as keyof typeof variant]
      )
        supported = false;
    }
    if (!supported) continue;
    const count = parameters.size - Number(parameters.has("q"));
    if (rank > specificity || (rank === specificity && count > parameterCount)) {
      specificity = rank;
      parameterCount = count;
      result = q;
    } else if (rank === specificity && count === parameterCount) result = Math.max(result, q);
  }
  return result;
}

export function wantsCar(url: URL, accept: string): boolean {
  const formats = url.searchParams.getAll("format");
  if (formats.length) return formats[0] === "car";
  return (
    accept.toLowerCase().includes(media) &&
    quality(accept, media, url) >= quality(accept, "application/vnd.ipld.raw", url)
  );
}

function carPath(request: IncomingMessage) {
  // URL normalizes dot segments before percent decoding; content paths need the opposite order.
  const raw = (request.url ?? "/").split("?")[0]!;
  if (raw.length > 16_384 || !raw.startsWith("/ipfs/")) throw new CarRequestError(400);
  let decoded: string;
  try {
    decoded = raw
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    throw new CarRequestError(400);
  }
  const parts: string[] = [];
  for (const part of decoded.split("/").slice(2)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length <= 1) throw new CarRequestError(400);
      parts.pop();
    } else {
      if (part.includes("\\") || hasControl(part)) throw new CarRequestError(400);
      parts.push(part);
    }
  }
  if (!parts[0] || parts[0].length > 2048 || parts.length > 65) throw new CarRequestError(400);
  let root: CID;
  try {
    root = CID.parse(parts[0]);
  } catch {
    throw new CarRequestError(400);
  }
  const segments = parts.slice(1);
  const path = [root.toString(), ...segments].join("/");
  const encoded =
    [root.toV1().toString(), ...segments]
      .map((part) =>
        encodeURIComponent(part).replace(
          /['()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        ),
      )
      .join("/") + (decoded.endsWith("/") ? "/" : "");
  return { root, segments, path, encoded };
}

async function write(response: ServerResponse, chunk: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted();
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      response.removeListener("drain", drain);
      response.removeListener("close", close);
      response.removeListener("error", close);
      signal.removeEventListener("abort", close);
      if (error) reject(error);
      else resolve();
    };
    const drain = () => finish();
    const close = () => finish(new Error("CAR transport closed."));
    response.once("drain", drain);
    response.once("close", close);
    response.once("error", close);
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted || response.destroyed) close();
  });
}

export async function serveCar(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: RawGatewayOptions,
  local: LocalRead,
  signal: AbortSignal,
) {
  for (const key of ["format", "dag-scope", "filename", "car-version", "car-order", "car-dups"])
    if (url.searchParams.getAll(key).length > 1) throw new CarRequestError(400);
  if (url.searchParams.has("entity-bytes")) throw new CarRequestError(400);
  const { root, segments, path, encoded } = carPath(request);
  const scope = url.searchParams.get("dag-scope");
  const probe = root.toString() === "bafkqaaa" && segments.length === 0;
  if (scope !== "block" && !(probe && scope === null)) throw new CarRequestError(400);
  for (const [key, value] of Object.entries(variant))
    if (url.searchParams.has(`car-${key}`) && url.searchParams.get(`car-${key}`) !== value)
      throw new CarRequestError(406);
  const accept = request.headers.accept ?? "";
  if (!url.searchParams.has("format") || accept.toLowerCase().includes(media)) {
    if (quality(accept, media, url) === 0) throw new CarRequestError(406);
  }
  const customFilename = url.searchParams.get("filename");
  if (customFilename && (customFilename.length > 256 || hasControl(customFilename)))
    throw new CarRequestError(400);
  const filename = customFilename || `${root.toV1()}.car`;
  const maxBlocks = options.maxTraversalBlocks ?? 128;
  const maxBytes = options.maxCarBytes ?? 67_108_864;
  let reads = 0;
  let readBytes = 0;
  const read = async (cid: CID) => {
    signal.throwIfAborted();
    if (++reads > maxBlocks) throw new CarRequestError(413);
    if (![0x55, 0x70].includes(cid.code) || ![0, sha256.code].includes(cid.multihash.code))
      throw new CarRequestError(501);
    if (cid.multihash.code === sha256.code && cid.multihash.size !== 32)
      throw new CarRequestError(400);
    const bytes =
      cid.multihash.code === 0
        ? cid.multihash.digest
        : await local(cid, { signal, maxBytes: options.maxBlockBytes });
    signal.throwIfAborted();
    readBytes += bytes.length;
    if (bytes.length > options.maxBlockBytes || readBytes > maxBytes)
      throw new CarRequestError(413);
    if (cid.multihash.code === sha256.code) {
      const hash = await sha256.digest(bytes);
      if (!Buffer.from(hash.digest).equals(Buffer.from(cid.multihash.digest)))
        throw new CarRequestError(500);
    }
    return bytes;
  };
  let cached = { cid: root, bytes: await read(root) };
  let emit: (cid: CID, bytes: Uint8Array) => Promise<void> = async () => {};
  const store = {
    async *get(cid: CID) {
      signal.throwIfAborted();
      if (!cached.cid.equals(cid)) cached = { cid, bytes: await read(cid) };
      await emit(cid, cached.bytes);
      yield cached.bytes;
    },
  };
  const validate = async (cid: CID, descending: boolean) => {
    const entry = await exporter(cid, store, { signal, offline: true });
    if (entry.type === "file" && !["file", "raw"].includes(entry.unixfs.type))
      throw new CarRequestError(501);
    if (descending && entry.type !== "directory") throw new CarRequestError(404);
  };
  await validate(root, segments.length > 0);
  let accountedBytes = headerLength({ roots: [root] });
  const sent = new Set<string>();
  const account = (cid: CID, bytes: Uint8Array) => {
    const key = cid.toV1().toString();
    if (sent.has(key) || cid.multihash.code === 0) return false;
    if (sent.size >= maxBlocks) throw new CarRequestError(413);
    accountedBytes += blockLength({ cid, bytes });
    if (accountedBytes > maxBytes) throw new CarRequestError(413);
    sent.add(key);
    return true;
  };
  if (accountedBytes + (root.multihash.code === 0 ? 0 : blockLength(cached)) > maxBytes)
    throw new CarRequestError(413);
  const etag = `"${createHash("sha256")
    .update(`${root.toV1()}/${segments.join("/")}\0block\0${carContentType}`)
    .digest("hex")}.car"`;
  response.setHeader("etag", etag);
  response.setHeader("vary", "Accept");
  response.setHeader("content-type", carContentType);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-ipfs-path", `/ipfs/${encoded}`);
  response.setHeader("ipfs-uri", `ipfs://${encoded}`);
  response.setHeader("accept-ranges", "none");
  response.setHeader(
    "cache-control",
    `${options.access === "public" ? "public" : "private"}, max-age=29030400, immutable`,
  );
  response.setHeader(
    "content-disposition",
    `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  );
  for (const [key, value] of Object.entries(variant)) url.searchParams.set(`car-${key}`, value);
  url.searchParams.set("format", "car");
  if (!probe || scope !== null) url.searchParams.set("dag-scope", "block");
  response.setHeader("content-location", `/ipfs/${encoded}${url.search}`);
  const matches = (header: string | undefined, weak: boolean) =>
    header?.split(",").some((part) => {
      const tag = part.trim();
      return tag === "*" || (weak ? tag.replace(/^W\//, "") : tag) === etag;
    });
  if (request.headers["if-match"] && !matches(request.headers["if-match"], false))
    throw new CarRequestError(412);
  const notModified = matches(request.headers["if-none-match"], true);
  if (request.method === "HEAD" || notModified) {
    emit = async (cid, bytes) => {
      account(cid, bytes);
    };
    for await (const entry of walkPath(path, store, {
      signal,
      offline: true,
      yieldSubShards: true,
    }))
      await validate(entry.cid, entry.remainder.length > 0);
    response.writeHead(notModified ? 304 : 200).end();
    return;
  }
  const { writer, out } = CarWriter.create([root]);
  let outputBytes = 0;
  let transportError: unknown;
  const pump = (async () => {
    // Drain the writer even after abort so a blocked put/close can always settle.
    for await (const chunk of out) {
      outputBytes += chunk.length;
      if (transportError) continue;
      try {
        if (outputBytes > maxBytes) throw new CarRequestError(413);
        await write(response, chunk, signal);
      } catch (error) {
        transportError = error;
        response.destroy();
      }
    }
  })();
  emit = async (cid, bytes) => {
    signal.throwIfAborted();
    if (transportError) throw transportError;
    if (!account(cid, bytes)) return;
    await writer.put({ cid, bytes });
  };
  try {
    response.writeHead(200);
    await emit(root, cached.bytes);
    for await (const entry of walkPath(path, store, {
      signal,
      offline: true,
      yieldSubShards: true,
    }))
      await validate(entry.cid, entry.remainder.length > 0);
  } catch (error) {
    response.destroy();
    throw error;
  } finally {
    await writer.close();
    await pump;
  }
  if (transportError) throw transportError;
  await new Promise<void>((resolve) => {
    response.once("close", resolve);
    response.end(resolve);
  });
}
