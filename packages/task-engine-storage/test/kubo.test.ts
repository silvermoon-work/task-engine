import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTaskEngine, IpfsStore, newId } from "@silvermoon-work/task-engine";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { kuboFixture } from "../../ipfs-store/test/kubo-fixture.js";
import { openSqliteStore } from "../src/index.js";

test("SQLite Engine reopen recovers stable Kubo roots, while manual block deletion fails dependent reads only", async () => {
  const directory = resolve(".cache", `sqlite-kubo-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const rpc = await kuboFixture();
  const content = new IpfsStore({
    backend: "kubo",
    apiUrl: rpc.apiUrl,
    coordinationDir: join(directory, "coordination"),
  });
  const path = join(directory, "tasks.sqlite");
  let store = openSqliteStore(path);
  let engine = createTaskEngine({ store, ipfsStore: content, authorize: () => true });
  const caller = { scope: "sqlite-kubo", subject: "test" };
  try {
    const entry = join(directory, "main.ts");
    await writeFile(
      entry,
      `export default async (_input, context) => {
      await context.output.write("/out.txt", new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("persistent output")); controller.close(); }
      }));
      return "persisted";
    };`,
    );
    const built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "SQLite Kubo",
        runtime: { type: "node", minVersion: "22.15.0" },
        entry: "worker.cjs",
        binary: [],
        inputSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      entry,
      outDirectory: join(directory, "bundle"),
    });
    for (const [cid, bytes] of built.blocks) rpc.blocks.set(cid, bytes);
    await engine.start();
    await engine.submit({ requestId: newId(), bundle: built.cid, timeoutMs: 15_000 }, caller);
    const drained = await engine.drain();
    assert.deepEqual(drained.errors, []);
    assert.equal(drained.tasks[0]!.stage, "completed");
    const task = drained.tasks[0]!;
    const output = task.output!.cid!;
    const identity = store.read().storeId;
    await engine.close();
    store.close();
    rpc.pins.delete(built.cid);
    rpc.pins.delete(output);
    store = openSqliteStore(path);
    assert.equal(store.read().storeId, identity);
    assert.equal(store.readContentBlock(output), undefined, "No SQLite output block duplicate");
    engine = createTaskEngine({ store, ipfsStore: content, authorize: () => true });
    await engine.start();
    await engine.reconcileContent();
    assert.match(rpc.pins.get(built.cid)!.Name, /^@silvermoon-work\/task-engine\//);
    assert.match(rpc.pins.get(output)!.Name, /^@silvermoon-work\/task-engine\//);
    const leaf = built.cid;
    const bytes = rpc.blocks.get(leaf)!;
    rpc.blocks.delete(leaf);
    await assert.rejects(engine.reconcileContent(), { code: "retention_unfinished" });
    assert.equal(
      engine.getTask(task.taskId, caller).stage,
      "completed",
      "Unrelated DB read still works",
    );
    rpc.blocks.set(leaf, bytes);
    await engine.reconcileContent();
  } finally {
    await engine.close();
    store.close();
    await content.close();
    await rpc.close();
    await rm(directory, { recursive: true, force: true });
  }
});
