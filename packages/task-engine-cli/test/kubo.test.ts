import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { IpfsStore } from "@silvermoon-work/ipfs-store";
import { newId } from "@silvermoon-work/task-engine";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { kuboFixture } from "../../ipfs-store/test/kubo-fixture.js";
import { importCarContent } from "../src/car.js";
import { DiskContent, Repository, pruneData } from "../src/data.js";
import { executeTask } from "../src/execution.js";
import { runBundle } from "../src/index.js";

test("managed Kubo CAR import, reads, output persistence and offline prune never create disk block/CAR copies", async () => {
  const directory = resolve(".cache", `managed-kubo-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const rpc = await kuboFixture();
  const config = {
    backend: "kubo" as const,
    apiUrl: rpc.apiUrl,
    coordinationDir: join(directory, "coordination"),
  };
  const shared = new IpfsStore(config);
  const repositories: Repository[] = [];
  const contents: DiskContent[] = [];
  try {
    const entry = join(directory, "main.ts");
    await writeFile(
      entry,
      `export default async (_input, context) => {
      const cid = await context.putContent(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("managed Kubo")); controller.close(); }
      }));
      return { done: true, cid: cid.toString() };
    };`,
    );
    const built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "Managed Kubo",
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
    const ids: string[] = [];
    for (const name of ["a", "b"]) {
      const path = join(directory, name);
      await mkdir(path);
      const repository = new Repository(path);
      repositories.push(repository);
      const content = new DiskContent(path, shared, undefined, undefined, () => {
        throw new Error("Kubo must not use a retained SQLite block read port");
      });
      contents.push(content);
      const id = newId();
      ids.push(id);
      const cid = await importCarContent(
        shared,
        await readFile(built.car),
        `${repository.contentOwner}/import/${id}`,
        repository.contentOwner,
      );
      if (name === "a") {
        await shared.retain(repository.legacyContentOwner, [built.cid]);
        await shared.confirmRetained(repository.legacyContentOwner, [built.cid]);
      }
      repository.put({
        taskId: id,
        rootId: id,
        status: "pending",
        createdAt: new Date().toISOString(),
        released: false,
        roots: [cid],
        timeoutMs: 15_000,
        parameters: {},
        cid,
      });
      await shared.confirmRetained(repository.contentOwner, [cid]);
      await executeTask(repository, id, content, {}, new AbortController().signal);
      const task = repository.get(id)!;
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      assert.equal(task.released, true);
      const stored = (task.output?.result as { data?: { cid?: string } })?.data?.cid;
      assert.equal(typeof stored, "string");
      assert.equal(repository.car(id), undefined);
      assert.equal(repository.db.prepare("SELECT count(*) AS n FROM ipfs_blocks").get()!.n, 0);
      assert.equal((await readdir(path)).includes("blocks"), false);
      assert.deepEqual(new Set(repository.contentRoots()), new Set([built.cid, stored]));
    }
    const result = repositories[0]!.get(ids[0]!)!.output?.result as
      | { data?: { cid?: string } }
      | undefined;
    const output = result?.data?.cid;
    assert.equal(typeof output, "string");
    if (typeof output !== "string") throw new Error("Expected output CID.");
    const first = await pruneData(
      repositories[0]!,
      { taskIds: [ids[0]!], cache: true },
      undefined,
      config,
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.deletedTasks, 1);
    assert.ok(rpc.pins.has(built.cid));
    assert.ok(rpc.pins.has(output), "Other managed repository keeps output");
    const second = await pruneData(
      repositories[1]!,
      { taskIds: [ids[1]!], cache: true },
      undefined,
      config,
    );
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(rpc.pins.has(built.cid), false);
    assert.equal(rpc.pins.has(output), false);
    assert.equal(rpc.calls.includes("repo/gc"), false);
    assert.equal(rpc.calls.includes("shutdown"), false);
    const temporary = await runBundle({ cid: built.cid, parameters: {}, ipfsStore: shared });
    assert.equal(temporary.status, "succeeded", JSON.stringify(temporary));
    assert.ok(rpc.pins.has(built.cid), "Domain disposal does not unpin on close");
    const afterTemporary = await pruneData(repositories[0]!, { cache: true }, undefined, config);
    assert.equal(afterTemporary.ok, true, JSON.stringify(afterTemporary));
    assert.equal(
      rpc.pins.has(built.cid),
      false,
      "A disposed MemoryStore cannot leave a permanent owner reference",
    );

    repositories[0]!.put({
      taskId: "already-committed",
      rootId: "already-committed",
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-02T00:00:00Z",
      released: true,
      releaseProof: { basis: "test" },
      roots: [],
      timeoutMs: 1,
    });
    rpc.setHook(async (command, _url, response) => {
      if (command === "pin/ls") {
        response.writeHead(503).end("{}");
        return true;
      }
      return undefined;
    });
    // Keep an owned pending hint so a failed status check is not bypassed by an empty sweep.
    rpc.setHook(undefined);
    await shared.pin(built.cid);
    rpc.setHook(async (command, _url, response) => {
      if (command === "pin/ls") {
        response.writeHead(503).end("{}");
        return true;
      }
      return undefined;
    });
    const failed = await pruneData(
      repositories[0]!,
      { taskIds: ["already-committed"] },
      undefined,
      config,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.data.deletedTasks, 1);
    if (!failed.ok) assert.equal(failed.error.code, "RETENTION_UNFINISHED");
    assert.equal(repositories[0]!.get("already-committed"), undefined);
    rpc.setHook(undefined);
    assert.equal((await pruneData(repositories[0]!, { cache: true }, undefined, config)).ok, true);
  } finally {
    await Promise.all(contents.map((content) => content.close()));
    for (const repository of repositories) repository.close();
    await shared.close();
    await rpc.close();
    await rm(directory, { recursive: true, force: true });
  }
});
