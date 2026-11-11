import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { DiskContent, Repository, pruneData, type TaskRecord } from "../src/data.js";

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
    result: null,
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
    outputCid: root.toString(),
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
