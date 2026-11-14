import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  isPending,
  type RegisteredType,
  type Store,
  TaskError,
  wrapRequestParameters,
} from "@silvermoon-work/task-protocol";
import { createTaskEngine } from "../src/engine.js";
import { newId } from "../src/index.js";
import { MemoryStore, VirtualClock } from "../src/testing.js";

const caller = { scope: "scope", subject: "actor" };
async function until(check: () => boolean) {
  const end = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > end) assert.fail("Domain contract observation timed out.");
    await delay(5);
  }
}
function fixture(limits: Parameters<typeof createTaskEngine>[0]["limits"] = {}) {
  const store = new MemoryStore(),
    clock = new VirtualClock();
  const registration: RegisteredType = {
    type: "isolated",
    version: "1",
    environment: "trusted",
    parametersSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
    module: new URL("./isolated-type.mjs", import.meta.url).href,
    exportName: "createType",
    configuration: { messageSchema: false },
    resourceLifetime: "request",
    async confirmResourceRelease(context) {
      assert.ok(
        store.read().facts.runs[context.runId]?.exit,
        "host proof follows actual Worker exit",
      );
    },
  };
  const options = {
    store,
    clock,
    types: [registration],
    currentVersions: { isolated: "1" },
    authorize: () => true,
    limits,
  };
  const engine = createTaskEngine(options);
  const request = (extra: Record<string, unknown> = {}) => ({
    requestId: newId(clock.now()),
    type: "isolated",
    timeoutMs: 1000,
    kind: "wait",
    ...extra,
  });
  return { store, clock, registration, options, engine, request };
}
test("startup rejects an otherwise valid cached Task judgment not justified by source facts", async () => {
  const f = fixture();
  await f.engine.start();
  const task = f.engine.submit(
    f.request({ eligibleAt: new Date(f.clock.now() + 100).toISOString() }),
    caller,
  );
  await f.engine.close();
  const store: Store = {
    claim: (owner) => f.store.claim(owner),
    release: (owner) => f.store.release(owner),
    append: (...args) => f.store.append(...args),
    compact: (...args) => f.store.compact(...args),
    close: () => f.store.close(),
    read() {
      const view = f.store.read();
      view.facts.tasks[task.taskId]!.canceledAt = new Date(f.clock.now()).toISOString();
      return view;
    },
  };
  const rejected = createTaskEngine({ ...f.options, store });
  try {
    await assert.rejects(rejected.start(), { code: "storage_corrupt" });
    f.store.claim("next");
    f.store.release("next");
  } finally {
    await rejected.close();
    f.store.close();
  }
});

test("M03 end-to-end: witness survives pure rollback, real early exit invalidates through complete observation", async () => {
  const f = fixture();
  await f.engine.start();
  try {
    const b = f.engine.submit(f.request(), caller);
    f.engine.tick();
    await until(() => !!f.engine.getTask(b.taskId, caller).run);
    const runId = f.engine.getTask(b.taskId, caller).run!.runId;
    await until(() => f.engine.getRun(runId, caller).progress !== undefined);
    f.clock.setTime(f.clock.now() + 1);
    const eligible = f.clock.now() + 9;
    const a = f.engine.submit(
      f.request({
        eligibleAt: new Date(eligible).toISOString(),
        matchPolicy: "terminates-after-eligible",
      }),
      caller,
    );
    const baseline = f.engine.listTasks({ stage: "running" }, {}, caller);
    assert.deepEqual(
      baseline.tasks.map((item) => item.taskId),
      [b.taskId],
    );
    const members = f.engine.subscribeTasks({ stage: "running" }, baseline.revision, caller);
    const allMembers = f.engine.subscribeTasks({}, baseline.revision, caller);
    const single = f.engine.subscribeTask(a.taskId, baseline.revision, caller);
    try {
      f.clock.setTime(eligible);
      assert.equal(f.engine.getTask(a.taskId, caller).stage, "initial");
      assert.equal(isPending(f.engine.getTask(a.taskId, caller)), false);
      assert.equal(f.engine.getTask(a.taskId, caller).revision, baseline.revision);
      assert.deepEqual(members.pull(), []);
      f.engine.tick();
      const current = f.engine.getTask(a.taskId, caller);
      assert.equal(current.stage, "running");
      assert.equal(current.run?.runId, runId);
      const envelope = members.pull();
      assert.equal(envelope.length, 1);
      assert.equal(envelope[0]?.revision, current.revision);
      assert.deepEqual(
        envelope[0]?.changes.map((change) => [change.kind, change.id]),
        [["joined", a.taskId]],
      );
      const delta = single.pull();
      assert.equal(delta.events.length, 1);
      assert.equal(delta.events[0]?.revision, current.revision);
      assert.equal(delta.events[0]?.type, "task.changed");
      const stored = f.store.read();
      assert.equal(
        stored.events.filter((event) => event.type === "qualification-time-observed").length,
        1,
      );
      assert.equal("snapshot" in (stored.facts.tasks[a.taskId] ?? {}), false);
      assert.equal("run" in (stored.facts.tasks[a.taskId] ?? {}), false);
      f.engine.tick();
      assert.equal(f.engine.getTask(a.taskId, caller).revision, current.revision);
      f.clock.setTime(eligible - 5);
      const rollback = f.engine.getTask(a.taskId, caller);
      assert.equal(rollback.stage, "running");
      assert.equal(isPending(rollback), true);
      f.engine.cancelTask(b.taskId, caller);
      await until(() => f.engine.getRun(runId, caller).reclaimedAt !== undefined);
      assert.equal(f.engine.getTask(a.taskId, caller).stage, "initial");
      assert.equal(isPending(f.engine.getTask(a.taskId, caller)), true);
      const exited = f.store.read().facts.runs[runId]!.exit!;
      const exitRevision = `${f.store.read().storeId}:${exited.sequence}`;
      const invalidation = single.pull().events.find((event) => event.revision === exitRevision);
      assert.equal(invalidation?.type, "task.changed");
      const envelopes = [];
      for (;;) {
        const batch = members.pull();
        if (!batch.length) break;
        envelopes.push(...batch);
      }
      assert.ok(
        envelopes.some((envelope) =>
          envelope.changes.some((change) => change.id === a.taskId && change.kind === "removed"),
        ),
      );
      const allEnvelopes = [];
      for (;;) {
        const batch = allMembers.pull();
        if (!batch.length) break;
        allEnvelopes.push(...batch);
      }
      const changes = allEnvelopes.find((event) => event.revision === exitRevision);
      const changed = changes?.changes.find((change) => change.id === a.taskId);
      assert.equal(changed?.kind, "updated");
      assert.equal(changed?.summary?.stage, "initial");
      assert.equal(changed?.summary?.updatedAt, exited.occurredAt);
      assert.equal(f.engine.getTask(a.taskId, caller).updatedAt, exited.occurredAt);
      const first = f.engine.cancelTask(a.taskId, caller);
      assert.equal(first.changed, true);
      assert.equal(first.canceled, true);
      assert.equal(first.stage, "initial");
      const second = f.engine.cancelTask(a.taskId, caller);
      assert.equal(second.changed, false);
      assert.equal(second.revision, first.revision);
      const history = f.engine.getTaskHistory(a.taskId, {}, caller);
      assert.ok(history.events.some((event) => event.revision === current.revision));
      assert.equal(
        history.events.some((event) => event.type.startsWith("run.")),
        false,
      );
    } finally {
      members.close();
      allMembers.close();
      single.close();
    }
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
test("ULID floor is persistent, inclusive, checked before idempotency and cannot retreat after clock/config rollback", async () => {
  const f = fixture({ windowMs: 100, futureSkewMs: 5 });
  await f.engine.start();
  const now = f.clock.now(),
    original = f.request(),
    task = f.engine.submit(original, caller);
  try {
    assert.equal(f.engine.submit(original, caller).taskId, task.taskId);
    assert.throws(() => f.engine.submit({ ...original, kind: "other" }, caller), {
      code: "idempotency_conflict",
    });
    assert.doesNotThrow(() => f.engine.submit(f.request({ requestId: newId(now - 100) }), caller));
    assert.doesNotThrow(() => f.engine.submit(f.request({ requestId: newId(now + 5) }), caller));
    assert.throws(() => f.engine.submit(f.request({ requestId: newId(now + 6) }), caller), {
      code: "request_future",
    });
    assert.throws(
      () => f.engine.submit(f.request({ matchPolicy: "started-after-eligible" }), caller),
      { code: "unsupported_request" },
    );
    assert.throws(
      () => f.engine.submit(f.request({ recurrence: { periodMs: 1, anchor: "eligible" } }), caller),
      { code: "unsupported_request" },
    );
    f.clock.setTime(now + 101);
    assert.throws(() => f.engine.submit(original, caller), { code: "request_expired" });
    const lower = f.store.read().facts.admissionLowerBound;
    f.clock.setTime(now);
    assert.throws(() => f.engine.submit(original, caller), { code: "request_expired" });
    assert.equal(f.store.read().facts.admissionLowerBound, lower);
    assert.equal(f.engine.getTask(task.taskId, caller).receivedAt, task.receivedAt);
    await f.engine.close();
    const reopened = createTaskEngine({
      ...f.options,
      limits: { windowMs: 1000, futureSkewMs: 5 },
    });
    await reopened.start();
    try {
      assert.throws(() => reopened.submit(original, caller), { code: "request_expired" });
      assert.deepEqual(
        reopened.getRequest(task.requestId, caller),
        wrapRequestParameters({ ...original }),
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
test("forced exit stops exactly one Run; independent host proof is required for physical reclamation", async () => {
  const f = fixture({ stopGraceMs: 30, forceExitWaitMs: 500 });
  await f.engine.start();
  try {
    const blocked = f.engine.submit(f.request({ kind: "ignore-cancel" }), caller);
    const healthy = f.engine.submit(f.request(), caller);
    f.engine.tick();
    await until(
      () =>
        !!f.engine.getTask(blocked.taskId, caller).run &&
        !!f.engine.getTask(healthy.taskId, caller).run,
    );
    const blockedRun = f.engine.getTask(blocked.taskId, caller).run!.runId;
    const healthyRun = f.engine.getTask(healthy.taskId, caller).run!.runId;
    await until(
      () =>
        f.engine.getRun(blockedRun, caller).progress !== undefined &&
        f.engine.getRun(healthyRun, caller).progress !== undefined,
    );
    f.engine.cancelTask(blocked.taskId, caller);
    await f.engine.waitForTaskRelease(blocked.taskId, caller);
    assert.equal(f.engine.getTask(blocked.taskId, caller).stage, "stopped");
    assert.equal(f.engine.getTask(blocked.taskId, caller).canceled, true);
    assert.equal(f.engine.getRun(blockedRun, caller).exit?.forced, true);
    assert.equal(f.engine.getTask(healthy.taskId, caller).stage, "running");
    f.engine.cancelTask(healthy.taskId, caller);
    await f.engine.waitForTaskRelease(healthy.taskId, caller);
    assert.equal(f.engine.getTask(healthy.taskId, caller).stage, "completed");
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
test("frozen pages carry one domain revision, allow bounded limit changes, and collection replay covers later members", async () => {
  const f = fixture();
  await f.engine.start();
  try {
    for (let i = 0; i < 3; i++)
      f.engine.submit(
        f.request({ eligibleAt: new Date(f.clock.now() + 100).toISOString(), value: i }),
        caller,
      );
    const query = { sort: "created-desc" as const },
      first = f.engine.listTasks(query, { limit: 1 }, caller);
    assert.ok(first.next);
    const fourth = f.engine.submit(
      f.request({ eligibleAt: new Date(f.clock.now() + 100).toISOString(), value: 4 }),
      caller,
    );
    const next = f.engine.listTasks(query, { cursor: first.next, limit: 2 }, caller);
    assert.equal(next.revision, first.revision);
    assert.equal(next.observedAt, first.observedAt);
    assert.equal(next.tasks.length, 2);
    assert.equal(
      [...first.tasks, ...next.tasks].some((item) => item.taskId === fourth.taskId),
      false,
    );
    const subscription = f.engine.subscribeTasks({}, first.revision, caller);
    try {
      assert.deepEqual(
        subscription.pull()[0]?.changes.map((change) => change.id),
        [fourth.taskId],
      );
    } finally {
      subscription.close();
    }
    assert.throws(() => f.engine.listTasks({ ...query, pending: true } as never, {}, caller), {
      code: "unsupported_condition",
    });

    assert.throws(() => f.engine.listTasks(query, { limit: 1001 }, caller), {
      code: "invalid_request",
    });
    assert.throws(() => f.engine.subscribeTasks({}, `another-domain:1`, caller), {
      code: "invalid_revision",
    });
    const current = f.engine.getTask(fourth.taskId, caller).revision;
    const domain = current.slice(0, current.lastIndexOf(":"));
    assert.throws(() => f.engine.subscribeTask(fourth.taskId, `${domain}:999999`, caller), {
      code: "invalid_revision",
    });
    assert.throws(() => f.engine.getTaskHistory(fourth.taskId, { limit: 0 }, caller), TaskError);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});

test("cooperative AbortError is a stop without a fabricated reliable business failure", async () => {
  const f = fixture();
  await f.engine.start();
  try {
    const task = f.engine.submit(f.request({ kind: "abort-on-cancel" }), caller);
    f.engine.tick();
    await until(() => !!f.engine.getTask(task.taskId, caller).run);
    const runId = f.engine.getTask(task.taskId, caller).run!.runId;
    await until(() => f.engine.getRun(runId, caller).progress !== undefined);
    f.engine.cancelTask(task.taskId, caller);
    await f.engine.waitForTaskRelease(task.taskId, caller);
    assert.equal(f.engine.getTask(task.taskId, caller).stage, "stopped");
    assert.equal(f.engine.getRun(runId, caller).outcome, undefined);
    assert.equal(
      f.store.read().events.some((event) => event.type === "run.outcome"),
      false,
    );
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
