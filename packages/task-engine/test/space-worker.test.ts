import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { createTaskEngine, newId } from "../src/index.js";
import { MemoryIpfsClient, MemoryStore } from "../src/testing.js";

const caller = { scope: "content", subject: "worker-test" };

for (const fail of [false, true])
  test(`real Worker CID capabilities ${fail ? "reject incomplete writes" : "retain stored bytes and stream resources"}`, async () => {
    const directory = resolve(".cache", `content-worker-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const store = new MemoryStore();
    const client = new MemoryIpfsClient();
    let engine: ReturnType<typeof createTaskEngine> | undefined;
    try {
      await writeFile(
        join(directory, "task.yaml"),
        JSON.stringify({
          $schema: taskSchemaUri,
          name: "Content integration",
          runtime: { type: "node", minVersion: "22.13.0" },
          entry: "worker.cjs",
          binary: [],
          parametersSchema: { type: "object" },
          resultSchema: true,
          messageSchema: false,
        }),
      );
      await writeFile(join(directory, "greeting.txt"), "hello spaces\n");
      await writeFile(
        join(directory, "callback.ts"),
        `export default async (_input, context) => {
  if ("generation" in context || "space" in context || "output" in context) throw Error("Legacy API");
  const abort = new AbortController();
  const interrupted = context.putContent(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); }
  }), {signal: abort.signal});
  await new Promise(resolve => setTimeout(resolve, 30));
  abort.abort();
  let cancelled = false;
  try { await interrupted; } catch { cancelled = true; }
  if (!cancelled) throw Error("Write cancellation not observed");
  const greetingCid = await context.resolveContent(context.bundle, "resources/greeting.txt");
  const node = await context.readContent(greetingCid);
  if (node.kind !== "file") throw Error("Expected file");
  const copy = await context.putContent(node.content);
  const bytes = new TextEncoder().encode("generated");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      ${fail ? 'controller.error(new Error("producer failed"));' : "controller.close();"}
    }
  });
  ${fail ? "" : "const generated = await"} context.putContent(stream);
  return {
    bundle: context.bundle,
    copy: copy.toString(),
    generated: ${fail ? "undefined" : "generated.toString()"}
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
      assert.equal(!!(run.output && "cid" in run.output), false);
      for (const snapshot of [drained.tasks.find((task) => task.requestId === requestId)!, run]) {
        assert.equal(Object.hasOwn(snapshot, "result"), false);
        assert.equal(Object.hasOwn(snapshot, "outputCid"), false);
      }
      if (fail) return;
      const result = run.output?.result as {
        data: { bundle: string; copy: string; generated: string };
        cidPaths: string[];
      };
      assert.deepEqual(result.cidPaths, []);
      assert.equal(result.data.bundle, built.cid);
      assert.notEqual(result.data.copy, result.data.generated);
      assert.ok(store.readRunContentRoots(run.runId).includes(result.data.copy));
      assert.ok(store.readRunContentRoots(run.runId).includes(result.data.generated));
      assert.ok(
        run.contentAccess?.includes(built.cid) || run.contentAccess?.includes(result.data.copy),
      );
    } finally {
      await engine?.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
