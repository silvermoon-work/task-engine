import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import {
  assertFactsVersion,
  reduce,
  type Store,
  type StoreView,
  taskSchemaUri,
} from "@silvermoon-work/task-protocol";
import { createTaskEngine, newId } from "../src/index.js";
import { MemoryIpfsClient, MemoryStore, VirtualClock } from "../src/testing.js";

const caller = { scope: "composition", subject: "external-caller" };
async function until(check: () => boolean, milliseconds = 10_000) {
  const end = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > end) throw new Error("Composition observation timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
type Artifact = { cid: string; directory: string; files: ReadonlyMap<string, Buffer> };
async function fixtures(directory: string, client: MemoryIpfsClient) {
  let next = 0;
  async function build(
    code: string,
    child?: Artifact,
    resultSchema: unknown = true,
    shared?: Artifact,
  ) {
    const root = join(directory, String(next++));
    await mkdir(root, { recursive: true });
    const entry = join(root, "main.ts");
    await writeFile(entry, code);
    const built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "Generic composing Task",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" }, mode: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        resultSchema,
        messageSchema: false,
      },
      entry,
      outDirectory: join(root, "bundle"),
      ...(child
        ? {
            imports: {
              "resources/child": child.cid,
              ...(shared ? { "resources/shared": shared.cid } : {}),
            },
            content: client,
          }
        : {}),
    });
    const files = built.files;
    for (const [cid, bytes] of built.blocks) client.blocks.set(cid, bytes);
    const cid = built.cid;
    return { cid, directory: built.directory, files };
  }
  const leaf = await build(
    `
import {setTimeout as delay} from "node:timers/promises";
export default async (input, context) => {
 if(input.mode==="slow") await delay(60000,undefined,{signal:context.signal});
 return {value:input.mode==="invalid-result"?"invalid":input.value};
};`,
    undefined,
    {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    },
  );
  const wrapper = (child: Artifact) => `
import {parentPort} from "node:worker_threads";
import {getEventListeners} from "node:events";
export default async (input, context) => {
 const request = {key:"one",bundle:context.bundle.root.resolve("resources/child"),input:{value:input.value,mode:input.mode||"normal"},timeoutMs:2000};
 if(input.mode==="mismatch") request.bundle=context.bundle.root.resolve("resources/missing");
 if(input.mode==="output") request.bundle=context.output.root;
 if(input.mode==="external") request.bundle=context.space(${JSON.stringify(child.cid)}).root;
 if(input.mode==="legacy") return context.invokeTask({key:"old",cid:${JSON.stringify(child.cid)},path:"resources/child",input:{value:input.value},timeoutMs:2000});
 if(input.mode==="forged") request.bundle={...request.bundle};
 if(input.mode==="invalid-input") request.input.value="invalid";
 if(input.mode==="timeout") {request.input.mode="slow";request.timeoutMs=100;}
 if(input.mode==="replay") {
   const [a,b]=await Promise.all([context.invokeTask(request),context.invokeTask(request)]);
   const c=await context.invokeTask(request);
   return {a,b,c};
 }
 if(input.mode==="lost-response") {
   const handlers=getEventListeners(parentPort,"message");
   let dropped=false;
   parentPort.removeAllListeners("message");
   parentPort.on("message",message=>{
     if(message.kind==="ack"&&message.value?.value===7&&!dropped) {dropped=true;return;}
     for(const handler of handlers) handler.call(parentPort,message);
   });
   void context.invokeTask(request).catch(()=>{});
   await new Promise(resolve=>setTimeout(resolve,250));
   const result=await context.invokeTask(request);
   if(!dropped) throw Error("No child acknowledgement was dropped");
   return result;
 }
 if(input.mode==="conflict") {
   const first=context.invokeTask({...request,input:{value:1,mode:"slow"}});
   try { await context.invokeTask({...request,input:{value:2}}); }
   finally {void first.catch(()=>{});}
 }
 if(input.mode==="concurrent") return await Promise.all([context.invokeTask({...request,key:"a",input:{value:1,mode:"slow"}}),context.invokeTask({...request,key:"b",input:{value:2,mode:"slow"}})]);
 if(input.mode==="total") {
   await context.invokeTask(request);
   return await context.invokeTask({...request,key:"two"});
 }
 if(input.mode==="early-exit"||input.mode==="hard-exit") {
   void context.invokeTask({...request,input:{value:input.value,mode:"slow"}}).catch(()=>{});
   await new Promise(resolve=>setTimeout(resolve,100));
   if(input.mode==="hard-exit") process.exit(9);
   return {early:true};
 }
 return await context.invokeTask(request);
};`;
  const parent = await build(wrapper(leaf), leaf);
  const externalParent = await build(wrapper(leaf));
  const nested = await build(wrapper(parent), parent, true, leaf);
  return { leaf, parent, nested, externalParent };
}

// Budget includes native build/CAR fixtures and sequential scenarios, not child deadlines.
test("generic host-mediated child Tasks", { timeout: 60_000 }, async (t) => {
  const directory = resolve(".cache", `composition-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new MemoryIpfsClient();
  const artifacts = await fixtures(directory, client);
  async function run(
    body: (engine: ReturnType<typeof createTaskEngine>, store: MemoryStore) => Promise<void>,
    extra: Partial<Parameters<typeof createTaskEngine>[0]> = {},
  ) {
    const store = new MemoryStore();
    const engine = createTaskEngine({
      store,
      ipfsClient: client,
      authorize: () => true,
      limits: {
        maxConcurrent: 1,
        maxChildConcurrent: 1,
        stopGraceMs: 1000,
        forceExitWaitMs: 1000,
        childCleanupMs: 2000,
      },
      ...extra,
    });
    await engine.start();
    try {
      await body(engine, store);
    } finally {
      await engine.close();
      store.close();
    }
  }
  async function submit(
    engine: ReturnType<typeof createTaskEngine>,
    cid: string,
    mode = "normal",
    timeoutMs = 5000,
    requestAt = Date.now(),
  ) {
    const requestId = newId(requestAt);
    await engine.submit({ requestId, bundle: cid, value: 7, mode, timeoutMs }, caller);
    const decision = await engine.getRequestStatus(requestId, { waitMs: 5000 }, caller);
    assert.equal(decision.status, "accepted", JSON.stringify(decision));
    if (decision.status !== "accepted") throw new Error("Expected admission.");
    return decision.taskId;
  }
  async function settled(engine: ReturnType<typeof createTaskEngine>, id: string) {
    await until(() =>
      ["completed", "failed", "stopped"].includes(engine.getTask(id, caller).stage),
    );
    return engine.getTask(id, caller);
  }
  await t.test("capacity one has distinct parent, child and grandchild lanes", () =>
    run(async (engine, store) => {
      const id = await submit(engine, artifacts.nested.cid);
      const task = await settled(engine, id);
      assert.equal(task.stage, "completed", JSON.stringify(task));
      assert.deepEqual(task.output?.result, { value: 7 });
      assert.equal(Object.values(store.read().facts.tasks).length, 3);
      assert.deepEqual(
        Object.values(store.read().facts.submissions)
          .flatMap((record) => (record.composition ? [record.composition.depth] : []))
          .sort(),
        [1, 2],
      );
      await engine.waitForTaskRelease(id, caller);
    }),
  );
  await t.test("lost acknowledgement retry reuses one durable child identity", () =>
    run(async (engine, store) => {
      const id = await submit(engine, artifacts.parent.cid, "replay");
      const task = await settled(engine, id);
      assert.equal(task.stage, "completed", JSON.stringify(task));
      assert.deepEqual(task.output?.result, { a: { value: 7 }, b: { value: 7 }, c: { value: 7 } });
      assert.equal(
        Object.values(store.read().facts.submissions).filter((record) => record.composition).length,
        1,
      );
      const child = Object.values(store.read().facts.submissions).find(
        (record) => record.composition,
      )!;
      assert.equal(child.composition!.targetCid, artifacts.leaf.cid);
      assert.equal(child.request.bundle, child.composition!.targetCid);
      assert.deepEqual(child.composition!.source, {
        sid: `ipfs:${artifacts.parent.cid}`,
        path: "/resources/child",
      });
      assert.ok(Date.parse(child.composition!.deadlineAt) <= Date.parse(task.deadlineAt));
    }),
  );
  await t.test("actual dropped IPC reply retries by original key without duplicate admission", () =>
    run(async (engine, store) => {
      const id = await submit(engine, artifacts.parent.cid, "lost-response");
      const task = await settled(engine, id);
      assert.equal(task.stage, "completed", JSON.stringify(task));
      assert.deepEqual(task.output?.result, { value: 7 });
      assert.equal(
        Object.values(store.read().facts.submissions).filter((record) => record.composition).length,
        1,
      );
    }),
  );
  await t.test(
    "prepared imported static closure runs after its source is disconnected",
    async () => {
      let activeStore: MemoryStore | undefined;
      let offlineReads = 0;
      const source = {
        block: {
          get: async (cid: string, options?: { signal?: AbortSignal }) => {
            if (activeStore && Object.keys(activeStore.read().facts.runs).length) {
              offlineReads++;
              throw new Error("Source disconnected after static preparation.");
            }
            return client.block.get(cid, options);
          },
        },
      };
      await run(
        async (engine, store) => {
          activeStore = store;
          const task = await settled(engine, await submit(engine, artifacts.nested.cid));
          assert.equal(task.stage, "completed", JSON.stringify(task));
          assert.deepEqual(task.output?.result, { value: 7 });
          assert.equal(Object.keys(store.read().facts.runs).length, 3);
          assert.equal(offlineReads, 0);
        },
        { ipfsClient: source },
      );
    },
  );
  await t.test(
    "completed parent restart preserves proof without reauthorizing historical children",
    () =>
      run(async (engine, store) => {
        const id = await submit(engine, artifacts.parent.cid);
        await settled(engine, id);
        await engine.waitForTaskRelease(id, caller);
        await engine.close();
        const before = store.read();
        const legacy = structuredClone(before.facts);
        const oldChild = Object.values(legacy.submissions).find((record) => record.composition)!;
        Reflect.deleteProperty(oldChild.composition!, "invocationVersion");
        assert.throws(() => assertFactsVersion(legacy), { code: "unsupported_version" });
        assert.deepEqual(store.read().facts, before.facts);
        const errors: unknown[] = [];
        const restored = createTaskEngine({
          store,
          ipfsClient: client,
          authorize: () => false,
          onError: (error) => errors.push(error),
        });
        await restored.start();
        try {
          assert.deepEqual(errors, []);
          assert.equal(store.read().facts.watermark, before.facts.watermark);
          assert.ok(
            Object.values(store.read().facts.runs).every(
              (run) => run.reclaimedAt && !run.cleanupUnknown,
            ),
          );
        } finally {
          await restored.close();
        }
      }),
  );
  for (const [mode, code] of [
    ["mismatch", "invalid_bundle"],
    ["output", "invalid_space"],
    ["legacy", "invalid_request"],
    ["forged", "invalid_space"],
    ["invalid-input", "invalid_input"],
    ["invalid-result", "invalid_input"],
    ["conflict", "idempotency_conflict"],
    ["concurrent", "child_quota_exceeded"],
    ["timeout", "child_timeout"],
  ])
    await t.test(`${mode} fails explicitly`, () =>
      run(async (engine) => {
        const task = await settled(engine, await submit(engine, artifacts.parent.cid, mode));
        assert.equal(task.stage, "failed", JSON.stringify(task));
        assert.equal(task.error?.code, code, JSON.stringify(task));
      }),
    );
  await t.test("external SpaceRef starts an independent child without authorizeChild", () =>
    run(async (engine, store) => {
      const task = await settled(
        engine,
        await submit(engine, artifacts.externalParent.cid, "external"),
      );
      assert.equal(task.stage, "completed", JSON.stringify(task));
      assert.equal(Object.keys(store.read().facts.tasks).length, 2);
    }, {}),
  );
  for (const quota of ["depth", "total"])
    await t.test(`${quota} quota is bounded`, () =>
      run(
        async (engine) => {
          const task = await settled(
            engine,
            await submit(
              engine,
              quota === "depth" ? artifacts.nested.cid : artifacts.parent.cid,
              quota === "total" ? "total" : "normal",
            ),
          );
          assert.equal(task.error?.code, "child_quota_exceeded", JSON.stringify(task));
        },
        {
          limits: {
            maxConcurrent: 1,
            maxChildConcurrent: 1,
            maxChildDepth: quota === "depth" ? 1 : 4,
            maxChildTotal: quota === "total" ? 1 : 64,
          },
        },
      ),
    );
  for (const mode of ["cancel", "early-exit"])
    await t.test(`${mode} cancels and releases descendants`, () =>
      run(async (engine, store) => {
        const id = await submit(
          engine,
          artifacts.parent.cid,
          mode.endsWith("exit") ? mode : "slow",
          5000,
        );
        await until(() =>
          Object.values(store.read().facts.submissions).some(
            (record) => record.composition?.parentRunId,
          ),
        );
        if (mode === "cancel") engine.cancelTask(id, caller);
        await settled(engine, id);
        await engine.waitForTaskRelease(id, caller);
        const children = Object.values(store.read().facts.submissions).filter(
          (record) => record.composition,
        );
        assert.equal(children.length, 1);
        for (const record of children) {
          assert.equal(record.decision.status, "accepted");
          if (record.decision.status === "accepted") {
            assert.equal(engine.getTask(record.decision.taskId, caller).canceled, true);
            await engine.waitForTaskRelease(record.decision.taskId, caller);
          }
        }
      }),
    );
  await t.test("parent-timeout cancels and releases already dispatched descendants", async () => {
    const clock = new VirtualClock(Date.now());
    await run(
      async (engine, store) => {
        const id = await submit(engine, artifacts.parent.cid, "slow", 10_000, clock.now());
        await until(() => {
          engine.tick();
          const parent = engine.getTask(id, caller);
          if (["failed", "stopped"].includes(parent.stage))
            assert.fail(`Parent ended before child dispatch: ${JSON.stringify(parent)}`);
          return Object.values(store.read().facts.submissions).some((record) => {
            if (!record.composition || record.decision.status !== "accepted") return false;
            const run = engine.getTask(record.decision.taskId, caller).run;
            return !!run && engine.getRun(run.runId, caller).stage === "running";
          });
        });
        const child = Object.values(store.read().facts.submissions).find(
          (record) => record.composition,
        )!;
        assert.equal(child.decision.status, "accepted");
        if (child.decision.status !== "accepted") throw new Error("Expected dispatched child.");
        clock.advance(10_001);
        engine.tick();
        await settled(engine, id);
        await engine.waitForTaskRelease(id, caller);
        assert.equal(engine.getTask(child.decision.taskId, caller).canceled, true);
        await engine.waitForTaskRelease(child.decision.taskId, caller);
        const parentRun = engine.getRun(engine.getTask(id, caller).run!.runId, caller);
        assert.equal(parentRun.stopRequested?.reason, "no_active_demand");
        assert.ok(parentRun.reclaimedAt);
        assert.equal(parentRun.cleanupUnknown, undefined);
      },
      { clock },
    );
  });
  await t.test(
    "killed parent cleans descendants without inventing parent resource-release proof",
    async () => {
      const store = new MemoryStore();
      const engine = createTaskEngine({
        store,
        ipfsClient: client,
        authorize: () => true,
        limits: { stopGraceMs: 50, forceExitWaitMs: 1000 },
      });
      await engine.start();
      const id = await submit(engine, artifacts.parent.cid, "hard-exit");
      await settled(engine, id);
      const child = Object.values(store.read().facts.submissions).find(
        (record) => record.composition,
      )!;
      assert.equal(child.decision.status, "accepted");
      if (child.decision.status !== "accepted") throw new Error("Expected child admission.");
      await engine.waitForTaskRelease(child.decision.taskId, caller);
      await until(
        () => !!engine.getRun(engine.getTask(id, caller).run!.runId, caller).cleanupUnknown,
      );
      await assert.rejects(engine.waitForTaskRelease(id, caller), { code: "reclamation_unknown" });
      assert.equal(engine.getTask(child.decision.taskId, caller).canceled, true);
      // Store ownership deliberately remains retained when OS side effects have no proof.
      await assert.rejects(engine.close(), { code: "reclamation_failed" });
    },
  );
  await t.test(
    "cancel while child content is preparing cannot later create an orphan Task",
    async () => {
      const store = new MemoryStore();
      let release!: () => void;
      let held = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const source = {
        block: {
          async get(cid: string, options?: { signal?: AbortSignal }) {
            return client.block.get(cid, options);
          },
        },
      };
      const engine = createTaskEngine({
        store,
        ipfsClient: source,
        authorize: () => true,
        bundlePreparation: {
          acquire: async () => {
            if (Object.keys(store.read().facts.runs).length) {
              held = true;
              await gate;
            }
            return () => {};
          },
        },
      });
      await engine.start();
      try {
        const id = await submit(engine, artifacts.parent.cid, "slow");
        await until(() => held);
        engine.cancelTask(id, caller);
        await settled(engine, id);
        await engine.waitForTaskRelease(id, caller);
        release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const child = Object.values(store.read().facts.submissions).find(
          (record) => record.composition,
        )!;
        assert.equal(child.decision.status, "rejected");
        assert.equal(Object.keys(store.read().facts.tasks).length, 1);
      } finally {
        release();
        await engine.close();
        store.close();
      }
    },
  );
  await t.test(
    "restart cancels persisted descendants and retains explicit unknown release",
    async () => {
      let snapshot!: StoreView;
      let parentId = "";
      await run(async (engine, store) => {
        parentId = await submit(engine, artifacts.parent.cid, "slow");
        await until(() => Object.values(store.read().facts.runs).length === 2);
        await writeFile(join(directory, "crash-facts.json"), JSON.stringify(store.read()));
      });
      snapshot = JSON.parse(
        await readFile(join(directory, "crash-facts.json"), "utf8"),
      ) as StoreView;
      let owner: string | undefined;
      const content = new MemoryStore();
      const store: Store = {
        claim(id) {
          content.claim(id);
          owner = id;
        },
        release(id) {
          assert.equal(id, owner);
          owner = undefined;
          content.release(id);
        },
        read: () => structuredClone(snapshot),
        append(id, watermark, events) {
          assert.equal(id, owner);
          assert.equal(watermark, snapshot.facts.watermark);
          const added = events.map((event, index) => ({
            ...event,
            sequence: watermark + index + 1,
          }));
          snapshot = {
            ...snapshot,
            facts: reduce(snapshot.facts, added),
            events: [...snapshot.events, ...added],
          };
          return structuredClone(snapshot);
        },
        compact() {
          throw new Error("Not required.");
        },
        readContentBlock: content.readContentBlock.bind(content),
        writeContentBlock: content.writeContentBlock.bind(content),
        retainRunContent: content.retainRunContent.bind(content),
        readRunContentRoots: content.readRunContentRoots.bind(content),
        readRunContentAccess: content.readRunContentAccess.bind(content),
        close: () => content.close(),
      };
      const errors: unknown[] = [];
      const engine = createTaskEngine({
        store,
        ipfsClient: client,
        authorize: () => true,
        limits: { childCleanupMs: 50 },
        onError: (error) => errors.push(error),
      });
      await engine.start();
      try {
        assert.equal(engine.getTask(parentId, caller).stage, "stopped");
        const child = Object.values(snapshot.facts.submissions).find(
          (record) => record.composition,
        )!;
        assert.equal(child.decision.status, "accepted");
        if (child.decision.status !== "accepted") throw new Error("Expected retained child.");
        assert.equal(engine.getTask(child.decision.taskId, caller).canceled, true);
        const run = engine.getRun(engine.getTask(child.decision.taskId, caller).run!.runId, caller);
        assert.equal(run.exit?.basis, "recovery");
        assert.equal(run.reclaimedAt, undefined);
        await assert.rejects(engine.waitForTaskRelease(child.decision.taskId, caller), {
          code: "reclamation_unconfirmed",
        });
        assert.ok(errors.length > 0);
        assert.match(
          (errors[0] as { message: string }).message,
          /unconfirmed child cleanup: reclamation_unconfirmed: Physical resource release is unknown/,
        );
        assert.ok(Object.values(snapshot.facts.runs).some((run) => run.cleanupUnknown));
        assert.equal(
          Object.values(snapshot.facts.submissions).filter((record) => record.composition).length,
          1,
        );
      } finally {
        await engine.close();
      }
    },
  );
});
