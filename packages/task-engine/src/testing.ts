import { randomBytes } from "node:crypto";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  type Clock,
  emptyFacts,
  fail,
  MemoryRunLogStorage,
  type NewEvent,
  reduce,
  type Store,
  type StoredRunLogs,
  type StoreView,
} from "@silvermoon-work/task-protocol";
import { newId } from "./identity.js";

/** Explicitly non-durable; useful for tests and disposable hosts only. */
export class MemoryStore implements Store {
  private readonly logs = new MemoryRunLogStorage();
  beforeLogCommit?: () => void;
  markRunLogsUnavailable(owner: string, id: string, now: number): void {
    if (this.closed || this.owner !== owner) fail("store_owned", "Owner mismatch.");
    this.logs.markRunLogsUnavailable(owner, id, now);
  }
  readRunLogs(id: string) {
    if (this.closed) fail("storage_failure", "Store closed.");
    return this.logs.readRunLogs(id);
  }
  writeRunLogs(owner: string, value: StoredRunLogs): void {
    if (this.closed || this.owner !== owner) fail("store_owned", "Owner mismatch.");
    this.beforeLogCommit?.();
    this.logs.writeRunLogs(owner, value);
  }
  pruneRunLogs(owner: string, before: number, bytes: number, runs: number): void {
    if (this.closed || this.owner !== owner) fail("store_owned", "Owner mismatch.");
    this.logs.pruneRunLogs(owner, before, bytes, runs);
  }
  private owner: string | undefined;
  private closed = false;
  private readonly domain = newId();
  private view: StoreView = {
    storeId: this.domain,
    cursorKey: randomBytes(32).toString("hex"),
    floor: 0,
    prefix: emptyFacts(this.domain),
    facts: emptyFacts(this.domain),
    events: [],
  };
  beforeCommit?: () => void;
  claim(owner: string): void {
    if (this.closed || this.owner) fail("store_owned", "Store is closed or already owned.");
    this.owner = owner;
  }
  release(owner: string): void {
    if (this.owner !== owner) fail("store_owned", "Owner mismatch.");
    this.owner = undefined;
  }
  read(): StoreView {
    if (this.closed) fail("storage_failure", "Store closed.");
    return structuredClone(this.view);
  }
  append(owner: string, expectedWatermark: number, events: NewEvent[]): StoreView {
    if (this.owner !== owner || this.closed) fail("store_owned", "Owner mismatch.");
    if (this.view.facts.watermark !== expectedWatermark) fail("storage_conflict", "Stale write.");
    const appended = events.map((event, index) => ({
      ...event,
      sequence: expectedWatermark + index + 1,
    }));
    const facts = reduce(this.view.facts, appended);
    this.beforeCommit?.();
    if (this.view.facts.watermark !== expectedWatermark)
      fail("storage_conflict", "Source prefix changed during the commit hook.");
    this.view = { ...this.view, facts, events: [...this.view.events, ...appended] };
    return this.read();
  }
  compact(owner: string, through: number): void {
    if (this.owner !== owner) fail("store_owned", "Owner mismatch.");
    if (Object.keys(this.view.facts.tasks).length || Object.keys(this.view.facts.runs).length)
      fail("protected_history", "Recovery references still protect history.");
    if (through < this.view.floor || through !== this.view.facts.watermark)
      fail("invalid_cursor", "Invalid compaction boundary.");
    this.view.events = this.view.events.filter((event) => event.sequence > through);
    this.view.floor = through;
    this.view.facts.observations = [];
    this.view.prefix = structuredClone(this.view.facts);
  }
  close(): void {
    if (this.owner) fail("store_owned", "Release Engine before closing Store.");
    this.closed = true;
  }
}

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
