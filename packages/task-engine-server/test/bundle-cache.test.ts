import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { newId } from "@silvermoon-work/task-engine";
import { MemoryIpfsClient, MemoryStore } from "@silvermoon-work/task-engine/testing";
import { TaskClient } from "@silvermoon-work/task-engine-http";
import { taskSchemaUri, wrapRequestParameters } from "@silvermoon-work/task-protocol";
import { startTaskServer } from "../src/index.js";

test("retired cache routes return 404 without changing IPFS content or Task admission", {
  timeout: 30_000,
}, async () => {
  const root = resolve(".cache", `cache-api-retired-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  let server: Awaited<ReturnType<typeof startTaskServer>> | undefined;
  try {
    const declaration = join(root, "task.yaml"),
      entry = join(root, "callback.mjs");
    await writeFile(
      declaration,
      JSON.stringify({
        $schema: taskSchemaUri,
        name: "Internal content reuse",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      }),
    );
    await writeFile(entry, "export default async input => input;");
    const built = await buildBundleFixture({
      declaration,
      entry,
      outDirectory: join(root, "bundle"),
    });
    const ipfsClient = new MemoryIpfsClient();
    await ipfsClient.import(built.files);
    server = await startTaskServer({
      port: 0,
      store: new MemoryStore(),
      ipfsClient,
      authorize: () => true,
      resolveCaller: () => ({ subject: "local", scope: "scope" }),
    });
    const client = new TaskClient({ url: server.url });
    for (const target of [server.engine, client])
      for (const method of [
        "listCachedBundles",
        "getCachedBundle",
        "removeCachedBundle",
        "evictBundle",
      ])
        assert.equal(method in target, false);
    const request = {
      requestId: newId(),
      bundle: built.cid,
      timeoutMs: 5000,
      value: 42,
      eligibleAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await client.submit(request);
    const decision = await client.getRequestStatus(request.requestId, { waitMs: 5000 });
    assert.equal(decision.status, "accepted");
    if (decision.status !== "accepted") throw new Error("Expected accepted Task.");
    const blocks = ipfsClient.blocks.size;
    for (const path of ["/bundle-cache", `/bundle-cache/${built.cid}`])
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${server.url}${path}`, {
          method,
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 404);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, "not_found");
      }
    assert.equal(ipfsClient.blocks.size, blocks);
    assert.equal((await client.getTask(decision.taskId)).stage, "initial");
    assert.deepEqual(
      await client.getRequest(request.requestId),
      wrapRequestParameters({ ...request }),
    );
    const repeated = { ...request, requestId: newId() };
    await client.submit(repeated);
    assert.equal(
      (await client.getRequestStatus(repeated.requestId, { waitMs: 5000 })).status,
      "accepted",
    );
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
