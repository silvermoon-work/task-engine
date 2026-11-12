import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { exporter } from "ipfs-unixfs-exporter";
import type { IpfsClient } from "./index.js";
import { isTaskBundlePath, TaskError } from "@silvermoon-work/task-protocol";

export interface ContentLimits {
  bytes: number;
  blocks: number;
  blockBytes: number;
  depth: number;
}
export const defaultContentLimits: Readonly<ContentLimits> = Object.freeze({
  bytes: 256 * 1024 * 1024,
  blocks: 16_384,
  blockBytes: 2 * 1024 * 1024,
  depth: 64,
});
export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  if (cid.multihash.code !== sha256.code || ![0x55, dagPb.code].includes(cid.code))
    throw new Error("Unsupported content hash or codec.");
  const hash = await sha256.digest(bytes);
  if (!Buffer.from(hash.digest).equals(Buffer.from(cid.multihash.digest)))
    throw new Error(`Content hash verification failed: ${cid}`);
}
export async function acquireBlock(
  client: IpfsClient,
  cid: CID,
  options: { signal?: AbortSignal; blockBytes?: number; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  let abort = () => {};
  try {
    const bytes = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return client.block.get(cid.toString(), { signal });
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    signal.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) throw new Error("Content source must return bytes.");
    if (bytes.byteLength > (options.blockBytes ?? 2 * 1024 * 1024))
      throw new TaskError("capacity_exceeded", "Content block capacity exceeded.");
    const snapshot = Uint8Array.from(bytes);
    await verifyBlock(cid, snapshot);
    signal.throwIfAborted();
    return snapshot;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** One owner per scope; immutable bytes, unique-CID storage accounting, no implicit source. */
export class ContentBlocks implements IpfsClient {
  readonly blocks = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  readonly limits: ContentLimits;
  retainedBytes = 0;
  constructor(
    private readonly source?: IpfsClient,
    limits: Partial<ContentLimits> = {},
  ) {
    this.limits = { ...defaultContentLimits, ...limits };
    for (const limit of Object.values(this.limits))
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid content capacity.");
  }
  readonly block = {
    get: async (value: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> => {
      options.signal?.throwIfAborted();
      const cid = CID.parse(value),
        key = cid.toV1().toString();
      let bytes = this.blocks.get(key);
      if (!bytes) {
        let operation = this.pending.get(key);
        if (!operation) {
          operation = (async () => {
            if (!this.source) throw new Error(`Missing local content block: ${cid}`);
            const fetched = await acquireBlock(this.source, cid, {
              ...options,
              blockBytes: this.limits.blockBytes,
            });
            await this.put(cid, fetched, options);
            return this.blocks.get(key)!;
          })();
          this.pending.set(key, operation);
          void operation.finally(() => this.pending.delete(key)).catch(() => {});
        }
        bytes = await operation;
      }
      options.signal?.throwIfAborted();
      return Uint8Array.from(bytes);
    },
  };
  async put(cid: CID, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<CID> {
    options.signal?.throwIfAborted();
    if (bytes.byteLength > this.limits.blockBytes)
      throw new Error("Content block capacity exceeded.");
    const snapshot = Uint8Array.from(bytes);
    await verifyBlock(cid, snapshot);
    options.signal?.throwIfAborted();
    const key = cid.toV1().toString();
    if (this.blocks.has(key)) return cid;
    if (
      this.blocks.size >= this.limits.blocks ||
      this.retainedBytes + bytes.byteLength > this.limits.bytes
    )
      throw new Error("Content retention capacity exceeded.");
    this.blocks.set(key, snapshot);
    this.retainedBytes += bytes.byteLength;
    return cid;
  }
  async *get(cid: CID, options: { signal?: AbortSignal } = {}) {
    yield await this.block.get(cid.toString(), options);
  }
  async prepare(root: CID | string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const seen = new Set<string>();
    const walk = async (cid: CID, depth: number): Promise<void> => {
      options.signal?.throwIfAborted();
      if (depth > this.limits.depth) throw new Error("Content DAG depth capacity exceeded.");
      const key = cid.toV1().toString();
      if (seen.has(key)) return;
      seen.add(key);
      const bytes = await this.block.get(cid.toString(), options);
      if (cid.code === dagPb.code)
        for (const link of dagPb.decode(bytes).Links) await walk(link.Hash, depth + 1);
    };
    await walk(typeof root === "string" ? CID.parse(root) : root, 0);
  }
}

export interface ContentFile {
  path: string;
  cid: string;
  bytes: Uint8Array;
}
/** Expand without re-encoding: metadata and chunk topology remain in the original blocks. */
export async function expandContent(
  root: CID,
  blocks: ContentBlocks,
  options: {
    signal?: AbortSignal;
    paths?: number;
    files?: number;
    bytes?: number;
    fileBytes?: number;
  } = {},
): Promise<ContentFile[]> {
  const files: ContentFile[] = [];
  let paths = 0,
    bytes = 0;
  const walk = async (cid: CID, path: string, depth: number): Promise<void> => {
    options.signal?.throwIfAborted();
    if (++paths > (options.paths ?? 16_384) || depth > blocks.limits.depth)
      throw new Error("Content logical path capacity exceeded.");
    const entry = await exporter(cid, blocks, options);
    if (entry.type === "directory") {
      const names = new Set<string>();
      for await (const child of entry.entries(options)) {
        if (
          !child.name ||
          child.name === "." ||
          child.name === ".." ||
          !isTaskBundlePath(child.name) ||
          child.name.includes("/") ||
          child.name.includes("\\") ||
          names.has(child.name.toLowerCase())
        )
          throw new Error("Unsafe or ambiguous UnixFS directory name.");
        names.add(child.name.toLowerCase());
        await walk(child.cid, path ? `${path}/${child.name}` : child.name, depth + 1);
      }
      if (!names.size) throw new Error("Empty UnixFS directories are not supported.");
    } else if (
      entry.type === "raw" ||
      (entry.type === "file" && ["file", "raw"].includes(entry.unixfs.type))
    ) {
      if (files.length >= (options.files ?? 4096))
        throw new Error("Content file capacity exceeded.");
      const parts: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of entry.content({ ...options, blockReadConcurrency: 1 })) {
        options.signal?.throwIfAborted();
        length += chunk.byteLength;
        bytes += chunk.byteLength;
        if (
          length > (options.fileBytes ?? 64 * 1024 * 1024) ||
          bytes > (options.bytes ?? 128 * 1024 * 1024)
        )
          throw new Error("Content logical byte capacity exceeded.");
        parts.push(chunk);
      }
      files.push({ path, cid: cid.toString(), bytes: Buffer.concat(parts, length) });
    } else throw new Error("Only regular UnixFS files and directories are supported.");
  };
  await blocks.prepare(root, options);
  await walk(root, "", 0);
  return files;
}

/** Replace an existing path with the original immutable node, rebuilding only ancestor dirs. */
export async function linkContent(
  root: CID,
  path: string,
  target: CID,
  blocks: ContentBlocks,
  options: { signal?: AbortSignal } = {},
): Promise<CID> {
  const sizes = new Map<string, number>();
  const dagSize = async (cid: CID, depth = 0): Promise<number> => {
    if (depth > blocks.limits.depth) throw new Error("Content DAG depth capacity exceeded.");
    const key = cid.toV1().toString(),
      cached = sizes.get(key);
    if (cached !== undefined) return cached;
    const bytes = await blocks.block.get(cid.toString(), options);
    let size = bytes.byteLength;
    if (cid.code === dagPb.code)
      for (const link of dagPb.decode(bytes).Links) size += await dagSize(link.Hash, depth + 1);
    if (!Number.isSafeInteger(size)) throw new Error("Content DAG size capacity exceeded.");
    sizes.set(key, size);
    return size;
  };
  const replace = async (cid: CID, parts: readonly string[]): Promise<CID> => {
    if (!parts.length) return target;
    const entry = await exporter(cid, blocks, options);
    if (entry.type !== "directory" || cid.code !== dagPb.code)
      throw new Error(`Import ancestor is not a plain UnixFS directory: ${path}`);
    const node = dagPb.decode(await blocks.block.get(cid.toString(), options));
    let found = false;
    const links = [];
    for (const link of node.Links) {
      if (link.Name !== parts[0]) {
        links.push(link);
        continue;
      }
      found = true;
      const child = await replace(link.Hash, parts.slice(1));
      links.push({ ...link, Hash: child, Tsize: await dagSize(child) });
    }
    if (!found) throw new Error(`Missing import destination: ${path}`);
    const bytes = dagPb.encode(dagPb.prepare({ ...node, Links: links }));
    const next = CID.createV1(dagPb.code, await sha256.digest(bytes));
    await blocks.put(next, bytes, options);
    return next;
  };
  return replace(root, path.split("/"));
}
