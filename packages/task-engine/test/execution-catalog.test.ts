import assert from "node:assert/strict";
import test from "node:test";
import { at, type RunPage, TaskError } from "@silvermoon-work/task-protocol";
import { RunCatalog } from "../src/catalog.js";
import { newId } from "../src/index.js";
import { createFixtureEngine } from "./driver.js";
import { caller, harness } from "./fixtures.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof TaskError && error.code === expected;
function next(page: RunPage): string {
  assert.ok(page.next);
  return page.next;
}

test("Execution directory is authoritative, scope-isolated, shared once and payload-free", async () => {
  const h = await harness({ resources: ["js", "js", "js", "js"], authorize: () => true });
  try {
    const a = h.submit(),
      b = h.submit();
    await h.turn();
    h.clock.setTime(h.clock.now() + 1000);
    const external = h.engine.submit(
      {
        requestId: newId(h.clock.now()),
        type: "echo",
        text: "external secret input",
        timeoutMs: 10000,
      },
      { scope: caller.scope, subject: "another-client" },
    );
    h.engine.submit(
      {
        requestId: newId(h.clock.now()),
        type: "echo",
        text: "other scope secret",
        timeoutMs: 10000,
      },
      { scope: "other", subject: "external" },
    );
    await h.turn();
    const page = h.engine.listRuns({}, {}, caller);
    assert.equal(page.runs.length, 2);
    const shared = h.engine.getTask(a.taskId, caller).run!.runId;
    assert.equal(h.engine.getTask(b.taskId, caller).run!.runId, shared);
    assert.equal(page.runs.filter((item) => item.runId === shared).length, 1);
    assert.equal(page.runs[0]!.runId, h.engine.getTask(external.taskId, caller).run!.runId);
    assert.deepEqual(Object.keys(page.runs[0]!).sort(), [
      "runId",
      "scope",
      "stage",
      "startedAt",
      "startedSequence",
      "state",
      "stopRequested",
      "type",
      "updatedAt",
      "version",
    ]);
    assert.equal(JSON.stringify(page).includes("secret"), false);
    assert.equal(JSON.stringify(page).includes("taskId"), false);
    const older = page.runs[1]!,
      newer = page.runs[0]!;
    assert.deepEqual(
      h.engine
        .listRuns({ startedFrom: older.startedAt, startedBefore: newer.startedAt }, {}, caller)
        .runs.map((item) => item.runId),
      [shared],
    );
    assert.equal(
      h.engine.listRuns({ startedFrom: older.startedAt.replace("Z", "+00:00") }, {}, caller).runs
        .length,
      2,
    );
    assert.equal(h.engine.listRuns({ type: "absent" }, {}, caller).runs.length, 0);
    assert.equal(h.engine.listRuns({}, {}, { ...caller, scope: "other" }).runs.length, 1);
    assert.deepEqual(
      h.engine
        .listTasks({ runId: shared }, {}, caller)
        .tasks.map((item) => item.taskId)
        .sort(),
      [a.taskId, b.taskId].sort(),
    );
    assert.equal(
      h.engine.listTasks({ runId: shared }, {}, { ...caller, scope: "other" }).tasks.length,
      0,
    );
  } finally {
    await h.close();
  }
});

test("Execution list permission is independent and is rechecked on every frozen page", async () => {
  let allowed = true;
  const h = await harness({
    authorize: (who, operation, scope) =>
      who.scope === scope &&
      (who.subject === "reader" ? allowed && operation === "list-runs" : who.subject === "tester"),
  });
  try {
    h.submit({ text: "one" });
    h.submit({ text: "two" });
    await h.turn();
    const reader = { ...caller, subject: "reader" };
    const page = h.engine.listRuns({}, { limit: 1 }, reader);
    assert.throws(() => h.engine.listTasks({}, {}, reader), code("forbidden"));
    assert.throws(() => h.engine.discoverTypes(reader), code("forbidden"));
    assert.throws(
      () => h.engine.readHistory({ runId: page.runs[0]!.runId }, {}, reader),
      code("forbidden"),
    );
    allowed = false;
    assert.throws(
      () => h.engine.listRuns({}, { cursor: next(page), limit: 1 }, reader),
      code("forbidden"),
    );
    allowed = true;
    assert.equal(
      h.engine.listRuns({}, { cursor: next(page), limit: 1 }, reader).observedAt,
      page.observedAt,
    );
    assert.throws(
      () => h.engine.listRuns({}, { cursor: next(page) }, caller),
      code("invalid_cursor"),
    );
  } finally {
    await h.close();
  }
});

test("Execution snapshots freeze state and membership, use independent cursors and expire on collection/restart", async () => {
  const h = await harness({
    limits: { pageSize: 1, retentionMs: 1 },
    resources: ["js", "js", "js"],
  });
  try {
    h.submit({ text: "one" });
    h.submit({ text: "two" });
    await h.turn();
    const page = h.engine.listRuns({}, {}, caller);
    const old = structuredClone(page);
    const tasks = h.engine.listTasks({}, {}, caller);
    assert.throws(
      () => h.engine.listRuns({}, { cursor: tasks.next! }, caller),
      code("invalid_cursor"),
    );
    assert.throws(
      () => h.engine.listTasks({}, { cursor: next(page) }, caller),
      code("invalid_cursor"),
    );
    const eventCursor = h.engine.readHistory({ runId: page.runs[0]!.runId }, {}, caller).cursor;
    assert.throws(
      () => h.engine.listRuns({}, { cursor: eventCursor }, caller),
      code("invalid_cursor"),
    );
    h.submit({ text: "later" });
    await h.turn();
    await h.finish(0, { ok: false, privateResult: "not in directory" });
    await h.finish(1);
    await h.finish(2);
    await h.turn();
    const second = h.engine.listRuns({}, { cursor: next(page) }, caller);
    assert.equal(second.observedAt, page.observedAt);
    assert.equal(second.runs[0]!.state.running, true);
    assert.deepEqual(page, old);
    const fresh = h.engine.listRuns({}, {}, caller);
    assert.equal(fresh.runs[0]!.state.completed, true);
    assert.equal(fresh.runs[0]!.state.reclaimed, true);
    h.clock.advance(20);
    h.engine.collect();
    assert.throws(
      () => h.engine.listRuns({}, { cursor: next(page) }, caller),
      code("query_expired"),
    );
    assert.equal(h.engine.listRuns({}, {}, caller).runs.length, 0);
    await h.engine.close();
    const reopened = createFixtureEngine({
      store: h.store,
      clock: h.clock,
      types: [h.type, h.sum],
      currentVersions: { echo: "1", sum: "1" },
      authorize: () => true,
    });
    await reopened.start();
    assert.throws(
      () => reopened.listRuns({}, { cursor: next(page) }, caller),
      code("query_expired"),
    );
    await reopened.close();
  } finally {
    await h.close();
  }
});

test("Execution query input, time, scan, view and byte budgets fail explicitly", async () => {
  const h = await harness({ limits: { pageSize: 1, maxQueryViews: 1, queryLifetimeMs: 20 } });
  try {
    h.submit({ text: "one" });
    h.submit({ text: "two" });
    await h.turn();
    for (const query of [
      { startedFrom: "2026-02-31T00:00:00Z" },
      { startedFrom: "no-timezone" },
      { startedFrom: at(h.clock.now()), startedBefore: at(h.clock.now()) },
      { sort: "created-desc" },
    ])
      assert.throws(() => h.engine.listRuns(query as never, {}, caller), code("invalid_request"));
    assert.throws(
      () => h.engine.listRuns({ input: "secret" } as never, {}, caller),
      code("unsupported_condition"),
    );
    const first = h.engine.listRuns({}, {}, caller);
    assert.throws(() => h.engine.listRuns({ type: "echo" }, {}, caller), code("capacity_exceeded"));
    assert.ok(
      h.engine.listTasks({}, {}, caller).next,
      "Task and Execution view budgets are independently bounded",
    );
    const facts = h.store.read().facts;
    assert.throws(
      () =>
        new RunCatalog({ ...h.engine.limits, queryScanLimit: 1 }).read(
          {},
          {},
          caller,
          facts,
          h.clock.now(),
          () => {},
        ),
      code("capacity_exceeded"),
    );
    assert.throws(
      () =>
        new RunCatalog({ ...h.engine.limits, queryPageBytes: 1 }).read(
          {},
          {},
          caller,
          facts,
          h.clock.now(),
          () => {},
        ),
      code("payload_too_large"),
    );
    assert.throws(
      () =>
        new RunCatalog({ ...h.engine.limits, maxQueryBytes: 1 }).read(
          {},
          {},
          caller,
          facts,
          h.clock.now(),
          () => {},
        ),
      code("capacity_exceeded"),
    );
    h.clock.advance(21);
    assert.throws(
      () => h.engine.listRuns({}, { cursor: next(first) }, caller),
      code("query_expired"),
    );
  } finally {
    await h.close();
  }
});
