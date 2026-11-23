import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { newId } from "@silvermoon-work/task-engine";
import { VirtualClock } from "@silvermoon-work/task-engine/testing";
import type { RegisteredType } from "@silvermoon-work/task-protocol";
import { project } from "@silvermoon-work/task-protocol";
import { createFixtureEngine as createTaskEngine } from "../../task-engine/test/driver.js";
import { openSqliteStore } from "../src/index.js";

for (const { boundary, effectDelayMs } of [
  { boundary: "before", effectDelayMs: 0 },
  { boundary: "after", effectDelayMs: 0 },
  { boundary: "before", effectDelayMs: 5000 },
]) {
  test(`crash ${boundary} startup commit distinguishes resumable queued from uncertain run${effectDelayMs ? " with delayed effect" : ""}`, {
    timeout: 60_000,
  }, async (t) => {
    await mkdir(resolve(".cache"), { recursive: true });
    const root = await mkdtemp(join(resolve(".cache"), "task-startup-"));
    const filename = join(root, "tasks.sqlite");
    const child = fork(
      fileURLToPath(new URL("./crash-child.mjs", import.meta.url)),
      [filename, `startup-${boundary}`, newId(new VirtualClock().now())],
      { silent: true },
    );
    const exit = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("startup fixture stalled"));
      }, 60_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
      child.once("error", reject);
    });
    assert.equal(exit, 17);
    const store = openSqliteStore(filename);
    const saved = store.read();
    const before = Object.values(saved.facts.tasks)[0];
    assert.ok(before);
    assert.equal(
      project(saved.facts, before.taskId, new VirtualClock().now()).stage,
      boundary === "before" ? "initial" : "running",
    );
    assert.equal(
      Object.values(saved.facts.runs).every((run) => typeof run.workerGeneration === "string"),
      true,
      "The start and dispatch-generation source facts commit atomically before entry delivery.",
    );
    let starts = 0;
    const type: RegisteredType = {
      type: "echo",
      version: "1",
      environment: "test",
      parametersSchema: { type: "object" },
      resultSchema: true,
      messageSchema: false,
      module: new URL("./crash-worker.mjs", import.meta.url).href,
      exportName: "createType",
      configuration: {},
      resourceLifetime: "request",
      resources: {
        async effect(_input, context) {
          if (effectDelayMs) await delay(effectDelayMs, undefined, { signal: context.signal });
          starts++;
          return { text: "crash" };
        },
      },
    };
    const clock = new VirtualClock();
    clock.advance(10);
    const engine = createTaskEngine({
      store,
      clock,
      types: [type],
      currentVersions: { echo: "1" },
      authorize: () => true,
    });
    try {
      const observedAt = performance.now();
      await engine.start();
      engine.tick();
      // Observe committed completion/reclamation, not an assumed wall-time duration.
      // The persisted request still has its original VirtualClock deadline.
      const idle = engine.waitForIdle(
        () => !!engine.getTask(before.taskId, { scope: "a", subject: "tester" }).termination,
        AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
      );
      if (boundary === "before") await idle;
      else await assert.rejects(idle, { code: "reclamation_unknown" });
      const task = engine.getTask(before.taskId, { scope: "a", subject: "tester" });
      t.diagnostic(
        JSON.stringify({
          boundary,
          effectDelayMs,
          recoveryWallMs: Math.round(performance.now() - observedAt),
          stage: task.stage,
          starts,
          virtualNow: clock.now(),
          deadlineAt: task.deadlineAt,
        }),
      );
      assert.equal(task.requestId, before.request.requestId);
      assert.equal(task.deadlineAt, before.deadlineAt);
      assert.equal(starts, boundary === "before" ? 1 : 0);
      assert.equal(task.stage, boundary === "before" ? "completed" : "stopped");
      assert.ok(
        Object.values(store.read().facts.runs).every(
          (run) =>
            run.exit &&
            (boundary === "before"
              ? run.reclaimedAt && !run.cleanupUnknown
              : run.cleanupUnknown && !run.reclaimedAt),
        ),
      );
      if (boundary === "after") assert.equal(task.error, undefined);
    } finally {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
