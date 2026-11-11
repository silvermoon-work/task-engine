import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { project, projectRun, type Store } from "@silvermoon-work/task-protocol";
import { MemoryStore } from "../../task-engine/src/memory-store.js";
import { epoch, fixture, time } from "../../task-protocol/test/fact-fixtures.js";
import { openSqliteStore } from "../src/index.js";

const cid = "bafkreigh2akiscaildcgcupt4v7q2falk6m4rsc3t2qxf2u7z4u5a7dx3u";

function contentContract(store: Store): void {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(store.readContentBlock!(cid), undefined);
  assert.deepEqual(store.readRunContentRoots!("first"), []);
  assert.deepEqual(store.readRunContentAccess!("first"), []);
  assert.throws(() => store.writeContentBlock!("owner", cid, bytes), { code: "store_owned" });
  store.claim("owner");
  assert.throws(() => store.writeContentBlock!("wrong", cid, bytes), { code: "store_owned" });
  assert.throws(() => store.retainRunContent!("wrong", "first", cid), { code: "store_owned" });
  assert.throws(() => store.recordRunContentAccess!("wrong", "first", "bundle"), {
    code: "store_owned",
  });
  store.writeContentBlock!("owner", cid, bytes);
  bytes[0] = 9;
  assert.deepEqual(store.readContentBlock!(cid), new Uint8Array([1, 2, 3]));
  const read = store.readContentBlock!(cid)!;
  read[0] = 9;
  assert.deepEqual(store.readContentBlock!(cid), new Uint8Array([1, 2, 3]));
  assert.throws(() => store.writeContentBlock!("owner", cid, bytes), { code: "storage_conflict" });
  store.writeContentBlock!("owner", cid, new Uint8Array([1, 2, 3]));
  for (const runId of ["first", "second", "first"]) {
    store.retainRunContent!("owner", runId, cid);
    store.recordRunContentAccess!("owner", runId, "bundle");
  }
  assert.deepEqual(store.readRunContentRoots!("first"), [cid]);
  assert.deepEqual(store.readRunContentRoots!("second"), [cid]);
  assert.deepEqual(store.readRunContentAccess!("first"), ["bundle"]);
  store.release("owner");
  assert.throws(() => store.retainRunContent!("owner", "third", cid), { code: "store_owned" });
}

test("MemoryStore content is immutable, shared across Run roots, and lease protected", () => {
  const store = new MemoryStore();
  try {
    contentContract(store);
  } finally {
    store.close();
  }
  assert.throws(() => store.readContentBlock(cid), { code: "storage_failure" });
});

test("SQLite content blocks, multi-Run roots and access associations survive reopen and compaction", async () => {
  const directory = resolve(".cache", `content-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const filename = join(directory, "tasks.sqlite");
  const store = openSqliteStore(filename);
  try {
    contentContract(store);
    store.claim("compact");
    store.compact("compact", 0);
    store.release("compact");
    store.close();
    const reopened = openSqliteStore(filename);
    try {
      assert.deepEqual(reopened.readContentBlock(cid), new Uint8Array([1, 2, 3]));
      assert.deepEqual(reopened.readRunContentRoots("first"), [cid]);
      assert.deepEqual(reopened.readRunContentRoots("second"), [cid]);
      assert.deepEqual(reopened.readRunContentAccess("first"), ["bundle"]);
      reopened.claim("new-owner");
      assert.throws(() => reopened.writeContentBlock("owner", cid, new Uint8Array()), {
        code: "store_owned",
      });
      reopened.retainRunContent("new-owner", "third", cid);
      reopened.release("new-owner");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const outputCid of [undefined, cid])
  test(`SQLite replays output envelope (${outputCid ? "with CID" : "non-bundle result"}) and content access`, async () => {
    const directory = resolve(".cache", `output-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const filename = join(directory, "tasks.sqlite");
    const f = fixture();
    const task = f.task(1, 0);
    const run = f.run(2, 1);
    for (const sid of ["bundle", "input", "input"])
      f.append({
        type: "run.content-access",
        runId: run.runId,
        scope: "scope",
        occurredAt: time(2),
        data: { sid },
      });
    f.append({
      type: "run.outcome",
      runId: run.runId,
      scope: "scope",
      occurredAt: time(3),
      data: {
        outcome: {
          kind: "completed",
          output: {
            result: { ok: true },
            ...(outputCid === undefined ? {} : { cid: outputCid }),
          },
          occurredAt: time(3),
        },
      },
    });
    f.append({
      type: "run.exited",
      runId: run.runId,
      scope: "scope",
      occurredAt: time(4),
      data: { basis: "worker", code: 0 },
    });
    const store = openSqliteStore(filename);
    try {
      store.claim("owner");
      store.append(
        "owner",
        0,
        f.events.map(({ sequence: _sequence, ...event }) => event),
      );
      store.release("owner");
      store.close();
      const reopened = openSqliteStore(filename);
      try {
        const view = reopened.read();
        const taskSnapshot = project(view.facts, task.taskId, epoch + 5);
        const runSnapshot = projectRun(view.facts, run.runId, epoch + 5);
        assert.equal(view.facts.projectionVersion, 5);
        assert.equal(view.facts.runs[run.runId]?.output?.cid, outputCid);
        assert.equal(taskSnapshot.stage, "completed");
        assert.equal(taskSnapshot.output?.cid, outputCid);
        assert.equal(runSnapshot.output?.cid, outputCid);
        assert.deepEqual(taskSnapshot.output, {
          ...(outputCid ? { cid: outputCid } : {}),
          result: { ok: true },
        });
        assert.deepEqual(runSnapshot.output, taskSnapshot.output);
        assert.equal(Object.hasOwn(runSnapshot, "result"), false);
        assert.equal(Object.hasOwn(runSnapshot, "outputCid"), false);
        assert.deepEqual(runSnapshot.contentAccess, ["bundle", "input"]);
        assert.deepEqual(taskSnapshot.run?.contentAccess, ["bundle", "input"]);
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
