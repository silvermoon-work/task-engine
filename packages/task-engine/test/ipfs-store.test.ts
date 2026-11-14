import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import {
  createTaskEngine,
  IpfsStore,
  MemoryStore,
  newId,
  retainedContentRoots,
} from "../src/index.js";
import { BundleCache } from "../src/bundle.js";
import { kuboFixture } from "../../ipfs-store/test/kubo-fixture.js";
import { VirtualClock } from "../src/testing.js";
import { ContentError } from "@silvermoon-work/ipfs-store";

test("Builder and two Engines consume the same injected IpfsStore without owning its lifetime", async () => {
  const directory = resolve(".cache", `injected-ipfs-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const store = new IpfsStore({ dataDir: join(directory, "content") });
  const resource = Buffer.from("a shared generic file");
  const resourceCid = CID.createV1(0x55, await sha256.digest(resource));
  const engines: ReturnType<typeof createTaskEngine>[] = [];
  try {
    await store.put(resourceCid, resource);
    const entry = join(directory, "main.ts");
    await writeFile(entry, 'export default async () => ({ value: "shared object" });');
    const built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "Shared injected store",
        runtime: { type: "node", minVersion: "22.15.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      entry,
      outDirectory: join(directory, "bundle"),
      imports: { "resources/file.bin": resourceCid.toString() },
      content: store,
    });

    for (const [cid, block] of built.blocks) await store.put(CID.parse(cid), block);
    for (let index = 0; index < 2; index++)
      engines.push(
        createTaskEngine({ store: new MemoryStore(), ipfsStore: store, authorize: () => true }),
      );
    await Promise.all(
      engines.map(async (engine) => {
        await engine.start();
        await engine.submit(
          { requestId: newId(), bundle: built.cid, timeoutMs: 10_000 },
          { scope: "same-store", subject: "caller" },
        );
        const result = await engine.drain();
        assert.deepEqual(result.errors, []);
        assert.equal(result.tasks[0]?.stage, "completed");
        assert.deepEqual(result.tasks[0]?.output?.result, {
          data: { value: "shared object" },
          cidPaths: [],
        });
        await engine.close();
      }),
    );
    const node = await store.read(resourceCid);
    assert.equal(node.type, "raw", "Neither Engine closes the caller's store.");
    const independent = new IpfsStore({ dataDir: join(directory, "content") });
    try {
      await independent.prepare(built.cid);
    } finally {
      await independent.close();
    }
  } finally {
    await Promise.allSettled(engines.map((engine) => engine.close()));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Engine resource boundary preserves typed capacity failures from the shared store", async () => {
  const bytes = Buffer.from("larger than the reader budget");
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  const content = IpfsStore.fromClient({ block: { get: async () => bytes } });
  const cache = new BundleCache({ ipfsStore: content, limits: { retainedBytes: 1 } });
  try {
    await assert.rejects(cache.block.get(cid.toString()), { code: "capacity_exceeded" });
  } finally {
    await cache.close();
    await content.close();
  }
});

test("a confirmation failure after accepted metadata is reported, not silently turned into success or rejection", async () => {
  const directory = resolve(".cache", `kubo-confirm-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const rpc = await kuboFixture();
  const database = new MemoryStore();
  let fault = true;
  class FailingConfirmation extends IpfsStore {
    override async confirmRetained(...args: Parameters<IpfsStore["confirmRetained"]>) {
      if (fault && Object.keys(database.read().facts.tasks).length) {
        fault = false;
        throw new ContentError(
          "retention_unfinished",
          "Controlled coordination confirmation failure.",
        );
      }
      await super.confirmRetained(...args);
    }
  }
  const content = new FailingConfirmation({
    backend: "kubo",
    apiUrl: rpc.apiUrl,
    coordinationDir: join(directory, "coordination"),
  });
  const engine = createTaskEngine({ store: database, ipfsStore: content, authorize: () => true });
  try {
    const entry = join(directory, "main.ts");
    await writeFile(entry, "export default async () => null;");
    const built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "Confirm failure",
        runtime: { type: "node", minVersion: "22.15.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      entry,
      outDirectory: join(directory, "bundle"),
    });
    for (const [cid, bytes] of built.blocks) rpc.blocks.set(cid, bytes);
    await engine.start();
    const requestId = newId(),
      caller = { scope: "confirm", subject: "test" };
    await engine.submit({ requestId, bundle: built.cid, timeoutMs: 15_000 }, caller);
    const decision = await engine.getRequestStatus(requestId, { waitMs: 5000 }, caller);
    assert.equal(decision.status, "accepted");
    assert.equal(Object.keys(database.read().facts.tasks).length, 1);
    assert.ok(engine.errors.some((error) => error.code === "retention_unfinished"));
    assert.ok(rpc.pins.has(built.cid), "The durable recovery intent is not undone");
  } finally {
    await engine.close();
    await content.close();
    database.close();
    await rpc.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Kubo Engine output bypasses business block storage and all retained Task/Run roots coordinate collection", async () => {
  const directory = resolve(".cache", `kubo-engine-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const rpc = await kuboFixture();
  const content = new IpfsStore({
    backend: "kubo",
    apiUrl: rpc.apiUrl,
    coordinationDir: join(directory, "coordination"),
  });
  const databases = [new MemoryStore(), new MemoryStore()];
  const clocks = [new VirtualClock(Date.now()), new VirtualClock(Date.now())];
  const engines = databases.map((store, index) =>
    createTaskEngine({
      store,
      ipfsStore: content,
      authorize: () => true,
      clock: clocks[index]!,
      limits: { retentionMs: 1 },
    }),
  );
  const caller = { scope: "kubo", subject: "test" };
  try {
    const linkedBytes = Buffer.from("an initially unpinned input block");
    const linked = CID.createV1(0x55, await sha256.digest(linkedBytes)).toString();
    rpc.blocks.set(linked, linkedBytes);
    const entry = join(directory, "main.ts");
    await writeFile(
      entry,
      `export default async (input, context) => {
      if (input.link) await context.readContent(input.link);
      let stored;
      if (input.write) stored = await context.putContent(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("retained output")); controller.close(); }
      }));
      return { json: true, stored: stored ? stored.toString() : null };
    };`,
    );
    const built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "Kubo output",
        runtime: { type: "node", minVersion: "22.15.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      entry,
      outDirectory: join(directory, "bundle"),
    });
    for (const [cid, bytes] of built.blocks) await content.put(CID.parse(cid), bytes);
    async function execute(engine: (typeof engines)[number], write: boolean) {
      const requestId = newId();
      await engine.submit(
        {
          requestId,
          bundle: built.cid,
          timeoutMs: 10_000,
          write,
          ...(write ? { link: linked } : {}),
        },
        caller,
      );
      const decision = await engine.getRequestStatus(requestId, { waitMs: 5000 }, caller);
      assert.equal(decision.status, "accepted", JSON.stringify(decision));
      assert.ok(decision.status === "accepted");
      const deadline = Date.now() + 15_000;
      while (
        !["completed", "failed", "stopped"].includes(engine.getTask(decision.taskId, caller).stage)
      ) {
        assert.ok(Date.now() < deadline);
        clocks[engines.indexOf(engine)]!.advance(10);
        await new Promise((done) => setTimeout(done, 10));
      }
      await engine.waitForTaskRelease(decision.taskId, caller);
      const result = engine.getTask(decision.taskId, caller);
      assert.equal(result.stage, "completed", JSON.stringify(result));
      return result;
    }
    await Promise.all(engines.map((engine) => engine.start()));
    const [a, b] = await Promise.all(engines.map((engine) => execute(engine, true)));
    const storedA = (a!.output?.result as { data?: { stored?: string } })?.data?.stored;
    const storedB = (b!.output?.result as { data?: { stored?: string } })?.data?.stored;
    assert.equal(typeof storedA, "string");
    assert.equal(storedA, storedB);
    const output = storedA!;
    assert.ok(
      rpc.pins.has(linked),
      "Imported existing blocks receive staging protection before publication",
    );
    const jsonOnly = await execute(engines[0]!, false);
    assert.deepEqual(jsonOnly.output?.result, { data: { json: true, stored: null }, cidPaths: [] });
    assert.equal(
      databases[0]!.readContentBlock(output),
      undefined,
      "No business block shadow copy",
    );
    const historical = structuredClone(databases[0]!.read().facts);
    historical.tasks = {};
    assert.deepEqual(
      new Set(retainedContentRoots(historical, databases[0])),
      new Set([built.cid, output, linked]),
      "Historical retained Runs keep their roots without a current Task",
    );
    const pureJson = structuredClone(historical);
    for (const run of Object.values(pureJson.runs)) {
      run.output = { result: { data: { looksLikeCid: output }, cidPaths: [] } };
      if (run.outcome)
        run.outcome.output = { result: { data: { looksLikeCid: output }, cidPaths: [] } };
    }
    assert.deepEqual(
      retainedContentRoots(pureJson),
      [built.cid],
      "JSON results without a CID do not invent output roots",
    );
    const corrupt = structuredClone(historical);
    Object.values(corrupt.runs)[0]!.output = { result: null, cid: "" } as never;
    await assert.rejects(
      content.reconcile("invalid-snapshot", () => retainedContentRoots(corrupt)),
      { code: "retention_unfinished" },
    );
    assert.ok(
      rpc.pins.has(output) && rpc.pins.has(built.cid),
      "A present but invalid persisted CID must fail marking, not be treated as no CID",
    );
    clocks[0]!.advance(20_000);
    await engines[0]!.collect();
    assert.equal(Object.keys(databases[0]!.read().facts.runs).length, 0);
    assert.ok(rpc.pins.has(built.cid));
    assert.ok(rpc.pins.has(output), "Other Engine still retains output");
    clocks[1]!.advance(20_000);
    await engines[1]!.collect();
    assert.equal(rpc.pins.has(built.cid), false);
    assert.equal(rpc.pins.has(output), false);
  } finally {
    await Promise.allSettled(engines.map((engine) => engine.close()));
    await content.close();
    await rpc.close();
    await rm(directory, { recursive: true, force: true });
  }
});
