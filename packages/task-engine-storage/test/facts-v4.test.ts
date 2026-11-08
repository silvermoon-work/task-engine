import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { project } from "@silvermoon-work/task-protocol";
import { epoch, fixture, time } from "../../task-protocol/test/fact-fixtures.js";
import { sharingCases, sharingFacts } from "../../task-protocol/test/sharing-fixtures.js";
import { openSqliteStore } from "../src/index.js";

function filename() {
  const file = resolve(".cache", `facts-v4-${randomUUID()}.sqlite`);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}
function clean(file: string) {
  for (const suffix of ["", "-wal", "-shm", ".owner"]) rmSync(`${file}${suffix}`, { force: true });
}
for (const scenario of sharingCases)
  test(`SQLite cold replay rebuilds Schema Equals: ${scenario.name}`, () => {
    const file = filename();
    const f = sharingFacts(scenario);
    const store = openSqliteStore(file);
    let before: ReturnType<typeof project>;
    try {
      store.claim("writer");
      store.append(
        "writer",
        0,
        f.events.map(({ sequence: _sequence, ...event }) => event),
      );
      before = project(store.read().facts, f.follower.taskId, epoch);
      store.release("writer");
    } finally {
      store.close();
    }
    const reopened = openSqliteStore(file);
    try {
      const view = reopened.read();
      assert.equal(
        project(view.facts, f.follower.taskId, epoch).run?.runId,
        scenario.equal ? f.run.runId : undefined,
      );
      assert.deepEqual(project(view.facts, f.follower.taskId, epoch), before);
      assert.deepEqual(view.facts.tasks[f.follower.taskId]?.input, scenario.right);
    } finally {
      reopened.close();
      clean(file);
    }
  });
test("v4 refuses old v3 without changing its bytes or creating an owner file", () => {
  const file = filename();
  try {
    const old = new DatabaseSync(file);
    old.exec(
      "CREATE TABLE old_records(id TEXT); INSERT INTO old_records VALUES ('preserve'); PRAGMA user_version=3;",
    );
    old.close();
    const before = readFileSync(file);
    assert.throws(() => openSqliteStore(file), { code: "unsupported_version" });
    assert.deepEqual(readFileSync(file), before);
    assert.equal(existsSync(`${file}.owner`), false);
  } finally {
    clean(file);
  }
});
test("v4 persists raw qualification facts and replays matching after rollback and restart", () => {
  const file = filename(),
    f = fixture();
  f.task(1, -20);
  const run = f.run(2, -10),
    a = f.task(3, 0, 10);
  const store = openSqliteStore(file);
  store.claim("first");
  store.append(
    "first",
    0,
    f.events.map(({ sequence: _sequence, ...event }) => event),
  );
  const accepted = structuredClone(store.read().facts.tasks[a.taskId]);
  store.append("first", 3, [
    {
      type: "qualification-time-observed",
      scope: "",
      occurredAt: time(10),
      data: { observedAt: time(10) },
    },
  ]);
  const domain = store.read().storeId;
  assert.deepEqual(store.read().facts.tasks[a.taskId], accepted);
  store.release("first");
  store.close();
  const reopened = openSqliteStore(file);
  try {
    reopened.claim("second");
    const snapshot = project(reopened.read().facts, a.taskId, epoch + 5);
    assert.equal(snapshot.run?.runId, run.runId);
    assert.equal(snapshot.stage, "running");
    assert.equal(snapshot.revision, `${domain}:4`);
    reopened.append("second", 4, [
      {
        type: "run.exited",
        scope: "scope",
        runId: run.runId,
        occurredAt: time(5),
        data: { basis: "recovery" },
      },
    ]);
    assert.equal(project(reopened.read().facts, a.taskId, epoch + 5).stage, "stopped");
    assert.throws(() => reopened.compact("second", 5), { code: "protected_history" });
    reopened.release("second");
  } finally {
    reopened.close();
    clean(file);
  }
});
test("M03/M04 SQLite restart preserves actual early-exit invalidation and requires a later qualification source", () => {
  const file = filename();
  const f = fixture();
  f.task(1, -20);
  const original = f.run(2, -10);
  const task = f.task(3, 0, 10);
  f.append({
    type: "qualification-time-observed",
    scope: "",
    occurredAt: time(10),
    data: { observedAt: time(10) },
  });
  const next = f.run(4, 11);
  f.append({
    type: "run.exited",
    scope: "scope",
    runId: original.runId,
    occurredAt: time(5),
    data: { basis: "worker", code: 1 },
  });
  const store = openSqliteStore(file);
  store.claim("writer");
  store.append(
    "writer",
    0,
    f.events.map(({ sequence: _sequence, ...event }) => event),
  );
  const before = project(store.read().facts, task.taskId, epoch + 10);
  assert.equal(before.stage, "initial");
  assert.equal(before.updatedAt, time(5));
  store.release("writer");
  store.close();
  const reopened = openSqliteStore(file);
  try {
    reopened.claim("reader");
    const view = reopened.read();
    assert.deepEqual(project(view.facts, task.taskId, epoch + 10), before);
    assert.equal(view.facts.runs[original.runId]?.exit?.occurredAt, time(5));
    reopened.append("reader", 6, [
      {
        type: "qualification-time-observed",
        scope: "",
        occurredAt: time(10),
        data: { observedAt: time(10) },
      },
    ]);
    const after = project(reopened.read().facts, task.taskId, epoch + 10);
    assert.equal(after.run?.runId, next.runId);
    assert.equal(after.run?.matchedAt, time(10));
    assert.equal(after.updatedAt, time(10));
    assert.equal(Object.keys(reopened.read().facts.runs).length, 2);
    reopened.release("reader");
  } finally {
    reopened.close();
    clean(file);
  }
});
test("v4 keeps request credentials after detail removal and its admission floor after compaction", () => {
  const file = filename(),
    store = openSqliteStore(file),
    f = fixture(),
    a = f.task(1, 0);
  store.claim("owner");
  try {
    store.append(
      "owner",
      0,
      f.events.map(({ sequence: _sequence, ...event }) => event),
    );
    store.append("owner", 1, [
      { type: "task.canceled", taskId: a.taskId, scope: "scope", occurredAt: time(1), data: {} },
      {
        type: "records.forgotten",
        scope: "",
        occurredAt: time(2),
        data: { taskIds: [a.taskId], runIds: [] },
      },
      { type: "window.advanced", scope: "", occurredAt: time(2), data: { lowerBound: epoch - 1 } },
    ]);
    assert.ok(store.read().facts.requests[a.request.requestId]);
    store.compact("owner", 4);
    assert.equal(store.read().prefix.watermark, 4);
    assert.equal(store.read().facts.admissionLowerBound, epoch - 1);
    store.append("owner", 4, [
      { type: "window.advanced", scope: "", occurredAt: time(10), data: { lowerBound: epoch + 1 } },
    ]);
    assert.equal(store.read().facts.requests[a.request.requestId], undefined);
    assert.throws(
      () =>
        store.append("owner", 5, [
          { type: "window.advanced", scope: "", occurredAt: time(5), data: { lowerBound: epoch } },
        ]),
      { code: "invalid_fact" },
    );
    assert.equal(store.read().facts.admissionLowerBound, epoch + 1);
    assert.equal(store.read().facts.watermark, 5);
  } finally {
    store.release("owner");
    store.close();
    clean(file);
  }
});
test("v4 rejects checksum-valid cached state that is not backed by source facts", () => {
  const file = filename(),
    store = openSqliteStore(file),
    f = fixture(),
    a = f.task(1, 0);
  store.claim("owner");
  store.append(
    "owner",
    0,
    f.events.map(({ sequence: _sequence, ...event }) => event),
  );
  store.release("owner");
  store.close();
  try {
    const db = new DatabaseSync(file),
      row = db.prepare("SELECT payload FROM checkpoint").get();
    const facts = JSON.parse(String(row?.payload));
    facts.tasks[a.taskId].canceledAt = time(1);
    const payload = JSON.stringify(facts);
    db.prepare("UPDATE checkpoint SET payload=?,checksum=?").run(
      payload,
      createHash("sha256").update(payload).digest("hex"),
    );
    db.close();
    const corrupt = openSqliteStore(file);
    try {
      assert.throws(() => corrupt.read(), { code: "storage_corrupt" });
    } finally {
      corrupt.close();
    }
  } finally {
    clean(file);
  }
});
