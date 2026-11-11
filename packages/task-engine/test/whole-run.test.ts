import assert from "node:assert/strict";
import test from "node:test";
import type { Json, RegisteredType } from "@silvermoon-work/task-protocol";
import { createTaskEngine } from "../src/engine.js";
import { newId } from "../src/index.js";
import { MemoryStore, VirtualClock } from "../src/testing.js";

const caller = { scope: "scope", subject: "owner" };
const inputSchema = {
  type: "object",
  properties: { mode: { enum: ["work", "messages", "mutate"] }, text: { type: "string" } },
  required: ["mode", "text"],
  additionalProperties: false,
};
const messageSchema = {
  type: "object",
  properties: {
    kind: { enum: ["add", "target", "finish"] },
    amount: { type: "integer", minimum: 1, maximum: 10 },
  },
  required: ["kind"],
  additionalProperties: false,
};
function type(resources: RegisteredType["resources"] = {}): RegisteredType {
  return {
    type: "run-test",
    version: "1",
    environment: "trusted",
    inputSchema,
    resultSchema: { type: "object" },
    messageSchema,
    module: new URL("./run-type.mjs", import.meta.url).href,
    exportName: "createType",
    verifyExportName: "verify",
    configuration: {},
    resourceLifetime: "request",
    resources,
  };
}
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > end) assert.fail("完整 Run 测试超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function setup(registration: RegisteredType, allowMessage = true) {
  const store = new MemoryStore(),
    clock = new VirtualClock();
  const engine = createTaskEngine({
    store,
    clock,
    types: [registration],
    currentVersions: { "run-test": "1" },
    authorize: (_caller, operation) => operation !== "message" || allowMessage,
  });
  const submit = (mode: string, extra = {}) =>
    engine.submit(
      {
        requestId: newId(clock.now()),
        type: "run-test",
        mode,
        text: "input",
        timeoutMs: 5000,
        ...extra,
      },
      caller,
    );
  return { engine, store, clock, submit };
}

test("准备中按源事实共享完整 Run；接收方有真实消息路由，但未消费消息不伪造接纳", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((a) => {
    resolve = a;
  });
  let preparations = 0;
  const h = setup(
    type({
      async prepare() {
        preparations++;
        await gate;
        return null;
      },
    }),
  );
  await h.engine.start();
  try {
    const owner = h.submit("work");
    h.engine.tick();
    await until(() => preparations === 1);
    const before = h.store.read();
    const run = Object.values(before.facts.runs)[0]!;
    assert.ok(
      run.startedSequence < before.events.find((event) => event.type === "run.progress")!.sequence,
    );
    h.clock.advance(1);
    const receiver = h.submit("work", { matchPolicy: "terminates-after-eligible", timeoutMs: 1 });
    const protector = h.submit("work", { matchPolicy: "terminates-after-eligible" });
    h.engine.tick();
    assert.equal(receiver.run?.runId, run.runId);
    assert.equal(protector.run?.runId, run.runId);
    const message = h.engine.sendTaskMessage(receiver.taskId, newId(), { kind: "finish" }, caller);
    assert.equal(message.state, "queued");
    assert.equal(message.runId, run.runId);
    h.engine.cancelTask(owner.taskId, caller);
    h.clock.advance(10);
    h.engine.tick();
    resolve();
    await until(() => !!h.engine.getTask(receiver.taskId, caller).termination);
    const final = h.engine.getTask(receiver.taskId, caller);
    assert.equal(final.stage, "completed");
    assert.equal(final.run?.runId, run.runId);
    assert.equal(preparations, 1);
    assert.equal(final.deadlineAt, receiver.deadlineAt);
    assert.ok(h.engine.getTask(owner.taskId, caller).canceledAt);
    assert.equal(
      h.engine.getTaskMessage(receiver.taskId, message.messageId, caller).state,
      "rejected",
    );
  } finally {
    resolve();
    await h.engine.close();
    h.store.close();
  }
});

test("消息接纳有持久化状态与幂等身份，取消只撤回所属需求的未使用投入", async () => {
  const h = setup(type());
  await h.engine.start();
  try {
    const a = h.submit("messages"),
      b = h.submit("messages");
    h.engine.tick();
    await until(() => h.store.read().events.some((event) => event.type === "run.progress"));
    const id = newId();
    const received = h.engine.sendTaskMessage(a.taskId, id, { kind: "add", amount: 3 }, caller);
    assert.equal(received.state, "queued");
    await until(() => h.engine.getTaskMessage(a.taskId, id, caller).state === "accepted");
    assert.equal(
      h.engine.sendTaskMessage(a.taskId, id, { kind: "add", amount: 3 }, caller).state,
      "accepted",
    );
    assert.throws(
      () => h.engine.sendTaskMessage(a.taskId, id, { kind: "add", amount: 4 }, caller),
      { code: "idempotency_conflict" },
    );
    const target = newId();
    h.engine.sendTaskMessage(b.taskId, target, { kind: "target" }, caller);
    await until(() => h.engine.getTaskMessage(b.taskId, target, caller).state === "rejected");
    h.engine.cancelTask(a.taskId, caller);
    const finish = newId();
    h.engine.sendTaskMessage(b.taskId, finish, { kind: "finish" }, caller);
    await until(() => !!h.engine.getTask(b.taskId, caller).termination);
    const output = h.engine.getTask(b.taskId, caller).output;
    assert.ok(output);
    assert.equal((output.result as { total: number }).total, 0);
    assert.equal(h.engine.getRequest(b.requestId, caller).text, "input");
    assert.equal(h.engine.getTask(b.taskId, caller).deadlineAt, b.deadlineAt);
    assert.throws(
      () => h.engine.sendTaskMessage(b.taskId, newId(), { kind: "add", amount: 1 }, caller),
      { code: "no_run_route" },
    );
  } finally {
    await h.engine.close();
    h.store.close();
  }
});

test("隔离副本不能改 Engine Input；未提供的主线程状态与环境不进入类型堆", async () => {
  const globals = globalThis as typeof globalThis & { __runHostMarker?: string };
  globals.__runHostMarker = "host-only";
  process.env.RUN_TEST_HOST_MARKER = "host-only";
  const h = setup(type(), false);
  await h.engine.start();
  try {
    const task = h.submit("mutate");
    h.engine.tick();
    assert.throws(
      () => h.engine.sendTaskMessage(task.taskId, newId(), { kind: "finish" }, caller),
      { code: "forbidden" },
    );
    await until(() => !!h.engine.getTask(task.taskId, caller).termination);
    assert.deepEqual(h.engine.getTask(task.taskId, caller).output?.result, {
      text: "changed",
      hostMarker: null,
      inheritedEnv: null,
    } as Json);
    assert.equal(h.engine.getRequest(task.requestId, caller).text, "input");
    assert.equal(globals.__runHostMarker, "host-only");
  } finally {
    delete globals.__runHostMarker;
    delete process.env.RUN_TEST_HOST_MARKER;
    await h.engine.close();
    h.store.close();
  }
});
