import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { createTaskEngine, newId } from "@silvermoon-work/task-engine";
import { MemoryIpfsClient, MemoryStore, VirtualClock } from "@silvermoon-work/task-engine/testing";
import { TaskError, taskSchemaUri, wrapRequestParameters } from "@silvermoon-work/task-protocol";
import { createTaskHandler, TaskClient } from "../src/index.js";

test("V10: client rejects legacy Task-shaped receipts, mismatched tracking tokens and incomplete Bundle references", async () => {
  const request = {
    requestId: newId(),
    bundle: {
      cid: "bafybeigdyrzt5sfp7udm7hu76u7ydwfmksn3y3sc57x4taoj7c3x2m3yuy",
      hint: "http://localhost:8080",
    },
    timeoutMs: 1000,
  };
  let value: unknown = { requestId: request.requestId, taskId: newId(), stage: "initial" };
  let fetched = 0;
  const client = new TaskClient({
    url: "http://fixture",
    fetch: async () => {
      fetched++;
      return new Response(JSON.stringify(value));
    },
  });
  await assert.rejects(client.submit(request), { code: "invalid_response" });
  value = { status: "preparing", requestId: request.requestId, trackingToken: newId() };
  await assert.rejects(client.getRequestStatus(request.requestId), { code: "invalid_response" });
  const before = fetched;
  await assert.rejects(
    client.submit({ ...request, bundle: { cid: request.bundle.cid } } as never),
    { code: "invalid_request" },
  );
  assert.equal(fetched, before);
});
test("V03/V05/V10: HTTP client observes Request preparation separately; disconnect does not cancel processing or create a Task", async () => {
  const directory = resolve(".cache", `http-bundle-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const caller = { scope: "scope", subject: "http" };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let downloadSignal: AbortSignal | undefined;
  const declaration = join(directory, "task.yaml");
  const callback = join(directory, "callback.ts");
  await writeFile(
    declaration,
    JSON.stringify({
      $schema: taskSchemaUri,
      name: "HTTP display",
      runtime: { type: "node", minVersion: "22.13.0" },
      entry: "worker.cjs",
      binary: [],
      parametersSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      resultSchema: true,
      messageSchema: false,
    }),
  );
  await writeFile(callback, "export default async input => input;");
  const built = await buildBundleFixture({
    declaration,
    entry: callback,
    outDirectory: join(directory, "bundle"),
  });
  const ipfs = new MemoryIpfsClient();
  await ipfs.import(built.files);
  const engine = createTaskEngine({
    store,
    clock,
    authorize: () => true,
    limits: { requestResultRetentionMs: 20 },
    ipfsClient: {
      block: {
        get: async (cid, init) => {
          downloadSignal = init!.signal!;
          await pending;
          return ipfs.block.get(cid, init);
        },
      },
    },
  });
  await engine.start();
  const handler = createTaskHandler({
    service: engine,
    resolveCaller(request) {
      if (request.headers.get("authorization") !== "Bearer test")
        throw new TaskError("unauthenticated", "Token required.");
      return caller;
    },
  });
  const fetcher: typeof fetch = async (input, init) => handler(new Request(input, init));
  const client = new TaskClient({
    url: "http://fixture",
    headers: { Authorization: "Bearer test" },
    fetch: fetcher,
  });
  const request = {
    requestId: newId(clock.now()),
    bundle: built.cid,
    value: 1,
    timeoutMs: 1000,
  };
  try {
    const preparing = await client.submit(request);
    assert.deepEqual(preparing, {
      status: "preparing",
      requestId: request.requestId,
      trackingToken: request.requestId,
    });
    assert.equal(
      (await client.getRequestStatus(request.requestId, { waitMs: 5 })).status,
      "preparing",
    );
    assert.equal(Object.keys(store.read().facts.tasks).length, 0);
    const headers = { Authorization: "Bearer test" };
    assert.equal(
      (await handler(new Request("http://fixture/task-types", { headers }))).status,
      404,
    );
    const legacy = await handler(
      new Request("http://fixture/tasks", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": newId(clock.now()),
        },
        body: JSON.stringify({ type: "old", timeoutMs: 10 }),
      }),
    );
    assert.equal(legacy.status, 400);
    const observer = new AbortController();
    const observing = handler(
      new Request(`http://fixture/requests/${request.requestId}/status?waitMs=10000`, {
        headers,
        signal: observer.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    observer.abort();
    assert.equal((await observing).status, 499);
    assert.equal(downloadSignal?.aborted, false);
    assert.equal((await client.getRequestStatus(request.requestId)).status, "preparing");
    release();
    const accepted = await client.getRequestStatus(request.requestId, { waitMs: 10_000 });
    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") throw new Error("Expected accepted.");
    assert.deepEqual(
      await client.getRequest(request.requestId),
      wrapRequestParameters({ ...request }),
    );
    engine.tick();
    const end = performance.now() + 10_000;
    while ((await client.getTask(accepted.taskId)).stage !== "completed") {
      if (performance.now() > end) throw new Error("HTTP Worker timed out.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const rejected = await client.submit({
      ...request,
      requestId: newId(clock.now()),
      value: "invalid",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(Object.keys(store.read().facts.tasks).length, 1);
    await assert.rejects(client.getRequestStatus(newId(clock.now())), { code: "not_found" });
    await assert.rejects(client.getRequestStatus(request.requestId, { waitMs: -1 }), {
      code: "invalid_request",
    });
    clock.advance(20);
    assert.equal(engine.collectRequestResults(), 2);
    await assert.rejects(client.getRequestStatus(request.requestId), {
      code: "record_unavailable",
    });
    assert.equal((await client.getTask(accepted.taskId)).stage, "completed");
  } finally {
    release();
    await engine.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
