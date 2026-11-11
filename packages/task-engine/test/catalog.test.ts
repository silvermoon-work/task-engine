import assert from "node:assert/strict";
import test from "node:test";
import {
  at,
  restoreTaskUpdates,
  type Store,
  TaskError,
  type TaskPage,
} from "@silvermoon-work/task-protocol";
import { TaskCatalog } from "../src/catalog.js";
import { newId } from "../src/index.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";
import { caller, harness } from "./fixtures.js";

function code(expected: string) {
  return (error: unknown) => error instanceof TaskError && error.code === expected;
}
function continuation(page: TaskPage): string {
  const cursor = page.next;
  assert.ok(cursor);
  return cursor;
}

test("directory covers callers/types with independent half-open normalized time ranges", async () => {
  const h = await harness({ authorize: () => true });
  try {
    const first = h.submit();
    h.clock.setTime(h.clock.now() + 1_000);
    const second = h.engine.submit(
      { requestId: newId(h.clock.now()), type: "sum", timeoutMs: 100, values: [1, 2] },
      { scope: caller.scope, subject: "another-client" },
    );
    h.engine.submit(
      { requestId: newId(h.clock.now()), type: "echo", timeoutMs: 100, text: "hidden" },
      { scope: "other", subject: caller.subject },
    );
    const all = h.engine.listTasks({}, {}, caller);
    assert.deepEqual(
      all.tasks.map((task) => task.taskId),
      [second.taskId, first.taskId],
    );
    assert.equal(all.tasks[0]?.version, "1");
    assert.equal(all.tasks[0]?.updatedAt, second.receivedAt);
    for (const item of all.tasks)
      assert.deepEqual(Object.keys(item).sort(), [
        "canceled",
        "deadlineAt",
        "eligibleAt",
        "receivedAt",
        "requestId",
        "scope",
        "seriesId",
        "stage",
        "state",
        "taskId",
        "type",
        "updatedAt",
        "version",
      ]);
    assert.deepEqual(
      h.engine
        .listTasks(
          {
            type: "echo",
            createdFrom: first.receivedAt,
            createdBefore: second.receivedAt,
            updatedFrom: first.receivedAt,
            updatedBefore: second.receivedAt,
          },
          {},
          caller,
        )
        .tasks.map((task) => task.taskId),
      [first.taskId],
    );
    const offset = first.receivedAt.replace("Z", "+00:00");
    assert.equal(h.engine.listTasks({ createdFrom: offset }, {}, caller).tasks.length, 2);
    const east = at(Date.parse(first.receivedAt) + 8 * 60 * 60 * 1_000).replace("Z", "+08:00");
    assert.equal(h.engine.listTasks({ createdFrom: east }, {}, caller).tasks.length, 2);
    assert.equal(h.engine.listTasks({ type: "absent" }, {}, caller).tasks.length, 0);
    assert.equal(
      h.engine.listTasks({ updatedFrom: second.receivedAt }, {}, caller).tasks.length,
      1,
    );
    assert.equal(h.engine.getRequest(second.requestId, caller).type, "sum");
    const before = h.store.read().facts;
    h.clock.setTime(h.clock.now() + 100_000);
    h.engine.getTask(first.taskId, caller);
    const timedOut = h.engine.listTasks({}, {}, caller);
    assert.equal(timedOut.tasks[0]?.state.timedOut, true);
    assert.deepEqual(h.store.read().facts, before, "reads/time passage do not write facts");
  } finally {
    await h.close();
  }
});

test("same-time task IDs sort deterministically; last accepted updates can move backwards", async () => {
  const h = await harness();
  try {
    const one = h.submit();
    const two = h.submit();
    assert.deepEqual(
      h.engine.listTasks({}, {}, caller).tasks.map((task) => task.taskId),
      [one.taskId, two.taskId].sort(),
    );
    h.clock.setTime(h.clock.now() - 10);
    h.engine.cancelTask(one.taskId, caller);
    const items = h.engine.listTasks({ sort: "updated-desc" }, {}, caller).tasks;
    assert.equal(items[0]?.taskId, two.taskId);
    assert.equal(items[1]?.updatedAt, at(h.clock.now()));
    assert.equal(items[1]?.receivedAt, one.receivedAt);
    assert.equal(items[1]?.state.canceled, true);
  } finally {
    await h.close();
  }
});

test("shared progress updates only the Run; canceled Tasks still observe later terminal facts", async () => {
  const h = await harness();
  try {
    const one = h.submit();
    const two = h.submit();
    await h.turn();
    assert.equal(h.work.length, 1);
    const matchedAt = h.engine.getTask(two.taskId, caller).updatedAt;
    h.clock.setTime(h.clock.now() + 10);
    h.work[0]?.permit.progress({ stage: "execution", percent: 1, message: "" });
    const updates = h.engine.listTasks({}, {}, caller).tasks;
    assert.ok(updates.every((task) => task.updatedAt === matchedAt));
    assert.equal(h.engine.getRun(h.work[0]!.permit.runId, caller).updatedAt, at(h.clock.now()));
    assert.ok(updates.every((task) => task.state.stage === "running"));
    h.clock.setTime(h.clock.now() + 10);
    h.engine.cancelTask(one.taskId, caller);
    const canceledAt = at(h.clock.now());
    h.clock.setTime(h.clock.now() + 10);
    h.work[0]?.permit.progress({ stage: "execution", percent: 2, message: "" });
    const after = h.engine.listTasks({ sort: "updated-desc" }, {}, caller);
    assert.equal(after.tasks[0]?.taskId, one.taskId);
    assert.equal(after.tasks[0]?.updatedAt, canceledAt);
    assert.equal(after.tasks[1]?.updatedAt, matchedAt);
    assert.equal(JSON.stringify(after).includes("percent"), false);
    await h.finish();
    h.engine.tick();
    assert.equal(
      h.engine.listTasks({}, {}, caller).tasks.find((task) => task.taskId === one.taskId)
        ?.updatedAt,
      at(h.clock.now()),
    );
    const broken = h.store.read().facts;
    const runId = h.work[0]?.permit.runId;
    assert.ok(runId);
    const run = broken.runs[runId];
    assert.ok(run);
    delete run.output;
    assert.throws(
      () => new TaskCatalog(h.engine.limits).read({}, {}, caller, broken, h.clock.now(), () => {}),
      code("history_gap"),
      "omitting result payload must not skip the normal missing-result invariant",
    );
  } finally {
    await h.close();
  }
});

test("query freezes membership/order/summaries across writes and supports cursor replay", async () => {
  const h = await harness({ limits: { pageSize: 1 } });
  try {
    const one = h.submit();
    h.clock.setTime(h.clock.now() + 10);
    const two = h.submit();
    const initial = h.engine.listTasks({ sort: "updated-desc" }, {}, caller);
    assert.equal(initial.tasks[0]?.taskId, two.taskId);
    assert.ok(initial.next);
    h.clock.setTime(h.clock.now() + 10);
    h.engine.cancelTask(one.taskId, caller);
    const three = h.submit();
    const next = h.engine.listTasks({ sort: "updated-desc" }, { cursor: initial.next }, caller);
    assert.equal(next.tasks[0]?.taskId, one.taskId);
    assert.equal(next.tasks[0]?.updatedAt, one.receivedAt);
    assert.equal(next.tasks[0]?.state.canceled, false);
    assert.equal(next.next, undefined);
    assert.deepEqual(
      h.engine.listTasks({ sort: "updated-desc" }, { cursor: initial.next }, caller),
      next,
    );
    const refreshed = h.engine.listTasks({}, {}, caller);
    assert.equal(refreshed.tasks[0]?.taskId, three.taskId);
    next.tasks[0]!.state.stage = "completed";
    assert.equal(
      h.engine.listTasks({ sort: "updated-desc" }, { cursor: initial.next }, caller).tasks[0]?.state
        .stage,
      "initial",
      "consumers cannot mutate the cached snapshot",
    );
  } finally {
    await h.close();
  }
});

test("qualified terminates-policy demand ignores progress; failed and not-yet-run Tasks remain discoverable", async () => {
  const h = await harness();
  try {
    const owner = h.submit();
    await h.turn();
    const waiting = h.submit({ matchPolicy: "terminates-after-eligible" });
    h.clock.setTime(h.clock.now() + 10);
    h.work[0]?.permit.progress({ stage: "execution", percent: 10, message: "" });
    assert.equal(
      h.engine.listTasks({}, {}, caller).tasks.find((task) => task.taskId === waiting.taskId)
        ?.updatedAt,
      waiting.receivedAt,
    );
    h.work[0]!.done.reject(new TaskError("test_failure", "private details"));
    h.work[0]!.exit.resolve();
    await h.engine.waitForTaskRelease(owner.taskId, caller);
    const listed = h.engine.listTasks({}, {}, caller);
    assert.ok(listed.tasks.every((task) => task.state.runFailed));
    assert.ok(listed.tasks.every((task) => task.updatedAt === at(h.clock.now())));
    assert.equal(JSON.stringify(listed).includes("private details"), false);
  } finally {
    await h.close();
  }
  const failing = await harness({
    prepare: async () => {
      throw new Error("cannot prepare");
    },
  });
  try {
    const task = failing.submit();
    assert.equal(failing.engine.listTasks({}, {}, caller).tasks[0]?.state.stage, "initial");
    await failing.turn();
    const listed = failing.engine.listTasks({}, {}, caller).tasks[0];
    assert.equal(listed?.taskId, task.taskId);
    assert.equal(listed?.state.stage, "failed");
  } finally {
    await failing.close();
  }
});

test("directory permissions stay separate from original-request permission and are reevaluated", async () => {
  let allowed = true;
  let submitAllowed = true;
  const h = await harness({
    authorize: (_who, operation) =>
      operation !== "request" &&
      (operation !== "list" || allowed) &&
      (operation !== "submit" || submitAllowed),
    limits: { pageSize: 1 },
  });
  try {
    const task = h.submit();
    h.submit();
    const first = h.engine.listTasks({}, {}, caller);
    assert.ok(first.next);
    assert.equal(h.engine.discoverTypes(caller).length, 2);
    submitAllowed = false;
    assert.throws(() => h.engine.discoverTypes(caller), code("forbidden"));
    assert.equal(h.engine.listTasks({}, {}, caller).tasks.length, 1);
    submitAllowed = true;
    assert.throws(() => h.engine.getRequest(task.requestId, caller), code("forbidden"));
    assert.throws(
      () =>
        h.engine.listTasks({}, { cursor: continuation(first) }, { ...caller, subject: "other" }),
      code("invalid_cursor"),
    );
    assert.throws(
      () => h.engine.listTasks({}, { cursor: continuation(first) }, { ...caller, scope: "other" }),
      code("invalid_cursor"),
    );
    allowed = false;
    assert.equal(h.engine.discoverTypes(caller).length, 2);
    assert.throws(
      () => h.engine.listTasks({}, { cursor: continuation(first) }, caller),
      code("forbidden"),
    );
    assert.throws(() => h.engine.listTasks({}, {}, caller), code("forbidden"));
  } finally {
    await h.close();
  }
});

test("catalog keeps historical schema binding while redo uses the current discovered contract", async () => {
  const h = await harness();
  try {
    const original = h.submit({ eligibleAt: at(h.clock.now() + 10_000) });
    const raw = h.engine.getRequest(original.requestId, caller);
    await h.engine.close();
    const latest = createTaskEngine({
      store: h.store,
      clock: h.clock,
      types: [h.type, { ...h.type, version: "2" }],
      currentVersions: { echo: "2" },
      authorize: () => true,
    });
    try {
      await latest.start();
      assert.equal(latest.discoverTypes(caller)[0]?.version, "2");
      assert.equal(latest.listTasks({}, {}, caller).tasks[0]?.version, "1");
      assert.deepEqual(latest.getRequest(original.requestId, caller), raw);
      assert.equal(raw.version, undefined);
      assert.equal(raw.expectedRevision, undefined);
      const redo = latest.submit({ ...raw, requestId: newId(h.clock.now()) }, caller);
      assert.equal(
        latest.listTasks({}, {}, caller).tasks.find((task) => task.taskId === redo.taskId)?.version,
        "2",
      );
      assert.equal(
        latest.listTasks({}, {}, caller).tasks.find((task) => task.taskId === original.taskId)
          ?.version,
        "1",
      );
    } finally {
      await latest.close();
    }
    const legacy: Store = {
      claim: (owner) => h.store.claim(owner),
      release: (owner) => h.store.release(owner),
      append: (...args) => h.store.append(...args),
      compact: (...args) => h.store.compact(...args),
      close: () => h.store.close(),
      read() {
        const view = h.store.read();
        for (const task of Object.values(view.facts.tasks)) {
          assert.equal("updatedAt" in task, false);
          Reflect.deleteProperty(task.binding, "contractRevision");
        }
        return view;
      },
    };
    const missingIdentity = createTaskEngine({
      store: legacy,
      clock: h.clock,
      types: [h.type, { ...h.type, version: "2" }],
      currentVersions: { echo: "2" },
      authorize: () => true,
    });
    await assert.rejects(
      missingIdentity.start(),
      code("unsupported_contract"),
      "timestamp recovery must never invent a missing schema contract identity",
    );
  } finally {
    await h.close();
  }
});

test("invalid inputs, cursor domains, expiry, tampering and restart fail explicitly", async () => {
  const h = await harness({ limits: { pageSize: 1, queryLifetimeMs: 100 } });
  try {
    const task = h.submit();
    h.submit();
    for (const query of [
      { createdFrom: "2026-10-01" },
      { updatedFrom: "2026-02-30T00:00:00Z" },
      { createdFrom: "2026-01-01T00:00:00" },
      { sort: "oldest" },
      { createdFrom: task.receivedAt, createdBefore: task.receivedAt },
      { createdFrom: "2026-01-01T24:00:00Z" },
      { type: "" },
    ])
      assert.throws(() => h.engine.listTasks(query as never, {}, caller), code("invalid_request"));
    assert.deepEqual(h.engine.listTasks({ scope: "other" }, {}, caller).tasks, []);
    for (const limit of [0, -1, 0.1, 1001])
      assert.throws(() => h.engine.listTasks({}, { limit }, caller), code("invalid_request"));
    assert.throws(() => h.engine.listTasks({}, { limit: NaN }, caller), code("invalid_payload"));
    const first = h.engine.listTasks({}, {}, caller);
    assert.ok(first.next);
    assert.throws(
      () => h.engine.listTasks({ type: "echo" }, { cursor: continuation(first) }, caller),
      code("invalid_cursor"),
    );
    assert.throws(
      () => h.engine.listTasks({}, { cursor: continuation(first).replace(":1:", ":2:") }, caller),
      code("invalid_cursor"),
    );
    const history = h.engine.readHistory({ taskId: task.taskId }, {}, caller);
    assert.throws(
      () => h.engine.listTasks({}, { cursor: history.cursor }, caller),
      code("invalid_cursor"),
    );
    assert.throws(
      () => h.engine.readHistory({ taskId: task.taskId }, { cursor: continuation(first) }, caller),
      code("invalid_cursor"),
    );
    h.clock.setTime(h.clock.now() + 100);
    assert.throws(
      () => h.engine.listTasks({}, { cursor: continuation(first) }, caller),
      code("query_expired"),
    );
    const active = h.engine.listTasks({}, {}, caller);
    await h.engine.close();
    const restarted = createTaskEngine({
      store: h.store,
      clock: h.clock,
      types: [h.type],
      currentVersions: { echo: "1" },
      authorize: () => true,
    });
    try {
      await restarted.start();
      assert.throws(
        () => restarted.listTasks({}, { cursor: continuation(active) }, caller),
        code("query_expired"),
      );
      assert.equal(restarted.listTasks({}, {}, caller).tasks.length, 2);
      assert.ok(
        restarted
          .listTasks({}, {}, caller)
          .tasks.every((item) => item.updatedAt === task.receivedAt),
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await h.close();
  }
});

test("monotonic query lifetime still expires after wall-clock rollback", async (t) => {
  let monotonic = 100;
  t.mock.method(performance, "now", () => monotonic);
  const h = await harness({ limits: { pageSize: 1, queryLifetimeMs: 100 } });
  try {
    h.submit();
    h.submit();
    const page = h.engine.listTasks({}, {}, caller);
    h.clock.setTime(h.clock.now() - 10_000);
    monotonic += 100;
    assert.throws(
      () => h.engine.listTasks({}, { cursor: continuation(page) }, caller),
      code("query_expired"),
    );
  } finally {
    await h.close();
  }
});

test("removed members invalidate the whole view, even members already delivered", async () => {
  const h = await harness({ limits: { pageSize: 1 } });
  try {
    h.submit();
    h.submit();
    const facts = h.store.read().facts;
    const catalog = new TaskCatalog(h.engine.limits);
    const first = catalog.read({}, {}, caller, facts, h.clock.now(), () => {});
    assert.ok(first.next);
    const removed = first.tasks[0]?.taskId;
    assert.ok(removed);
    delete facts.tasks[removed];
    assert.throws(
      () =>
        catalog.read({}, { cursor: continuation(first) }, caller, facts, h.clock.now(), () => {}),
      code("query_expired"),
    );
  } finally {
    await h.close();
  }
});

test("explicit collection invalidates pages and memory restart recovers after compaction", async () => {
  const h = await harness({ limits: { pageSize: 1, retentionMs: 1 } });
  try {
    const one = h.submit();
    const two = h.submit();
    const page = h.engine.listTasks({}, {}, caller);
    assert.ok(page.next);
    h.engine.cancelTask(one.taskId, caller);
    h.engine.cancelTask(two.taskId, caller);
    h.clock.setTime(h.clock.now() + 10);
    h.engine.collect();
    assert.equal(h.store.read().events.length, 0);
    assert.throws(
      () => h.engine.listTasks({}, { cursor: continuation(page) }, caller),
      code("query_expired"),
    );
    assert.deepEqual(h.engine.listTasks({}, {}, caller).tasks, []);
    const fresh = h.submit();
    await h.engine.close();
    const restart = createTaskEngine({
      store: h.store,
      clock: h.clock,
      types: [h.type],
      currentVersions: { echo: "1" },
      authorize: () => true,
    });
    try {
      await restart.start();
      assert.equal(restart.listTasks({}, {}, caller).tasks[0]?.updatedAt, fresh.receivedAt);
    } finally {
      await restart.close();
    }
  } finally {
    await h.close();
  }
});

test("bounded 5000-record scan preserves all membership without a derived index", async () => {
  const h = await harness({ limits: { queryPageBytes: 200_000 } });
  try {
    const original = h.submit();
    const facts = h.store.read().facts;
    const template = facts.tasks[original.taskId];
    assert.ok(template);
    for (let index = 1; index < 5_000; index++) {
      const taskId = newId(h.clock.now());
      facts.tasks[taskId] = {
        ...structuredClone(template),
        taskId,
        seriesId: taskId,
        request: { ...template.request, requestId: taskId },
      };
    }
    const catalog = new TaskCatalog(h.engine.limits);
    let checks = 0;
    const authorize = () => {
      checks++;
    };
    const page = catalog.read({}, {}, caller, facts, h.clock.now(), authorize);
    assert.equal(page.tasks.length, 100);
    assert.ok(page.next);
    assert.equal(checks, 10_000, "one candidate scan and one full membership authorization pass");
    const next = catalog.read({}, { cursor: page.next }, caller, facts, h.clock.now(), authorize);
    assert.equal(next.tasks.length, 100);
    assert.equal(checks, 15_000, "continuation validates bounded cached membership only");
  } finally {
    await h.close();
  }
});

test("scan, total memory, view count and full wire page bytes are bounded without truncation", async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 4; index++) h.submit();
    const facts = h.store.read().facts;
    const read = (catalog: TaskCatalog, cursor?: string): TaskPage =>
      catalog.read({}, cursor ? { cursor } : {}, caller, facts, h.clock.now(), () => {});
    assert.throws(
      () => read(new TaskCatalog({ ...h.engine.limits, queryScanLimit: 3 })),
      code("capacity_exceeded"),
    );
    assert.throws(
      () => read(new TaskCatalog({ ...h.engine.limits, maxQueryBytes: 500 })),
      code("capacity_exceeded"),
    );
    const sharedBudget = new TaskCatalog({
      ...h.engine.limits,
      pageSize: 1,
      maxQueryBytes: 8_000,
    });
    const retained = read(sharedBudget);
    assert.ok(retained.next);
    assert.throws(() => read(sharedBudget), code("capacity_exceeded"));
    assert.ok(
      read(sharedBudget, retained.next).tasks.length,
      "pressure never evicts an active view",
    );
    assert.throws(
      () => read(new TaskCatalog({ ...h.engine.limits, queryPageBytes: 100 })),
      code("payload_too_large"),
    );
    const bounded = new TaskCatalog({ ...h.engine.limits, queryPageBytes: 1300 });
    let page = read(bounded);
    const found = [...page.tasks];
    assert.ok(page.next);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1300);
    while (page.next) {
      page = read(bounded, page.next);
      found.push(...page.tasks);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1300);
    }
    assert.equal(new Set(found.map((item) => item.taskId)).size, 4);
    const oneView = new TaskCatalog({ ...h.engine.limits, pageSize: 1, maxQueryViews: 1 });
    const initial = read(oneView);
    assert.throws(() => read(oneView), code("capacity_exceeded"));
    assert.ok(read(oneView, initial.next).tasks.length);
    h.clock.setTime(h.clock.now() + h.engine.limits.queryLifetimeMs);
    assert.ok(read(oneView).tasks.length, "expired contexts free capacity");
  } finally {
    await h.close();
  }
});

test("v4 updates derive from source facts without Task metadata; old checkpoint versions are rejected", async () => {
  const h = await harness();
  try {
    const task = h.submit();
    await h.turn();
    const taskUpdatedAt = h.engine.getTask(task.taskId, caller).updatedAt;
    h.clock.setTime(h.clock.now() + 10);
    h.work[0]?.permit.progress({ stage: "execution", percent: 1, message: "" });
    h.clock.setTime(h.clock.now() - 20);
    h.work[0]?.permit.progress({ stage: "execution", percent: 2, message: "" });
    const view = h.store.read();
    const recovered = restoreTaskUpdates(view);
    assert.deepEqual(recovered, view);
    assert.equal("updatedAt" in recovered.facts.tasks[task.taskId]!, false);
    assert.equal(h.engine.getTask(task.taskId, caller).updatedAt, taskUpdatedAt);
    assert.equal(recovered.facts.runs[h.work[0]!.permit.runId]!.updatedAt, at(h.clock.now()));
    const broken = structuredClone(view);
    Reflect.set(broken.facts, "projectionVersion", 2);
    assert.throws(() => restoreTaskUpdates(broken), code("unsupported_version"));
    assert.throws(() => h.store.compact("not-owner", view.facts.watermark), code("store_owned"));
  } finally {
    await h.close();
  }
});
