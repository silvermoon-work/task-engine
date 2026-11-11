import assert from "node:assert/strict";
import test from "node:test";
import {
  at,
  canonical,
  isCanceled,
  isCompleted,
  isPending,
  isRunFailed,
  isTimedOut,
  type JsonObject,
  json,
  reduce,
} from "@silvermoon-work/task-protocol";
import { newId } from "../src/index.js";
import { MemoryStore, VirtualClock } from "../src/testing.js";
import type { LifecycleFixture } from "./driver.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";
import { caller, deferred, echoEquals, flush, harness, validateEcho } from "./fixtures.js";

test("initial is fact-based; identity prepare, two generic types and independent time dimensions", async () => {
  const h = await harness();
  try {
    const task = h.submit({ eligibleAt: at(h.clock.now() + 20) });
    assert.equal(task.stage, "initial");
    assert.ok(isPending(task));
    h.clock.setTime(h.clock.now() + 20);
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "initial");
    assert.equal(isPending(h.engine.getTask(task.taskId, caller)), false);
    await h.turn();
    assert.equal(h.prepares(), 1);
    assert.equal(h.work.length, 1);
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "running");
    await h.finish();
    h.engine.tick();
    h.clock.advance(1000);
    const finished = h.engine.getTask(task.taskId, caller);
    assert.ok(isCompleted(finished));
    assert.equal(isTimedOut(finished), true);
    assert.deepEqual(finished.output?.result, { text: "hello" });
    for (const key of ["type", "request", "state", "progress", "matchPolicy"])
      assert.equal(key in finished, false);
    assert.equal(typeof finished.revision, "string");
    assert.throws(() => h.submit({ type: "sum", text: undefined } as never), {
      code: "invalid_payload",
    });
    const sum = h.engine.submit(
      { requestId: newId(h.clock.now()), type: "sum", values: [2, 3], timeoutMs: 100 },
      caller,
    );
    await h.turn();
    assert.equal(h.work.at(-1)?.input.text, "5");
    await h.finish(1, { sum: 5 });
    h.engine.tick();
    assert.deepEqual(h.engine.getTask(sum.taskId, caller).output?.result, { sum: 5 });
  } finally {
    await h.close();
  }
});

test("admission validates full intent, strict JSON, original omissions, authorization and equals", async () => {
  const h = await harness();
  try {
    const task = h.submit();
    const raw = h.engine.getRequest(task.requestId, caller);
    assert.equal("eligibleAt" in raw, false);
    assert.equal("matchPolicy" in raw, false);
    assert.equal(h.engine.submit(raw, caller).taskId, task.taskId);
    for (const patch of [
      { type: "sum", values: [1] },
      { matchPolicy: "terminated-after-eligible" },
      { timeoutMs: 101 },
    ])
      assert.throws(() => h.engine.submit({ ...raw, ...patch }, caller), {
        code: "idempotency_conflict",
      });
    for (const patch of [
      { prerequisites: [] },
      { recurrence: { periodMs: 2 } },
      { timeoutMs: 0 },
      { timeoutMs: Infinity },
      { type: "unknown" },
    ])
      assert.throws(() => h.submit(patch));
    assert.throws(() => h.engine.getTask(task.taskId, { scope: "b", subject: "tester" }), {
      code: "forbidden",
    });
    assert.throws(
      () => h.engine.submit({ ...raw, requestId: newId() }, { scope: "a", subject: "attacker" }),
      { code: "forbidden" },
    );
    assert.equal(h.work.length, 0);
    const a = Object.freeze({ text: "a" });
    assert.equal(echoEquals(a, 2), false);
    assert.equal(echoEquals(a, a), true);
    assert.equal(echoEquals(a, { text: "a" }), echoEquals({ text: "a" }, a));
    assert.equal(echoEquals(a, { text: "b" }), false);
    assert.equal(canonical(validateEcho(a)), canonical(a));
  } finally {
    await h.close();
  }
});

test("sharing uses input, scope and eligibility; cancellation does not freeze shared Run facts", async () => {
  const h = await harness();
  try {
    const a = h.submit();
    const b = h.submit();
    await h.turn();
    assert.equal(h.work.length, 1);
    assert.equal(
      h.engine.getTask(a.taskId, caller).run?.runId,
      h.engine.getTask(b.taskId, caller).run?.runId,
    );
    const frozen = h.engine.cancelTask(a.taskId, caller);
    assert.equal(frozen.stage, "running");
    assert.equal(h.work[0]?.stops.length, 0);
    await h.finish();
    h.engine.tick();
    const after = h.engine.getTask(a.taskId, caller);
    assert.ok(isCanceled(after));
    assert.equal(after.stage, "completed");
    assert.deepEqual(after.output?.result, { text: "hello" });
    assert.ok(after.run?.completedAt);
    assert.ok(isCompleted(h.engine.getTask(b.taskId, caller)));
    assert.equal(h.engine.cancelTask(a.taskId, caller).canceledAt, frozen.canceledAt);
    assert.equal(h.engine.cancelTask(b.taskId, caller).changed, true);
    assert.equal(h.engine.cancelTask(b.taskId, caller).changed, false);
  } finally {
    await h.close();
  }
});

test("normal not-performed business results complete; business exceptions fail only run", async () => {
  const h = await harness();
  try {
    const a = h.submit();
    await h.turn();
    await h.finish(0, { performed: false, reason: "unavailable" });
    h.engine.tick();
    assert.equal(h.engine.getTask(a.taskId, caller).stage, "completed");
    await h.turn(5);
    assert.equal(h.work.length, 1, "no automatic readiness retry");
    const b = h.submit();
    await h.turn();
    h.work[1]?.done.reject(new Error("business preflight fault"));
    h.work[1]?.exit.resolve();
    await flush();
    h.engine.tick();
    assert.ok(isRunFailed(h.engine.getTask(b.taskId, caller)));
  } finally {
    await h.close();
  }
});

test("deadline equality, durable completion and terminal cancellation preserve independent current time", async () => {
  for (const lateness of [0, 1]) {
    const h = await harness();
    try {
      const task = h.submit();
      await h.turn();
      h.clock.advance(Date.parse(task.deadlineAt) - h.clock.now() + lateness);
      await h.finish();
      // No Task coordinator turn has processed completion.
      assert.equal(h.engine.cancelTask(task.taskId, caller).stage, "completed");
      assert.equal(isTimedOut(h.engine.getTask(task.taskId, caller)), lateness > 0);
      h.clock.advance(10000);
      const result = h.engine.getTask(task.taskId, caller);
      assert.ok(isCompleted(result));
      assert.equal(isTimedOut(result), true);
    } finally {
      await h.close();
    }
  }
});

test("expired preparation retracts and late preparation cannot launch business execution", async () => {
  const preparation = deferred<JsonObject>();
  let aborted = false;
  const h = await harness({
    prepare: async (_input, options) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return preparation.promise;
    },
  });
  try {
    const a = h.submit({ eligibleAt: at(h.clock.now() + 20) });
    assert.equal(h.engine.cancelTask(a.taskId, caller).stage, "initial");
    const b = h.submit();
    await h.turn();
    assert.equal(h.engine.getTask(b.taskId, caller).stage, "running");
    await h.turn(101);
    assert.equal(aborted, true);
    h.engine.cancelTask(b.taskId, caller);
    preparation.resolve({ text: "hello" });
    await flush();
    await h.turn();
    assert.equal(h.work.length, 0);
    assert.ok(isTimedOut(h.engine.getTask(b.taskId, caller)));
    const c = h.submit();
    await h.turn();
    assert.equal(h.engine.cancelTask(c.taskId, caller).stage, "running");
    await h.engine.waitForTaskRelease(c.taskId, caller);
    assert.equal(h.engine.getTask(c.taskId, caller).stage, "stopped");
  } finally {
    await h.close();
  }
});

test("expired running and queued demands both stop without starting queued business code", async () => {
  const h = await harness({ resources: ["js"] });
  try {
    const a = h.submit({ text: "occupy", timeoutMs: 10 });
    await h.turn();
    const b = h.submit({ text: "queued", timeoutMs: 10 });
    await h.turn();
    assert.equal(h.engine.getTask(b.taskId, caller).stage, "running");
    await h.turn(20);
    await Promise.all([a, b].map((task) => h.engine.waitForTaskRelease(task.taskId, caller)));
    assert.equal(h.work[0]?.stops.length, 1);
    assert.equal(h.pool.stats.queued, 0);
    assert.equal(h.work.length, 1);
    assert.equal(h.engine.getTask(a.taskId, caller).stage, "stopped");
    assert.ok(isTimedOut(h.engine.getTask(a.taskId, caller)));
    assert.equal(h.engine.getTask(b.taskId, caller).stage, "stopped");
  } finally {
    await h.close();
  }
});

test("terminates policy qualifies an active Run at a committed source boundary", async () => {
  const h = await harness();
  try {
    const a = h.submit({ eligibleAt: at(h.clock.now() - 10) });
    await h.turn();
    const b = h.submit({ matchPolicy: "terminates-after-eligible" });
    assert.equal(
      h.engine.getTask(b.taskId, caller).run?.runId,
      h.engine.getTask(a.taskId, caller).run?.runId,
    );
    await h.turn();
    assert.equal(h.work.length, 1);
    await h.finish();
    h.clock.advance(200);
    h.engine.tick();
    assert.ok(isCompleted(h.engine.getTask(b.taskId, caller)));
    assert.equal(isTimedOut(h.engine.getTask(b.taskId, caller)), true);
    assert.ok(isCompleted(h.engine.getTask(a.taskId, caller)));
  } finally {
    await h.close();
  }
});

test("prepared differences do not prevent input sharing, but scope still isolates", async () => {
  let version = 0;
  const h = await harness({ prepare: async (input) => ({ ...input, contentVersion: ++version }) });
  try {
    h.submit();
    h.submit();
    await h.turn();
    assert.equal(h.work.length, 1);
  } finally {
    await h.close();
  }
  const scoped = await harness();
  try {
    scoped.submit();
    scoped.engine.submit(
      { requestId: newId(scoped.clock.now()), type: "echo", text: "hello", timeoutMs: 100 },
      { ...caller, scope: "b" },
    );
    await scoped.turn();
    assert.equal(scoped.work.length, 2);
  } finally {
    await scoped.close();
  }
});

test("prepare validation fails before allocation; registered contracts are immutable", async () => {
  const h = await harness({ prepare: async () => ({ bad: Infinity }) });
  try {
    const task = h.submit();
    await h.turn();
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "failed");
    assert.equal(h.work.length, 0);
  } finally {
    await h.close();
  }
  const broken = await harness();
  try {
    broken.submit({ matchPolicy: "terminates-after-eligible" });
    await broken.turn();
    broken.type.inputSchema = { type: "object", properties: { other: { type: "number" } } };
    broken.submit({ matchPolicy: "terminates-after-eligible" });
    await broken.turn();
    assert.equal(broken.engine.errors.length, 0);
    assert.equal(broken.work.length, 1);
  } finally {
    await broken.close();
  }
});

test("eligible recurrence is rejected; external series can retain multiple independent pending Tasks", async () => {
  const h = await harness({ resources: ["js", "js", "js", "js"] });
  try {
    const start = h.clock.now();
    assert.throws(() => h.submit({ recurrence: { anchor: "eligible", periodMs: 10 } }), {
      code: "unsupported_request",
    });
    assert.equal(Object.keys(h.store.read().facts.tasks).length, 0);
    const seriesId = newId(start);
    const a = h.submit({ timeoutMs: 1000, eligibleAt: at(start + 30), seriesId });
    const b = h.submit({ timeoutMs: 1000, eligibleAt: at(start + 40), seriesId });
    assert.ok(isPending(a));
    assert.ok(isPending(b));
    assert.equal(h.engine.getTask(a.taskId, caller).canceled, false);
    await h.turn(25);
    assert.equal(h.work.length, 0);
    await h.turn(5);
    assert.equal(h.work.length, 1);
    assert.equal(h.engine.getTask(b.taskId, caller).stage, "initial");
    await h.turn(10);
    assert.equal(h.work.length, 2);
    assert.notEqual(
      h.engine.getTask(a.taskId, caller).run?.runId,
      h.engine.getTask(b.taskId, caller).run?.runId,
    );
    h.engine.cancelTask(a.taskId, caller);
    assert.equal(h.engine.getTask(b.taskId, caller).canceled, false);
    assert.equal(Object.values(h.store.read().facts.tasks).length, 2);
  } finally {
    await h.close();
  }
});

test("terminated recurrence is rejected and an external successor cannot be synthesized by completion", async () => {
  const h = await harness();
  try {
    const start = h.clock.now();
    assert.throws(
      () => h.submit({ timeoutMs: 10, recurrence: { anchor: "terminated", periodMs: 20 } }),
      { code: "unsupported_request" },
    );
    const a = h.submit();
    await h.turn();
    await h.finish();
    const b = h.submit({ seriesId: a.seriesId, eligibleAt: at(start + 70) });
    await h.turn(54);
    assert.equal(h.engine.getTask(a.taskId, caller).stage, "completed");
    assert.equal(h.engine.getTask(b.taskId, caller).stage, "initial");
    assert.equal(h.work.length, 1);
    await h.turn(15);
    await h.finish(1);
    h.engine.tick();
    assert.equal(Object.keys(h.store.read().facts.tasks).length, 2);
    assert.equal(h.engine.getTask(b.taskId, caller).stage, "completed");
    assert.equal("successor" in h.store.read().facts.tasks[a.taskId]!, false);
  } finally {
    await h.close();
  }
});

test("capacity backpressure preserves accepted facts and never creates implicit recurrence state", async () => {
  const h = await harness({ limits: { maxTasks: 1 } });
  try {
    const a = h.submit({ eligibleAt: at(h.clock.now() + 1000) });
    assert.throws(() => h.submit(), { code: "capacity_exceeded" });
    await h.turn();
    assert.equal("successor" in h.store.read().facts.tasks[a.taskId]!, false);
    h.engine.collect();
    assert.ok(h.store.read().facts.tasks[a.taskId]);
    h.engine.limits.maxTasks = 3;
    const b = h.submit({ seriesId: a.seriesId, eligibleAt: at(h.clock.now() + 1000) });
    await h.turn();
    assert.equal(h.engine.getTask(a.taskId, caller).canceled, false);
    assert.equal(h.engine.getTask(b.taskId, caller).canceled, false);
    assert.equal(Object.keys(h.store.read().facts.tasks).length, 2);
  } finally {
    await h.close();
  }
});

test("history fixed watermarks, repeatable stream resumes, pure checkpoint equivalence", async () => {
  const h = await harness();
  try {
    const task = h.submit();
    await h.turn();
    const filter = { runId: h.engine.getTask(task.taskId, caller).run!.runId };
    h.work[0]?.permit.progress({ stage: "execution", percent: 1, message: "" });
    const taskUpdatedAt = h.engine.getTask(task.taskId, caller).updatedAt;
    const page = h.engine.readHistory(filter, { limit: 2 }, caller);
    h.work[0]?.permit.progress({ stage: "execution", percent: 2, message: "" });
    assert.equal(h.engine.getTask(task.taskId, caller).updatedAt, taskUpdatedAt);
    assert.ok(page.next);
    const nextCursor = page.next;
    const second = h.engine.readHistory(filter, { cursor: page.next }, caller);
    assert.ok(second.events.every((event) => event.sequence <= page.watermark));
    const sub = h.engine.subscribe(filter, second.cursor, caller);
    assert.ok(sub.initial.events.some((event) => event.sequence > page.watermark));
    const repeat = h.engine.subscribe(filter, second.cursor, caller);
    assert.deepEqual(repeat.initial.events, sub.initial.events);
    assert.throws(
      () => h.engine.readHistory({ seriesId: task.seriesId }, { cursor: nextCursor }, caller),
      { code: "invalid_cursor" },
    );
    sub.close();
    repeat.close();
    await h.finish();
    h.engine.tick();
    const view = h.store.read();
    assert.deepEqual(reduce(view.prefix, view.events), view.facts);
    const half = Math.floor(view.events.length / 2);
    assert.deepEqual(
      reduce(reduce(view.prefix, view.events.slice(0, half)), view.events.slice(half)),
      view.facts,
    );
    assert.deepEqual(reduce(view.facts, view.events), view.facts);
  } finally {
    await h.close();
  }
});

test("version-bound history and idempotency never silently use current validators", async () => {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const old: LifecycleFixture<JsonObject> = {
    type: "echo",
    version: "1",
    environment: "one",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    prepare: async (input) => input,
    validatePrepared: validateEcho,
    validateResult: json,
    validateProgress: json,
    async execute() {
      throw new Error("must not start future task");
    },
  };
  const options = {
    store,
    clock,
    types: [old],
    currentVersions: { echo: "1" },
    authorize: () => true,
  };
  const engine = createTaskEngine(options);
  await engine.start();
  const raw = {
    requestId: newId(clock.now()),
    type: "echo",
    text: "old",
    timeoutMs: 100,
    eligibleAt: at(clock.now() + 100),
  };
  const task = engine.submit(raw, caller);
  await engine.close();
  const newer = {
    ...old,
    version: "2",
    inputSchema: {
      type: "object",
      properties: { different: { type: "number" } },
      required: ["different"],
    },
  };
  const restored = createTaskEngine({
    ...options,
    types: [old, newer],
    currentVersions: { echo: "2" },
  });
  await restored.start();
  assert.equal(restored.submit(raw, caller).taskId, task.taskId);
  assert.deepEqual(restored.getRequest(raw.requestId, caller), raw);
  await restored.close();
  const unsupported = createTaskEngine({
    ...options,
    types: [newer],
    currentVersions: { echo: "2" },
  });
  await assert.rejects(unsupported.start(), { code: "unsupported_version" });
  store.close();
});

test("invalid business result becomes explicit run failure, never a stranded running task", async () => {
  const h = await harness({
    validateResult() {
      throw new Error("result schema defect");
    },
  });
  try {
    const task = h.submit();
    await h.turn();
    await h.finish();
    h.engine.tick();
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "failed");
    assert.equal(h.engine.getTask(task.taskId, caller).error?.code, "invalid_payload");
  } finally {
    await h.close();
  }
});

test("terminates policy uses a proving source boundary without awaiting completion", async () => {
  const h = await harness();
  try {
    const owner = h.submit();
    await h.turn();
    const task = h.submit({ matchPolicy: "terminates-after-eligible" });
    h.engine.tick();
    await flush();
    h.engine.tick();
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "running");
    assert.equal(
      h.engine.getTask(task.taskId, caller).run?.runId,
      h.engine.getTask(owner.taskId, caller).run?.runId,
    );
    await h.finish();
    h.engine.tick();
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "completed");
    await h.turn();
    assert.equal(h.work.length, 1);
  } finally {
    await h.close();
  }
});

test("fixed history cannot retroactively acquire an older Run through a later qualification", async () => {
  const h = await harness();
  try {
    const owner = h.submit({ timeoutMs: 1000 });
    await h.turn();
    const task = h.submit({
      matchPolicy: "terminates-after-eligible",
      seriesId: owner.seriesId,
      eligibleAt: at(h.clock.now() + 10),
    });
    h.engine.tick();
    await flush();
    await h.turn();
    const filter = { seriesId: task.seriesId };
    const page = h.engine.readHistory(filter, { limit: 1 }, caller);
    assert.ok(page.next);
    await h.turn(10);
    assert.equal(
      h.engine.getTask(task.taskId, caller).run?.runId,
      h.engine.getTask(owner.taskId, caller).run?.runId,
    );
    const rest = h.engine.readHistory(filter, { cursor: page.next }, caller);
    assert.equal(rest.revision, page.revision);
    assert.equal(
      rest.events.some((event) => event.taskId === task.taskId && event.runId !== undefined),
      false,
    );
  } finally {
    await h.close();
  }
});
