import assert from "node:assert/strict";
import test from "node:test";
import { at, type Json, json, type Store, wrapRequestParameters } from "@silvermoon-work/task-protocol";
import { newId } from "../src/index.js";
import { MemoryStore, VirtualClock } from "../src/testing.js";
import type { LifecycleFixture } from "./driver.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";
import { caller, harness } from "./fixtures.js";

const type = (version: string): LifecycleFixture<Json> => ({
  type: "example",
  version,
  environment: "private-runtime-secret",
  parametersSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
  prepare: async (value) => value,
  validatePrepared: json,
  validateResult: json,
  validateProgress: json,
  async execute() {
    throw new Error("future task must not execute");
  },
});

test("discovery is immutable, current-only, submit-authorized and detached from author config", async () => {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const currentVersions = { example: "2" };
  const current = type("2");
  const engine = createTaskEngine({
    store,
    clock,
    types: [type("1"), current],
    currentVersions,
    authorize: (who, operation) => who.subject === "tester" && operation === "submit",
  });
  await engine.start();
  try {
    const found = engine.discoverTypes(caller);
    assert.equal(found.length, 1);
    assert.deepEqual(Object.keys(found[0]!).sort(), ["parametersSchema", "revision", "type", "version"]);
    assert.equal(found[0]?.version, "2");
    assert.ok(!JSON.stringify(found).includes("private-runtime-secret"));
    assert.ok(Object.isFrozen(found));
    assert.ok(Object.isFrozen(found[0]?.parametersSchema));
    assert.throws(() => engine.discoverTypes({ ...caller, subject: "denied" }), {
      code: "forbidden",
    });
    assert.throws(() => engine.discoverTypes({ scope: "", subject: "" }), {
      code: "unauthenticated",
    });
    currentVersions.example = "1";
    current.parametersSchema.properties = {};
    assert.equal(engine.discoverTypes(caller)[0]?.version, "2");
    const request = {
      requestId: newId(clock.now()),
      type: "example",
      value: 1,
      timeoutMs: 100,
      eligibleAt: at(clock.now() + 1000),
    };
    const revision = found[0]!.revision;
    assert.throws(() => engine.submit(request, caller, { expectedRevision: "stale" }), {
      code: "contract_revision_mismatch",
    });
    assert.deepEqual(store.read().facts.tasks, {});
    assert.ok(store.read().events.every((event) => event.type === "window.advanced"));
    const created = engine.submit(request, caller, { expectedRevision: revision });
    assert.equal(engine.submit(request, caller).taskId, created.taskId);
    assert.equal(
      engine.submit(request, caller, { expectedRevision: revision }).taskId,
      created.taskId,
    );
    assert.throws(
      () => engine.submit({ ...request, value: 2 }, caller, { expectedRevision: revision }),
      { code: "idempotency_conflict" },
    );
    assert.equal(store.read().facts.tasks[created.taskId]?.binding.contractRevision, revision);
    assert.deepEqual(
      store.read().facts.tasks[created.taskId]?.request,
      wrapRequestParameters({ ...request }),
    );
  } finally {
    await engine.close();
    store.close();
  }
});

test("revision races fail before persistence; history never silently changes Schema identity", async () => {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const original = type("1");
  const options = { store, clock, authorize: () => true };
  const first = createTaskEngine({
    ...options,
    types: [original],
    currentVersions: { example: "1" },
  });
  await first.start();
  const oldRevision = first.discoverTypes(caller)[0]!.revision;
  const raw = {
    requestId: newId(clock.now()),
    type: "example",
    value: 1,
    timeoutMs: 100,
    eligibleAt: at(clock.now() + 1000),
  };
  const task = first.submit(raw, caller);
  await first.close();
  const newer = type("2");
  const second = createTaskEngine({
    ...options,
    types: [original, newer],
    currentVersions: { example: "2" },
  });
  await second.start();
  assert.throws(
    () =>
      second.submit({ ...raw, requestId: newId(clock.now()) }, caller, {
        expectedRevision: oldRevision,
      }),
    { code: "contract_revision_mismatch" },
  );
  assert.equal(second.submit(raw, caller).taskId, task.taskId);
  assert.deepEqual(
    second.discoverTypes(caller).map((entry) => entry.version),
    ["2"],
  );
  await second.close();
  const mutated = type("1");
  mutated.parametersSchema = { type: "object" };
  const replaced = createTaskEngine({
    ...options,
    types: [mutated],
    currentVersions: { example: "1" },
  });
  await assert.rejects(replaced.start(), { code: "unsupported_contract" });
  const missing = createTaskEngine({
    ...options,
    types: [newer],
    currentVersions: { example: "2" },
  });
  await assert.rejects(missing.start(), { code: "unsupported_version" });
  const legacy: Store = {
    claim: (owner) => store.claim(owner),
    release: (owner) => store.release(owner),
    append: (...args) => store.append(...args),
    compact: (...args) => store.compact(...args),
    close: () => store.close(),
    read() {
      const view = store.read();
      for (const record of Object.values(view.facts.tasks))
        Reflect.deleteProperty(record.binding, "contractRevision");
      return view;
    },
  };
  const historical = createTaskEngine({
    ...options,
    store: legacy,
    types: [original],
    currentVersions: { example: "1" },
  });
  await assert.rejects(historical.start(), { code: "unsupported_contract" });
  store.close();
});

test("run records independently require the original contract identity", async () => {
  const h = await harness();
  try {
    h.submit();
    await h.turn();
    await h.finish();
    h.engine.tick();
    await h.engine.close();
    for (const revision of [undefined, "different"])
      for (const orphan of [false, true]) {
        const store: Store = {
          claim: (owner) => h.store.claim(owner),
          release: (owner) => h.store.release(owner),
          append: (...args) => h.store.append(...args),
          compact: (...args) => h.store.compact(...args),
          close: () => h.store.close(),
          read() {
            const view = h.store.read();
            if (orphan) view.facts.tasks = {};
            for (const run of Object.values(view.facts.runs)) {
              if (revision === undefined) Reflect.deleteProperty(run.binding, "contractRevision");
              else run.binding.contractRevision = revision;
            }
            return view;
          },
        };
        const restored = createTaskEngine({
          store,
          clock: h.clock,
          types: [h.type],
          currentVersions: { echo: "1" },
          authorize: () => true,
        });
        await assert.rejects(restored.start(), { code: "unsupported_contract" });
      }
  } finally {
    await h.close();
  }
});

test("M01 includes allowed undeclared fields and never invokes obsolete per-demand type authorization", async () => {
  const h = await harness({
    parametersSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  });
  let revoked = false;
  h.type.authorize = (input) => {
    if (revoked && input.source === "blocked") throw new Error("source permission revoked");
  };
  try {
    const owner = h.submit({ source: "owner" });
    await h.turn();
    const blocked = h.submit({ source: "blocked", matchPolicy: "terminates-after-eligible" });
    const allowed = h.submit({ source: "allowed", matchPolicy: "terminates-after-eligible" });
    const duplicate = h.submit({ source: "owner", matchPolicy: "terminates-after-eligible" });
    assert.equal(duplicate.run?.runId, h.engine.getTask(owner.taskId, caller).run?.runId);
    assert.equal(h.engine.getTask(allowed.taskId, caller).run, undefined);
    assert.equal(Object.hasOwn(h.store.read().facts.tasks[allowed.taskId]!, "prepared"), false);
    revoked = true;
    await h.finish();
    await h.turn();
    assert.ok(h.engine.getTask(allowed.taskId, caller).run);
    assert.ok(h.engine.getTask(blocked.taskId, caller).run);
    assert.notEqual(
      h.engine.getTask(allowed.taskId, caller).run?.runId,
      h.engine.getTask(owner.taskId, caller).run?.runId,
    );
    assert.notEqual(
      h.engine.getTask(blocked.taskId, caller).run?.runId,
      h.engine.getTask(owner.taskId, caller).run?.runId,
    );
    assert.notEqual(
      h.engine.getTask(allowed.taskId, caller).run?.runId,
      h.engine.getTask(blocked.taskId, caller).run?.runId,
    );
    assert.equal(
      h.engine.errors.some((error) => error.message === "source permission revoked"),
      false,
    );
    assert.equal(h.work.length, 3);
  } finally {
    await h.close();
  }
});
