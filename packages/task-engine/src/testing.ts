import type { Clock } from "@silvermoon-work/task-protocol";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

export { MemoryStore } from "./memory-store.js";

export class VirtualClock implements Clock {
  private elapsed = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  constructor(private time = 1_800_000_000_000) {}
  now(): number {
    return this.time;
  }
  setTime(time: number): void {
    this.time = time;
  }
  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.next;
    this.timers.set(id, { at: this.elapsed + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(milliseconds: number): void {
    this.time += milliseconds;
    this.elapsed += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.elapsed && this.timers.delete(id)) timer.callback();
    }
  }
  get pendingTimers(): number {
    return this.timers.size;
  }
}
/** Offline fixture, not a publisher or production storage backend. */
export class MemoryIpfsClient {
  readonly blocks = new Map<string, Uint8Array>();
  readonly pins = new Set<string>();
  readonly block = {
    put: async (bytes: Uint8Array, options: { format: "raw" | "dag-pb" }) => {
      const cid = CID.createV1(options.format === "raw" ? 0x55 : 0x70, await sha256.digest(bytes));
      this.blocks.set(cid.toString(), Uint8Array.from(bytes));
      return cid;
    },
    get: async (cid: string, options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      const bytes = this.blocks.get(cid);
      if (!bytes) throw new Error("IPFS block is unavailable.");
      return Uint8Array.from(bytes);
    },
  };
  readonly pin = {
    add: async (cid: string) => {
      if (!this.blocks.has(cid)) throw new Error("Cannot pin missing root.");
      this.pins.add(cid);
      return CID.parse(cid);
    },
  };
  async import(files: ReadonlyMap<string, Uint8Array>) {
    const [{ unixfs }, { MemoryBlockstore }, { fixedSize }, { balanced }] = await Promise.all([
      import("@helia/unixfs"),
      import("blockstore-core"),
      import("ipfs-unixfs-importer/chunker"),
      import("ipfs-unixfs-importer/layout"),
    ]);
    const blockstore = new MemoryBlockstore();
    const store = blockstore.put.bind(blockstore);
    blockstore.put = async (cid, bytes, options) => {
      const chunks: Uint8Array[] = [];
      if (bytes instanceof Uint8Array) chunks.push(bytes);
      else for await (const chunk of bytes) chunks.push(chunk);
      const value = Buffer.concat(chunks);
      this.blocks.set(cid.toString(), value);
      return store(cid, value, options);
    };
    let cid: string | undefined;
    for await (const entry of unixfs({ blockstore }).addAll(
      [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, content]) => ({ path, content })),
      {
        cidVersion: 1,
        rawLeaves: true,
        wrapWithDirectory: true,
        reduceSingleLeafToSelf: true,
        shardSplitThresholdBytes: Number.MAX_SAFE_INTEGER,
        fileImportConcurrency: 1,
        blockWriteConcurrency: 4,
        chunker: fixedSize({ chunkSize: 262_144 }),
        layout: balanced({ maxChildrenPerNode: 174 }),
      },
    ))
      cid = entry.cid.toString();
    if (!cid) throw new Error("Cannot import an empty fixture.");
    return cid;
  }
}
