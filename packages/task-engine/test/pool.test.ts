import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { at, type ExecuteOptions, type JsonObject, json } from "@silvermoon-work/task-protocol";
import { newId } from "../src/index.js";
import { createExecutorPool, type RunningWork } from "../src/pool.js";
import { MemoryStore, VirtualClock } from "../src/testing.js";
import type { LifecycleFixture } from "./driver.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";
import { caller, deferred, flush, harness, validateEcho } from "./fixtures.js";

function permitOptions(replaceRunId?: string, authorize = () => true) {
  const controller = new AbortController();
  const reports: unknown[] = [];
  const options: ExecuteOptions = {
    context: { type: "test", version: "1", environment: "test", scope: "test" },
    signal: controller.signal,
    ...(replaceRunId ? { replaceRunId } : {}),
    authorizeReplacement: authorize,
    start: () => ({
      runId: newId(),
      generation: newId(),
      startedAt: at(Date.now()),
      progress: (value) => reports.push(value),
      complete: (value) => reports.push(value),
      fail: (error) => reports.push(error),
    }),
  };
  return { options, controller, reports };
}
function controllable() {
  const result = deferred<unknown>();
  const exited = deferred<void>();
  let cleanup = 0;
  const work: RunningWork = {
    result: result.promise,
    exited: exited.promise,
    cooperate(reason) {
      result.reject(new Error(reason));
      exited.resolve();
    },
    async force() {
      assert.fail("cooperative work should not need force");
    },
    async cleanup() {
      cleanup++;
    },
  };
  return { work, result, exited, cleanup: () => cleanup };
}

for (const allowB of [true, false]) {
  test(`Pool preserves replacement wakeups during another reclaim (authorize B=${allowB})`, async () => {
    const cleanupA = deferred<void>();
    const cleaningA = deferred<void>();
    const starts: string[] = [];
    let authorizationsB = 0;
    const pool = createExecutorPool<string>({
      resources: ["a", "b"],
      resourceKey: (input) => input,
      run(input) {
        const firstA = input === "a" && !starts.includes("a");
        starts.push(input);
        const work = controllable();
        if (firstA)
          work.work.cleanup = async () => {
            cleaningA.resolve();
            await cleanupA.promise;
          };
        return work.work;
      },
    });
    const a = await pool.execute("a", permitOptions().options);
    const b = await pool.execute("b", permitOptions().options);
    const replacingA = pool.execute("a", permitOptions(a.runId).options);
    await cleaningA.promise;
    const replacingB = pool.execute(
      "b",
      permitOptions(b.runId, () => {
        authorizationsB++;
        return allowB;
      }).options,
    );
    void replacingB.catch(() => {});
    try {
      assert.equal(authorizationsB, 0);
      cleanupA.resolve();
      await replacingA;
      await flush();
      assert.equal(authorizationsB, 1, "new replacement must be reconsidered without an idle slot");
      if (allowB) {
        await replacingB;
        assert.deepEqual(starts, ["a", "b", "a", "b"]);
        assert.equal(pool.stats.queued, 0);
      } else {
        await flush();
        assert.equal(authorizationsB, 1, "denied work must not hot-spin");
        assert.deepEqual(starts, ["a", "b", "a"]);
        assert.equal(pool.stats.queued, 1);
      }
      assert.equal(pool.stats.idle, 0);
    } finally {
      cleanupA.resolve();
      await pool.close();
      await Promise.allSettled([replacingA, replacingB]);
    }
  });
}

test("Pool uses compatible free capacity before a supplied replacement candidate", async () => {
  let authorizations = 0;
  const works: ReturnType<typeof controllable>[] = [];
  const pool = createExecutorPool<number>({
    resources: ["a", "a"],
    resourceKey: () => "a",
    run() {
      const work = controllable();
      works.push(work);
      return work.work;
    },
  });
  const first = await pool.execute(1, permitOptions().options);
  await pool.execute(
    2,
    permitOptions(first.runId, () => {
      authorizations++;
      return true;
    }).options,
  );
  assert.equal(authorizations, 0);
  assert.equal(works[0]?.cleanup(), 0);
  await pool.close();
});

test("Pool does not kill ineffective candidate; queued cancellation frees only its queue entry", async () => {
  let authorizations = 0;
  const pool = createExecutorPool<string>({
    resources: ["a", "b"],
    resourceKey: (input) => input,
    run: () => controllable().work,
  });
  const a = await pool.execute("a", permitOptions().options);
  await pool.execute("b", permitOptions().options);
  const queued = permitOptions(a.runId, () => {
    authorizations++;
    return true;
  });
  const pending = pool.execute("b", queued.options);
  assert.equal(pool.stats.queued, 1);
  assert.equal(authorizations, 0);
  queued.controller.abort();
  await assert.rejects(pending, { code: "allocation_canceled" });
  assert.equal(pool.stats.running, 2);
  await pool.close();
});

test("candidate generation/owner revalidation denial preserves old work", async () => {
  let checks = 0;
  const pool = createExecutorPool<number>({
    resources: ["a"],
    resourceKey: () => "a",
    run: () => controllable().work,
  });
  const old = await pool.execute(1, permitOptions().options);
  const request = permitOptions(old.runId, () => {
    checks++;
    return false;
  });
  const pending = pool.execute(2, request.options);
  assert.equal(checks, 1);
  assert.equal(pool.stats.running, 1);
  request.controller.abort();
  await assert.rejects(pending);
  await pool.close();
});

test("cleanup failure quarantines physical capacity; it is never counter-only reclaimed", async () => {
  const work = controllable();
  work.work.cleanup = async () => {
    throw new Error("cleanup failed");
  };
  const pool = createExecutorPool<number>({
    resources: ["a"],
    resourceKey: () => "a",
    run: () => work.work,
  });
  const tracking = await pool.execute(1, permitOptions().options);
  await assert.rejects(tracking.reclaim("test"), /cleanup failed/);
  assert.equal(pool.stats.idle, 0);
  assert.equal(pool.stats.quarantined, 1);
  const request = permitOptions(tracking.runId);
  const pending = pool.execute(2, request.options);
  assert.equal(pool.stats.queued, 1);
  request.controller.abort();
  await assert.rejects(pending);
  await assert.rejects(pool.close(), /cleanup failed/);
});

test("real isolated runaway worker is physically terminated before pressure replacement starts", async () => {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const ready = deferred<void>();
  let worker: Worker | undefined;
  let exited = false;
  let cleaned = false;
  let forced = 0;
  let starts = 0;
  const pool = createExecutorPool<JsonObject>({
    resources: ["worker"],
    resourceKey: () => "worker",
    graceMs: 5,
    reclaimMs: 3000,
    run(input, permit) {
      starts++;
      assert.ok(store.read().facts.runs[permit.runId]);
      if (input.text === "next") {
        assert.equal(exited, true);
        assert.equal(cleaned, true);
        const result = Promise.resolve({ text: "next" });
        return {
          result,
          exited: Promise.resolve(),
          cooperate() {},
          async force() {},
          async cleanup() {},
        };
      }
      worker = new Worker(
        "const {parentPort}=require('node:worker_threads');parentPort.postMessage('ready');while(true){}",
        { eval: true },
      );
      worker.once("message", () => ready.resolve());
      const result = deferred<unknown>();
      const exit = new Promise<void>((resolve) =>
        worker?.once("exit", () => {
          exited = true;
          result.reject(new Error("worker exited"));
          resolve();
        }),
      );
      worker.once("error", (error) => result.reject(error));
      return {
        result: result.promise,
        exited: exit,
        cooperate() {},
        async force() {
          forced++;
          await worker?.terminate();
        },
        async cleanup() {
          assert.equal(exited, true);
          cleaned = true;
        },
      };
    },
  });
  const type: LifecycleFixture<JsonObject> = {
    type: "echo",
    version: "1",
    environment: "worker",
    parametersSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    prepare: async (input) => input,
    validatePrepared: validateEcho,
    validateResult: json,
    validateProgress: json,
    execute: (input, options) => pool.execute(input, options),
  };
  const engine = createTaskEngine({
    store,
    clock,
    types: [type],
    currentVersions: { echo: "1" },
    authorize: () => true,
  });
  await engine.start();
  try {
    const old = engine.submit(
      { requestId: newId(clock.now()), type: "echo", text: "runaway", timeoutMs: 5 },
      caller,
    );
    clock.advance(1);
    engine.tick();
    await flush();
    engine.tick();
    await flush();
    await ready.promise;
    clock.advance(10);
    engine.tick();
    assert.equal(exited, false, "Stop acceptance is not evidence that the worker has exited.");
    const next = engine.submit(
      { requestId: newId(clock.now()), type: "echo", text: "next", timeoutMs: 100 },
      caller,
    );
    clock.advance(1);
    engine.tick();
    await flush();
    engine.tick();
    await flush();
    for (let index = 0; index < 200 && starts < 2; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await flush();
    engine.tick();
    assert.equal(forced, 1);
    assert.equal(starts, 2);
    assert.equal(engine.getTask(next.taskId, caller).stage, "completed");
    assert.equal(engine.getTask(old.taskId, caller).stage, "failed");
    assert.notEqual(
      engine.getTask(old.taskId, caller).run?.runId,
      engine.getTask(next.taskId, caller).run?.runId,
    );
    assert.ok(Object.values(store.read().facts.runs).some((run) => run.stopRequested));
  } finally {
    await worker?.terminate();
    await engine.close();
    await pool.close();
    store.close();
  }
});

test("independent wall cap and last-owner cancellation reclaim without fabricating Task cancel", async () => {
  const h = await harness({ limits: { executionWallMs: 5 } });
  try {
    const task = h.submit({ timeoutMs: 1000 });
    await h.turn();
    await h.turn(5);
    await flush();
    h.engine.tick();
    const snapshot = h.engine.getTask(task.taskId, caller);
    assert.equal(snapshot.stage, "stopped");
    assert.equal(snapshot.canceledAt, undefined);
    assert.equal(h.pool.stats.idle, 2);
  } finally {
    await h.close();
  }
});

test("cancel at durable start and delayed tracking return cannot orphan the run", async () => {
  const h = await harness();
  try {
    const originalExecute = h.type.execute;
    const delivery = deferred<void>();
    h.type.execute = async (input, options) => {
      const tracking = await originalExecute(input, options);
      await delivery.promise;
      return tracking;
    };
    const task = h.submit();
    await h.turn();
    assert.equal(h.work.length, 1);
    h.engine.cancelTask(task.taskId, caller);
    delivery.resolve();
    await h.engine.waitForTaskRelease(task.taskId, caller);
    assert.equal(h.work[0]?.stops.length, 1);
    assert.equal(h.pool.stats.idle, 2);
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "stopped");
  } finally {
    await h.close();
  }
});

test("close waits for delayed tracking before releasing Store ownership", async () => {
  const h = await harness();
  const delivery = deferred<void>();
  const originalExecute = h.type.execute;
  h.type.execute = async (input, options) => {
    const tracking = await originalExecute(input, options);
    await delivery.promise;
    return tracking;
  };
  h.submit();
  await h.turn();
  const closing = h.engine.close();
  assert.throws(() => h.store.claim("another"), { code: "store_owned" });
  delivery.resolve();
  await closing;
  assert.equal(h.pool.stats.idle, 2);
  await h.pool.close();
  h.store.close();
});

test("non-artifact orchestration returns child identity as ordinary result data", async () => {
  const h = await harness();
  try {
    const parent = h.submit({ text: "parent" });
    await h.turn();
    const child = h.engine.submit(
      { requestId: newId(h.clock.now()), type: "sum", values: [1, 2], timeoutMs: 100 },
      caller,
    );
    await h.turn();
    assert.equal(h.work.length, 2);
    await h.finish(1, { sum: 3 });
    h.engine.tick();
    await h.finish(0, {
      childTaskId: child.taskId,
      result: h.engine.getTask(child.taskId, caller).output?.result ?? null,
    });
    h.engine.tick();
    assert.equal(h.engine.getTask(parent.taskId, caller).stage, "completed");
  } finally {
    await h.close();
  }
});

test("Engine denies stale pressure authorization for a newly protected Run and never revives a stopped Run", async () => {
  const h = await harness({ resources: ["js"] });
  const release = deferred<void>();
  const execute = h.type.execute;
  h.type.execute = async (input, options) => {
    if (input.text === "replacement") await release.promise;
    return execute(input, options);
  };
  try {
    const old = h.submit({ timeoutMs: 5 });
    await h.turn();
    await h.turn(10);
    h.submit({ text: "replacement" });
    await h.turn();
    const protectedTask = h.submit({ matchPolicy: "terminates-after-eligible" });
    await h.turn();
    assert.ok(h.engine.getTask(protectedTask.taskId, caller).run);
    assert.notEqual(
      h.engine.getTask(protectedTask.taskId, caller).run?.runId,
      h.engine.getTask(old.taskId, caller).run?.runId,
    );
    release.resolve();
    await flush();
    assert.equal(h.work[0]?.stops.length, 1);
    assert.equal(h.work[1]?.stops.length, 0);
    assert.equal(h.pool.stats.queued, 1);
    await h.finish(1);
    assert.equal(
      h.engine.getTask(protectedTask.taskId, caller).run?.runId,
      h.work[1]?.permit.runId,
    );
    await flush();
    assert.equal(h.work.length, 3);
  } finally {
    release.resolve();
    await h.close();
  }
});

test("two pressure replacements cannot double-count one resource; stale callbacks cannot affect successor", async () => {
  const h = await harness({ resources: ["js"] });
  try {
    h.submit({ timeoutMs: 5 });
    await h.turn();
    await h.turn(10);
    const b = h.submit({ text: "b" });
    const c = h.submit({ text: "c" });
    await h.turn();
    await flush();
    assert.equal(h.work.length, 2);
    assert.equal(h.work[0]?.stops.length, 1);
    assert.equal(h.pool.stats.queued, 1);
    h.work[0]?.permit.complete({ stale: true });
    assert.throws(() => h.work[0]?.permit.progress({ stage: "execution", message: "迟到进度" }), {
      code: "run_finished",
    });
    assert.equal(h.engine.getTask(b.taskId, caller).output?.result, undefined);
    await h.finish(1, { text: "b" });
    await flush();
    assert.equal(h.work.length, 3);
    assert.notEqual(
      h.engine.getTask(b.taskId, caller).run?.runId,
      h.engine.getTask(c.taskId, caller).run?.runId,
    );
  } finally {
    await h.close();
  }
});
