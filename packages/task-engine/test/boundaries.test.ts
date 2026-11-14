import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type JsonObject, json } from "@silvermoon-work/task-protocol";
import { newId } from "../src/index.js";
import { createExecutorPool } from "../src/pool.js";
import { MemoryStore } from "../src/testing.js";
import type { LifecycleFixture } from "./driver.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";
import { caller, deferred, harness, validateEcho } from "./fixtures.js";

async function until(check: () => boolean, description: string) {
  const deadline = performance.now() + 15_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}.`);
    await delay(10);
  }
}

test("startup captures one trusted timestamp even if time advances on every clock read", async () => {
  const store = new MemoryStore();
  let now = 1_800_000_000_000;
  let starts = 0;
  const pool = createExecutorPool<JsonObject>({
    resources: ["js"],
    resourceKey: () => "js",
    run(input, permit) {
      starts++;
      const event = store.read().events.find((event) => event.type === "run.started");
      assert.equal(event?.occurredAt, permit.startedAt);
      return {
        result: Promise.resolve(input),
        exited: Promise.resolve(),
        cooperate() {},
        async force() {},
        async cleanup() {},
      };
    },
  });
  const type: LifecycleFixture<JsonObject> = {
    type: "echo",
    version: "1",
    environment: "js",
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
    clock: { now: () => ++now, schedule: () => () => {} },
    types: [type],
    currentVersions: { echo: "1" },
    authorize: () => true,
  });
  await engine.start();
  try {
    const task = engine.submit(
      { requestId: newId(now), type: "echo", text: "time", timeoutMs: 10000 },
      caller,
    );
    await until(() => {
      engine.tick();
      return (
        starts === 1 &&
        engine.getTask(task.taskId, caller).stage === "completed" &&
        !!Object.values(store.read().facts.runs)[0]?.reclaimedAt
      );
    }, "the Run result, actual exit and resource reclamation");
    assert.equal(starts, 1);
    assert.equal(engine.getTask(task.taskId, caller).stage, "completed");
    assert.ok(Object.values(store.read().facts.runs)[0]?.reclaimedAt);
  } finally {
    await engine.close();
    await pool.close();
    store.close();
  }
});

test("failed durable startup prevents business invocation and releases reserved Pool resource", async () => {
  const h = await harness();
  try {
    const task = h.submit();
    h.clock.advance(1);
    let armed = true;
    h.store.beforeCommit = () => {
      if (armed) {
        armed = false;
        throw new Error("startup commit rejected");
      }
    };
    h.engine.tick();
    await until(
      () => h.engine.errors.some((error) => error.code === "storage_failure"),
      "the rejected durable startup",
    );
    assert.equal(h.work.length, 0);
    assert.equal(h.pool.stats.idle, 2);
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "initial");
    assert.ok(h.engine.errors.some((error) => error.code === "storage_failure"));
    assert.equal(Object.keys(h.store.read().facts.runs).length, 0);
  } finally {
    await h.close();
  }
});

test("registered environment is detached from subsequent author object mutation", async () => {
  const preparing = deferred<void>();
  const continuePreparation = deferred<void>();
  const h = await harness({
    async prepare(input) {
      preparing.resolve();
      await continuePreparation.promise;
      return input;
    },
  });
  try {
    const task = h.submit();
    h.clock.advance(1);
    h.engine.tick();
    let entered = false;
    void preparing.promise.then(() => {
      entered = true;
    });
    await until(() => entered, "the Run Worker to enter controlled preparation");
    h.type.environment = "different-runtime";
    continuePreparation.resolve();
    await until(
      () => h.work.length === 1 && h.engine.getTask(task.taskId, caller).stage === "running",
      "the Run Worker to allocate business work",
    );
    assert.equal(h.work.length, 1);
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "running");
    assert.equal(h.store.read().facts.tasks[task.taskId]?.binding.environment, "js-v1");
  } finally {
    continuePreparation.resolve();
    await h.close();
  }
});

test("Task and event backpressure preserve final facts and expose payload failures", async () => {
  const h = await harness({ limits: { maxEvents: 64 } });
  try {
    const task = h.submit();
    await h.turn();
    await until(() => h.work.length === 1, "business work before testing backpressure");
    assert.throws(
      () => {
        for (let index = 0; index < 100; index++)
          h.work[0]?.permit.progress({ stage: "execution", message: String(index) });
      },
      { code: "capacity_exceeded" },
    );
    await until(() => {
      h.engine.tick();
      return h.engine.getTask(task.taskId, caller).stage === "failed" && h.pool.stats.idle === 2;
    }, "backpressure failure and physical resource release");
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "failed");
    assert.equal(h.engine.getTask(task.taskId, caller).error?.code, "capacity_exceeded");
    assert.ok(h.store.read().events.length <= 64);
    assert.equal(h.pool.stats.idle, 2);
  } finally {
    await h.close();
  }
});

test("run wall timer survives business-clock rollback independently of Task deadline", async () => {
  let h: Awaited<ReturnType<typeof harness>>;
  h = await harness({
    limits: { executionWallMs: 5 },
    prepare: async (input) => {
      h.clock.setTime(h.clock.now() - 10000);
      h.submit({ matchPolicy: "terminates-after-eligible", timeoutMs: 60000 });
      return input;
    },
  });
  try {
    const task = h.submit({ timeoutMs: 1000 });
    await h.turn();
    await until(() => h.work.length === 1, "business work before advancing the Run wall timer");
    await h.turn(5);
    await h.engine.waitForTaskRelease(task.taskId, caller);
    const stopped = h.engine.getTask(task.taskId, caller);
    assert.equal(stopped.stage, "stopped");
    assert.ok(stopped.timestamp < stopped.eligibleAt);
    assert.equal(
      h.engine.getRun(stopped.run!.runId, caller).stopRequested?.reason,
      "execution_wall_limit",
    );
    assert.equal(h.work[0]?.stops.length, 1);
    assert.equal(h.pool.stats.idle, 2);
  } finally {
    await h.close();
  }
});
