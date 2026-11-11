import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { newId } from "@silvermoon-work/task-engine";
import { MemoryIpfsClient } from "@silvermoon-work/task-engine/testing";
import { TaskClient } from "@silvermoon-work/task-engine-http";
import { TaskError, taskSchemaUri } from "@silvermoon-work/task-protocol";
import { startTaskServer } from "../src/index.js";

test("V06/V10: real authenticated TCP Server executes the SDK entry, reopens SQLite v5 without content or business replay", async () => {
  const root = resolve(".cache", `server-bundle-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const database = join(root, "new-domain-v5.sqlite");
  const ipfsClient = new MemoryIpfsClient();
  const marker = join(root, "loads.txt");
  let server: Awaited<ReturnType<typeof startTaskServer>> | undefined;
  try {
    const declaration = join(root, "task.yaml"),
      callback = join(root, "callback.ts");
    await writeFile(
      declaration,
      JSON.stringify({
        $schema: taskSchemaUri,
        name: "独立 Server Bundle",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        inputSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      }),
    );
    await writeFile(
      callback,
      `import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(marker)},"loaded\\n");export default async input=>input;`,
    );
    const built = await buildBundleFixture({
      declaration,
      entry: callback,
      outDirectory: join(root, "bundle"),
    });
    await ipfsClient.import(built.files);
    await rm(callback);
    const options = {
      port: 0,
      database,
      ipfsClient,
      authorize: () => true,
      resolveCaller(request: Request) {
        if (request.headers.get("authorization") !== "Bearer test")
          throw new TaskError("unauthenticated", "Token required.");
        return { scope: "scope", subject: "caller" };
      },
    };
    server = await startTaskServer(options);
    let client = new TaskClient({ url: server.url, headers: { Authorization: "Bearer test" } });
    const request = {
      requestId: newId(),
      bundle: built.cid,
      text: "production",
      timeoutMs: 10_000,
    };
    await client.submit(request);
    const accepted = await client.getRequestStatus(request.requestId, { waitMs: 10_000 });
    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") throw new Error("Expected accepted.");
    const deadline = performance.now() + 10_000;
    for (;;) {
      const task = await client.getTask(accepted.taskId);
      if (task.stage === "completed" && (await client.getRun(task.run!.runId)).reclaimedAt) break;
      if (performance.now() > deadline) throw new Error("TCP Bundle execution timed out.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const original = await client.getTask(accepted.taskId);
    assert.equal(original.name, "独立 Server Bundle");
    assert.deepEqual(original.output?.result, { text: "production" });
    assert.equal(await readFile(marker, "utf8"), "loaded\n");
    assert.equal(
      (await fetch(`${server.url}/task-types`, { headers: { Authorization: "Bearer test" } }))
        .status,
      404,
    );
    await server.close();
    server = undefined;
    ipfsClient.blocks.clear();
    server = await startTaskServer(options);
    client = new TaskClient({ url: server.url, headers: { Authorization: "Bearer test" } });
    assert.equal((await client.getTask(accepted.taskId)).revision, original.revision);
    assert.deepEqual(await client.submit(request), accepted);
    assert.deepEqual(await client.getRequest(request.requestId), request);
    assert.equal(await readFile(marker, "utf8"), "loaded\n");
    const another = { ...request, requestId: newId() };
    await client.submit(another);
    assert.equal(
      (await client.getRequestStatus(another.requestId, { waitMs: 1000 })).status,
      "rejected",
    );
    assert.equal((await client.getTask(accepted.taskId)).stage, "completed");
    assert.equal((await client.listTasks({})).tasks.length, 1);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
