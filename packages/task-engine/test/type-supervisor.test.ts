import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import {
  type Json,
  type ResolvedTaskBundle,
  type TypeWorkerRegistration,
  taskSchemaUri,
} from "@silvermoon-work/task-protocol";
import {
  type RunWorkerExit,
  type SupervisorLimits,
  type TypeChannel,
  TypeSupervisor,
} from "../src/type-supervisor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((a) => {
    resolve = a;
  });
  return { promise, resolve };
}
function fixture(messageSchema: Json = false, limits: Partial<SupervisorLimits> = {}) {
  const progress: { runId: string; value: Json }[] = [];
  const results = new Map<string, Json>();
  const failures = new Map<string, string>();
  const released = new Set<string>();
  const loss = deferred<readonly string[]>();
  const confirmations: { runId: string; taskId: string; messageId: string }[] = [];
  const exits = new Map<string, RunWorkerExit>();
  const stopping = new Set<string>();
  const channel: TypeChannel = {
    async progress(runId, value) {
      progress.push({ runId, value });
    },
    async complete(runId, value) {
      results.set(runId, value);
    },
    async failed(runId, error) {
      failures.set(runId, error.code);
    },
    async confirm(runId, taskId, messageId) {
      confirmations.push({ runId, taskId, messageId });
    },
    released(runId) {
      released.add(runId);
    },
    lost(runIds) {
      loss.resolve(runIds);
    },
    async stopping(runId) {
      stopping.add(runId);
    },
    async exited(runId, fact) {
      exits.set(runId, fact);
    },
  };
  const registration: TypeWorkerRegistration = {
    type: "isolated",
    version: "1",
    environment: "trusted",
    inputSchema: { type: "object" },
    resultSchema: true,
    messageSchema: messageSchema as TypeWorkerRegistration["messageSchema"],
    module: new URL("./isolated-type.mjs", import.meta.url).href,
    exportName: "createType",
    configuration: { messageSchema },
  };
  const supervisor = new TypeSupervisor(registration, channel, {
    heartbeatMs: 20,
    healthMs: 5000,
    maxInFlight: 8,
    maxPayloadBytes: 65_536,
    ...limits,
  });
  return {
    supervisor,
    registration,
    channel,
    progress,
    results,
    failures,
    released,
    loss,
    confirmations,
    exits,
    stopping,
  };
}
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > end) assert.fail("隔离类型测试等待超时。");
    await delay(5);
  }
}

test("concurrent close and retirement await one Worker termination", async () => {
  const f = fixture();
  await f.supervisor.start();
  const worker = (f.supervisor as unknown as { verifier: { worker: Worker } }).verifier.worker;
  const terminate = worker.terminate.bind(worker);
  const barrier = deferred<void>();
  let calls = 0;
  worker.terminate = () => {
    calls++;
    return barrier.promise.then(terminate);
  };
  let closed = false;
  const closing = f.supervisor.close().then(() => {
    closed = true;
  });
  const retiring = f.supervisor.retire();
  try {
    assert.equal(calls, 1);
    assert.equal(closed, false);
    assert.ok(worker.threadId > 0);
  } finally {
    barrier.resolve();
    await Promise.all([closing, retiring]);
    await f.supervisor.close();
  }
  assert.equal(calls, 1);
  assert.equal(closed, true);
  assert.equal(worker.threadId, -1);
});

test("Bundle host rejects a different handshake CID or Schema before dispatch", async () => {
  const f = fixture();
  const declaration: ResolvedTaskBundle = {
    $schema: taskSchemaUri,
    name: "Verified Bundle",
    runtime: { type: "node", minVersion: "22.13.0" },
    entry: "worker.cjs",
    binary: [],
    include: ["task.yaml", "worker.cjs"],
    inputSchema: f.registration.inputSchema,
    resultSchema: f.registration.resultSchema,
    messageSchema: f.registration.messageSchema,
  };
  let dispatched = false;
  f.channel.dispatch = async () => {
    dispatched = true;
  };
  for (const mismatch of [{ cid: "different-bundle" }, { inputSchema: { type: "string" } }]) {
    const supervisor = new TypeSupervisor(
      {
        ...f.registration,
        bundle: { cid: "bafybeigdyrzt5sfp7udm7hu76u7cnngv7cbd3gbta6ipjcnpf7bh6zyvle", declaration },
        getBundleSource: () => `
const {parentPort,workerData}=require("node:worker_threads");
const {$schema,inputSchema,resultSchema,messageSchema}=workerData.bundle.declaration;
parentPort.postMessage({
  generation:workerData.generation,
  kind:"ready",
  value:{$schema,cid:workerData.bundle.cid,inputSchema,resultSchema,messageSchema,...${JSON.stringify(mismatch)}},
});`,
      },
      f.channel,
      { heartbeatMs: 20, healthMs: 5000, maxInFlight: 8, maxPayloadBytes: 65_536 },
    );
    try {
      await assert.rejects(supervisor.run("mismatched", {}, "scope"), {
        code: "unsupported_contract",
      });
      assert.equal(dispatched, false);
      assert.equal(f.results.size, 0);
    } finally {
      await supervisor.close();
    }
  }
  await f.supervisor.close();
});

test("每个完整 Run 使用独立 Worker，指定 Run 取消不影响同类型其他 Run", async () => {
  const f = fixture();
  try {
    await Promise.all([
      f.supervisor.run("a", { kind: "wait" }, "scope-a"),
      f.supervisor.run("b", { kind: "wait" }, "scope-b"),
    ]);
    await until(() => f.progress.length === 2);
    f.supervisor.cancel("a");
    await until(() => f.released.has("a"));
    assert.deepEqual(f.exits.get("a"), { code: 1, requested: true, forced: false });
    assert.equal(f.stopping.has("a"), true);
    assert.equal(f.released.has("b"), false);
    assert.deepEqual(f.results.get("a"), { runId: "a", scope: "scope-a", canceled: true });
    f.supervisor.cancel("b");
    await until(() => f.released.has("b"));
  } finally {
    f.supervisor.cancel("a");
    f.supervisor.cancel("b");
    await until(() => f.released.size === 2);
    await f.supervisor.close();
  }
});

test("同类型完整 Run 不共享模块堆或复用前一个 Run 的 Worker", async () => {
  const f = fixture();
  try {
    await Promise.all([
      f.supervisor.run("first", { kind: "heap" }, "scope"),
      f.supervisor.run("second", { kind: "heap" }, "scope"),
    ]);
    await until(() => f.released.size === 2);
    await f.supervisor.run("third", { kind: "heap" }, "scope");
    await until(() => f.released.size === 3);
    assert.deepEqual(
      [...f.results.values()],
      [{ invocations: 1 }, { invocations: 1 }, { invocations: 1 }],
    );
    assert.equal(f.exits.size, 3);
  } finally {
    await f.supervisor.close();
  }
});

test("同类型 Worker 启动有界排队，已就绪的完整 Run 仍并行运行", async () => {
  const f = fixture();
  const barrier = deferred<void>();
  const dispatches: string[] = [];
  f.channel.dispatch = async (id) => {
    dispatches.push(id);
    if (id === "first") await barrier.promise;
  };
  const starts = [
    f.supervisor.run("first", { kind: "wait" }, "scope"),
    f.supervisor.run("second", { kind: "wait" }, "scope"),
  ];
  try {
    await until(() => dispatches.length === 1);
    const workers = (f.supervisor as unknown as { workers: Map<string, { worker?: Worker }> })
      .workers;
    assert.ok(workers.get("first")?.worker);
    assert.equal(workers.get("second")?.worker, undefined);
    barrier.resolve();
    await Promise.all(starts);
    await until(() => f.progress.length === 2);
    assert.deepEqual(dispatches, ["first", "second"]);
    assert.equal(f.supervisor.canRoute("first"), true);
    assert.equal(f.supervisor.canRoute("second"), true);
    f.supervisor.cancel("first");
    await until(() => f.released.has("first"));
    assert.equal(f.released.has("second"), false);
  } finally {
    barrier.resolve();
    await Promise.all(starts);
    f.supervisor.cancel("first");
    f.supervisor.cancel("second");
    await until(() => f.released.size === 2);
    await f.supervisor.close();
  }
});

test("退休排队中的旧 Worker 不投递入口或删除同 ID 的新 Worker", async () => {
  const f = fixture();
  const barrier = deferred<void>();
  const dispatches: string[] = [];
  f.channel.dispatch = async (id) => {
    dispatches.push(id);
    if (id === "busy") await barrier.promise;
  };
  const busy = f.supervisor.run("busy", { kind: "heap" }, "scope");
  void busy.catch(() => {});
  await until(() => dispatches.length === 1);
  const old = f.supervisor.run("same-id", { kind: "heap" }, "scope");
  void old.catch(() => {});
  try {
    await f.supervisor.retire();
    const fresh = f.supervisor.run("same-id", { kind: "heap" }, "scope");
    barrier.resolve();
    await assert.rejects(busy, { code: "run_finished" });
    await assert.rejects(old, { code: "run_finished" });
    await fresh;
    await until(() => f.released.has("same-id"));
    assert.deepEqual(dispatches, ["busy", "same-id"]);
    assert.deepEqual(f.results.get("same-id"), { invocations: 1 });
    assert.equal(f.results.has("busy"), false);
  } finally {
    barrier.resolve();
    await Promise.allSettled([busy, old]);
    await f.supervisor.close();
  }
});

for (const outcome of ["completed", "failed"] as const) {
  test(`可靠 ${outcome} 结果先到但 Worker 仍存活时不交付终结`, async () => {
    const f = fixture();
    const barrier = deferred<void>();
    try {
      await f.supervisor.run(
        "exit-gated",
        { kind: outcome === "completed" ? "wait" : "wait-fail" },
        "scope",
      );
      await until(() => f.progress.length === 1);
      const session = (
        f.supervisor as unknown as {
          workers: Map<string, { worker: Worker; outcome?: { kind: string } }>;
        }
      ).workers.get("exit-gated")!;
      const worker = session.worker;
      const terminate = worker.terminate.bind(worker);
      // Gate the real Worker exit, not the result channel or a simulated exit callback.
      worker.terminate = () => barrier.promise.then(terminate);
      f.supervisor.cancel("exit-gated");
      await until(() => session.outcome?.kind === outcome);
      assert.ok(worker.threadId > 0);
      assert.equal(f.results.size, 0);
      assert.equal(f.failures.size, 0);
      assert.equal(f.exits.size, 0);
      assert.equal(f.released.size, 0);
      barrier.resolve();
      await until(() => f.released.has("exit-gated"));
      assert.equal(worker.threadId, -1);
      assert.ok(f.exits.has("exit-gated"));
      if (outcome === "completed")
        assert.deepEqual(f.results.get("exit-gated"), {
          runId: "exit-gated",
          scope: "scope",
          canceled: true,
        });
      else assert.equal(f.failures.get("exit-gated"), "run_failed");
    } finally {
      barrier.resolve();
      f.supervisor.cancel("exit-gated");
      await until(() => f.released.has("exit-gated"));
      await f.supervisor.close();
    }
  });
}

test("强制终止卡死的指定 Run，其他同类型 Run 仍可接收取消并形成可靠结果", async () => {
  const f = fixture();
  try {
    await f.supervisor.run("healthy", { kind: "wait" }, "scope");
    await until(() => f.progress.length === 1);
    await f.supervisor.run("blocked", { kind: "block" }, "scope");
    const exit = await f.supervisor.forceTerminate("blocked");
    assert.deepEqual(exit, { code: 1, requested: true, forced: true });
    assert.deepEqual(await f.loss.promise, ["blocked"]);
    assert.equal(f.results.has("blocked"), false);
    assert.equal(f.released.has("blocked"), false);
    assert.equal(f.supervisor.canRoute("blocked"), false);
    assert.equal(f.supervisor.canRoute("healthy"), true);
    f.supervisor.cancel("healthy");
    await until(() => f.released.has("healthy"));
    assert.deepEqual(f.results.get("healthy"), {
      runId: "healthy",
      scope: "scope",
      canceled: true,
    });
  } finally {
    f.supervisor.cancel("healthy");
    await until(() => f.released.has("healthy"));
    await f.supervisor.close();
  }
});

test("Worker 接纳停止后仍不退出，宽限到期强制退出且不伪造业务结果或宿主回收", async () => {
  const f = fixture(false, { stopGraceMs: 50, forceExitWaitMs: 1000 });
  try {
    await f.supervisor.run("ignores", { kind: "ignore-cancel" }, "scope");
    await until(() => f.progress.length === 1);
    f.supervisor.cancel("ignores");
    await until(() => f.stopping.has("ignores"));
    assert.equal(f.exits.size, 0);
    assert.equal(f.results.size, 0);
    await until(() => f.exits.has("ignores"));
    assert.deepEqual(f.exits.get("ignores"), { code: 1, requested: true, forced: true });
    assert.deepEqual(await f.loss.promise, ["ignores"]);
    assert.equal(f.results.size, 0);
    assert.equal(f.released.size, 0);
  } finally {
    await f.supervisor.close();
  }
});

test("Worker 意外退出只报告实际退出和失联，不伪造可靠结果", async () => {
  const f = fixture();
  try {
    await f.supervisor.run("unexpected", { kind: "exit" }, "scope");
    assert.deepEqual(await f.loss.promise, ["unexpected"]);
    assert.deepEqual(f.exits.get("unexpected"), { code: 19, requested: false, forced: false });
    assert.equal(f.results.size, 0);
    assert.equal(f.released.size, 0);
  } finally {
    await f.supervisor.close();
  }
});

test("强杀请求不能替代退出确认，等待超限明确失败且关闭业务消息路由", async () => {
  const f = fixture(false, { forceExitWaitMs: 100 });
  const barrier = deferred<void>();
  try {
    await f.supervisor.run("exit-held", { kind: "wait" }, "scope");
    await until(() => f.progress.length === 1);
    const worker = (
      f.supervisor as unknown as { workers: Map<string, { worker: Worker }> }
    ).workers.get("exit-held")!.worker;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => barrier.promise.then(terminate);
    await assert.rejects(f.supervisor.forceTerminate("exit-held"), {
      code: "stop_unconfirmed",
    });
    assert.ok(worker.threadId > 0);
    assert.equal(f.supervisor.canRoute("exit-held"), false);
    assert.equal(f.exits.size, 0);
    assert.equal(f.results.size, 0);
    assert.equal(f.released.size, 0);
    barrier.resolve();
    assert.deepEqual(await f.loss.promise, ["exit-held"]);
    assert.equal(worker.threadId, -1);
    assert.deepEqual(f.exits.get("exit-held"), { code: 1, requested: true, forced: true });
  } finally {
    barrier.resolve();
    await f.supervisor.close();
  }
});

test("进度确认等待宿主接纳边界，不把 postMessage 当作完成", async () => {
  const f = fixture();
  const barrier = deferred<void>();
  let received = false;
  f.channel.progress = async () => {
    received = true;
    await barrier.promise;
  };
  try {
    await f.supervisor.run("progress", {}, "scope");
    await until(() => received);
    assert.equal(f.results.size, 0);
    barrier.resolve();
    await until(() => f.released.has("progress"));
    assert.ok(f.results.has("progress"));
  } finally {
    barrier.resolve();
    await until(() => f.released.has("progress"));
    await f.supervisor.close();
  }
});

test("消息保留 Task/Caller 归属，Never 在投递前明确拒绝", async () => {
  const f = fixture(true);
  try {
    await f.supervisor.run("messages", { kind: "message" }, "scope");
    f.supervisor.message("messages", {
      messageId: "id",
      taskId: "task",
      caller: { scope: "scope", subject: "subject" },
      payload: { contribution: 1 },
    });
    await until(() => f.released.has("messages"));
    assert.deepEqual(f.confirmations, [{ runId: "messages", taskId: "task", messageId: "id" }]);
    assert.deepEqual(f.results.get("messages"), {
      messageId: "id",
      taskId: "task",
      caller: { scope: "scope", subject: "subject" },
      payload: { contribution: 1 },
    });
    assert.throws(
      () =>
        f.supervisor.message("messages", {
          messageId: "late",
          taskId: "task",
          caller: { scope: "scope", subject: "subject" },
          payload: {},
        }),
      { code: "no_run_route" },
    );
  } finally {
    await f.supervisor.close();
  }
  const never = fixture();
  try {
    await never.supervisor.run("never", { kind: "wait" }, "scope");
    await until(() => never.progress.length > 0);
    for (const payload of [{}, null])
      assert.throws(
        () =>
          never.supervisor.message("never", {
            messageId: "id",
            taskId: "task",
            caller: { scope: "scope", subject: "subject" },
            payload,
          }),
        { code: "invalid_input" },
      );
    never.supervisor.cancel("never");
    await until(() => never.released.has("never"));
  } finally {
    await never.supervisor.close();
  }
});

test("宿主存储拒绝进度会拒绝上报，不返回业务成功", async () => {
  const f = fixture();
  f.channel.progress = async () => {
    throw new Error("存储拒绝");
  };
  try {
    await f.supervisor.run("rejected", {}, "scope");
    await until(() => f.released.has("rejected"));
    assert.equal(f.results.size, 0);
    assert.equal(f.failures.get("rejected"), "type_channel_failure");
  } finally {
    await f.supervisor.close();
  }
});

test("卡死的类型不会卡死宿主，健康恢复不自动重跑旧 Run", async () => {
  const f = fixture();
  const supervisor = new TypeSupervisor(f.registration, f.channel, {
    heartbeatMs: 20,
    healthMs: 1000,
    maxInFlight: 8,
    maxPayloadBytes: 65_536,
  });
  try {
    await supervisor.run("blocked", { kind: "block" }, "scope");
    await delay(30);
    let responsive = false;
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        responsive = true;
        resolve();
      }),
    );
    assert.equal(responsive, true);
    assert.deepEqual(await f.loss.promise, ["blocked"]);
    assert.equal(f.results.has("blocked"), false);
    assert.equal(f.released.has("blocked"), false);
    await supervisor.run("fresh", {}, "scope");
    await until(() => f.released.has("fresh"));
    assert.equal(f.results.has("blocked"), false);
    assert.ok(f.results.has("fresh"));
  } finally {
    await supervisor.close();
  }
});
