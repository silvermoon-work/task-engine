import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { type JsonObject, json } from "@silvermoon-work/task-protocol";
import { newId } from "../src/index.js";
import { createExecutorPool } from "../src/pool.js";
import { MemoryStore, VirtualClock } from "../src/testing.js";
import type { LifecycleFixture } from "./driver.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";
import { caller, deferred, flush } from "./fixtures.js";

test("isolated admission lets executing and queued parents advance with one child slot", async () => {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const pool = createExecutorPool<JsonObject>({
    resources: ["parent", "child"],
    resourceKey: (input) => String(input.kind),
    run(input) {
      const controller = new AbortController();
      const result = (async () => {
        if (input.kind === "child") return { value: 6 };
        const child = engine.submit(
          { requestId: newId(clock.now()), type: "child", value: input.value!, timeoutMs: 1000 },
          caller,
        );
        while (!controller.signal.aborted) {
          const snapshot = engine.getTask(child.taskId, caller);
          if (snapshot.stage === "completed")
            return { childTaskId: child.taskId, result: snapshot.output?.result ?? null };
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        throw new Error("parent stopped");
      })();
      return {
        result,
        exited: result.then(
          () => {},
          () => {},
        ),
        cooperate() {
          controller.abort();
        },
        async force() {
          throw new Error("Cooperative test executor only.");
        },
        async cleanup() {},
      };
    },
  });
  const type: LifecycleFixture<JsonObject> = {
    type: "parent",
    allocationLimit: 1,
    version: "1",
    environment: "js",
    inputSchema: { type: "object" },
    prepare: async (input) => ({ ...input, kind: "parent" }),
    validatePrepared: json as (input: unknown) => JsonObject,
    validateResult: json,
    validateProgress: json,
    execute: (input, options) => pool.execute(input, options),
  };
  const { allocationLimit: _allocationLimit, ...shared } = type;
  const childType = {
    ...shared,
    type: "child",
    prepare: async (input: JsonObject) => ({ ...input, kind: "child" }),
  };
  const engine = createTaskEngine({
    store,
    clock,
    types: [type, childType],
    currentVersions: { parent: "1", child: "1" },
    authorize: () => true,
    limits: { maxConcurrent: 1 },
  });
  await engine.start();
  try {
    const parents = [1, 2, 3].map((value) =>
      engine.submit(
        { requestId: newId(clock.now()), type: "parent", value, timeoutMs: 1000 },
        caller,
      ),
    );
    for (let i = 0; i < 100; i++) {
      clock.advance(1);
      engine.tick();
      await flush();
      engine.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (parents.every((parent) => engine.getTask(parent.taskId, caller).stage === "completed"))
        break;
    }
    for (const parent of parents) {
      const result = engine.getTask(parent.taskId, caller);
      assert.equal(result.stage, "completed");
      assert.ok(result.output);
      assert.deepEqual((result.output.result as JsonObject).result, { value: 6 });
      await engine.waitForTaskRelease(parent.taskId, caller);
    }
    assert.equal(Object.keys(store.read().facts.tasks).length, 6);
    assert.equal(Object.keys(store.read().facts.runs).length, 6);
  } finally {
    await engine.close();
    await pool.close();
    store.close();
  }
});

test("independent run wall limit force-terminates a real uncooperative worker", async () => {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const ready = deferred<void>();
  let worker: Worker | undefined;
  let physicallyExited = false;
  let forceCount = 0;
  let cleanCount = 0;
  const pool = createExecutorPool<JsonObject>({
    resources: ["worker"],
    resourceKey: () => "worker",
    graceMs: 5,
    reclaimMs: 3000,
    run() {
      worker = new Worker(
        "const {parentPort}=require('node:worker_threads');parentPort.postMessage('ready');while(true){}",
        { eval: true },
      );
      worker.once("message", () => ready.resolve());
      const result = deferred<unknown>();
      worker.once("error", result.reject);
      const exited = new Promise<void>((resolve) =>
        worker?.once("exit", () => {
          physicallyExited = true;
          result.reject(new Error("terminated"));
          resolve();
        }),
      );
      return {
        result: result.promise,
        exited,
        cooperate() {},
        async force() {
          forceCount++;
          await worker?.terminate();
        },
        async cleanup() {
          assert.ok(physicallyExited);
          cleanCount++;
        },
      };
    },
  });
  const type: LifecycleFixture<JsonObject> = {
    type: "loop",
    version: "1",
    environment: "worker",
    inputSchema: { type: "object" },
    prepare: async (input) => input,
    validatePrepared: json as (input: unknown) => JsonObject,
    validateResult: json,
    validateProgress: json,
    execute: (input, options) => pool.execute(input, options),
  };
  const engine = createTaskEngine({
    store,
    clock,
    types: [type],
    currentVersions: { loop: "1" },
    authorize: () => true,
    limits: { executionWallMs: 5 },
  });
  await engine.start();
  try {
    const task = engine.submit(
      { requestId: newId(clock.now()), type: "loop", timeoutMs: 1000 },
      caller,
    );
    clock.advance(1);
    engine.tick();
    await flush();
    engine.tick();
    await flush();
    await ready.promise;
    clock.advance(5);
    engine.tick();
    for (let i = 0; i < 200 && cleanCount === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await flush();
    engine.tick();
    assert.equal(forceCount, 1);
    assert.equal(cleanCount, 1);
    assert.equal(pool.stats.idle, 1);
    assert.equal(engine.getTask(task.taskId, caller).stage, "failed");
    assert.equal(engine.getTask(task.taskId, caller).canceledAt, undefined);
  } finally {
    await worker?.terminate();
    await engine.close();
    await pool.close();
    store.close();
  }
});
