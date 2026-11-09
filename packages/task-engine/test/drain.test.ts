import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { createTaskEngine as createCoordinator } from "../src/engine.js";
import { createTaskEngine, MemoryStore, newId } from "../src/index.js";
import { MemoryIpfsClient, VirtualClock } from "../src/testing.js";

const caller = { scope: "drain", subject: "owner" };
test("a falsy AbortSignal reason still rejects drain rather than declaring exhaustion", async () => {
  const store = new MemoryStore();
  const engine = createTaskEngine({
    store,
    ipfsClient: new MemoryIpfsClient(),
    authorize: () => true,
  });
  await engine.start();
  const controller = new AbortController();
  controller.abort(false);
  await assert.rejects(engine.drain({ signal: controller.signal }), (error) => error === false);
  store.close();
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) assert.fail("Drain test observation timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function artifact(
  directory: string,
  code: string,
  client: MemoryIpfsClient,
  child?: { directory: string; files: ReadonlyMap<string, Buffer> },
) {
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "main.ts");
  await writeFile(entry, code);
  const built = await buildBundleFixture({
    declaration: {
      $schema: taskSchemaUri,
      name: "Drain fixture",
      runtime: { type: "node", minVersion: "22.13.0" },
      entry: "worker.cjs",
      binary: [],
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      resultSchema: true,
      messageSchema: false,
    },
    entry,
    outDirectory: join(directory, "bundle"),
    resources: child
      ? Object.fromEntries(
          [...child.files.keys()].map((path) => [
            `resources/child/${path}`,
            join(child.directory, ...path.split("/")),
          ]),
        )
      : {},
  });
  const files = built.files;
  assert.equal(await client.import(files), built.cid);
  return { cid: built.cid, directory: built.directory, files };
}

test("drain seals admission while a root preparation is in flight", {
  timeout: 20_000,
}, async (t) => {
  const directory = resolve(".cache", `drain-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new MemoryIpfsClient();
  const bundle = await artifact(
    directory,
    "export default async input => ({value:input.value});",
    client,
  );
  const preparation = gate();
  let held = false;
  const store = new MemoryStore();
  const engine = createTaskEngine({
    store,
    authorize: () => true,
    ipfsClient: {
      block: {
        async get(cid, options) {
          if (cid === bundle.cid) {
            held = true;
            await preparation.promise;
          }
          return client.block.get(cid, options);
        },
      },
    },
  });
  await engine.start();
  try {
    assert.equal(engine.collectRequestResults(), 0);
    const submitting = engine.submit(
      { requestId: newId(), bundle: bundle.cid, value: 7, timeoutMs: 5000 },
      caller,
    );
    let completed = false;
    const draining = engine.drain().then((value) => {
      completed = true;
      return value;
    });
    assert.equal(engine.drain(), engine.drain());
    await submitting;
    await until(() => held);
    assert.equal(completed, false);
    assert.equal(Object.keys(store.read().facts.tasks).length, 0);
    await assert.rejects(
      engine.submit({ requestId: newId(), bundle: bundle.cid, value: 8, timeoutMs: 5000 }, caller),
      { code: "engine_draining" },
    );
    assert.throws(() => engine.collect(), { code: "engine_draining" });
    assert.throws(() => engine.collectRequestResults(), { code: "engine_draining" });
    preparation.release();
    const final = await draining;
    assert.equal(final.tasks.length, 1);
    assert.deepEqual(final.tasks[0]!.result, { value: 7 });
    assert.ok(Object.values(store.read().facts.runs).every((run) => run.exit && run.reclaimedAt));
    store.close();
  } finally {
    preparation.release();
    await engine.close();
  }
});

test("the last active Run admits a delayed child after drain; parallel nested closure is complete", {
  timeout: 30_000,
}, async (t) => {
  const directory = resolve(".cache", `drain-child-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new MemoryIpfsClient();
  const leaf = await artifact(
    join(directory, "leaf"),
    "export default async input => ({value:input.value});",
    client,
  );
  const marker = join(directory, "continue");
  const wrapper = (cid: string, wait: boolean) => `
import {existsSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
export default async (input,context) => {
 ${wait ? `while(!existsSync(${JSON.stringify(marker)})) await delay(5,undefined,{signal:context.signal});` : ""}
 return await Promise.all(["a","b"].map(key=>context.invokeTask({key,cid:${JSON.stringify(cid)},path:"resources/child",input:{value:input.value},timeoutMs:5000})));
};`;
  const parent = await artifact(join(directory, "parent"), wrapper(leaf.cid, false), client, leaf);
  const root = await artifact(join(directory, "root"), wrapper(parent.cid, true), client, parent);
  const preparation = gate();
  let held = false;
  const store = new MemoryStore();
  const engine = createTaskEngine({
    store,
    authorize: () => true,
    authorizeChild: () => true,
    limits: { maxConcurrent: 1, childTimeoutMs: 10_000 },
    ipfsClient: {
      block: {
        async get(cid, options) {
          if (cid === parent.cid && Object.keys(store.read().facts.runs).length) {
            held = true;
            await preparation.promise;
          }
          return client.block.get(cid, options);
        },
      },
    },
  });
  await engine.start();
  try {
    const requestId = newId();
    await engine.submit({ requestId, bundle: root.cid, value: 9, timeoutMs: 15_000 }, caller);
    const decision = await engine.getRequestStatus(requestId, { waitMs: 10_000 }, caller);
    assert.equal(decision.status, "accepted");
    if (decision.status !== "accepted") throw Error("Expected accepted root.");
    await until(() => engine.getTask(decision.taskId, caller).stage === "running");
    assert.equal(Object.keys(store.read().facts.tasks).length, 1);
    let completed = false;
    const draining = engine.drain().then((value) => {
      completed = true;
      return value;
    });
    await writeFile(marker, "continue");
    await until(() => held);
    assert.equal(completed, false);
    assert.ok(
      Object.values(store.read().facts.submissions).some(
        (record) => record.composition && record.decision.status === "preparing",
      ),
    );
    preparation.release();
    const final = await draining;
    assert.equal(final.tasks.length, 7);
    assert.ok(final.tasks.every((task) => task.stage === "completed"));
    assert.deepEqual(final.tasks.find((task) => task.requestId === requestId)!.result, [
      [{ value: 9 }, { value: 9 }],
      [{ value: 9 }, { value: 9 }],
    ]);
    assert.ok(Object.values(store.read().facts.runs).every((run) => run.exit && run.reclaimedAt));
    store.close();
  } finally {
    preparation.release();
    await engine.close();
  }
});

test("future eligible Tasks remain work; resident engines remain available after idle", {
  timeout: 20_000,
}, async (t) => {
  const directory = resolve(".cache", `drain-future-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new MemoryIpfsClient();
  const bundle = await artifact(directory, "export default async input => input;", client);
  const clock = new VirtualClock(Date.now());
  const store = new MemoryStore();
  const engine = createTaskEngine({ store, clock, ipfsClient: client, authorize: () => true });
  await engine.start();
  const submit = async (eligibleAt?: string) => {
    const requestId = newId(clock.now());
    await engine.submit(
      {
        requestId,
        bundle: bundle.cid,
        value: 1,
        timeoutMs: 5000,
        ...(eligibleAt ? { eligibleAt } : {}),
      },
      caller,
    );
    const decision = await engine.getRequestStatus(requestId, { waitMs: 5000 }, caller);
    assert.equal(decision.status, "accepted");
    if (decision.status !== "accepted") throw Error("Expected accepted Task.");
    return decision.taskId;
  };
  try {
    const first = await submit();
    engine.tick();
    await until(() => engine.getTask(first, caller).stage === "completed");
    await engine.waitForTaskRelease(first, caller);
    assert.ok(clock.pendingTimers > 0);
    clock.advance(1);
    const future = await submit(new Date(clock.now() + 1000).toISOString());
    let completed = false;
    const draining = engine.drain().then((value) => {
      completed = true;
      return value;
    });
    clock.advance(999);
    engine.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(engine.getTask(future, caller).stage, "initial");
    clock.advance(1);
    engine.tick();
    const final = await draining;
    assert.equal(final.tasks.length, 2);
    assert.equal(clock.pendingTimers, 0);
    store.close();
  } finally {
    await engine.close();
  }
});

test("logical completion is insufficient until host resource release; uncertainty rejects idle", {
  timeout: 20_000,
}, async (t) => {
  for (const uncertain of [false, true]) {
    await t.test(
      uncertain ? "unconfirmed resource cleanup" : "delayed physical reclamation",
      async () => {
        const cleanup = gate();
        let entered = false;
        const store = new MemoryStore();
        const engine = createCoordinator({
          store,
          authorize: () => true,
          types: [
            {
              type: "run-test",
              version: "1",
              environment: "trusted",
              inputSchema: {
                type: "object",
                properties: {
                  mode: { enum: ["work", "messages", "mutate"] },
                  text: { type: "string" },
                },
                required: ["mode", "text"],
                additionalProperties: false,
              },
              resultSchema: { type: "object" },
              messageSchema: {
                type: "object",
                properties: {
                  kind: { enum: ["add", "target", "finish"] },
                  amount: { type: "integer", minimum: 1, maximum: 10 },
                },
                required: ["kind"],
                additionalProperties: false,
              },
              module: new URL("./run-type.mjs", import.meta.url).href,
              exportName: "createType",
              verifyExportName: "verify",
              configuration: {},
              resources: { prepare: async () => null },
              confirmResourceRelease: async () => {
                entered = true;
                await cleanup.promise;
                if (uncertain) throw Error("No release proof.");
              },
            },
          ],
          currentVersions: { "run-test": "1" },
        });
        await engine.start();
        try {
          const task = engine.submit(
            { requestId: newId(), type: "run-test", mode: "work", text: "test", timeoutMs: 5000 },
            caller,
          );
          engine.tick();
          await until(() => entered);
          assert.equal(engine.getTask(task.taskId, caller).stage, "completed");
          assert.equal(
            engine.getRun(engine.getTask(task.taskId, caller).run!.runId, caller).reclaimedAt,
            undefined,
          );
          let completed = false;
          const idle = engine
            .waitForIdle(() => true)
            .then(() => {
              completed = true;
            });
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(completed, false);
          cleanup.release();
          if (uncertain) {
            await assert.rejects(idle, { code: "reclamation_unknown" });
            await assert.rejects(engine.close(), { code: "reclamation_failed" });
          } else {
            await idle;
            assert.ok(
              engine.getRun(engine.getTask(task.taskId, caller).run!.runId, caller).reclaimedAt,
            );
            await engine.close();
            store.close();
          }
        } finally {
          cleanup.release();
          await engine.close().catch(() => {});
        }
      },
    );
  }
});

test("drain abort cancels waiting work and physically closes", { timeout: 20_000 }, async (t) => {
  const directory = resolve(".cache", `drain-abort-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new MemoryIpfsClient();
  const bundle = await artifact(
    directory,
    'import {setTimeout as delay} from "node:timers/promises"; export default async (input,context) => { await delay(60000,undefined,{signal:context.signal}); return input; };',
    client,
  );
  const store = new MemoryStore();
  const engine = createTaskEngine({ store, ipfsClient: client, authorize: () => true });
  await engine.start();
  const requestId = newId();
  await engine.submit({ requestId, bundle: bundle.cid, value: 1, timeoutMs: 60_000 }, caller);
  await until(() => Object.values(store.read().facts.runs).some((run) => !run.exit));
  const controller = new AbortController();
  const draining = engine.drain({ signal: controller.signal });
  const reason = Error("User interrupt");
  controller.abort(reason);
  await assert.rejects(draining, (error) => error === reason);
  assert.ok(Object.values(store.read().facts.runs).every((run) => run.exit && run.reclaimedAt));
  store.close();
  assert.equal((await readFile(join(directory, "main.ts"), "utf8")).includes("delay"), true);
});
