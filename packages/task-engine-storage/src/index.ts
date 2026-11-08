import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertFactsVersion,
  emptyFacts,
  type FactEvent,
  type Facts,
  fail,
  type NewEvent,
  reduce,
  restoreTaskUpdates,
  type Store,
  type StoredRunLogs,
  type StoreView,
  TaskError,
} from "@silvermoon-work/task-protocol";

export interface SqliteOptions {
  logFault?: () => void;
  busyTimeoutMs?: number;
  fault?: (point: "beforeCommit" | "afterCommit") => void;
}
function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function unsupported(): never {
  return fail(
    "unsupported_version",
    "Unsupported Task storage format. Use a new database path; old data is not migrated or deleted.",
  );
}

function inspectFormat(db: DatabaseSync): boolean {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version === 0) {
    if (db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get()) unsupported();
    return false;
  }
  if (version !== 5) unsupported();
  const checkpoint = db
    .prepare("SELECT projection_version, payload FROM checkpoint WHERE singleton=1")
    .get();
  if (checkpoint?.projection_version !== 5 || typeof checkpoint.payload !== "string") unsupported();
  assertFactsVersion(JSON.parse(checkpoint.payload) as Facts);
  return true;
}

function preflight(filename: string): void {
  if (!existsSync(filename) || statSync(filename).size === 0) return;
  const descriptor = openSync(filename, "r");
  const header = Buffer.alloc(100);
  let length: number;
  try {
    length = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (length >= 64 && header.subarray(0, 16).toString() === "SQLite format 3\0") {
    const version = header.readUInt32BE(60);
    if (version !== 0 && version !== 5) unsupported();
  }
  const wal = `${filename}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    // Even SQLite's read-only WAL reader writes SHM read marks. Inspect an owned
    // sibling snapshot instead, never recovering/checkpointing the original.
    const snapshot = `${filename}.inspect-${randomUUID()}`;
    const stamp = () =>
      [filename, wal]
        .map((path) => {
          const stat = statSync(path, { bigint: true });
          return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        })
        .join("|");
    const before = stamp();
    try {
      copyFileSync(filename, snapshot);
      copyFileSync(wal, `${snapshot}-wal`);
      if (stamp() !== before)
        fail("storage_conflict", "Storage changed during read-only format inspection; retry.");
      const db = new DatabaseSync(snapshot, { readOnly: true });
      try {
        inspectFormat(db);
      } finally {
        db.close();
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${snapshot}${suffix}`, { force: true });
    }
  } else {
    // Node 22.13 treats SQLite URI strings as filenames. Inspect an owned copy
    // so rejecting a format never changes the original database or sidecars.
    const snapshot = `${filename}.inspect-${randomUUID()}`;
    try {
      copyFileSync(filename, snapshot);
      const db = new DatabaseSync(snapshot, { readOnly: true });
      try {
        inspectFormat(db);
      } finally {
        db.close();
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${snapshot}${suffix}`, { force: true });
    }
  }
}

export class SqliteStore implements Store {
  private logsInitialized = false;
  private logDepth = 0;
  private readonly busyTimeoutMs: number;
  private logOperation<T>(operation: () => T): T {
    const outer = this.logDepth === 0;
    if (outer) this.db.exec("PRAGMA busy_timeout=0");
    this.logDepth++;
    try {
      return operation();
    } finally {
      this.logDepth--;
      if (outer) this.db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs}`);
    }
  }
  markRunLogsUnavailable(owner: string, id: string, now: number): void {
    this.logOperation(() => {
      this.owned(owner);
      this.initializeLogs();
      const value = this.readRunLogs(id) ?? {
        runId: id,
        updatedAt: now,
        bytes: 0,
        entries: [],
        state: {
          availability: "unavailable" as const,
          completeness: "open" as const,
          dropped: 0,
          lastSequence: 0,
          firstSequence: 1,
        },
      };
      value.state.availability = "unavailable";
      value.state.reason = "storage";
      this.db
        .prepare("INSERT OR REPLACE INTO run_logs VALUES (?, ?, ?, ?)")
        .run(id, value.updatedAt, value.bytes, JSON.stringify(value));
    });
  }
  private initializeLogs(): void {
    if (this.closed) fail("storage_failure", "Store closed.");
    if (this.logsInitialized) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_logs (
      run_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS run_logs_age ON run_logs(updated_at);`);
    this.logsInitialized = true;
  }
  readRunLogs(id: string): StoredRunLogs | undefined {
    return this.logOperation(() => {
      this.initializeLogs();
      const row = this.db.prepare("SELECT payload FROM run_logs WHERE run_id=?").get(id);
      return row ? (JSON.parse(String(row.payload)) as StoredRunLogs) : undefined;
    });
  }
  writeRunLogs(owner: string, value: StoredRunLogs): void {
    this.logOperation(() => {
      this.owned(owner);
      this.initializeLogs();
      this.options.logFault?.();
      this.db
        .prepare("INSERT OR REPLACE INTO run_logs VALUES (?, ?, ?, ?)")
        .run(value.runId, value.updatedAt, value.bytes, JSON.stringify(value));
    });
  }
  pruneRunLogs(owner: string, before: number, maxBytes: number, maxRuns: number): void {
    this.logOperation(() => {
      this.owned(owner);
      this.initializeLogs();
      const rows = this.db
        .prepare("SELECT run_id, updated_at, bytes FROM run_logs ORDER BY updated_at, run_id")
        .all();
      let bytes = rows.reduce((sum, row) => sum + Number(row.bytes), 0);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          if (Number(row.updated_at) >= before && bytes <= maxBytes) continue;
          const value = this.readRunLogs(String(row.run_id))!;
          bytes -= value.bytes;
          value.bytes = 0;
          value.entries = [];
          value.state.availability = "expired";
          value.state.firstSequence = value.state.lastSequence + 1;
          this.db
            .prepare("UPDATE run_logs SET bytes=0, payload=? WHERE run_id=?")
            .run(JSON.stringify(value), value.runId);
        }
        for (const row of rows.slice(0, Math.max(0, rows.length - maxRuns)))
          this.db.prepare("DELETE FROM run_logs WHERE run_id=?").run(String(row.run_id));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  private readonly db: DatabaseSync;
  private lock: DatabaseSync | undefined;
  private owner: string | undefined;
  private closed = false;
  private readonly filename: string;
  constructor(
    filename: string,
    private readonly options: SqliteOptions = {},
  ) {
    if (
      !filename ||
      filename === ":memory:" ||
      filename.startsWith("file:") ||
      filename.startsWith("\\\\")
    )
      fail("storage_failure", "SQLite Store requires an explicit local file.");
    const timeout = options.busyTimeoutMs ?? 100;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5_000)
      fail("invalid_request", "SQLite busy timeout must be between 0 and 5000 ms.");
    this.busyTimeoutMs = timeout;
    this.filename = resolve(filename);
    preflight(this.filename);
    this.db = new DatabaseSync(this.filename);
    this.filename = realpathSync.native(this.filename);
    try {
      const initialized = inspectFormat(this.db);
      this.db.exec(
        `PRAGMA busy_timeout=${timeout}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`,
      );
      if (initialized) return;
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          store_id TEXT NOT NULL, floor INTEGER NOT NULL, watermark INTEGER NOT NULL,
          owner_path TEXT NOT NULL, cursor_key TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requests (
          request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS checkpoint (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          watermark INTEGER NOT NULL, projection_version INTEGER NOT NULL,
          payload TEXT NOT NULL, checksum TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history_prefix (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          payload TEXT NOT NULL, checksum TEXT NOT NULL
        );
        PRAGMA user_version=5;
      `);
      const domain = randomUUID();
      this.db
        .prepare("INSERT OR IGNORE INTO metadata VALUES (1, ?, 0, 0, ?, ?)")
        .run(domain, `${this.filename}.owner`, randomBytes(32).toString("hex"));
      const initial = JSON.stringify(emptyFacts(domain));
      this.db
        .prepare("INSERT OR IGNORE INTO checkpoint VALUES (1, 0, 5, ?, ?)")
        .run(initial, checksum(initial));
      this.db
        .prepare("INSERT OR IGNORE INTO history_prefix VALUES (1, ?, ?)")
        .run(initial, checksum(initial));
      this.db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  claim(owner: string): void {
    if (this.closed || this.owner) fail("store_owned", "Store is closed or already owned.");
    const ownerPath = this.db
      .prepare("SELECT owner_path FROM metadata WHERE singleton=1")
      .get()?.owner_path;
    if (typeof ownerPath !== "string")
      fail("storage_corrupt", "Missing stable owner lock location.");
    const lock = new DatabaseSync(ownerPath);
    try {
      lock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
      this.lock = lock;
      this.owner = owner;
    } catch {
      lock.close();
      fail("store_owned", "Another active Engine owns this SQLite file.");
    }
  }
  private owned(owner: string): void {
    if (this.closed || this.owner !== owner) fail("store_owned", "Store owner mismatch.");
  }
  release(owner: string): void {
    this.owned(owner);
    this.lock?.exec("ROLLBACK");
    this.lock?.close();
    this.lock = undefined;
    this.owner = undefined;
  }
  private readInside(): StoreView {
    const metadata = this.db
      .prepare("SELECT store_id, floor, watermark, cursor_key FROM metadata WHERE singleton=1")
      .get();
    const checkpoint = this.db
      .prepare(
        "SELECT watermark, projection_version, payload, checksum FROM checkpoint WHERE singleton=1",
      )
      .get();
    if (
      !metadata ||
      typeof metadata.cursor_key !== "string" ||
      !checkpoint ||
      checkpoint.projection_version !== 5 ||
      typeof checkpoint.payload !== "string" ||
      checksum(checkpoint.payload) !== checkpoint.checksum
    )
      fail("storage_corrupt", "Invalid durable checkpoint.");
    let facts: Facts;
    let prefix: Facts;
    let events: FactEvent[];
    try {
      facts = JSON.parse(checkpoint.payload) as Facts;
      assertFactsVersion(facts);
      const row = this.db
        .prepare("SELECT payload,checksum FROM history_prefix WHERE singleton=1")
        .get();
      if (!row || typeof row.payload !== "string" || checksum(row.payload) !== row.checksum)
        fail("storage_corrupt", "Invalid retained source prefix.");
      prefix = JSON.parse(row.payload) as Facts;
      assertFactsVersion(prefix);
      if (
        prefix.watermark !== metadata.floor ||
        prefix.dataDomain !== metadata.store_id ||
        facts.dataDomain !== metadata.store_id
      )
        fail("storage_corrupt", "Source prefix or data domain mismatch.");
      events = this.db
        .prepare("SELECT sequence, payload, checksum FROM events ORDER BY sequence")
        .all()
        .map((row) => {
          const event = JSON.parse(String(row.payload)) as FactEvent;
          if (event.sequence !== row.sequence || checksum(String(row.payload)) !== row.checksum)
            fail("storage_corrupt", "Event identity or checksum mismatch.");
          return event;
        });
    } catch (error) {
      if (error instanceof TaskError) throw error;
      fail("storage_corrupt", "Cannot decode persisted facts.");
    }
    if (facts.watermark !== checkpoint.watermark)
      fail("storage_corrupt", "Checkpoint boundary mismatch.");
    const rebuilt = reduce(prefix, events);
    if (JSON.stringify(rebuilt) !== JSON.stringify(facts))
      fail("storage_corrupt", "Cached facts do not match the retained source prefix.");
    facts = rebuilt;
    if (facts.watermark !== metadata.watermark)
      fail("storage_corrupt", "Missing committed event suffix.");
    return restoreTaskUpdates({
      storeId: String(metadata.store_id),
      cursorKey: metadata.cursor_key,
      floor: Number(metadata.floor),
      prefix,
      facts,
      events,
    });
  }
  read(): StoreView {
    if (this.closed) fail("storage_failure", "Store closed.");
    this.db.exec("BEGIN");
    try {
      const view = this.readInside();
      this.db.exec("COMMIT");
      return view;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  append(owner: string, expectedWatermark: number, events: NewEvent[]): StoreView {
    this.owned(owner);
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const view = this.readInside();
      if (view.facts.watermark !== expectedWatermark)
        fail("storage_conflict", "Stale event watermark.");
      const appended = events.map((event, index) => ({
        ...event,
        sequence: expectedWatermark + index + 1,
      }));
      const facts = reduce(view.facts, appended);
      const insert = this.db.prepare(
        "INSERT INTO events(sequence,payload,checksum) VALUES (?, ?, ?)",
      );
      for (const event of appended) {
        const serialized = JSON.stringify(event);
        insert.run(event.sequence, serialized, checksum(serialized));
        if (event.type === "task.created")
          this.db
            .prepare("INSERT INTO requests(request_id,task_id) VALUES (?, ?)")
            .run(event.data.task.request.requestId, event.data.task.taskId);
      }
      for (const id of Object.keys(view.facts.requests))
        if (!facts.requests[id]) this.db.prepare("DELETE FROM requests WHERE request_id=?").run(id);
      const payload = JSON.stringify(facts);
      this.db
        .prepare("UPDATE checkpoint SET watermark=?,payload=?,checksum=? WHERE singleton=1")
        .run(facts.watermark, payload, checksum(payload));
      this.db.prepare("UPDATE metadata SET watermark=? WHERE singleton=1").run(facts.watermark);
      this.options.fault?.("beforeCommit");
      this.db.exec("COMMIT");
      committed = true;
      this.options.fault?.("afterCommit");
      return { ...view, facts, events: [...view.events, ...appended] };
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  compact(owner: string, through: number): void {
    this.owned(owner);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const view = this.readInside();
      if (Object.keys(view.facts.tasks).length || Object.keys(view.facts.runs).length)
        fail("protected_history", "Recovery references still protect history.");
      if (through < view.floor || through !== view.facts.watermark)
        fail("invalid_cursor", "Invalid history compaction boundary.");
      this.db.prepare("DELETE FROM events WHERE sequence<=?").run(through);
      this.db.prepare("UPDATE metadata SET floor=? WHERE singleton=1").run(through);
      view.facts.observations = [];
      const serialized = JSON.stringify(view.facts);
      this.db
        .prepare("UPDATE history_prefix SET payload=?,checksum=? WHERE singleton=1")
        .run(serialized, checksum(serialized));
      this.db
        .prepare("UPDATE checkpoint SET payload=?,checksum=? WHERE singleton=1")
        .run(serialized, checksum(serialized));
      this.db.exec("COMMIT");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    if (this.owner) fail("store_owned", "Close Engine before Store.");
    this.db.close();
    this.closed = true;
  }
}

export function openSqliteStore(filename: string, options?: SqliteOptions): SqliteStore {
  return new SqliteStore(filename, options);
}
