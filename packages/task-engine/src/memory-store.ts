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
