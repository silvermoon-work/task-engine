import assert from "node:assert/strict";
import test from "node:test";
import { at, isTimedOut, type JsonObject, reduce, TaskError } from "@silvermoon-work/task-protocol";
import { MemoryStore } from "../src/testing.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";
import { caller, deferred, flush, harness } from "./fixtures.js";

for (const outcome of ["completed", "failed"] as const) {
  test(`source qualification shares unprepared demand and the exit projects every Task atomically: ${outcome}`, async () => {
    const waiting = deferred<JsonObject>();
    let prepares = 0;
    const h = await harness({
      prepare: async (input) => (++prepares === 1 ? input : waiting.promise),
    });
    try {
      const owner = h.submit();
      await h.turn();
      const follower = h.submit({ matchPolicy: "terminates-after-eligible" });
      assert.equal(follower.stage, "running");
      assert.equal(follower.run?.runId, h.engine.getTask(owner.taskId, caller).run?.runId);
      if (outcome === "completed") h.work[0]!.done.resolve({ text: "shared" });
      else h.work[0]!.done.reject(new TaskError("business", "Failed"));
      assert.equal(h.engine.getTask(follower.taskId, caller).stage, "running");
      assert.equal(
        h.store.read().events.some((event) => event.type === "run.outcome"),
        false,
      );
      h.work[0]!.exit.resolve();
      await h.engine.waitForTaskRelease(owner.taskId, caller);
      const final = h.engine.getTask(follower.taskId, caller);
      assert.equal(final.stage, outcome);
      assert.equal(final.run?.runId, h.engine.getTask(owner.taskId, caller).run?.runId);
      const view = h.store.read();
      const terminal = view.events.find((event) => event.type === "run.exited")!;
      assert.deepEqual(
        view.events.filter((event) => event.taskId === follower.taskId).map((event) => event.type),
        ["task.created"],
      );
      for (const task of [owner, follower]) {
        const history = h.engine.getTaskHistory(task.taskId, {}, caller);
        assert.equal(history.events.at(-1)?.sequence, terminal.sequence);
        assert.equal(history.events.at(-1)?.occurredAt, terminal.occurredAt);
      }
      assert.deepEqual(reduce(view.prefix, view.events), view.facts);
      waiting.resolve({ text: "late" });
      await flush();
      assert.deepEqual(h.engine.getTask(follower.taskId, caller), final);
      assert.equal(h.work.length, 1);
      assert.equal(prepares, 1);
      assert.equal(h.engine.cancelTask(follower.taskId, caller).stage, outcome);
      h.clock.setTime(h.clock.now() + 1);
      const later = h.submit({ matchPolicy: "terminates-after-eligible" });
      assert.ok(later.receivedAt > terminal.occurredAt);
      assert.equal(later.run, undefined);
    } finally {
      waiting.resolve({ text: "late" });
      await h.close();
    }
  });
}

test("start qualifies equivalent same-time receipts inclusively; later eligibility needs a new Run", async () => {
  const firstPrepare = deferred<JsonObject>(),
    secondPrepare = deferred<JsonObject>();
  let prepares = 0;
  const h = await harness({
    prepare: () => (++prepares === 1 ? firstPrepare.promise : secondPrepare.promise),
  });
  const waitForWork = async (count: number) => {
    const end = performance.now() + 5000;
    while (h.work.length < count) {
      if (performance.now() > end) assert.fail("Worker did not reach fixture execution in time.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    const first = h.submit(),
      second = h.submit();
    h.engine.tick();
    await flush();
    firstPrepare.resolve({ text: "prepared-a" });
    await flush();
    h.engine.tick();
    await waitForWork(1);
    assert.equal(h.work.length, 1);
    const a = h.engine.getTask(first.taskId, caller);
    assert.equal(a.run?.startedAt, a.eligibleAt);
    assert.equal(h.engine.getTask(second.taskId, caller).run?.runId, a.run?.runId);
    const equal = h.submit();
    assert.equal(equal.receivedAt, a.run?.startedAt);
    assert.equal(equal.run?.runId, a.run?.runId);
    h.clock.setTime(h.clock.now() + 1);
    const later = h.submit();
    assert.equal(later.run, undefined);
    secondPrepare.resolve({ text: "prepared-b" });
    await h.turn(0);
    await waitForWork(2);
    assert.notEqual(h.engine.getTask(later.taskId, caller).run?.runId, a.run?.runId);
    assert.equal(h.work.length, 2);
  } finally {
    firstPrepare.resolve({ text: "hello" });
    secondPrepare.resolve({ text: "hello" });
    await h.close();
  }
});

test("requested eligibility is preserved while effective anchors clamp once", async () => {
  const h = await harness();
  try {
    const requested = at(h.clock.now() - 1000);
    const task = h.submit({ eligibleAt: requested, timeoutMs: 20 });
    const raw = h.engine.getRequest(task.requestId, caller);
    assert.equal(raw.eligibleAt, requested);
    assert.equal(task.eligibleAt, task.receivedAt);
    assert.equal(Date.parse(task.deadlineAt), Date.parse(task.receivedAt) + 20);
    h.clock.advance(100);
    const retried = h.engine.submit(raw, caller);
    assert.equal(retried.taskId, task.taskId);
    assert.equal(retried.eligibleAt, task.eligibleAt);
    assert.equal(retried.deadlineAt, task.deadlineAt);
    const future = h.submit({ eligibleAt: at(h.clock.now() + 100) });
    assert.equal(Date.parse(future.eligibleAt), h.clock.now() + 100);
    assert.throws(() => h.submit({ matchPolicy: "completed-after-eligible" }), {
      code: "unsupported_request",
    });
  } finally {
    await h.close();
  }
});

test("qualified terminates demand protects shared work; cancellation does not freeze its peer", async () => {
  const h = await harness();
  try {
    const first = h.submit({ timeoutMs: 5 });
    await h.turn();
    const demand = h.submit({ matchPolicy: "terminates-after-eligible", timeoutMs: 100 });
    h.engine.cancelTask(first.taskId, caller);
    assert.equal(demand.run?.runId, h.engine.getTask(first.taskId, caller).run?.runId);
    assert.equal(h.work[0]!.stops.length, 0);
    await h.finish();
    assert.equal(h.engine.getTask(demand.taskId, caller).stage, "completed");
    assert.equal(h.engine.getTask(first.taskId, caller).stage, "completed");
    assert.ok(h.engine.getTask(first.taskId, caller).canceledAt);
  } finally {
    await h.close();
  }
});

for (const outcome of ["completed", "failed"] as const) {
  test(`a matched timed-out demand observes shared ${outcome} without scheduling work`, async () => {
    const h = await harness();
    try {
      const owner = h.submit({ timeoutMs: 1000 });
      await h.turn();
      const task = h.submit({ matchPolicy: "terminates-after-eligible", timeoutMs: 2 });
      await h.turn(3);
      assert.equal(h.work.length, 1);
      assert.equal(
        h.engine.getTask(task.taskId, caller).run?.runId,
        h.engine.getTask(owner.taskId, caller).run?.runId,
      );
      assert.ok(isTimedOut(h.engine.getTask(task.taskId, caller)));
      if (outcome === "completed") h.work[0]!.done.resolve({ text: "late" });
      else h.work[0]!.done.reject(new TaskError("late", "Late failure"));
      h.work[0]!.exit.resolve();
      await h.engine.waitForTaskRelease(owner.taskId, caller);
      const result = h.engine.getTask(task.taskId, caller);
      assert.equal(result.stage, outcome);
      assert.ok(isTimedOut(result));
    } finally {
      await h.close();
    }
  });
}

test("服务授权拒绝异步授予；类型不再具有逐需求授权 hook", async () => {
  let denied = false;
  const h = await harness({ authorize: () => !denied });
  try {
    h.type.authorize = async () => {};
    h.submit();
    await h.turn();
    const task = h.submit({ matchPolicy: "terminates-after-eligible" });
    denied = true;
    assert.throws(() => h.submit(), { code: "forbidden" });
    denied = false;
    await h.finish();
    assert.ok(h.engine.getTask(task.taskId, caller).run);
    assert.equal(h.engine.errors.length, 0);
  } finally {
    await h.close();
  }
});

test("expired unmatched demand cannot borrow another Task's later start or schedule work", async () => {
  const h = await harness();
  try {
    const expired = h.submit({ timeoutMs: 1 });
    await h.turn(2);
    assert.equal(h.work.length, 0);
    const driver = h.submit();
    await h.turn();
    assert.equal(h.work.length, 1);
    assert.equal(h.engine.getTask(expired.taskId, caller).run, undefined);
    assert.ok(h.engine.getTask(driver.taskId, caller).run);
    await h.finish();
    assert.equal(h.engine.getTask(expired.taskId, caller).stage, "initial");
    assert.ok(isTimedOut(h.engine.getTask(expired.taskId, caller)));
  } finally {
    await h.close();
  }
});

test("last qualified cancellation stops the exact Run and retains its fact-derived reference", async () => {
  const h = await harness();
  try {
    const task = h.submit({ matchPolicy: "terminates-after-eligible" });
    await h.turn();
    const runId = h.work[0]!.permit.runId;
    assert.equal(h.engine.getTask(task.taskId, caller).run?.runId, runId);
    h.engine.cancelTask(task.taskId, caller);
    await h.engine.waitForTaskRelease(task.taskId, caller);
    assert.equal(h.work[0]!.stops.length, 1);
    assert.ok(h.engine.getTask(task.taskId, caller).canceledAt);
    assert.equal(h.engine.getTask(task.taskId, caller).run?.runId, runId);
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "stopped");
    assert.ok(h.store.read().facts.runs[runId]!.reclaimedAt);
  } finally {
    await h.close();
  }
});

test("stop entry excludes new arrivals even at the same inclusive wall-clock boundary", async () => {
  const h = await harness({ resources: ["js"] });
  try {
    const task = h.submit({ matchPolicy: "terminates-after-eligible" });
    await h.turn();
    const old = h.engine.getTask(task.taskId, caller).run!.runId;
    h.engine.cancelTask(task.taskId, caller);
    const later = h.submit({ matchPolicy: "terminates-after-eligible" });
    assert.equal(later.receivedAt, h.engine.getRun(old, caller).stopRequested?.occurredAt);
    assert.equal(later.run, undefined);
    await h.turn();
    const runId = h.engine.getTask(later.taskId, caller).run!.runId;
    assert.notEqual(runId, old);
    const view = h.store.read();
    assert.ok(
      view.facts.runs[runId]!.startedSequence > view.facts.runs[old]!.stopRequested!.sequence,
    );
    assert.equal("sealedTaskIds" in view.facts.runs[old]!, false);
    assert.deepEqual(reduce(view.prefix, view.events), view.facts);
  } finally {
    await h.close();
  }
});

test("injected legacy facts and historical rebinding are rejected", async () => {
  const legacy = new MemoryStore();
  const read = legacy.read.bind(legacy);
  legacy.read = () => ({ ...read(), facts: { ...read().facts, projectionVersion: 1 } }) as never;
  assert.throws(
    () =>
      createTaskEngine({ store: legacy, types: [], currentVersions: {}, authorize: () => true }),
    { code: "unsupported_version" },
  );
  legacy.close();
  const h = await harness();
  try {
    h.submit();
    await h.turn();
    await h.finish();
    const later = h.submit({ matchPolicy: "terminates-after-eligible" });
    const facts = h.store.read().facts,
      run = Object.values(facts.runs)[0]!;
    assert.throws(
      () =>
        reduce(facts, [
          {
            sequence: facts.watermark + 1,
            type: "task.run.bound",
            taskId: later.taskId,
            scope: caller.scope,
            occurredAt: run.completedAt!,
            data: { runId: run.runId },
          } as never,
        ]),
      { code: "invalid_fact" },
    );
    const bad = structuredClone(facts);
    bad.tasks[later.taskId]!.request.matchPolicy = "completed-after-eligible" as never;
    assert.throws(() => reduce(bad, []), { code: "unsupported_version" });
  } finally {
    await h.close();
  }
});

test("canceled demand derives its Run and unknown physical release across recovery without a reference cache", async () => {
  const h = await harness(),
    restoredStore = new MemoryStore();
  let restored: ReturnType<typeof createTaskEngine> | undefined;
  try {
    const task = h.submit({ matchPolicy: "terminates-after-eligible" });
    await h.turn();
    const runId = h.engine.getTask(task.taskId, caller).run!.runId;
    h.engine.cancelTask(task.taskId, caller);
    const view = h.store.read();
    assert.equal("releaseRunIds" in view.facts.tasks[task.taskId]!, false);
    restoredStore.claim("copy");
    restoredStore.append(
      "copy",
      0,
      view.events.map(({ sequence: _sequence, ...event }) => event),
    );
    restoredStore.release("copy");
    restored = createTaskEngine({
      store: restoredStore,
      types: [h.type],
      currentVersions: { echo: "1" },
      clock: h.clock,
      authorize: () => true,
    });
    await restored.start();
    assert.equal(restored.getTask(task.taskId, caller).run?.runId, runId);
    assert.equal(restored.getTask(task.taskId, caller).stage, "stopped");
    assert.equal(restored.getRun(runId, caller).exit?.basis, "recovery");
    await assert.rejects(restored.waitForTaskRelease(task.taskId, caller), {
      code: "reclamation_unconfirmed",
    });
  } finally {
    await restored?.close();
    restoredStore.close();
    await h.close();
  }
});
