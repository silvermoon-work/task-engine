import { randomBytes } from "node:crypto";
import {
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
  private readonly contentBlocks = new Map<string, Uint8Array>();
  private readonly contentRoots = new Map<string, Set<string>>();
  private readonly contentAccess = new Map<string, Set<string>>();
  readContentBlock(cid: string): Uint8Array | undefined {
    if (this.closed) fail("storage_failure", "Store closed.");
    return this.contentBlocks.get(cid)?.slice();
  }
  writeContentBlock(owner: string, cid: string, bytes: Uint8Array): void {
    if (this.closed || this.owner !== owner) fail("store_owned", "Owner mismatch.");
    const existing = this.contentBlocks.get(cid);
    if (existing && !Buffer.from(existing).equals(bytes))
      fail("storage_conflict", "Content block bytes do not match the retained CID.");
    this.contentBlocks.set(cid, Uint8Array.from(bytes));
  }
  retainRunContent(owner: string, runId: string, cid: string): void {
    if (this.closed || this.owner !== owner) fail("store_owned", "Owner mismatch.");
    const roots = this.contentRoots.get(runId) ?? new Set<string>();
    roots.add(cid);
    this.contentRoots.set(runId, roots);
  }
  readRunContentRoots(runId: string): string[] {
    if (this.closed) fail("storage_failure", "Store closed.");
    return [...(this.contentRoots.get(runId) ?? [])].sort();
  }
  recordRunContentAccess(owner: string, runId: string, sid: string): void {
    if (this.closed || this.owner !== owner) fail("store_owned", "Owner mismatch.");
    const access = this.contentAccess.get(runId) ?? new Set<string>();
    access.add(sid);
    this.contentAccess.set(runId, access);
  }
  readRunContentAccess(runId: string): string[] {
    if (this.closed) fail("storage_failure", "Store closed.");
    return [...(this.contentAccess.get(runId) ?? [])].sort();
  }
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
