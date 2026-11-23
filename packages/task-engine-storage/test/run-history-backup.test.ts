import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { IpfsStore } from "../../task-engine/src/content.js";
import { createTaskEngine } from "../../task-engine/src/engine.js";
import { newId } from "../../task-engine/src/identity.js";
import { VirtualClock } from "../../task-engine/src/testing.js";
import {
  archiveTestType,
  deferred,
  poll,
  putRawContent,
} from "../../task-engine/test/run-history-archive-fixture.js";
import { openSqliteStore } from "../src/index.js";

const caller = { scope: "scope", subject: "owner" };

function copyDatabase(source: string, directory: string) {
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, "facts.sqlite");
  copyFileSync(source, destination);
  for (const extra of ["-wal", "-shm"]) {
    if (existsSync(source + extra)) copyFileSync(source + extra, destination + extra);
  }
  return destination;
}

test("SQLite backup restore keeps run state and idempotency while missing IPFS details stay missing", async (t) => {
  const directory = resolve(".cache", `run-history-backup-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "facts.sqlite");
  const archiveStore = new IpfsStore({ dataDir: join(directory, "ipfs") });
  let store = openSqliteStore(file);
  const starts = { n: 0 };
  const hold = deferred<void>();
  const clock = new VirtualClock();
  const bytes = Buffer.from("backup-content-root");
  const contentCid = await putRawContent(archiveStore, bytes);
  const engine = createTaskEngine({
    store,
    clock,
    archiveStore,
    types: [archiveTestType(starts, hold.promise)],
    currentVersions: { "run-test": "1" },
    authorize: () => true,
    archive: { retryDelayMs: 1, leaseMs: 10_000, maxAttempts: 8 },
  });
  t.after(async () => {
    await engine.close().catch(() => {});
    await archiveStore.close().catch(() => {});
    try {
      store.close();
    } catch {
      /* released or already closed */
    }
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* Windows may still hold the data directory */
    }
  });
  await engine.start();
  const request = {
    requestId: newId(clock.now()),
    type: "run-test",
    timeoutMs: 5000,
    mode: "work",
    text: contentCid.toString(),
  };
  const task = engine.submit(request, caller);
  engine.tick();
  await poll(() => starts.n === 1, t.signal);
  const runId = Object.keys(engine.facts().facts.runs)[0]!;
  engine.writeContentBlock(contentCid.toString(), bytes);
  engine.retainRunContent(runId, contentCid.toString());
  hold.resolve();
  await engine.waitForIdle(
    () => !!engine.getTask(task.taskId, caller).termination,
    AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
  );
  await poll(() => store.runHistory.read(runId)?.archive.state === "archived", t.signal);
  const rootCid = store.runHistory.read(runId)!.archive.published!.receipt.rootCid;
  const original = engine.getRequest(task.requestId, caller);
  await engine.close();
  store.close();
  await archiveStore.close();
  const restoredFile = copyDatabase(file, join(directory, "restore"));
  store = openSqliteStore(restoredFile);
  const empty = new IpfsStore({ dataDir: join(directory, "empty-ipfs") });
  t.after(() => empty.close().catch(() => {}));
  const restored = createTaskEngine({
    store,
    clock,
    archiveStore: empty,
    types: [archiveTestType(starts)],
    currentVersions: { "run-test": "1" },
    authorize: () => true,
  });
  t.after(() => restored.close().catch(() => {}));
  await restored.start();
  restored.tick();
  assert.equal(starts.n, 1);
  assert.equal(restored.getTask(task.taskId, caller).stage, "completed");
  assert.equal(restored.submit(original, caller).taskId, task.taskId);
  assert.equal(store.runHistory.read(runId)?.archive.published?.receipt.rootCid, rootCid);
  const detail = await restored.readRunHistoryArchive(runId, caller);
  assert.ok(detail.status === "missing" || detail.status === "not_archived");
  assert.equal(detail.source, undefined);
  assert.equal(Object.keys(store.read().facts.runs).length, 1);
});
