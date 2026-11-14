import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import {
  type SubmissionResult,
  taskSchemaUri,
  wrapRequestParameters,
} from "@silvermoon-work/task-protocol";
import { createTaskEngine, newId } from "../src/index.js";
import { MemoryIpfsClient, MemoryStore, VirtualClock } from "../src/testing.js";

const caller = { scope: "scope", subject: "actor" };
async function until(check: () => boolean) {
  const end = performance.now() + 15_000;
  while (!check()) {
    if (performance.now() > end) throw new Error("Bundle observation timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(
  run: (value: {
    directory: string;
    cid: string;
    client: MemoryIpfsClient;
    marker: string;
    tree: ReadonlyMap<string, Buffer>;
  }) => Promise<void>,
) {
  const directory = resolve(".cache", `admission-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    const declaration = join(directory, "task.yaml"),
      entry = join(directory, "callback.ts");
    const marker = join(directory, "executions.txt");
    await writeFile(
      declaration,
      JSON.stringify({
        $schema: taskSchemaUri,
        name: "shared display name",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: true,
        },
        resultSchema: { type: "object" },
        messageSchema: false,
      }),
    );
    await writeFile(join(directory, "data.bin"), Buffer.alloc(600_000, 42));
    await writeFile(
      entry,
      `import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(marker)},"loaded\\n");
export default async (input, context) => {
  let bytes=0, chunks=0;
  const fileCid=await context.resolveContent(context.bundle,"resources/data.bin");
  const file=await context.readContent(fileCid);
  if(file.kind!=="file")throw Error("Expected file");
  for await (const chunk of file.content) { bytes+=chunk.length; chunks++; }
  for (const path of ["../worker.cjs","resources/missing"]) {
    let failed=false;try {await context.resolveContent(context.bundle,path)}catch{failed=true}
    if(!failed)throw Error("Unsafe path accepted");
  }
  const canceled=new AbortController();
  const cancellable=await context.readContent(fileCid,{signal:canceled.signal});
  if(cancellable.kind!=="file")throw Error("Expected file");
  const reader=cancellable.content.getReader();
  await reader.read();canceled.abort();let aborted=false;try{await reader.read()}catch{aborted=true}
  if(!aborted)throw Error("Cancellation not observed");
  if("generation" in context || "space" in context || "output" in context)throw Error("Legacy context exposed");
  appendFileSync(${JSON.stringify(marker)},JSON.stringify({startedAt:context.startedAt,scope:context.scope})+"\\n");
  return {value:input.value,bytes,chunks};
};`,
    );
    const built = await buildBundleFixture({
      declaration,
      entry,
      outDirectory: join(directory, "bundle"),
      resources: { "resources/data.bin": join(directory, "data.bin") },
    });
    const client = new MemoryIpfsClient();
    const cid = await client.import(built.files);
    const tree = built.files;
    await rm(entry);
    await rm(built.directory, { recursive: true });
    await run({ directory, marker, cid, client, tree });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function accepted(result: SubmissionResult): string {
  assert.equal(result.status, "accepted", JSON.stringify(result));
  if (result.status !== "accepted") throw new Error("Expected accepted admission.");
  return result.taskId;
}
test("verified memory-source Worker streams resources independent of author/host location; history needs no content or replay", async () => {
  await fixture(async ({ marker, cid, client }) => {
    const store = new MemoryStore(),
      clock = new VirtualClock();
    const options = { store, clock, ipfsClient: client, authorize: () => true };
    const engine = createTaskEngine(options);
    await engine.start();
    const request = {
      requestId: newId(clock.now()),
      bundle: cid,
      value: 7,
      timeoutMs: 1000,
      generation: "untrusted",
      startedAt: "untrusted",
      scope: "untrusted",
    };
    try {
      await engine.submit(request, caller);
      const id = accepted(
        await engine.getRequestStatus(request.requestId, { waitMs: 10_000 }, caller),
      );
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.equal(engine.getTask(id, caller).stage, "initial");
      engine.tick();
      await until(
        () =>
          engine.getTask(id, caller).stage === "completed" ||
          engine.getTask(id, caller).stage === "failed",
      );
      const snapshot = engine.getTask(id, caller);
      assert.equal(snapshot.stage, "completed", JSON.stringify(snapshot));
      const run = snapshot.run!.runId;
      await until(() => !!engine.getRun(run, caller).reclaimedAt);
      const result = snapshot.output?.result as {
        data?: { value: number; bytes: number; chunks: number };
        cidPaths?: string[];
      };
      assert.deepEqual(result?.cidPaths, []);
      assert.equal(result?.data?.value, 7);
      assert.equal(result?.data?.bytes, 600_000);
      assert.ok(typeof result?.data?.chunks === "number" && result.data.chunks > 1);
      const evaluated = await readFile(marker, "utf8");
      assert.deepEqual(JSON.parse(evaluated.trim().split("\n")[1]!), {
        startedAt: snapshot.run!.startedAt,
        scope: caller.scope,
      });
      await engine.close();
      client.blocks.clear();
      const restored = createTaskEngine(options);
      await restored.start();
      try {
        assert.equal(restored.getTask(id, caller).stage, "completed");
        assert.equal(accepted(await restored.submit(request, caller)), id);
        assert.deepEqual(
          restored.getRequest(request.requestId, caller),
          wrapRequestParameters({ ...request }),
        );
        assert.equal(await readFile(marker, "utf8"), evaluated);
      } finally {
        await restored.close();
      }
    } finally {
      await engine.close();
      store.close();
    }
  });
});
test("raw reference/hint representation stays idempotent while CID-only matching ignores hints", async () => {
  await fixture(async ({ cid, client, tree }) => {
    const store = new MemoryStore(),
      clock = new VirtualClock();
    const engine = createTaskEngine({ store, clock, ipfsClient: client, authorize: () => true });
    await engine.start();
    try {
      const request = {
        requestId: newId(clock.now()),
        bundle: { cid, hint: ["http://first", "http://second"] },
        value: 1,
        timeoutMs: 1000,
      };
      await engine.submit(request, caller);
      const first = accepted(
        await engine.getRequestStatus(request.requestId, { waitMs: 10_000 }, caller),
      );
      const ids = [first];
      for (const bundle of [
        cid,
        { cid, hint: "http://first" },
        { cid, hint: ["http://second", "http://first"] },
      ]) {
        await assert.rejects(engine.submit({ ...request, bundle }, caller), {
          code: "idempotency_conflict",
        });
        const second = { ...request, requestId: newId(clock.now()), bundle };
        await engine.submit(second, caller);
        const id = accepted(
          await engine.getRequestStatus(second.requestId, { waitMs: 10_000 }, caller),
        );
        ids.push(id);
        assert.equal(
          store.read().facts.tasks[id]!.binding.version,
          store.read().facts.tasks[first]!.binding.version,
        );
      }
      assert.equal(engine.listTasks({ bundleCid: cid }, {}, caller).items.length, 4);
      const otherTree = new Map([...tree, ["resources/data.bin", Buffer.alloc(600_000, 43)]]);
      const otherCid = await client.import(otherTree);
      const different = { ...request, requestId: newId(clock.now()), bundle: otherCid };
      await engine.submit(different, caller);
      const other = accepted(
        await engine.getRequestStatus(different.requestId, { waitMs: 10_000 }, caller),
      );
      engine.tick();
      await until(() =>
        [...ids, other].every((id) =>
          ["completed", "failed"].includes(engine.getTask(id, caller).stage),
        ),
      );
      const run = engine.getTask(first, caller).run!.runId;
      assert.ok(ids.every((id) => engine.getTask(id, caller).run!.runId === run));
      assert.notEqual(engine.getTask(other, caller).run!.runId, run);
    } finally {
      await engine.close();
      store.close();
    }
  });
});
test("preparing capacity and final failure decisions are durable; stop cancels only Engine reads and recovery retains original timing", async () => {
  await fixture(async ({ cid, client }) => {
    const store = new MemoryStore(),
      clock = new VirtualClock();
    let fetched = 0;
    const options = {
      store,
      clock,
      authorize: () => true,
      limits: { maxPreparing: 1, windowMs: 100, futureSkewMs: 0, requestResultRetentionMs: 20 },
    };
    const engine = createTaskEngine({
      ...options,
      ipfsClient: {
        block: {
          get: async (_cid, init) => {
            fetched++;
            return new Promise<Uint8Array>((_resolve, reject) => {
              init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
                once: true,
              });
            });
          },
        },
      },
    });
    await engine.start();
    const request = { requestId: newId(clock.now()), bundle: cid, value: 1, timeoutMs: 5 };
    try {
      assert.equal((await engine.submit(request, caller)).status, "preparing");
      const second = { ...request, requestId: newId(clock.now()) };
      const rejected = await engine.submit(second, caller);
      assert.equal(rejected.status, "rejected");
      await until(() => fetched === 1);
      assert.equal(Object.keys(store.read().facts.tasks).length, 0);
      await engine.close();
      clock.advance(1000);
      const restored = createTaskEngine({ ...options, ipfsClient: client });
      await restored.start();
      try {
        const id = accepted(
          await restored.getRequestStatus(request.requestId, { waitMs: 10_000 }, caller),
        );
        assert.equal(restored.getTask(id, caller).receivedAt, new Date(clock.now()).toISOString());
        assert.equal(Date.parse(restored.getTask(id, caller).deadlineAt) - clock.now(), 5);
        await assert.rejects(restored.submit(request, caller), { code: "request_expired" });
        assert.deepEqual(
          restored.getRequest(request.requestId, caller),
          wrapRequestParameters({ ...request }),
        );
        assert.deepEqual(await restored.getRequestStatus(second.requestId, {}, caller), rejected);
        clock.advance(20);
        assert.equal(restored.collectRequestResults(), 2);
      } finally {
        await restored.close();
      }
    } finally {
      await engine.close();
      store.close();
    }
  });
});
test("definitive failed acquisition is persisted and redacts transport diagnostics", async () => {
  await fixture(async ({ cid }) => {
    const store = new MemoryStore();
    let fetched = 0;
    const engine = createTaskEngine({
      store,
      authorize: () => true,
      ipfsClient: {
        block: {
          get: async () => {
            fetched++;
            throw new Error("secret transport diagnostics");
          },
        },
      },
    });

    await engine.start();
    try {
      const request = { requestId: newId(), bundle: cid, value: 1, timeoutMs: 10 };
      await engine.submit(request, caller);
      const rejected = await engine.getRequestStatus(request.requestId, { waitMs: 1000 }, caller);
      assert.equal(rejected.status, "rejected");
      assert.equal(JSON.stringify(rejected).includes("secret"), false);
      assert.deepEqual(await engine.submit(request, caller), rejected);
      assert.equal(fetched, 1);
    } finally {
      await engine.close();
      store.close();
    }
  });
});
test("invalid new references remain durable rejected intentions, while unsupported stored protocol is refused without migration", async () => {
  const store = new MemoryStore(),
    ipfsClient = new MemoryIpfsClient();
  const options = { store, ipfsClient, authorize: () => true };
  const request = {
    requestId: newId(),
    bundle: { url: "file:///legacy.tgz", digest: `sha256:${"a".repeat(64)}` },
    timeoutMs: 1000,
  };
  const engine = createTaskEngine(options);
  await engine.start();
  const rejected = await engine.submit(request, caller);
  assert.equal(rejected.status, "rejected");
  await engine.close();
  const restored = createTaskEngine(options);
  await restored.start();
  assert.deepEqual(await restored.getRequestStatus(request.requestId, {}, caller), rejected);
  assert.deepEqual(
    restored.getRequest(request.requestId, caller),
    wrapRequestParameters({ ...request }),
  );
  await restored.close();
  store.close();

  const legacy = new MemoryStore();
  const now = Date.now(),
    at = new Date(now).toISOString();
  const id = newId(now);
  legacy.claim("fixture");
  legacy.append("fixture", 0, [
    { type: "window.advanced", scope: "", occurredAt: at, data: { lowerBound: now - 1000 } },
    {
      type: "submission.preparing",
      scope: caller.scope,
      occurredAt: at,
      data: {
        record: {
          request: { ...request, requestId: id } as never,
          caller,
          arrivedAt: at,
          qualifiedLowerBound: now - 1000,
          decision: { status: "preparing", requestId: id, trackingToken: id },
        },
      },
    },
  ]);
  legacy.release("fixture");
  const before = legacy.read();
  const unsupported = createTaskEngine({ ...options, store: legacy });
  await assert.rejects(unsupported.start(), { code: "unsupported_version" });
  assert.deepEqual(legacy.read(), before);
  await unsupported.close();
  legacy.close();
});
test("legacy idempotency-only history is explicitly refused even after its Task records were collected", async () => {
  const store = new MemoryStore();
  const read = store.read.bind(store),
    id = newId();
  store.read = () => {
    const view = read();
    view.facts.requests[id] = {
      taskId: id,
      scope: caller.scope,
      intent: { requestId: id, type: "legacy", timeoutMs: 1000 } as never,
    };
    return view;
  };
  const before = store.read();
  const engine = createTaskEngine({
    store,
    ipfsClient: new MemoryIpfsClient(),
    authorize: () => true,
  });
  await assert.rejects(engine.start(), { code: "unsupported_version" });
  assert.deepEqual(store.read(), before);
  await engine.close();
  store.close();
});
