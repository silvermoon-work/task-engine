import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CarWriter } from "@ipld/car/writer";
import { blockLength, headerLength } from "@ipld/car/buffer-writer";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS, Node as UnixFSNode } from "ipfs-unixfs";
import { exporter, walkPath } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { LocalRead, RawGatewayOptions } from "./raw-gateway.js";

const media = "application/vnd.ipld.car";
const variant = { version: "1", order: "dfs", dups: "n" } as const;
export const carContentType = `${media}; version=1; order=dfs; dups=n`;
const maxDepth = 64;

type WalkMode = "block" | "all" | "entity" | "file" | "hamt";
function children(
  cid: CID,
  bytes: Uint8Array,
  mode: WalkMode,
  limit: number,
): { cid: CID; mode: WalkMode }[] {
  if (cid.code === 0x55) {
    if (mode === "hamt") throw new CarRequestError(501);
    return [];
  }
  if (cid.code === dagCbor.code) {
    const value: unknown = dagCbor.decode(bytes);
    if (mode !== "all") {
      if (mode === "file" || mode === "hamt") throw new CarRequestError(501);
      return [];
    }
    const links: CID[] = [];
    const stack: Iterator<unknown>[] = [[value].values()];
    while (stack.length) {
      const item = stack.at(-1)!.next();
      if (item.done) {
        stack.pop();
        continue;
      }
      const link = CID.asCID(item.value);
      if (link) {
        if (links.length >= limit) throw new CarRequestError(413);
        links.push(link);
      } else if (
        item.value &&
        typeof item.value === "object" &&
        !(item.value instanceof Uint8Array)
      ) {
        const values = Array.isArray(item.value)
          ? item.value
          : Object.keys(item.value)
              .sort((a, b) => Buffer.compare(dagCbor.encode(a), dagCbor.encode(b)))
              .map((key) => (item.value as Record<string, unknown>)[key]);
        if (stack.length > maxDepth) throw new CarRequestError(413);
        stack.push(values.values());
      }
    }
    return links.map((cid) => ({ cid, mode: "all" }));
  }
  const node = dagPb.decode(bytes);
  if (mode === "block") return [];
  if (mode === "all") return node.Links.map((link) => ({ cid: link.Hash, mode }));
  let unixfs: UnixFS | undefined;
  try {
    if (node.Data) unixfs = UnixFS.unmarshal(node.Data);
  } catch {
    // DAG-PB is also a general IPLD codec; Data need not be UnixFS.
  }
  if (mode === "entity" && !unixfs) return [];
  if (unixfs?.type === "file" || unixfs?.type === "raw") {
    if (mode === "hamt") throw new CarRequestError(501);
    return node.Links.map((link) => ({ cid: link.Hash, mode: "file" }));
  }
  if (unixfs?.type === "hamt-sharded-directory") {
    if (
      mode === "file" ||
      unixfs.fanout !== 256n ||
      UnixFSNode.decode(bytes).data?.hashType !== 0x22n
    )
      throw new CarRequestError(501);
    return node.Links.filter((link) => link.Name?.length === 2).map((link) => ({
      cid: link.Hash,
      mode: "hamt",
    }));
  }
  if (mode === "file" || mode === "hamt") throw new CarRequestError(501);
  return [];
}

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
  const scope = url.searchParams.get("dag-scope") ?? "all";
  if (scope !== "block" && scope !== "entity" && scope !== "all") throw new CarRequestError(400);
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
    if (
      ![0x55, dagPb.code, dagCbor.code].includes(cid.code) ||
      ![0, sha256.code].includes(cid.multihash.code)
    )
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
  children(root, cached.bytes, "block", maxBlocks);
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
    if (!descending) return;
    const entry = await exporter(cid, store, { signal, offline: true });
    if (entry.type !== "directory") throw new CarRequestError(404);
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
  const traverse = async () => {
    let target = root;
    if (segments.length)
      for await (const entry of walkPath(path, store, {
        signal,
        offline: true,
        yieldSubShards: true,
      })) {
        await validate(entry.cid, entry.remainder.length > 0);
        target = entry.cid;
      }
    const visited = new Set<string>();
    const stack: { cid: CID; mode: WalkMode; depth: number }[] = [
      { cid: target, mode: scope, depth: 0 },
    ];
    while (stack.length) {
      signal.throwIfAborted();
      const item = stack.pop()!;
      const key = item.cid.toV1().toString();
      if (visited.has(key)) continue;
      if (item.depth > maxDepth || visited.size >= maxBlocks) throw new CarRequestError(413);
      visited.add(key);
      if (!cached.cid.equals(item.cid)) cached = { cid: item.cid, bytes: await read(item.cid) };
      await emit(item.cid, cached.bytes);
      const links = children(item.cid, cached.bytes, item.mode, maxBlocks - stack.length);
      // Bound the pending frontier as well as reads, including identity links.
      if (links.length + stack.length > maxBlocks) throw new CarRequestError(413);
      for (let i = links.length - 1; i >= 0; i--)
        stack.push({ ...links[i]!, depth: item.depth + 1 });
    }
  };
  const etag = `"${createHash("sha256")
    .update(`${root.toV1()}/${segments.join("/")}\0${scope}\0${carContentType}`)
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
  url.searchParams.set("dag-scope", scope);
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
    await traverse();
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
    await traverse();
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
