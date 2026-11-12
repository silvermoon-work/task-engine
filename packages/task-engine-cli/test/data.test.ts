import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { DiskContent, Repository, pruneData, type TaskRecord } from "../src/data.js";
import { managedDiagnostics } from "../src/diagnostics.js";
import type { RunLogEntry } from "@silvermoon-work/task-protocol";
import { IpfsStore } from "@silvermoon-work/ipfs-store";

test("durable log snapshots are atomic and replay without new disk writes or cursor positions", async (t) => {
  const directory = resolve(".cache", `log-snapshots-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  let failure: unknown;
  const repository = new Repository(directory, (error) => {
    failure = error;
  });
  const observer = new DatabaseSync(join(directory, "tasks.sqlite"), { readOnly: true });
  t.after(async () => {
    observer.close();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const entries: RunLogEntry[] = [1, 2, 3].map((sequence) => ({
    runId: "run",
    sequence,
    receivedAt: "2026-01-01T00:00:00.000Z",
    level: "info",
    message: `entry-${sequence}`,
  }));
  repository.db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON logs WHEN NEW.sequence=2
    BEGIN SELECT RAISE(FAIL, 'controlled write failure'); END;`);
  assert.throws(() => repository.appendLogs("task", entries));
  assert.ok(failure);
  assert.equal(observer.prepare("SELECT count(*) AS n FROM logs").get()?.n, 0);
  repository.db.exec("DROP TRIGGER reject_second");
  repository.appendLogs("task", entries.slice(0, 2));
  const version = observer.prepare("PRAGMA data_version").get()?.data_version;
  repository.appendLogs("task", entries.slice(0, 2));
  assert.equal(observer.prepare("PRAGMA data_version").get()?.data_version, version);
  repository.appendLogs("task", entries);
  assert.deepEqual(
    observer
      .prepare("SELECT position,sequence,message FROM logs ORDER BY position")
      .all()
      .map((row) => ({ ...row })),
    entries.map((entry) => ({
      position: entry.sequence,
      sequence: entry.sequence,
      message: entry.message,
    })),
  );
});

test("managed diagnostics reserve bounded private space, redact failures and survive restart", async (t) => {
  const directory = resolve(".cache", `diagnostics-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "daemon-diagnostic.json");
  const first = managedDiagnostics(directory, "first-instance");
  try {
    first.record(
      "shutdown-failed",
      new AggregateError(
        [
          Object.assign(new Error("secret-token"), { code: "ENOSPC", path: "private-path" }),
          Object.assign(new Error("private-input"), { code: "SECRET_VALUE" }),
        ],
        "sensitive-output",
      ),
    );
  } finally {
    first.close();
  }
  const saved = await readFile(path, "utf8");
  assert.equal(Buffer.byteLength(saved), 4096);
  assert.doesNotMatch(saved, /secret|sensitive|private|SECRET/);
  assert.deepEqual(JSON.parse(saved).causes, [{ systemCode: "ENOSPC" }, {}]);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  const second = managedDiagnostics(directory, "second-instance");
  try {
    assert.equal(await readFile(path, "utf8"), saved);
    second.record("storage-failed", Object.assign(new Error("secret"), { code: "EIO" }));
    const latest = JSON.parse(await readFile(path, "utf8"));
    assert.equal(latest.instanceId, "second-instance");
    assert.equal(latest.systemCode, "EIO");
  } finally {
    second.close();
  }
  await link(path, join(directory, "shared"));
  assert.throws(() => managedDiagnostics(directory, "third-instance"), { code: "START_FAILED" });
  await rm(join(directory, "shared"));
  await writeFile(path, "invalid-size");
  assert.throws(() => managedDiagnostics(directory, "third-instance"), { code: "START_FAILED" });
});

test("offline mark-sweep preserves shared descendants, rejects unknown graphs and reports partial history changes", async (t) => {
  const directory = resolve(".cache", `prune-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const repository = new Repository(directory);
  const content = new DiskContent(directory);
  t.after(async () => {
    repository.close();
    await content.close();
    await rm(directory, { recursive: true, force: true });
  });
  const put = async (code: number, bytes: Uint8Array) => {
    const cid = CID.createV1(code, await sha256.digest(bytes));
    await content.put(cid, bytes);
    return cid;
  };
  const shared = await put(0x55, Buffer.from("shared"));
  const a = await put(
    dagPb.code,
    dagPb.encode({ Data: Buffer.from("A"), Links: [{ Name: "shared", Hash: shared, Tsize: 6 }] }),
  );
  const b = await put(
    dagPb.code,
    dagPb.encode({ Data: Buffer.from("B"), Links: [{ Name: "shared", Hash: shared, Tsize: 6 }] }),
  );
  const orphan = await put(0x55, Buffer.from("orphan"));
  const record = (id: string, root: string): TaskRecord => ({
    taskId: id,
    rootId: id,
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:00.000Z",
    released: true,
    releaseProof: { basis: "test" },
    roots: [root],
    timeoutMs: 1000,
    output: { result: null },
  });
  repository.put(record("A", a.toString()));
  repository.put(record("B", b.toString()));
  const tooEarly = await pruneData(repository, { before: "2026-01-01T12:00:00.000Z" });
  assert.equal(
    tooEarly.data.deletedTasks,
    0,
    "History selection uses completion time, not creation time.",
  );
  const cache = await pruneData(repository, { cache: true });
  assert.equal(cache.ok, true);
  assert.equal(cache.data.deletedCacheBlocks, 1);
  assert.equal(cache.data.deletedCacheBytes, 6);
  assert.equal((await readdir(join(directory, "blocks"))).includes(orphan.toString()), false);
  assert.deepEqual(await content.local(shared), Buffer.from("shared"));
  const combined = await pruneData(repository, { taskIds: ["A"], cache: true });
  assert.equal(combined.ok, true);
  assert.equal(combined.data.deletedTasks, 1);
  assert.equal(combined.data.deletedCacheBlocks, 1);
  assert.deepEqual(await content.local(shared), Buffer.from("shared"));
  const unknown = await put(0x55, Buffer.from("missing"));
  repository.put(record("missing", unknown.toString()));
  await rm(join(directory, "blocks", unknown.toString()));
  const extra = await put(0x55, Buffer.from("must survive failed mark"));
  const failed = await pruneData(repository, { taskIds: ["B"], cache: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.data.deletedTasks, 1);
  assert.equal(failed.data.deletedCacheBlocks, 0);
  if (!failed.ok) assert.equal(failed.error.code, "CACHE_MARK_FAILED");
  assert.deepEqual(await content.local(extra), Buffer.from("must survive failed mark"));
  const history = await pruneData(repository, { taskIds: ["missing"] });
  assert.equal(history.ok, true);
  assert.equal(Object.hasOwn(history.data, "deletedCacheBlocks"), false);
  const empty = await pruneData(repository, { cache: true });
  assert.equal(empty.ok, true);
  assert.equal(empty.data.deletedCacheBlocks, 3);
  repository.put({ ...record("first", a.toString()), roots: [] });
  repository.put({ ...record("second", b.toString()), roots: [] });
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  const partial = await pruneData(repository, { taskIds: ["first", "second"] }, controller.signal);
  assert.equal(partial.ok, false);
  assert.equal(partial.data.deletedTasks, 1);
  assert.equal(repository.get("first"), undefined);
  assert.ok(repository.get("second"));
  if (!partial.ok) assert.equal(partial.error.code, "INTERRUPTED");
});

test("disk content validates hashes, never falls back to network, and propagates controlled ENOSPC as fatal", async (t) => {
  const directory = resolve(".cache", `disk-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("verified");
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  const missing = new DiskContent(directory);
  await assert.rejects(missing.block.get(cid.toString()), { code: "CONTENT_NOT_CACHED" });
  await assert.rejects(missing.put(cid, Buffer.from("wrong")), { code: "INVALID_CONTENT" });
  let fatal: unknown;
  const disk = new DiskContent(
    directory,
    undefined,
    (error) => {
      fatal = error;
    },
    () => {
      throw Object.assign(new Error("controlled storage exhaustion"), { code: "ENOSPC" });
    },
  );
  await assert.rejects(disk.put(cid, bytes), { code: "ENOSPC" });
  assert.equal((fatal as NodeJS.ErrnoException).code, "ENOSPC");
  await missing.close();
  await disk.close();
});

test("the host adapts retained output into IpfsStore without network or transferring source ownership", async () => {
  const directory = resolve(".cache", `retained-store-${randomUUID()}`);
  const bytes = Buffer.from("retained output");
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  let upstream = 0;
  const source = IpfsStore.fromClient(
    {
      block: {
        get: async () => {
          upstream++;
          throw new Error("not available upstream");
        },
      },
    },
    {},
    directory,
  );
  const content = new DiskContent(directory, source, undefined, undefined, (value) =>
    value === cid.toString() ? bytes : undefined,
  );
  try {
    const node = await content.ipfsStore.read(cid);
    assert.equal(node.type, "raw");
    assert.equal(upstream, 0);
    await content.close();
    assert.deepEqual(Buffer.from(await source.block.get(cid.toString())), bytes);
    assert.equal(upstream, 0);
  } finally {
    await content.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline cache cleanup preserves retained SQLite output graphs until their tasks are removed", async (t) => {
  const directory = resolve(".cache", `output-prune-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const repository = new Repository(directory);
  const content = new DiskContent(directory);
  t.after(async () => {
    repository.close();
    await content.close();
    await rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from("output");
  const child = CID.createV1(0x55, await sha256.digest(bytes));
  await content.put(child, bytes);
  const rootBytes = dagPb.encode({ Links: [{ Name: "file", Hash: child, Tsize: bytes.length }] });
  const root = CID.createV1(dagPb.code, await sha256.digest(rootBytes));
  const orphanBytes = Buffer.from("orphan");
  const orphan = CID.createV1(0x55, await sha256.digest(orphanBytes));
  repository.db.exec(`
    CREATE TABLE ipfs_blocks (cid TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE run_content_roots (run_id TEXT, cid TEXT, PRIMARY KEY (run_id,cid));
  `);
  const insert = repository.db.prepare("INSERT INTO ipfs_blocks VALUES (?,?)");
  insert.run(root.toString(), rootBytes);
  insert.run(orphan.toString(), orphanBytes);
  repository.db.prepare("INSERT INTO run_content_roots VALUES (?,?)").run("run", root.toString());
  repository.put({
    taskId: "output",
    rootId: "output",
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:00.000Z",
    released: true,
    roots: [root.toString()],
    output: { cid: root.toString(), result: null },
    releaseProof: { basis: "test" },
    timeoutMs: 1000,
  });
  const retained = await pruneData(repository, { cache: true });
  assert.equal(retained.ok, true, JSON.stringify(retained));
  assert.equal(retained.data.deletedCacheBlocks, 1);
  assert.ok(repository.readContentBlock(root.toString()));
  assert.equal(repository.readContentBlock(orphan.toString()), undefined);
  const removed = await pruneData(repository, { taskIds: ["output"], cache: true });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.data.deletedCacheBlocks, 2);
  assert.equal(repository.readContentBlock(root.toString()), undefined);
  assert.equal(
    repository.db.prepare("SELECT count(*) AS count FROM run_content_roots").get()!.count,
    0,
  );
});
