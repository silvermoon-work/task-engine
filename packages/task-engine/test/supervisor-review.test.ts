import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ErrorFact,
  type Json,
  type RegisteredType,
  type Store,
  TaskError,
} from "@silvermoon-work/task-protocol";
import { createTaskEngine } from "../src/engine.js";
import { newId } from "../src/index.js";
import { MemoryStore } from "../src/testing.js";
import { type TypeChannel, TypeSupervisor } from "../src/type-supervisor.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail("审查回归等待超时。");
    await delay(5);
  }
}
function registration(configuration: Json = {}, requestScoped = true): RegisteredType {
  return {
    type: "review",
    version: "1",
    environment: "review-v1",
    inputSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
    module: new URL("./review-type.mjs", import.meta.url).href,
    exportName: "createType",
    verifyExportName: "verify",
    configuration,
    ...(requestScoped ? { resourceLifetime: "request" as const } : {}),
  };
}
function fixture(type: RegisteredType, healthMs = 5000) {
  const released = new Set<string>();
  const complete = new Set<string>();
  const failed = new Map<string, { error: ErrorFact; result?: Json }>();
  const lost: string[] = [];
  const channel: TypeChannel = {
    async progress() {},
    async complete(id) {
      complete.add(id);
    },
    async failed(id, error, result) {
      failed.set(id, { error, ...(result === undefined ? {} : { result }) });
    },
    async confirm() {},
    released(id) {
      released.add(id);
    },
    lost(ids) {
      lost.push(...ids);
    },
  };
  const supervisor = new TypeSupervisor(type, channel, {
    heartbeatMs: 20,
    healthMs,
    maxInFlight: 8,
    maxPayloadBytes: 65_536,
  });
  return { supervisor, released, complete, failed, lost };
}

test("静态 factory 不可用则启动明确失败，不虚构 Run 或永久保留租约", async () => {
  const store = new MemoryStore();
  const engine = createTaskEngine({
    store,
    types: [{ ...registration(), exportName: "missingFactory" }],
    currentVersions: { review: "1" },
    authorize: () => true,
  });
  try {
    await assert.rejects(engine.start(), /factory/);
    assert.deepEqual(store.read().facts.runs, {});
    assert.deepEqual(store.read().facts.tasks, {});
    assert.equal(
      store.read().events.some((event) => event.type === "run.progress"),
      false,
    );
    assert.equal(
      engine.errors.some((error) => error.code === "reclamation_unknown"),
      false,
    );
    await engine.close();
    store.claim("next-owner");
    store.release("next-owner");
  } finally {
    await engine.close();
    store.close();
  }
});

for (const rewrite of [false, true, "in-place"]) {
  test(`R01 隔离边界拒绝${rewrite === "in-place" ? "原地改写" : rewrite ? "改写" : "无效"}失败证据，保留原业务错误`, async () => {
    const f = fixture(registration({ rewrite }));
    try {
      await f.supervisor.run("failure", { kind: "failure", valid: rewrite !== false }, "scope");
      await until(() => f.released.has("failure"));
      assert.deepEqual(f.failed.get("failure"), {
        error: { code: "business_failure", message: "原业务失败" },
      });
      assert.equal(f.complete.size, 0);
    } finally {
      await f.supervisor.close();
    }
  });
}
test("R01 合法失败证据及无效证据的运行/恢复事实一致", async () => {
  for (const valid of [false, true]) {
    const store = new MemoryStore();
    const options = {
      store,
      types: [registration()],
      currentVersions: { review: "1" },
      authorize: () => true,
    };
    const caller = { scope: "scope", subject: "review" };
    const engine = createTaskEngine(options);
    await engine.start();
    const task = engine.submit(
      { requestId: newId(), type: "review", kind: "failure", valid, timeoutMs: 5000 },
      caller,
    );
    try {
      await engine.waitForTaskRelease(task.taskId, caller);
      const before = engine.getTask(task.taskId, caller);
      assert.equal(before.stage, "failed");
      assert.deepEqual(before.error, { code: "business_failure", message: "原业务失败" });
      assert.deepEqual(before.result, valid ? { valid, marker: "失败证据" } : undefined);
      if (!valid)
        assert.equal(
          store
            .read()
            .events.some((event) => JSON.stringify(event).includes('"marker":"失败证据"')),
          false,
        );
      await engine.close();
      const reopened = createTaskEngine(options);
      try {
        await reopened.start();
        const after = reopened.getTask(task.taskId, caller);
        assert.deepEqual(after.error, before.error);
        assert.deepEqual(after.result, before.result);
      } finally {
        await reopened.close();
      }
      if (valid) {
        const corrupt: Store = {
          claim: (owner) => store.claim(owner),
          release: (owner) => store.release(owner),
          append: (...args) => store.append(...args),
          compact: (...args) => store.compact(...args),
          close: () => store.close(),
          read() {
            const view = store.read();
            const forged = { valid: false, marker: "篡改证据" };
            const run = view.facts.runs[before.run!.runId]!;
            run.result = forged;
            if (run.outcome?.kind === "failed") run.outcome.result = forged;
            for (const event of view.events)
              if (
                event.runId === run.runId &&
                event.type === "run.outcome" &&
                event.data.outcome.kind === "failed"
              )
                event.data.outcome.result = forged;
            return view;
          },
        };
        const rejected = createTaskEngine({ ...options, store: corrupt });
        try {
          await assert.rejects(rejected.start(), /失败业务证据/);
        } finally {
          await rejected.close();
        }
      }
    } finally {
      await engine.close();
      store.close();
    }
  }
});
test("R01 失败证据拒绝不覆盖原清理未知语义", async () => {
  const f = fixture(registration());
  try {
    await f.supervisor.run(
      "unknown",
      { kind: "failure", valid: false, code: "reclamation_unknown" },
      "scope",
    );
    await until(() => f.lost.includes("unknown"));
    assert.equal(f.failed.get("unknown")?.error.code, "reclamation_unknown");
    assert.equal(f.failed.get("unknown")?.result, undefined);
    assert.equal(f.released.size, 0);
  } finally {
    await f.supervisor.close();
  }
});

for (const cancel of [false, true]) {
  test(`R02 ${cancel ? "指定取消" : "未等待资源"}不提前确认宿主动作物理回收`, async () => {
    const barrier = deferred();
    let started = false,
      finished = false,
      signal: AbortSignal | undefined;
    const f = fixture({
      ...registration(),
      resources: {
        async slow(_value, context) {
          started = true;
          signal = context.signal;
          await barrier.promise;
          finished = true;
          return null;
        },
      },
    });
    try {
      await f.supervisor.run("resource", { wait: cancel }, "scope");
      await until(() => started);
      if (cancel) f.supervisor.cancel("resource");
      await until(() => f.complete.has("resource") && !f.supervisor.canRoute("resource"));
      assert.equal(f.supervisor.canRoute("resource"), false);
      assert.equal(f.released.size, 0);
      assert.equal(finished, false);
      assert.equal(signal?.aborted, true);
      await assert.rejects(f.supervisor.close(), { code: "reclamation_failed" });
      barrier.resolve();
      await until(() => f.released.has("resource"));
      assert.equal(finished, true);
    } finally {
      barrier.resolve();
      await until(() => f.released.has("resource"));
      await f.supervisor.close();
    }
  });
}
test("R02 Engine 回收事实和 waitForTaskRelease 等待未等待的宿主资源动作", async () => {
  const barrier = deferred();
  let started = false,
    released = false;
  const store = new MemoryStore();
  const type = {
    ...registration(),
    resources: {
      async slow() {
        started = true;
        await barrier.promise;
        return null;
      },
    },
  };
  const engine = createTaskEngine({
    store,
    types: [type],
    currentVersions: { review: "1" },
    authorize: () => true,
  });
  const caller = { scope: "scope", subject: "review" };
  await engine.start();
  const task = engine.submit({ requestId: newId(), type: "review", timeoutMs: 5000 }, caller);
  const release = engine.waitForTaskRelease(task.taskId, caller).then(() => {
    released = true;
  });
  try {
    await until(() => started && engine.getTask(task.taskId, caller).stage === "completed");
    assert.equal(released, false);
    assert.equal(Object.values(store.read().facts.runs)[0]!.reclaimedAt, undefined);
    barrier.resolve();
    await release;
    assert.ok(Object.values(store.read().facts.runs)[0]!.reclaimedAt);
  } finally {
    barrier.resolve();
    await release;
    await engine.close();
    store.close();
  }
});
test("R02 旧代际资源 finally 不删除新代际同 ID 跟踪或确认新 Run 回收", async () => {
  const old = deferred(),
    fresh = deferred();
  const starts: string[] = [];
  const f = fixture({
    ...registration(),
    resources: {
      async slow(value) {
        const label = (value as { label: string }).label;
        starts.push(label);
        await (label === "old" ? old.promise : fresh.promise);
        return null;
      },
    },
  });
  const count = () => (f.supervisor as unknown as { inFlight: Set<object> }).inFlight.size;
  try {
    await f.supervisor.run("same-id", { label: "old" }, "scope");
    await until(() => f.complete.has("same-id") && starts.includes("old"));
    await f.supervisor.retire();
    assert.deepEqual(f.lost, ["same-id"]);
    f.complete.clear();
    await f.supervisor.run("same-id", { label: "fresh" }, "scope");
    await until(() => f.complete.has("same-id") && starts.includes("fresh"));
    assert.equal(count(), 2);
    old.resolve();
    await until(() => count() === 1);
    assert.equal(f.released.size, 0);
    fresh.resolve();
    await until(() => f.released.has("same-id"));
    assert.equal(count(), 0);
  } finally {
    old.resolve();
    fresh.resolve();
    await until(() => count() === 0);
    await f.supervisor.close();
  }
});
test("R02 资源动作超时保持未知，迟到结束不改写回收且关闭不会无限等待", async () => {
  const barrier = deferred();
  const f = fixture(
    {
      ...registration(),
      resources: {
        async slow() {
          await barrier.promise;
          return null;
        },
      },
    },
    1000,
  );
  try {
    await f.supervisor.run("timeout", {}, "scope");
    await until(() => f.lost.includes("timeout"));
    assert.equal(f.released.size, 0);
    await assert.rejects(f.supervisor.close(), { code: "reclamation_failed" });
    barrier.resolve();
    await until(() => (f.supervisor as unknown as { inFlight: Set<object> }).inFlight.size === 0);
    assert.equal(f.released.size, 0);
  } finally {
    barrier.resolve();
    await delay(10);
    await f.supervisor.close();
  }
});
test("R02 返回资源句柄仍需适配器的独立清理证明，证明拒绝不确认回收", async () => {
  const f = fixture({
    ...registration({}, false),
    resources: {
      async slow() {
        return { handle: "still-live" };
      },
    },
    async confirmResourceRelease() {
      throw new TaskError("reclamation_unknown", "句柄仍存活。");
    },
  });
  try {
    await f.supervisor.run("handle", {}, "scope");
    await until(() => f.lost.includes("handle"));
    assert.ok(f.complete.has("handle"));
    assert.equal(f.released.size, 0);
  } finally {
    await f.supervisor.close();
  }
});
test("R02 未声明生命周期或清理证明的宿主资源不会默认为已回收", () => {
  assert.throws(
    () =>
      fixture({
        ...registration({}, false),
        resources: {
          async slow() {
            return { handle: "unproven" };
          },
        },
      }),
    { code: "invalid_type" },
  );
});
test("R02 清理证明有界且旧证明完成不能复活已终结回收状态", async () => {
  const barrier = deferred();
  const f = fixture(
    {
      ...registration(),
      resources: {
        async slow() {
          return null;
        },
      },
      async confirmResourceRelease() {
        await barrier.promise;
      },
    },
    1000,
  );
  try {
    await f.supervisor.run("proof", {}, "scope");
    await until(() => f.lost.includes("proof"));
    await assert.rejects(f.supervisor.close(), { code: "reclamation_failed" });
    barrier.resolve();
    await until(
      () => (f.supervisor as unknown as { resourceProofs: Set<object> }).resourceProofs.size === 0,
    );
    assert.equal(f.released.size, 0);
  } finally {
    barrier.resolve();
    await delay(10);
    await f.supervisor.close();
  }
});
