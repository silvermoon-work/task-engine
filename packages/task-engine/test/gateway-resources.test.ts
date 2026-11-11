import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { BundleCache } from "../src/bundle.js";
import { createIpfsGatewayClient } from "../src/content.js";
import { createTaskEngine } from "../src/index.js";
import { newId } from "../src/identity.js";
import { MemoryIpfsClient, MemoryStore } from "../src/testing.js";

const resource = Buffer.from(
  Array.from({ length: 800_000 }, (_, i) => (i * 13 + Math.floor(i / 262_144)) % 251),
);
function tree() {
  return new Map([
    [
      "task.yaml",
      Buffer.from(
        JSON.stringify({
          $schema: taskSchemaUri,
          name: "On demand",
          runtime: { type: "node", minVersion: "22.13.0" },
          entry: "worker.cjs",
          binary: ["resources/nested/data.bin"],
          include: ["task.yaml", "worker.cjs", "resources/nested/data.bin"],
          inputSchema: { type: "object" },
          resultSchema: true,
          messageSchema: false,
        }),
      ),
    ],
    ["worker.cjs", Buffer.from("module.exports = {};")],
    ["resources/nested/data.bin", resource],
  ]);
}
async function gateway(t: TestContext, memory: MemoryIpfsClient) {
  const requests: string[] = [];
  const resourceKeys = new Set(
    [...memory.blocks]
      .filter(([, bytes]) => {
        for (let offset = 0; offset < resource.length; offset += 262_144)
          if (Buffer.from(bytes).equals(resource.subarray(offset, offset + 262_144))) return true;
        return false;
      })
      .map(([key]) => key),
  );
  let mode = "ok";
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    const url = new URL(request.url!, "http://localhost");
    assert.match(url.pathname, /^\/ipfs\/[^/]+$/);
    assert.equal(url.search, "?format=raw");
    const key = url.pathname.split("/").at(-1)!;
    requests.push(key);
    response.setHeader("content-type", "application/vnd.ipld.raw");
    if (mode === "stall") {
      response.writeHead(200);
      response.flushHeaders();
      return;
    }
    if (mode === "redirect") {
      response.writeHead(302, { location: `${url.origin}/forbidden` }).end();
      return;
    }
    if (mode === "oversize") {
      response.writeHead(200, { "content-length": 2_097_153 }).end(Buffer.alloc(2_097_153));
      return;
    }
    if (mode === "missing" || (mode === "missing-resource" && resourceKeys.has(key))) {
      response.writeHead(404).end();
      return;
    }
    const bytes = mode === "corrupt" ? Uint8Array.of(0) : memory.blocks.get(key);
    response.writeHead(bytes ? 200 : 404).end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      assert.equal(
        new URL(String(input)).origin,
        origin,
        "No unconfigured gateway, RPC or public discovery.",
      );
      assert.equal(init?.redirect, "error");
      return originalFetch(input, init);
    },
  );
  return {
    requests,
    origin,
    setMode(value: string) {
      mode = value;
    },
  };
}
async function bytes(iterator: AsyncIterator<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const item = await iterator.next();
    if (item.done) return Buffer.concat(chunks);
    chunks.push(item.value);
  }
}
test("official HTTP/UnixFS demand reads are bounded, cancelable, cached and differ from prefetch", async (t) => {
  const memory = new MemoryIpfsClient();
  const cid = await memory.import(tree());
  const host = await gateway(t, memory);
  const client = createIpfsGatewayClient(host.origin);
  const leaves = new Set(
    [...memory.blocks].filter(([, block]) => block.length > 10_000).map(([key]) => key),
  );
  const cache = new BundleCache({ ipfsClient: client });
  t.after(() => cache.close());
  const bundle = await cache.acquire(cid);
  assert.equal(
    host.requests.some((key) => leaves.has(key)),
    false,
    "Admission does not prefetch resource data.",
  );
  const stream = await bundle.read("resources/nested/data.bin", new AbortController().signal);
  const first = await stream.next();
  assert.ok(!first.done && first.value.length <= 262_144);
  assert.ok(
    host.requests.filter((key) => leaves.has(key)).length <= 2,
    "One range can read its adjacent boundary block, not the whole file.",
  );
  assert.equal(
    host.requests.some((key) => leaves.has(key) && key === [...leaves].at(-1)),
    false,
  );
  await stream.return?.();
  const controller = new AbortController();
  const canceled = await bundle.read("resources/nested/data.bin", controller.signal);
  await canceled.next();
  const count = host.requests.length;
  controller.abort();
  await assert.rejects(canceled.next());
  assert.equal(host.requests.length, count);
  for (const path of [
    "../worker.cjs",
    "resources/missing",
    "/resources/nested/data.bin",
    "resources/nested/../../worker.cjs",
  ])
    await assert.rejects(bundle.read(path, new AbortController().signal), {
      code: "invalid_bundle",
    });
  host.setMode("missing");
  const cachedRange = await bundle.read("resources/nested/data.bin", new AbortController().signal);
  assert.equal(
    (await cachedRange.next()).done,
    false,
    "The first cached block survives Gateway failure.",
  );
  await assert.rejects(bytes(cachedRange), "An unread block can fail after acceptance.");
  host.setMode("ok");
  assert.deepEqual(
    await bytes(await bundle.read("resources/nested/data.bin", new AbortController().signal)),
    resource,
  );
  host.setMode("missing");
  const allCached = host.requests.length;
  assert.deepEqual(
    await bytes(await bundle.read("resources/nested/data.bin", new AbortController().signal)),
    resource,
  );
  assert.equal(host.requests.length, allCached);
  bundle.release();
  assert.equal(await cache.evict(cid), true);

  host.setMode("ok");
  const eager = new BundleCache({ ipfsClient: client, prefetch: true });
  t.after(() => eager.close());
  const prefetched = await eager.acquire(cid);
  assert.ok([...leaves].every((key) => host.requests.includes(key)));
  host.setMode("missing");
  const before = host.requests.length;
  assert.deepEqual(
    await bytes(await prefetched.read("resources/nested/data.bin", new AbortController().signal)),
    resource,
  );
  assert.equal(host.requests.length, before, "Explicit prefetch provides offline reads.");
  prefetched.release();
});
test("configured official Gateway rejects corrupt, missing, oversized and redirect responses", async (t) => {
  const memory = new MemoryIpfsClient();
  const cid = await memory.import(tree());
  const host = await gateway(t, memory);
  const client = createIpfsGatewayClient(host.origin, { timeoutMs: 2000 });
  for (const mode of ["corrupt", "missing", "oversize", "redirect"]) {
    host.setMode(mode);
    await assert.rejects(client.block.get(cid), mode);
  }
  const controller = new AbortController();
  controller.abort();
  const before = host.requests.length;
  await assert.rejects(client.block.get(cid, { signal: controller.signal }));
  assert.equal(host.requests.length, before);
  host.setMode("stall");
  const active = new AbortController();
  const pending = client.block.get(cid, { signal: active.signal });
  const deadline = Date.now() + 1500;
  while (host.requests.length === before) {
    assert.ok(Date.now() < deadline);
    await new Promise((done) => setTimeout(done, 5));
  }
  const canceledAt = Date.now();
  active.abort();
  await assert.rejects(pending);
  assert.ok(
    Date.now() - canceledAt < 1000,
    "Cancellation interrupts a pending response body, not just future pulls.",
  );
  assert.throws(() => createIpfsGatewayClient(`${host.origin}/gateway`), /Gateway base URL/);
  assert.throws(() => createIpfsGatewayClient(`${host.origin}?x=1`), /Gateway base URL/);
});
test("a real self-contained Worker reads a nested resource through only the configured official Gateway", async (t) => {
  const directory = resolve(".cache", `official-worker-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const declaration = resolve(directory, "task.yaml"),
    entry = resolve(directory, "callback.ts");
  await writeFile(
    declaration,
    JSON.stringify({
      $schema: taskSchemaUri,
      name: "Gateway Worker",
      runtime: { type: "node", minVersion: "22.13.0" },
      entry: "worker.cjs",
      binary: [],
      inputSchema: { type: "object" },
      resultSchema: true,
      messageSchema: false,
    }),
  );
  await writeFile(resolve(directory, "resource.bin"), resource);
  await writeFile(
    entry,
    `export default async (_input,context)=>{
    let length=0,sum=0;
    const node=await context.bundle.root.resolve("resources/nested/data.bin").read();
    if(node.kind!=="file")throw Error("Expected resource file");
    for await(const chunk of node.content){
      length+=chunk.length;for(const byte of chunk)sum+=byte;
    }
    return {length,sum};
  };`,
  );
  const built = await buildBundleFixture({
    declaration,
    entry,
    resources: { "resources/nested/data.bin": resolve(directory, "resource.bin") },
    binary: ["resources/nested/data.bin"],
    outDirectory: resolve(directory, "bundle"),
  });
  const memory = new MemoryIpfsClient();
  assert.equal(await memory.import(built.files), built.cid);
  const host = await gateway(t, memory);
  const store = new MemoryStore();
  const engine = createTaskEngine({
    store,
    ipfsClient: createIpfsGatewayClient(host.origin),
    authorize: () => true,
  });
  await engine.start();
  t.after(async () => {
    await engine.close();
    store.close();
  });
  const caller = { scope: "official", subject: "fixture" };
  let decision = await engine.submit(
    { requestId: newId(), bundle: built.cid, timeoutMs: 10_000 },
    caller,
  );
  while (decision.status === "preparing")
    decision = await engine.getRequestStatus(decision.requestId, { waitMs: 1000 }, caller);
  assert.equal(decision.status, "accepted");
  if (decision.status !== "accepted") return;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const task = engine.getTask(decision.taskId, caller);
    if (task.stage === "completed") {
      assert.deepEqual(task.result, {
        length: resource.length,
        sum: resource.reduce((sum, byte) => sum + byte, 0),
      });
      break;
    }
    assert.notEqual(task.stage, "failed");
    assert.ok(Date.now() < deadline);
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.ok(host.requests.length > 4);
  host.setMode("missing-resource");
  for (const bundlePrefetch of [false, true]) {
    const coldStore = new MemoryStore();
    const cold = createTaskEngine({
      store: coldStore,
      ipfsClient: createIpfsGatewayClient(host.origin),
      bundlePrefetch,
      authorize: () => true,
    });
    await cold.start();
    try {
      let failed = await cold.submit(
        { requestId: newId(), bundle: built.cid, timeoutMs: 10_000 },
        caller,
      );
      while (failed.status === "preparing")
        failed = await cold.getRequestStatus(failed.requestId, { waitMs: 1000 }, caller);
      assert.equal(failed.status, bundlePrefetch ? "rejected" : "accepted");
      if (failed.status === "accepted") {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const task = cold.getTask(failed.taskId, caller);
          if (
            task.stage === "failed" &&
            task.run &&
            cold.getRun(task.run.runId, caller).reclaimedAt
          )
            break;
          assert.ok(Date.now() < deadline, JSON.stringify(task));
          await new Promise((done) => setTimeout(done, 10));
        }
      } else {
        assert.equal(
          Object.keys(coldStore.read().facts.tasks).length,
          0,
          "Prefetch failure never admits a Task.",
        );
      }
    } finally {
      await cold.close();
      coldStore.close();
    }
  }
});
