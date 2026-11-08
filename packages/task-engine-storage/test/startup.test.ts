import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { newId } from "@silvermoon-work/task-engine";
import { VirtualClock } from "@silvermoon-work/task-engine/testing";
import type { RegisteredType } from "@silvermoon-work/task-protocol";
import { project } from "@silvermoon-work/task-protocol";
import { createFixtureEngine as createTaskEngine } from "../../task-engine/test/driver.js";
import { openSqliteStore } from "../src/index.js";

for (const boundary of ["before", "after"]) {
  test(`crash ${boundary} startup commit distinguishes resumable queued from uncertain run`, async () => {
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
      inputSchema: { type: "object" },
      resultSchema: true,
      messageSchema: false,
      module: new URL("./crash-worker.mjs", import.meta.url).href,
      exportName: "createType",
      configuration: {},
      resourceLifetime: "request",
      resources: {
        async effect() {
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
      await engine.start();
      engine.tick();
      for (
        let index = 0;
        index < 200 &&
        !engine.getTask(before.taskId, { scope: "a", subject: "tester" }).termination;
        index++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      engine.tick();
      const task = engine.getTask(before.taskId, { scope: "a", subject: "tester" });
      assert.equal(task.requestId, before.request.requestId);
      assert.equal(task.deadlineAt, before.deadlineAt);
      assert.equal(starts, boundary === "before" ? 1 : 0);
      assert.equal(task.stage, boundary === "before" ? "completed" : "stopped");
      if (boundary === "after") assert.equal(task.error, undefined);
    } finally {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
