import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { openContent } from "../src/content.js";
import { createTaskEngine, newId } from "../src/index.js";
import { MemoryIpfsClient, MemoryStore } from "../src/testing.js";

const caller = { scope: "spaces", subject: "worker-test" };

for (const fail of [false, true])
  test(`real Worker space operations ${fail ? "reject incomplete writes" : "retain final output and references"}`, async () => {
    const directory = resolve(".cache", `space-worker-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const store = new MemoryStore();
    const client = new MemoryIpfsClient();
    let engine: ReturnType<typeof createTaskEngine> | undefined;
    try {
      await writeFile(
        join(directory, "task.yaml"),
        JSON.stringify({
          $schema: taskSchemaUri,
          name: "Space integration",
          runtime: { type: "node", minVersion: "22.13.0" },
          entry: "worker.cjs",
          binary: [],
          inputSchema: { type: "object" },
          resultSchema: true,
          messageSchema: false,
        }),
      );
      await writeFile(join(directory, "greeting.txt"), "hello spaces\n");
      await writeFile(
        join(directory, "callback.ts"),
        `export default async (_input, context) => {
  if ("generation" in context || "checkpoint" in context) throw Error("Legacy API");
  const abort = new AbortController();
  const interrupted = context.output.write("/cancelled.txt", new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); }
  }), {signal: abort.signal});
  await new Promise(resolve => setTimeout(resolve, 30));
  abort.abort();
  let cancelled = false;
  try { await interrupted; } catch { cancelled = true; }
  if (!cancelled) throw Error("Write cancellation not observed");
  let partial = false;
  try { await context.output.root.resolve("cancelled.txt").read(); partial = true; } catch {}
  if (partial) throw Error("Cancelled file was committed");
  const ref = context.bundle.root.resolve("resources");
  await context.output.link("/", ref);
  const node = await context.output.root.resolve("greeting.txt").read();
  if (node.kind !== "file") throw Error("Expected file");
  await context.output.write("/copies/greeting.txt", node.content);
  await context.output.link("/copies/old", context.output.root.resolve("copies"));
  const before = await context.output.getCid();
  const bytes = new TextEncoder().encode("generated");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      ${fail ? 'controller.error(new Error("producer failed"));' : "controller.close();"}
    }
  });
  ${fail ? "" : "await"} context.output.write("/generated/result.txt", stream);
  return {
    bundleCid: context.bundle.cid,
    before,
    ref: context.output.root.resolve("generated/result.txt").toJSON()
  };
};`,
      );
      const built = await buildBundleFixture({
        declaration: join(directory, "task.yaml"),
        entry: join(directory, "callback.ts"),
        resources: { "resources/greeting.txt": join(directory, "greeting.txt") },
        outDirectory: join(directory, "bundle"),
      });
      await client.import(built.files);
      engine = createTaskEngine({ store, ipfsClient: client, authorize: () => true });
      await engine.start();
      const requestId = newId();
      await engine.submit({ requestId, bundle: built.cid, timeoutMs: 15_000 }, caller);
      const drained = await engine.drain();
      assert.equal(drained.runs.length, 1);
      const run = drained.runs[0]!;
      assert.ok(run.reclaimedAt, JSON.stringify(run));
      assert.equal(run.stage, fail ? "failed" : "completed", JSON.stringify(run));
      if (fail) {
        assert.equal(run.outputCid, undefined);
        return;
      }
      assert.ok(run.outputCid);
      const task = drained.tasks.find((task) => task.requestId === requestId)!;
      assert.equal(task.outputCid, run.outputCid);
      assert.ok(store.readRunContentRoots(run.runId).includes(run.outputCid));
      assert.ok(run.contentAccess?.includes(`ipfs:${built.cid}`));
      const result = run.result as { bundleCid: string; before: string; ref: unknown };
      assert.equal(result.bundleCid, built.cid);
      assert.notEqual(result.before, run.outputCid);
      assert.deepEqual(result.ref, {
        sid: `run:${run.runId}:output`,
        path: "/generated/result.txt",
      });
      await engine.close();
      client.blocks.clear();
      const access = {
        signal: new AbortController().signal,
        retainedBlocks: new Map<string, Uint8Array>(),
        retentionBudget: { bytes: 0, limit: 16 * 1024 * 1024 },
        maxBlockBytes: 2 * 1024 * 1024,
        maxDagBlocks: 1024,
      };
      const local = {
        block: {
          async get(cid: string) {
            const bytes = store.readContentBlock(cid);
            assert.ok(bytes, `Missing retained block ${cid}`);
            return bytes;
          },
        },
      };
      for (const [path, expected] of [
        ["generated/result.txt", "generated"],
        ["copies/old/greeting.txt", "hello spaces\n"],
      ]) {
        const node = await openContent(local, `${run.outputCid}/${path}`, access);
        assert.ok(node.type === "file" || node.type === "raw");
        const chunks: Uint8Array[] = [];
        for await (const chunk of node.content()) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), expected);
      }
      engine = createTaskEngine({ store, ipfsClient: client, authorize: () => true });
      await engine.start();
      assert.equal(engine.getRun(run.runId, caller).outputCid, run.outputCid);
    } finally {
      await engine?.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
