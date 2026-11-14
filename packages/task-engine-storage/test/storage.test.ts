import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { newId } from "@silvermoon-work/task-engine";
import { VirtualClock } from "@silvermoon-work/task-engine/testing";
import type { RegisteredType } from "@silvermoon-work/task-protocol";
import { at, project, reduce } from "@silvermoon-work/task-protocol";
import { createFixtureEngine as createTaskEngine } from "../../task-engine/test/driver.js";
import { openSqliteStore } from "../src/index.js";

const caller = { scope: "a", subject: "tester" };
const childFile = fileURLToPath(new URL("./crash-child.mjs", import.meta.url));
async function directory() {
  const root = resolve(".cache");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "task-sqlite-"));
}
function type(): RegisteredType {
  return {
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
      async effect() {
        throw new Error("Recovered started work must not rerun.");
      },
    },
  };
}
async function crash(filename: string, mode: string, requestId: string) {
  const child = fork(childFile, [filename, mode, requestId], { silent: true });
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += data;
  });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Child stalled: ${stderr}`));
    }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveCode(code);
    });
  });
  assert.equal(code, 17, stderr);
}

test("SQLite WAL/FK/FULL, atomic indexes, checkpoint and duplicate owners", async () => {
  const root = await directory();
  const filename = join(root, "tasks.sqlite");
  const store = openSqliteStore(filename);
  const clock = new VirtualClock();
  const engine = createTaskEngine({
    store,
    clock,
    types: [type()],
    currentVersions: { echo: "1" },
    authorize: () => true,
  });
  await engine.start();
  try {
    const raw = {
      requestId: newId(clock.now()),
      type: "echo",
      text: "future",
      timeoutMs: 100,
      eligibleAt: at(clock.now() + 100),
    };
    const task = engine.submit(raw, caller);
    assert.equal(engine.submit(raw, caller).taskId, task.taskId);
    const competitor = openSqliteStore(filename);
    assert.throws(() => competitor.claim("other"), { code: "store_owned" });
    competitor.close();
    const inspection = new DatabaseSync(filename);
    assert.equal(inspection.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(inspection.prepare("SELECT count(*) AS n FROM requests").get()?.n, 1);
    assert.equal(inspection.prepare("SELECT count(*) AS n FROM checkpoint").get()?.n, 1);
    inspection.close();
    const view = store.read();
    assert.deepEqual(view.facts, reduce(view.prefix, view.events));
  } finally {
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real process crash releases exclusive owner lock without stale PID guessing", async () => {
  const root = await directory();
  const filename = join(root, "tasks.sqlite");
  const child = fork(childFile, [filename, "owner", newId()], { silent: true });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Owner did not become ready")), 60_000);
      child.once("message", () => {
        clearTimeout(timer);
        resolveReady();
      });
      child.once("error", reject);
    });
    const second = openSqliteStore(filename);
    assert.throws(() => second.claim("second"), { code: "store_owned" });
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill();
    await exited;
    second.claim("recovered");
    second.release("recovered");
    second.close();
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["started", "completed", "future"]) {
  test(`real restart: ${mode} preserves exact identity and adopts reliable facts`, async () => {
    const root = await directory();
    const filename = join(root, "tasks.sqlite");
    const requestId = newId(new VirtualClock().now());
    await crash(filename, mode, requestId);
    const store = openSqliteStore(filename);
    const clock = new VirtualClock();
    const engine = createTaskEngine({
      store,
      clock,
      types: [type()],
      currentVersions: { echo: "1" },
      authorize: () => true,
    });
    try {
      const before = Object.values(store.read().facts.tasks)[0];
      assert.ok(before);
      await engine.start();
      const snapshot = engine.getTask(before.taskId, caller);
      assert.equal(snapshot.requestId, requestId);
      assert.equal(snapshot.deadlineAt, before.deadlineAt);
      assert.equal(
        snapshot.stage,
        mode === "completed" ? "completed" : mode === "started" ? "stopped" : "initial",
      );
      if (mode === "completed")
        assert.deepEqual(snapshot.output?.result, { data: { text: "durable final" }, cidPaths: [] });
      if (mode === "started") assert.equal(snapshot.error, undefined);
      assert.equal(
        engine.submit(engine.getRequest(requestId, caller), caller).taskId,
        snapshot.taskId,
      );
      const watermark = store.read().facts.watermark;
      await engine.close();
      const again = createTaskEngine({
        store,
        clock,
        types: [type()],
        currentVersions: { echo: "1" },
        authorize: () => true,
      });
      await again.start();
      assert.equal(
        store.read().facts.watermark,
        watermark,
        "repeat recovery creates no duplicate failure",
      );
      await again.close();
    } finally {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const moment of ["before", "after"]) {
  test(`real crash ${moment} qualification commit replays complete historical membership after rollback and recovery`, async () => {
    const root = await directory();
    const filename = join(root, "tasks.sqlite");
    await crash(filename, `qualification-${moment}`, newId(new VirtualClock().now()));
    const store = openSqliteStore(filename);
    const before = store.read();
    const followers = Object.values(before.facts.tasks).filter(
      (task) => task.binding.matchPolicy === "terminates-after-eligible",
    );
    assert.equal(followers.length, 2);
    const run = Object.values(before.facts.runs)[0]!;
    const witness = before.events.find((event) => event.type === "qualification-time-observed");
    assert.equal(!!witness, moment === "after");
    const clock = new VirtualClock();
    clock.setTime(clock.now() + 5);
    for (const task of followers)
      assert.equal(
        project(before.facts, task.taskId, clock.now()).stage,
        moment === "after" ? "running" : "initial",
      );
    const engine = createTaskEngine({
      store,
      clock,
      types: [type()],
      currentVersions: { echo: "1" },
      authorize: () => true,
    });
    try {
      await engine.start();
      assert.equal(engine.getRun(run.runId, caller).exit?.basis, "recovery");
      for (const task of followers) {
        const snapshot = engine.getTask(task.taskId, caller);
        assert.equal(snapshot.stage, moment === "after" ? "stopped" : "initial");
        assert.equal(snapshot.run?.runId, moment === "after" ? run.runId : undefined);
        assert.ok(snapshot.timestamp < snapshot.eligibleAt);
      }
      assert.deepEqual(store.read().facts.tasks, before.facts.tasks);
      if (witness) {
        const subscription = engine.subscribeTasks(
          { runId: run.runId },
          `${before.storeId}:${witness.sequence - 1}`,
          caller,
        );
        try {
          const joined = subscription.pull();
          assert.equal(joined.length, 1);
          assert.equal(joined[0]!.revision, `${before.storeId}:${witness.sequence}`);
          assert.deepEqual(
            joined[0]!.changes.map((change) => change.id),
            followers.map((task) => task.taskId).sort(),
          );
          assert.ok(
            joined[0]!.changes.every(
              (change) => change.kind === "joined" && change.summary?.stage === "running",
            ),
          );
          const recovery = subscription.pull();
          assert.equal(recovery[0]!.changes.length, 3);
          assert.ok(
            recovery[0]!.changes.every(
              (change) => change.kind === "updated" && change.summary?.stage === "stopped",
            ),
          );
        } finally {
          subscription.close();
        }
      }
    } finally {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const moment of ["before", "after"]) {
  for (const outcome of ["completed", "failed"]) {
    test(`real crash ${moment} ${outcome} Worker-exit commit projects all matching Tasks without binding writes`, async () => {
      const root = await directory();
      const filename = join(root, "tasks.sqlite");
      await crash(filename, `terminate-${outcome}-${moment}`, newId(new VirtualClock().now()));
      const store = openSqliteStore(filename);
      const before = store.read();
      const tasks = Object.values(before.facts.tasks);
      assert.equal(tasks.length, 2);
      const demand = tasks.find(
        (task) => task.binding.matchPolicy === "terminates-after-eligible",
      )!;
      const saved = project(before.facts, demand.taskId, new VirtualClock().now() + 1);
      assert.ok(saved.run);
      assert.equal(saved.stage, moment === "after" ? outcome : "running");
      const clock = new VirtualClock();
      clock.advance(10);
      const engine = createTaskEngine({
        store,
        clock,
        types: [type()],
        currentVersions: { echo: "1" },
        authorize: () => true,
      });
      try {
        await engine.start();
        const expected = moment === "after" ? outcome : "stopped";
        for (const task of tasks) {
          const final = engine.getTask(task.taskId, caller);
          assert.equal(final.stage, expected);
          assert.equal(final.eligibleAt, task.eligibleAt);
          assert.equal(final.deadlineAt, task.deadlineAt);
          assert.equal(
            final.error?.code,
            moment === "before" ? undefined : outcome === "failed" ? "business" : undefined,
          );
        }
        const view = store.read();
        assert.deepEqual(view.facts, reduce(view.prefix, view.events));
      } finally {
        await engine.close();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  test(`crash ${moment} commit keeps request/event/index atomic`, async () => {
    const root = await directory();
    const filename = join(root, "tasks.sqlite");
    const requestId = newId(new VirtualClock().now());
    await crash(filename, `submit-${moment}`, requestId);
    const store = openSqliteStore(filename);
    const clock = new VirtualClock();
    const engine = createTaskEngine({
      store,
      clock,
      types: [type()],
      currentVersions: { echo: "1" },
      authorize: () => true,
    });
    try {
      assert.equal(Object.keys(store.read().facts.tasks).length, moment === "before" ? 0 : 1);
      await engine.start();
      const raw = { requestId, type: "echo", text: "crash", timeoutMs: 1000 };
      const task = engine.submit(raw, caller);
      assert.equal(engine.submit(raw, caller).taskId, task.taskId);
      assert.equal(Object.keys(store.read().facts.tasks).length, 1);
    } finally {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test(`crash ${moment} external-series admission preserves independent requests without successor authority`, async () => {
    const root = await directory();
    const filename = join(root, "tasks.sqlite");
    const requestId = newId(new VirtualClock().now());
    await crash(filename, `external-${moment}`, requestId);
    const store = openSqliteStore(filename);
    const clock = new VirtualClock();
    const engine = createTaskEngine({
      store,
      clock,
      types: [type()],
      currentVersions: { echo: "1" },
      authorize: () => true,
    });
    try {
      const prior = Object.values(store.read().facts.tasks).find(
        (task) => task.request.requestId === requestId,
      );
      assert.ok(prior);
      assert.equal("successor" in prior, false);
      assert.equal(Object.keys(store.read().facts.tasks).length, moment === "before" ? 1 : 2);
      await engine.start();
      const request = {
        requestId: requestId.slice(0, -1) + (requestId.endsWith("0") ? "1" : "0"),
        type: "echo",
        text: "crash",
        timeoutMs: 1000,
        seriesId: prior.seriesId,
        eligibleAt: at(clock.now() + 100),
      };
      const next = engine.submit(request, caller);
      assert.equal(engine.submit(request, caller).taskId, next.taskId);
      assert.notEqual(next.taskId, prior.taskId);
      assert.equal(engine.getTask(prior.taskId, caller).canceled, false);
      assert.equal(next.canceled, false);
      assert.equal(next.seriesId, prior.seriesId);
      assert.equal(Object.keys(store.read().facts.tasks).length, 2);
    } finally {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("transaction fault rejects acceptance without partial state or silent memory fallback", async () => {
  const root = await directory();
  let armed = true;
  const store = openSqliteStore(join(root, "tasks.sqlite"), {
    fault(point) {
      if (armed && point === "beforeCommit") throw new Error("injected transaction failure");
    },
  });
  const engine = createTaskEngine({
    store,
    types: [type()],
    currentVersions: { echo: "1" },
    authorize: () => true,
  });
  await engine.start();
  try {
    const raw = { requestId: newId(), type: "echo", text: "fail", timeoutMs: 1000 };
    assert.throws(() => engine.submit(raw, caller), /injected/);
    assert.equal(store.read().facts.watermark, 0);
    armed = false;
    engine.submit(raw, caller);
    assert.equal(Object.keys(store.read().facts.tasks).length, 1);
    assert.throws(() => openSqliteStore(join(root, "absent", "tasks.sqlite")));
    assert.throws(() => openSqliteStore(":memory:"), { code: "storage_failure" });
  } finally {
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
