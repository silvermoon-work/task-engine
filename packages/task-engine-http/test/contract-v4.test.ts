import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { createTaskEngine, newId } from "@silvermoon-work/task-engine";
import { MemoryIpfsClient, MemoryStore, VirtualClock } from "@silvermoon-work/task-engine/testing";
import type {
  CancellationResult,
  HistoryPage,
  RunPage,
  RunSnapshot,
  SubmissionResult,
  TaskMessageRecord,
  TaskPage,
  TaskRequest,
  TaskSnapshot,
} from "@silvermoon-work/task-protocol";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { createTaskHandler } from "../src/index.js";

async function until(check: () => boolean) {
  const end = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > end) assert.fail("HTTP contract timed out.");
    await delay(5);
  }
}
async function data<T>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}
async function eventFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\ndata:") || !text.endsWith("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}
async function fixture(limits: Parameters<typeof createTaskEngine>[0]["limits"] = {}) {
  const store = new MemoryStore(),
    clock = new VirtualClock();
  const root = resolve(".cache", `http-contract-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const yaml = join(root, "task.yaml"),
    entry = join(root, "callback.ts");
  await writeFile(
    yaml,
    JSON.stringify({
      $schema: taskSchemaUri,
      name: "HTTP fixture",
      runtime: { type: "node", minVersion: "22.13.0" },
      entry: "worker.cjs",
      binary: [],
      inputSchema: { type: "object" },
      resultSchema: true,
      messageSchema: true,
    }),
  );
  await writeFile(
    entry,
    `import {createType} from ${JSON.stringify(
      relative(
        dirname(entry),
        fileURLToPath(new URL("../../task-engine/test/isolated-type.mjs", import.meta.url)),
      )
        .split(sep)
        .join("/"),
    )};
const type=createType({messageSchema:true});export default (input,context)=>type.run(input,context);`,
  );
  const built = await buildBundleFixture({
    declaration: yaml,
    entry,
    outDirectory: join(root, "bundle"),
  });
  const ipfsClient = new MemoryIpfsClient();
  const bundle = await ipfsClient.import(built.files);
  const caller = { scope: "scope", subject: "http" };
  const engine = createTaskEngine({
    store,
    clock,
    ipfsClient,
    authorize: () => true,
    limits,
  });
  await engine.start();
  const handler = createTaskHandler({ service: engine, resolveCaller: () => caller, pollMs: 5 });
  const get = (path: string) => handler(new Request(`http://fixture${path}`));
  const submit = async (kind: string, extra: Record<string, unknown> = {}) => {
    const requestId = newId(clock.now());
    const response = await handler(
      new Request("http://fixture/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": requestId },
        body: JSON.stringify({ bundle, kind, timeoutMs: 1000, ...extra }),
      }),
    );
    assert.ok(response.ok);
    let result = (await response.json()) as SubmissionResult;
    while (result.status === "preparing")
      result = await engine.getRequestStatus(requestId, { waitMs: 1000 }, caller);
    assert.equal(result.status, "accepted");
    if (result.status !== "accepted") throw Error("Expected accepted.");
    return engine.getTask(result.taskId, caller);
  };
  const cancel = (id: string) =>
    handler(new Request(`http://fixture/tasks/${id}/cancel`, { method: "POST" }));
  return {
    store,
    clock,
    engine,
    caller,
    handler,
    get,
    submit,
    cancel,
    bundle,
    async close() {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("concurrent HTTP retries accept exactly one Task and retain the complete original omitted-field intent", async () => {
  const f = await fixture();
  try {
    const requestId = newId(f.clock.now());
    const body = { bundle: f.bundle, kind: "wait", timeoutMs: 1000 };
    const send = (payload: unknown) =>
      f.handler(
        new Request("http://fixture/tasks", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": requestId },
          body: JSON.stringify(payload),
        }),
      );
    const responses = await Promise.all(Array.from({ length: 8 }, () => send(body)));
    assert.ok(responses.every((response) => response.ok));
    const decisions = await Promise.all(
      responses.map((response) => data<SubmissionResult>(response)),
    );
    assert.ok(decisions.every((value) => value.requestId === requestId));
    let final = await f.engine.getRequestStatus(requestId, { waitMs: 1000 }, f.caller);
    while (final.status === "preparing")
      final = await f.engine.getRequestStatus(requestId, { waitMs: 1000 }, f.caller);
    assert.equal(final.status, "accepted");
    assert.equal(Object.keys(f.store.read().facts.tasks).length, 1);
    assert.equal(f.store.read().events.filter((event) => event.type === "task.created").length, 1);
    assert.deepEqual(f.engine.getRequest(requestId, f.caller), { ...body, requestId });
    assert.equal((await send({ ...body, kind: "different" })).status, 409);
  } finally {
    await f.close();
  }
});

test("HTTP source fan-out fails atomically with the last complete revision and a quiet connection never writes facts", async () => {
  const f = await fixture({ collectionMaxChanges: 1 });
  try {
    const owner = await f.submit("wait");
    f.engine.tick();
    await until(() => !!f.engine.getTask(owner.taskId, f.caller).run);
    const runId = f.engine.getTask(owner.taskId, f.caller).run!.runId;
    await until(() => f.engine.getRun(runId, f.caller).progress !== undefined);
    const due = f.clock.now() + 10;
    const tasks = [];
    for (let index = 0; index < 2; index++)
      tasks.push(
        await f.submit("wait", {
          eligibleAt: new Date(due).toISOString(),
          matchPolicy: "terminates-after-eligible",
        }),
      );
    const baseline = await data<TaskPage>(f.get("/tasks?stage=running"));
    const response = await f.get(
      `/tasks/events?stage=running&fromRevision=${encodeURIComponent(baseline.revision)}`,
    );
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
    assert.equal(f.engine.getTask(owner.taskId, f.caller).revision, baseline.revision);
    f.clock.setTime(due);
    f.engine.tick();
    const text = await eventFrame(reader);
    assert.match(text, /event: task.error/);
    assert.equal(/^id:/m.test(text), false);
    const error = JSON.parse(
      text
        .split("\n")
        .find((line) => line.startsWith("data:"))!
        .slice(5),
    );
    assert.equal(error.error.code, "capacity_exceeded");
    assert.equal(error.error.details.lastCompleteRevision, baseline.revision);
    assert.ok(tasks.every((task) => f.engine.getTask(task.taskId, f.caller).run?.runId === runId));
    const refreshed = await data<TaskPage>(f.get("/tasks?stage=running"));
    assert.equal(refreshed.tasks.length, 3);
    const retry = await f.get(
      `/tasks/events?stage=running&fromRevision=${encodeURIComponent(refreshed.revision)}`,
    );
    await retry.body!.cancel();
    assert.ok(tasks.every((task) => !f.engine.getTask(task.taskId, f.caller).canceled));
  } finally {
    await f.close();
  }
});

test("HTTP controls, independent Task/Run snapshots and frozen histories expose a consistent source revision", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get("/task-types")).status, 404);
    const task = await f.submit("heap");
    f.engine.tick();
    await until(() => f.engine.getTask(task.taskId, f.caller).stage === "completed");
    const snapshot = await data<TaskSnapshot>(f.get(`/tasks/${task.taskId}`));
    assert.ok(snapshot.run);
    const run = await data<RunSnapshot>(f.get(`/runs/${snapshot.run.runId}`));
    assert.equal(run.stage, "completed");
    assert.equal(run.dataDomain, snapshot.dataDomain);
    assert.deepEqual(run.result, snapshot.result);
    const original = await data<TaskRequest>(f.get(`/requests/${task.requestId}`));
    assert.equal(original.requestId, task.requestId);
    const tasks = await data<TaskPage>(f.get("/tasks?canceled=false&stage=completed"));
    const runs = await data<RunPage>(f.get("/runs?stage=completed"));
    assert.equal(tasks.tasks[0]?.taskId, task.taskId);
    assert.equal(runs.runs[0]?.runId, run.runId);
    const history = await data<HistoryPage>(f.get(`/tasks/${task.taskId}/history?limit=1`));
    assert.equal(history.events[0]?.type, "task.created");
    assert.ok(history.next);
    const next = await data<HistoryPage>(
      f.get(`/tasks/${task.taskId}/history?limit=100&cursor=${encodeURIComponent(history.next)}`),
    );
    assert.equal(next.revision, history.revision);
    assert.equal(
      next.events.some((event: { type: string }) => event.type.startsWith("run.")),
      false,
    );
    const runHistory = await data<HistoryPage>(f.get(`/runs/${run.runId}/history`));
    assert.ok(runHistory.events.some((event: { type: string }) => event.type === "run.started"));
    assert.ok(runHistory.events.some((event: { type: string }) => event.type === "run.exited"));
    assert.equal(
      (await f.get(`/tasks/${task.taskId}/events?fromRevision=${encodeURIComponent(history.next)}`))
        .status,
      400,
    );
    const stream = await f.get(
      `/tasks/${task.taskId}/events?fromRevision=${encodeURIComponent(snapshot.revision)}`,
    );
    const reader = stream.body!.getReader();
    const result = await data<CancellationResult>(f.cancel(task.taskId));
    const text = await eventFrame(reader);
    assert.match(text, /event: task.event/);
    assert.ok(text.includes(result.revision));
    assert.equal(result.changed, true);
    const repeat = await data<CancellationResult>(f.cancel(task.taskId));
    assert.equal(repeat.changed, false);
    assert.equal(repeat.revision, result.revision);
    await reader.cancel();
    assert.equal((await f.get("/tasks?pending=true")).status, 400);
    assert.equal((await f.get("/tasks?canceled=0")).status, 400);
    assert.equal((await f.get(`/tasks/${task.taskId}/events`)).status, 400);
  } finally {
    await f.close();
  }
});
test("HTTP collection subscribers receive one whole qualification source after a frozen baseline", async () => {
  const f = await fixture();
  try {
    const b = await f.submit("wait");
    f.engine.tick();
    await until(() => !!f.engine.getTask(b.taskId, f.caller).run);
    const runId = f.engine.getTask(b.taskId, f.caller).run!.runId;
    await until(() => f.engine.getRun(runId, f.caller).progress !== undefined);
    f.clock.setTime(f.clock.now() + 1);
    const due = f.clock.now() + 9;
    const a = await f.submit("wait", {
      eligibleAt: new Date(due).toISOString(),
      matchPolicy: "terminates-after-eligible",
    });
    const twin = await f.submit("wait", {
      eligibleAt: new Date(due).toISOString(),
      matchPolicy: "terminates-after-eligible",
    });
    const baseline = await data<TaskPage>(f.get("/tasks?stage=running"));
    const stream = await f.get(
      `/tasks/events?stage=running&fromRevision=${encodeURIComponent(baseline.revision)}`,
    );
    const reader = stream.body!.getReader();
    f.clock.setTime(due);
    f.engine.tick();
    const chunk = await eventFrame(reader);
    assert.match(chunk, /event: task.collection/);
    const envelope = JSON.parse(
      chunk
        .split("\n")
        .find((line) => line.startsWith("data:"))!
        .slice(5),
    );
    assert.deepEqual(
      envelope.changes.map((change: { id: string }) => change.id),
      [a.taskId, twin.taskId].sort(),
    );
    assert.equal(envelope.revision, f.engine.getTask(a.taskId, f.caller).revision);
    await reader.cancel();
    assert.equal(f.engine.getTask(a.taskId, f.caller).canceled, false);
    await f.cancel(a.taskId);
    await f.cancel(b.taskId);
  } finally {
    await f.close();
  }
});
test("HTTP Run collection and single Run streams are independently cancellable without withdrawing a Task", async () => {
  const f = await fixture();
  try {
    const baseline = await data<RunPage>(f.get("/runs"));
    const collection = await f.get(
      `/runs/events?fromRevision=${encodeURIComponent(baseline.revision)}`,
    );
    const collectionReader = collection.body!.getReader();
    const task = await f.submit("wait");
    f.engine.tick();
    const text = await eventFrame(collectionReader);
    assert.match(text, /event: run.collection/);
    await collectionReader.cancel();
    await until(() => !!f.engine.getTask(task.taskId, f.caller).run);
    const runId = f.engine.getTask(task.taskId, f.caller).run!.runId;
    const run = await data<RunSnapshot>(f.get(`/runs/${runId}`));
    const live = await f.get(
      `/runs/${runId}/events?fromRevision=${encodeURIComponent(run.revision)}`,
    );
    await live.body!.cancel();
    assert.equal(f.engine.getTask(task.taskId, f.caller).canceled, false);
    assert.equal(f.engine.getRun(runId, f.caller).stage, "running");
    await f.cancel(task.taskId);
  } finally {
    await f.close();
  }
});
test("Task messages retain ownership, immutable payload and independent receipts under the new Run history split", async () => {
  const f = await fixture();
  try {
    const task = await f.submit("message");
    f.engine.tick();
    await until(() => !!f.engine.getTask(task.taskId, f.caller).run);
    const message = newId(f.clock.now()),
      path = `/tasks/${task.taskId}/messages/${message}`;
    const posted = await f.handler(
      new Request(`http://fixture${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { contribution: 1 } }),
      }),
    );
    assert.equal(posted.status, 202);
    await until(() => f.engine.getTaskMessage(task.taskId, message, f.caller).state === "accepted");
    assert.equal((await data<TaskMessageRecord>(f.get(path))).caller.subject, f.caller.subject);
    const retry = await f.handler(
      new Request(`http://fixture${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { contribution: 2 } }),
      }),
    );
    assert.equal(retry.status, 409);
  } finally {
    await f.close();
  }
});
