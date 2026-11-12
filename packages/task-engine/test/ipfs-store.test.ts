import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { createTaskEngine, IpfsStore, MemoryStore, newId } from "../src/index.js";
import { BundleCache } from "../src/bundle.js";

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
        inputSchema: { type: "object" },
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
        assert.deepEqual(result.tasks[0]?.output?.result, { value: "shared object" });
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
