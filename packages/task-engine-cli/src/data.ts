import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, realpath, readFile, open, rename, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createIpfsGatewayClient, type GatewayClient } from "@silvermoon-work/task-engine";
import {
  type ErrorFact,
  type Json,
  type RunLogEntry,
  json,
  TaskError,
} from "@silvermoon-work/task-protocol";

export type Status =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "rejected";
export interface TaskRecord {
  taskId: string;
  rootId: string;
  status: Status;
  createdAt: string;
  completedAt?: string;
  result?: Json;
  error?: ErrorFact;
  released: boolean;
  roots: string[];
  timeoutMs: number;
  input?: Record<string, Json>;
  cid?: string;
  outputCid?: string;
  cancelRequested?: boolean;
  releaseProof?: Json;
  logsError?: ErrorFact;
}
export interface InstanceRecord {
  version: 1;
  instanceId: string;
  token: string;
  pid: number;
  birth: string;
  dataDir: string;
  state: "starting" | "ready" | "stopping" | "stopped";
  engineUrl?: string;
  released: boolean;
}
export function errorFact(error: unknown, fallback = "OPERATION_FAILED"): ErrorFact {
  return {
    code: error instanceof TaskError && error.code.trim() ? error.code : fallback,
    message: error instanceof Error && error.message.trim() ? error.message : "Operation failed.",
  };
}
export async function readInstance(directory: string): Promise<InstanceRecord | undefined> {
  let text: string;
  try {
    text = await readFile(join(directory, "instance.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const record = JSON.parse(text) as InstanceRecord;
  if (
    record.version !== 1 ||
    typeof record.instanceId !== "string" ||
    typeof record.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.token) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.birth !== "string" ||
    !(process.platform === "win32"
      ? /^[0-9]{17,20}$/.test(record.birth)
      : process.platform === "linux"
        ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[0-9]+$/.test(record.birth)
        : /^(?:[A-Z][a-z]{2} ){2}[0-9]{1,2} [0-9:]{8} [0-9]{4}$/.test(record.birth)) ||
    record.dataDir !== directory ||
    !["starting", "ready", "stopping", "stopped"].includes(record.state) ||
    typeof record.released !== "boolean"
  )
    throw new TaskError("LOCAL_SERVER_UNKNOWN", "Invalid local instance identity.");
  return record;
}
export async function atomicFile(path: string, value: Uint8Array | string): Promise<void> {
  const candidate = `${path}.${randomUUID()}.pending`;
  try {
    const file = await open(candidate, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(candidate, path);
  } finally {
    await rm(candidate, { force: true });
  }
}
export async function directoryLock(path: string, create: boolean) {
  if (create) await mkdir(resolve(path), { recursive: true });
  const directory = await realpath(resolve(path));
  const contents = await readdir(directory);
  if (!create && !contents.includes("instance.json"))
    throw new TaskError("LOCAL_SERVER_UNKNOWN", "Directory has no managed instance identity.");
  if (
    contents.some((name) => !["instance.lock", "instance.lock-journal"].includes(name)) &&
    !contents.includes("instance.json")
  )
    throw new TaskError(
      "LOCAL_SERVER_UNKNOWN",
      "Directory is not a managed Engine data directory.",
    );
  let conflict: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const lock = new DatabaseSync(join(directory, "instance.lock"));
    try {
      lock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      return {
        directory,
        close() {
          lock.exec("ROLLBACK");
          lock.close();
        },
      };
    } catch (error) {
      lock.close();
      conflict = error;
      if ((error as { errcode?: number }).errcode !== 5) throw error;
      if (attempt < 3)
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 25)));
    }
  }
  throw new TaskError(
    "DATA_IN_USE",
    `Instance directory is locked: ${directory}. ${errorFact(conflict).message}`,
  );
}
export function directoryUnlocked(directory: string): boolean {
  const path = join(directory, "instance.lock");
  if (!existsSync(path) || !lstatSync(path).isFile())
    throw new TaskError("LOCAL_SERVER_UNKNOWN", "Instance lock identity is unavailable.");
  const lock = new DatabaseSync(path, { readOnly: true });
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN");
    lock.prepare("SELECT count(*) FROM sqlite_schema").get();
    lock.exec("ROLLBACK");
    return true;
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 5) return false;
    throw new TaskError(
      "LOCAL_SERVER_UNKNOWN",
      "Instance lock state could not be verified read-only.",
    );
  } finally {
    lock.close();
  }
}
export class Repository {
  readonly db: DatabaseSync;
  private readonly cursorKey: string;
  constructor(
    readonly directory: string,
    private readonly failed: (error: unknown) => void = () => {},
  ) {
    const path = join(directory, "tasks.sqlite");
    if (existsSync(path)) {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
        throw new TaskError(
          "DATA_OWNERSHIP_UNKNOWN",
          "Task database is not an exclusively owned regular file.",
        );
    }
    this.db = new DatabaseSync(path);
    try {
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (
        (version !== 0 && version !== 1) ||
        (version === 0 && this.db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get())
      ) {
        throw new TaskError("UNSUPPORTED_STORAGE", "Unsupported managed task database format.");
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, payload TEXT NOT NULL, car BLOB);
      CREATE TABLE IF NOT EXISTS facts (root_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (position INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        run_id TEXT NOT NULL, sequence INTEGER NOT NULL, time TEXT NOT NULL, level TEXT NOT NULL,
        message TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id,sequence));
      CREATE INDEX IF NOT EXISTS logs_task ON logs(task_id,position); PRAGMA user_version=1;`);
      this.db
        .prepare("INSERT OR IGNORE INTO metadata VALUES ('cursor',?)")
        .run(randomBytes(32).toString("hex"));
      this.cursorKey = String(
        this.db.prepare("SELECT value FROM metadata WHERE key='cursor'").get()!.value,
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  write<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }
  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT id,root_id,payload FROM tasks WHERE id=?").get(id);
    return row && this.decode(row);
  }
  all(): TaskRecord[] {
    return this.db
      .prepare("SELECT id,root_id,payload FROM tasks")
      .all()
      .map((row) => this.decode(row));
  }
  readContentBlock(cid: string): Uint8Array | undefined {
    if (
      !this.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ipfs_blocks'")
        .get()
    )
      return undefined;
    const row = this.db.prepare("SELECT bytes FROM ipfs_blocks WHERE cid=?").get(cid);
    if (!row) return undefined;
    if (!(row.bytes instanceof Uint8Array))
      throw new TaskError("storage_corrupt", "Invalid retained IPFS block.");
    return new Uint8Array(row.bytes);
  }
  private decode(row: Record<string, import("node:sqlite").SQLOutputValue>): TaskRecord {
    const task = JSON.parse(String(row.payload)) as TaskRecord;
    if (
      task.taskId !== row.id ||
      task.rootId !== row.root_id ||
      typeof task.released !== "boolean" ||
      (task.released && (!task.releaseProof || !task.completedAt)) ||
      !Array.isArray(task.roots) ||
      task.roots.some((root) => typeof root !== "string") ||
      !["pending", "running", "succeeded", "failed", "timed_out", "cancelled", "rejected"].includes(
        task.status,
      )
    )
      throw new TaskError(
        "STORAGE_CORRUPT",
        "Managed task identity or lifecycle record is invalid.",
      );
    if (Object.hasOwn(task, "result")) json(task.result, Number.MAX_SAFE_INTEGER);
    return task;
  }
  put(task: TaskRecord, car?: Uint8Array): void {
    this.write(() => {
      if (car)
        this.db
          .prepare("INSERT INTO tasks VALUES (?,?,?,?)")
          .run(task.taskId, task.rootId, JSON.stringify(task), car);
      else
        this.db
          .prepare(
            `INSERT INTO tasks VALUES (?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
              car=CASE WHEN ? THEN NULL ELSE tasks.car END`,
          )
          .run(task.taskId, task.rootId, JSON.stringify(task), task.released ? 1 : 0);
    });
  }
  car(id: string): Uint8Array | undefined {
    const value = this.db.prepare("SELECT car FROM tasks WHERE id=?").get(id)?.car;
    return value instanceof Uint8Array ? value : undefined;
  }
  appendLogs(taskId: string, entries: readonly RunLogEntry[]): void {
    this.write(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // A log snapshot includes previously acknowledged entries. INSERT OR
        // IGNORE alone still advances AUTOINCREMENT for duplicates, causing a
        // FULL-sync write per old entry on every subsequent acknowledgement.
        const insert = this.db.prepare(
          `INSERT INTO logs(task_id,run_id,sequence,time,level,message,payload)
           SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS
           (SELECT 1 FROM logs WHERE run_id=? AND sequence=?)`,
        );
        for (const entry of entries)
          insert.run(
            taskId,
            entry.runId,
            entry.sequence,
            entry.receivedAt,
            entry.level,
            entry.message,
            JSON.stringify(entry),
            entry.runId,
            entry.sequence,
          );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  cursor(scope: string, offset: number): string {
    const body = Buffer.from(JSON.stringify({ scope, offset })).toString("base64url");
    return `${body}.${createHmac("sha256", this.cursorKey).update(body).digest("base64url")}`;
  }
  offset(scope: string, token?: string): number {
    if (!token) return 0;
    const [body, mac, extra] = token.split(".");
    const expected = createHmac("sha256", this.cursorKey)
      .update(body ?? "")
      .digest();
    const actual = Buffer.from(mac ?? "", "base64url");
    if (!body || extra || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new TaskError("INVALID_CURSOR", "Cursor does not belong to this service and query.");
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      scope: string;
      offset: number;
    };
    if (parsed.scope !== scope || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0)
      throw new TaskError("INVALID_CURSOR", "Cursor does not belong to this service and query.");
    return parsed.offset;
  }
  close() {
    this.db.close();
  }
}
export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  if (
    cid.multihash.code !== sha256.code ||
    !Buffer.from((await sha256.digest(bytes)).bytes).equals(Buffer.from(cid.multihash.bytes))
  )
    throw new TaskError("INVALID_CONTENT", `CID verification failed: ${cid}.`);
}
export class DiskContent implements GatewayClient {
  private readonly gateway: GatewayClient | undefined;
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<Uint8Array>>();
  constructor(
    readonly directory: string,
    gateway?: string,
    private readonly failed: (error: unknown) => void = () => {},
    private readonly beforeWrite?: () => void,
    private readonly retainedBlock?: (cid: string) => Uint8Array | undefined,
  ) {
    this.checkDirectory();
    if (gateway) this.gateway = createIpfsGatewayClient(gateway, { allowPath: true });
  }
  private checkDirectory() {
    const path = join(this.directory, "blocks");
    if (existsSync(path)) {
      const metadata = lstatSync(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new TaskError(
          "CACHE_OWNERSHIP_UNKNOWN",
          "Cache directory is not an owned regular directory.",
        );
    }
  }
  async put(cid: CID, bytes: Uint8Array): Promise<void> {
    await verifyBlock(cid, bytes);
    try {
      await this.local(cid);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      this.beforeWrite?.();
      this.checkDirectory();
      await mkdir(join(this.directory, "blocks"), { recursive: true });
      await atomicFile(join(this.directory, "blocks", cid.toV1().toString()), bytes);
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }
  async local(cid: CID): Promise<Uint8Array> {
    this.checkDirectory();
    const path = join(this.directory, "blocks", cid.toV1().toString());
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!metadata) {
      const retained = this.retainedBlock?.(cid.toV1().toString());
      if (!retained) {
        const error: NodeJS.ErrnoException = new Error(`Content block is not cached: ${cid}.`);
        error.code = "ENOENT";
        throw error;
      }
      await verifyBlock(cid, retained);
      return retained;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new TaskError("CACHE_OWNERSHIP_UNKNOWN", "Cache block is not a regular file.");
    const bytes = await readFile(path);
    await verifyBlock(cid, bytes);
    return bytes;
  }
  readonly block = {
    get: (value: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> => {
      const operation = this.read(value, options.signal);
      this.active.add(operation);
      void operation.then(
        () => this.active.delete(operation),
        () => this.active.delete(operation),
      );
      return operation;
    },
  };
  private async read(value: string, signal?: AbortSignal): Promise<Uint8Array> {
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const cid = CID.parse(value);
    try {
      return await this.local(cid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.gateway)
      throw new TaskError(
        "CONTENT_NOT_CACHED",
        "Content is not cached and no IPFS Gateway is configured.",
      );
    const bytes = await this.gateway.block.get(value, { signal: combined });
    await this.put(cid, bytes);
    return bytes;
  }
  async close() {
    this.lifetime.abort(new TaskError("ENGINE_CLOSING", "Content reads are closing."));
    await this.gateway?.close();
    await Promise.allSettled([...this.active]);
  }
}
export interface PruneSelection {
  taskIds?: string[];
  before?: string;
  cache?: true;
}
export async function pruneData(
  repository: Repository,
  selection: PruneSelection,
  signal?: AbortSignal,
) {
  const counts = {
    dataDir: repository.directory,
    selection,
    deletedTasks: 0,
    deletedLogs: 0,
    ...(selection.cache ? { deletedCacheBlocks: 0, deletedCacheBytes: 0 } : {}),
  };
  try {
    const records = repository.all();
    const selected = selection.taskIds
      ? [...new Set(selection.taskIds)].map((id) => {
          const task = repository.get(id);
          if (!task || !task.released || !task.completedAt)
            throw new TaskError(
              "INVALID_CLEANUP_TASK",
              `Task ${id} is missing, active or release is unconfirmed.`,
            );
          return task;
        })
      : records.filter(
          (task) =>
            selection.before &&
            task.released &&
            task.completedAt &&
            task.completedAt < selection.before,
        );
    for (const task of selected) {
      signal?.throwIfAborted();
      repository.write(() => {
        repository.db.exec("BEGIN IMMEDIATE");
        try {
          const logs = repository.db
            .prepare("DELETE FROM logs WHERE task_id=?")
            .run(task.taskId).changes;
          repository.db.prepare("DELETE FROM tasks WHERE id=?").run(task.taskId);
          repository.db.prepare("DELETE FROM facts WHERE root_id=?").run(task.rootId);
          repository.db.exec("COMMIT");
          counts.deletedTasks++;
          counts.deletedLogs += Number(logs);
        } catch (error) {
          repository.db.exec("ROLLBACK");
          throw error;
        }
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (selection.cache) {
      const content = new DiskContent(
        repository.directory,
        undefined,
        undefined,
        undefined,
        (cid) => repository.readContentBlock(cid),
      );
      const marked = new Set<string>();
      const pending = repository.all().flatMap((task) => {
        if (!task.released)
          throw new TaskError("DATA_IN_USE", "Retained task release cannot be verified.");
        return task.roots;
      });
      try {
        while (pending.length) {
          signal?.throwIfAborted();
          const cid = CID.parse(pending.pop()!).toV1();
          const key = cid.toString();
          if (marked.has(key)) continue;
          const bytes = await content.local(cid);
          marked.add(key);
          if (cid.code === dagPb.code)
            pending.push(...dagPb.decode(bytes).Links.map((link) => link.Hash.toString()));
          else if (cid.code !== 0x55)
            throw new TaskError("CACHE_MARK_FAILED", "Unsupported content link encoding.");
        }
      } catch (error) {
        if (signal?.aborted && error === signal.reason) throw error;
        throw new TaskError(
          "CACHE_MARK_FAILED",
          `Retained reference graph cannot be completely marked; no cache deleted. ${errorFact(error).message}`,
        );
      } finally {
        await content.close();
      }
      let blocks: string[];
      try {
        blocks = await readdir(join(repository.directory, "blocks"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        blocks = [];
      }
      for (const key of blocks) {
        signal?.throwIfAborted();
        if (marked.has(key)) continue;
        const cid = CID.parse(key);
        if (cid.toV1().toString() !== key)
          throw new TaskError("CACHE_INVALID", "Unexpected cache file identity.");
        const path = join(repository.directory, "blocks", key);
        const metadata = await lstat(path);
        if (!metadata.isFile())
          throw new TaskError("CACHE_INVALID", "Unexpected cache entry type.");
        await rm(path);
        counts.deletedCacheBlocks!++;
        counts.deletedCacheBytes! += metadata.size;
      }
      if (
        repository.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ipfs_blocks'")
          .get()
      )
        for (const row of repository.db
          .prepare("SELECT cid, length(bytes) AS size FROM ipfs_blocks")
          .all()) {
          signal?.throwIfAborted();
          const cid = String(row.cid);
          if (marked.has(cid)) continue;
          repository.write(() => {
            repository.db.exec("BEGIN IMMEDIATE");
            try {
              repository.db.prepare("DELETE FROM run_content_roots WHERE cid=?").run(cid);
              repository.db.prepare("DELETE FROM ipfs_blocks WHERE cid=?").run(cid);
              repository.db.exec("COMMIT");
            } catch (error) {
              repository.db.exec("ROLLBACK");
              throw error;
            }
          });
          counts.deletedCacheBlocks!++;
          counts.deletedCacheBytes! += Number(row.size);
        }
    }
    return { ok: true as const, data: counts };
  } catch (error) {
    return {
      ok: false as const,
      data: counts,
      error:
        signal?.aborted && error === signal.reason
          ? {
              code: "INTERRUPTED",
              message: "Cleanup interrupted; confirmed deletions were not rolled back.",
            }
          : errorFact(error),
    };
  }
}
