import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { asNativeCID, encodeDagCbor } from "@silvermoon-work/ipfs-payload/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { IpfsClient } from "./index.js";
import { ContentError } from "./errors.js";

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

/** Enumerate genuine IPLD links, never CID-looking strings or application object shapes. */
export function contentLinks(
  cid: CID,
  bytes: Uint8Array,
  limits: { depth?: number; nodes?: number } = {},
): readonly CID[] {
  for (const limit of Object.values(limits))
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new ContentError("capacity_exceeded", "Invalid structured content limit.");
  if (cid.code === 0x55) return [];
  if (cid.code === dagPb.code) return dagPb.decode(bytes).Links.map((link) => link.Hash);
  if (cid.code !== dagCbor.code)
    throw new ContentError("unsupported_content", "Unsupported content DAG codec.");
  const links: CID[] = [];
  let nodes = 0;
  const value: unknown = dagCbor.decode(bytes);
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > (limits.nodes ?? 100_000) || depth > (limits.depth ?? 64))
      throw new ContentError("capacity_exceeded", "Structured content capacity exceeded.");
    const link = asNativeCID(value);
    if (link) links.push(link);
    else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (value && typeof value === "object" && !(value instanceof Uint8Array))
      for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(value, 0);
  const canonical = encodeDagCbor(value);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    throw new ContentError("unsupported_content", "Non-canonical DAG-CBOR content.");
  return links;
}

export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  if (cid.multihash.code !== sha256.code) throw new Error("Unsupported content hash.");
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
      throw new ContentError("capacity_exceeded", "Content block capacity exceeded.");
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
  private readonly lifetime = new AbortController();
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
      return this.readBlock(value, options);
    },
  };
  async readBlock(
    value: string,
    options: { signal?: AbortSignal } = {},
    source = this.source,
  ): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const cid = CID.parse(value),
      key = cid.toV1().toString();
    let bytes = this.blocks.get(key);
    if (!bytes) {
      let operation = this.pending.get(key);
      if (!operation) {
        operation = (async () => {
          if (!source)
            throw new ContentError("missing_block", `Missing local content block: ${cid}`);
          const fetched = await acquireBlock(source, cid, {
            signal: this.lifetime.signal,
            blockBytes: this.limits.blockBytes,
          });
          await this.put(cid, fetched, { signal: this.lifetime.signal });
          return this.blocks.get(key)!;
        })();
        this.pending.set(key, operation);
        void operation.finally(() => this.pending.delete(key)).catch(() => {});
      }
      let abort = () => {};
      try {
        bytes = await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            abort = () => reject(options.signal?.reason);
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) abort();
          }),
        ]);
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    }
    options.signal?.throwIfAborted();
    return Uint8Array.from(bytes);
  }
  async close(): Promise<void> {
    this.lifetime.abort(new Error("Content blocks are closed."));
    await Promise.allSettled([...this.pending.values()]);
  }
  async put(cid: CID, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<CID> {
    options.signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (bytes.byteLength > this.limits.blockBytes)
      throw new ContentError("capacity_exceeded", "Content block capacity exceeded.");
    const snapshot = Uint8Array.from(bytes);
    await verifyBlock(cid, snapshot);
    options.signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const key = cid.toV1().toString();
    if (this.blocks.has(key)) return cid;
    if (
      this.blocks.size >= this.limits.blocks ||
      this.retainedBytes + bytes.byteLength > this.limits.bytes
    )
      throw new ContentError("capacity_exceeded", "Content retention capacity exceeded.");
    this.blocks.set(key, snapshot);
    this.retainedBytes += bytes.byteLength;
    return cid;
  }
  async *get(cid: CID, options: { signal?: AbortSignal } = {}) {
    yield await this.block.get(cid.toString(), options);
  }
  async prepare(root: CID | string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const heights = new Map<string, number>();
    const walk = async (cid: CID, depth: number): Promise<number> => {
      options.signal?.throwIfAborted();
      if (depth > this.limits.depth) throw new Error("Content DAG depth capacity exceeded.");
      const key = cid.toV1().toString();
      const known = heights.get(key);
      if (known !== undefined) {
        if (depth + known > this.limits.depth)
          throw new Error("Content DAG depth capacity exceeded.");
        return known;
      }
      const bytes = await this.block.get(cid.toString(), options);
      let height = 0;
      for (const link of contentLinks(cid, bytes))
        height = Math.max(height, 1 + (await walk(link, depth + 1)));
      heights.set(key, height);
      return height;
    };
    await walk(typeof root === "string" ? CID.parse(root) : root, 0);
  }
}
