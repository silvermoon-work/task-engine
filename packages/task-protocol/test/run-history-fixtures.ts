import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  isRunHistoryFinalizable,
  matchedRun,
  type NewEvent,
  project,
  type RunHistoryArchiveLease,
  type RunHistoryStorage,
  type Store,
} from "../src/index.js";
import { epoch, fixture, id, time } from "./fact-fixtures.js";

export const historyCid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
export const historyPolicy = {
  now: epoch + 10,
  retainUntil: epoch + 1000,
  maxAttempts: 2,
  retryDelayMs: 10,
  maxSourceBytes: 100_000,
};
export function historyFixture() {
  const f = fixture();
  const first = f.task(1, 0);
  const run = f.run(2, 1);
  const second = f.task(3, 2);
  f.append({
    type: "message.received",
    scope: "scope",
    taskId: first.taskId,
    runId: run.runId,
    occurredAt: time(3),
    data: {
      message: {
        taskId: first.taskId,
        messageId: id(4, 3),
        runId: run.runId,
        generation: run.generation,
        caller: { scope: "scope", subject: "actor" },
        receivedAt: time(3),
        state: "queued",
        payload: { note: "settle at exit" },
      },
    },
  });
  f.append({
    type: "run.outcome",
    scope: "scope",
    runId: run.runId,
    occurredAt: time(4),
    data: { outcome: { kind: "completed", occurredAt: time(4), output: { result: "done" } } },
  });
  const outcome = f.events.length;
  f.append({
    type: "run.exited",
    scope: "scope",
    runId: run.runId,
    occurredAt: time(5),
    data: { basis: "worker", code: 0 },
  });
  f.append({
    type: "run.cleanup.unknown",
    scope: "scope",
    runId: run.runId,
    occurredAt: time(6),
    data: { reason: "release callback not yet confirmed" },
  });
  const unknown = f.events.length;
  f.append({
    type: "run.reclaimed",
    scope: "scope",
    runId: run.runId,
    occurredAt: time(7),
    data: {},
  });
  return {
    f,
    run,
    first,
    second,
    outcome,
    unknown,
    events: f.events.map(({ sequence: _sequence, ...event }) => event),
  };
}
export function receipt(now = epoch + 12) {
  return {
    rootCid: historyCid,
    blockCount: 3,
    byteLength: 123,
    verifiedAt: now,
    retainedAt: now,
  };
}
export type HistoryStore = Store & { readonly runHistory: RunHistoryStorage };

export function runHistoryCases(
  name: string,
  create: () => { store: HistoryStore; dispose(): void },
): void {
  function setup(t: TestContext, complete = true) {
    const { store, dispose } = create();
    store.claim("writer");
    t.after(() => {
      store.release("writer");
      store.close();
      dispose();
    });
    const f = historyFixture();
    if (complete) store.append("writer", 0, f.events);
    return { store, history: store.runHistory, ...f };
  }
  test(`${name}: finalization waits for exit, message settlement and cleanup, not reliable outcome`, (t) => {
    const { store, history, run, events, outcome, unknown, first, second, f } = setup(t, false);
    store.append("writer", 0, events.slice(0, outcome));
    assert.equal(isRunHistoryFinalizable(store.read().facts, run.runId), false);
    assert.throws(() => history.finalize("writer", run.runId, historyPolicy), {
      code: "history_not_finalizable",
    });
    assert.equal(history.read(run.runId), undefined);
    store.append("writer", outcome, events.slice(outcome, unknown));
    assert.equal(project(store.read().facts, first.taskId, epoch + 10).stage, "completed");
    assert.equal(
      store.read().facts.runs[run.runId]?.cleanupUnknown?.reason,
      "release callback not yet confirmed",
    );
    assert.throws(() => history.finalize("writer", run.runId, historyPolicy), {
      code: "history_not_finalizable",
    });
    store.append("writer", unknown, events.slice(unknown));
    store.retainRunContent!("writer", run.runId, historyCid);
    store.recordRunContentAccess!("writer", run.runId, `ipfs:${historyCid}`);
    const before = store.read();
    const finalized = history.finalize("writer", run.runId, historyPolicy);
    assert.deepEqual(store.read(), before);
    assert.equal(finalized.archive.state, "pending");
    const source = history.readSource(run.runId, historyPolicy.now);
    assert.equal(source.run.outcome?.kind, "completed");
    assert.equal(source.run.exit?.basis, "worker");
    assert.equal(source.run.reclaimedAt, time(7));
    assert.equal(source.messages[0]?.state, "unknown");
    assert.equal(
      source.events.some((event) => event.type === "run.cleanup.unknown"),
      true,
    );
    assert.deepEqual(source.contentRoots, [historyCid]);
    assert.deepEqual(source.contentAccess, [`ipfs:${historyCid}`]);
    assert.equal("cursorKey" in source, false);
    for (const task of [first, second])
      assert.equal(matchedRun(store.read().facts, task)?.runId, run.runId);
    assert.equal(history.list().length, 1);
    source.run.parameters = "mutated caller copy";
    assert.deepEqual(
      history.readSource(run.runId, historyPolicy.now).run.parameters,
      run.parameters,
    );
    assert.throws(
      () =>
        store.append("writer", before.facts.watermark, [
          {
            type: "run.content-access",
            runId: run.runId,
            scope: "scope",
            occurredAt: time(11),
            data: { sid: "late" },
          },
        ]),
      { code: "history_finalized" },
    );
    assert.throws(() => store.retainRunContent!("writer", run.runId, historyCid), {
      code: "history_finalized",
    });
    assert.throws(() => store.recordRunContentAccess!("writer", run.runId, "late"), {
      code: "history_finalized",
    });
    assert.deepEqual(store.read(), before);
    const follower = f.task(9, 4);
    const { sequence: _sequence, ...created } = f.events.at(-1)!;
    store.append("writer", store.read().facts.watermark, [created]);
    assert.equal(matchedRun(store.read().facts, follower)?.runId, run.runId);
    assert.equal(
      history.readSource(run.runId, historyPolicy.now).sourceWatermark,
      finalized.sourceWatermark,
    );
    assert.equal(history.list().length, 1);
  });
  test(`${name}: archive budgets and ownership do not alter execution facts`, (t) => {
    const { store, history, run } = setup(t);
    const before = store.read();
    assert.throws(() => history.finalize("intruder", run.runId, historyPolicy), {
      code: "store_owned",
    });
    assert.throws(
      () => history.finalize("writer", run.runId, { ...historyPolicy, maxSourceBytes: 1 }),
      {
        code: "history_limit",
      },
    );
    assert.equal(history.read(run.runId), undefined);
    const record = history.finalize("writer", run.runId, historyPolicy);
    assert.deepEqual(
      history.finalize("writer", run.runId, {
        ...historyPolicy,
        retainUntil: epoch + 2000,
      }),
      record,
    );
    assert.equal(history.list("", 1).length, 1);
    assert.deepEqual(history.list(run.runId), []);
    assert.throws(() => history.list("", 1001), { code: "invalid_request" });
    assert.deepEqual(store.read(), before);
  });
  test(`${name}: source budget admits the measured limit and rejects limit+1`, (t) => {
    const measured = setup(t);
    measured.history.finalize("writer", measured.run.runId, {
      ...historyPolicy,
      maxSourceBytes: 10_000_000,
    });
    const size = new TextEncoder().encode(
      JSON.stringify(measured.history.readSource(measured.run.runId, historyPolicy.now)),
    ).byteLength;
    assert.ok(size > 1);
    const over = setup(t);
    assert.throws(
      () =>
        over.history.finalize("writer", over.run.runId, {
          ...historyPolicy,
          maxSourceBytes: size - 1,
        }),
      { code: "history_limit" },
    );
    assert.equal(over.history.read(over.run.runId), undefined);
    const exact = setup(t);
    assert.equal(
      exact.history.finalize("writer", exact.run.runId, {
        ...historyPolicy,
        maxSourceBytes: size,
      }).runId,
      exact.run.runId,
    );
  });
  test(`${name}: recovery exit is not physical cleanup or a completed result`, (t) => {
    const { store, history, run, events, outcome, first } = setup(t, false);
    store.append("writer", 0, events.slice(0, outcome));
    store.append("writer", outcome, [
      {
        type: "run.exited",
        scope: "scope",
        runId: run.runId,
        occurredAt: time(5),
        data: { basis: "recovery" },
      },
    ]);
    assert.equal(project(store.read().facts, first.taskId, epoch + 10).stage, "stopped");
    assert.ok(store.read().facts.runs[run.runId]?.cleanupUnknown);
    assert.throws(() => history.finalize("writer", run.runId, historyPolicy), {
      code: "history_not_finalizable",
    });
    store.append("writer", store.read().facts.watermark, [
      {
        type: "run.reclaimed",
        scope: "scope",
        runId: run.runId,
        occurredAt: time(7),
        data: {},
      },
    ]);
    history.finalize("writer", run.runId, historyPolicy);
    const source = history.readSource(run.runId, historyPolicy.now);
    assert.equal(source.run.outcome?.kind, "completed");
    assert.equal(source.run.exit?.basis, "recovery");
    assert.equal(source.run.completedAt, undefined);
    assert.equal(source.run.reclaimedAt, time(7));
  });
  test(`${name}: pin uncertainty retries only archive work, with distinct owners and bounded attempts`, (t) => {
    const { store, history, run, first, second } = setup(t);
    history.finalize("writer", run.runId, historyPolicy);
    const before = store.read();
    const a = history.claimArchive("writer", run.runId, { now: epoch + 11, leaseMs: 100 })!;
    assert.ok(a);
    assert.equal(
      history.claimArchive("writer", run.runId, { now: epoch + 11, leaseMs: 100 }),
      undefined,
    );
    assert.throws(() => history.completeArchive("writer", a, receipt(), epoch + 12), {
      code: "storage_conflict",
    });
    assert.equal(history.setArchiveRoot("writer", a, historyCid, epoch + 11), true);
    assert.equal(
      history.failArchive(
        "writer",
        a,
        { code: "rpc_timeout", message: "pin may have succeeded" },
        epoch + 12,
      ),
      true,
    );
    assert.equal(history.read(run.runId)?.archive.error?.code, "rpc_timeout");
    assert.equal(
      history.claimArchive("writer", run.runId, { now: epoch + 21, leaseMs: 100 }),
      undefined,
    );
    const cleanup = history.claimRelease("writer", run.runId, 1, {
      now: epoch + 12,
      leaseMs: 100,
    })!;
    assert.equal(history.completeRelease("writer", cleanup, epoch + 13), true);
    const b = history.claimArchive("writer", run.runId, { now: epoch + 22, leaseMs: 100 })!;
    assert.notEqual(a.owner, b.owner);
    assert.equal(history.setArchiveRoot("writer", b, historyCid, epoch + 22), true);
    assert.equal(history.completeArchive("writer", b, receipt(epoch + 23), epoch + 23), true);
    assert.equal(history.completeArchive("writer", b, receipt(epoch + 23), epoch + 23), true);
    // Old successful/failed callbacks can only re-arm cleanup for their own owner.
    assert.equal(history.completeArchive("writer", a, receipt(epoch + 24), epoch + 24), false);
    assert.equal(history.read(run.runId)?.attempts[0]?.release?.state, "pending");
    assert.equal(history.read(run.runId)?.archive.published?.attempt, 2);
    assert.equal(
      history.observeRead("writer", run.runId, {
        rootCid: historyCid,
        status: "missing",
        observedAt: epoch + 25,
      }),
      true,
    );
    assert.equal(history.read(run.runId)?.lastRead?.status, "missing");
    for (const task of [first, second])
      assert.equal(project(store.read().facts, task.taskId, epoch + 25).stage, "completed");
    assert.deepEqual(store.read(), before);
  });
  test(`${name}: lease recovery fences abandoned publishers and exhausts only archive retries`, (t) => {
    const { store, history, run } = setup(t);
    history.finalize("writer", run.runId, historyPolicy);
    const before = store.read();
    const a = history.claimArchive("writer", run.runId, { now: epoch + 11, leaseMs: 5 })!;
    history.setArchiveRoot("writer", a, historyCid, epoch + 11);
    const recovered = history.recover("writer", run.runId, epoch + 16);
    assert.equal(recovered.archive.error?.code, "archive_lease_expired");
    assert.equal(
      history.claimArchive("writer", run.runId, { now: epoch + 25, leaseMs: 5 }),
      undefined,
    );
    const b = history.claimArchive("writer", run.runId, { now: epoch + 26, leaseMs: 5 })!;
    assert.equal(history.completeArchive("writer", a, receipt(epoch + 27), epoch + 27), false);
    history.recover("writer", run.runId, epoch + 31);
    assert.equal(
      history.claimArchive("writer", run.runId, { now: epoch + 100, leaseMs: 5 }),
      undefined,
    );
    assert.equal(history.read(run.runId)?.attempts.length, 2);
    assert.equal(history.read(run.runId)?.retention.state, "retained");
    assert.equal(b.generation, a.generation);
    assert.deepEqual(store.read(), before);
  });
  test(`${name}: release and late pin completion are fenced even after release acknowledgement`, (t) => {
    const { store, history, run } = setup(t);
    history.finalize("writer", run.runId, historyPolicy);
    const before = store.read();
    const a = history.claimArchive("writer", run.runId, { now: epoch + 11, leaseMs: 100 })!;
    history.setArchiveRoot("writer", a, historyCid, epoch + 11);
    history.requestRelease("writer", run.runId, epoch + 12);
    assert.throws(() => history.readSource(run.runId, epoch + 12), { code: "history_released" });
    const release = history.claimRelease("writer", run.runId, 1, { now: epoch + 13, leaseMs: 50 })!;
    assert.equal(history.completeRelease("writer", release, epoch + 14), true);
    assert.equal(history.read(run.runId)?.retention.state, "released");
    assert.equal(history.completeArchive("writer", a, receipt(epoch + 15), epoch + 15), false);
    assert.equal(history.read(run.runId)?.retention.state, "release-requested");
    assert.equal(history.completeRelease("writer", release, epoch + 16), false);
    const next = history.claimRelease("writer", run.runId, 1, { now: epoch + 16, leaseMs: 50 })!;
    assert.ok(next.revision > release.revision);
    assert.equal(
      history.failRelease("writer", next, { code: "offline", message: "retry" }, epoch + 17),
      true,
    );
    assert.equal(
      history.claimRelease("writer", run.runId, 1, { now: epoch + 26, leaseMs: 50 }),
      undefined,
    );
    const retry = history.claimRelease("writer", run.runId, 1, { now: epoch + 27, leaseMs: 5 })!;
    // Lost unpin response: recovery leaves a retryable intent, never claims physical deletion.
    history.recover("writer", run.runId, epoch + 32);
    assert.equal(history.completeRelease("writer", retry, epoch + 32), false);
    const final = history.claimRelease("writer", run.runId, 1, { now: epoch + 33, leaseMs: 50 })!;
    assert.equal(history.completeRelease("writer", final, epoch + 34), true);
    assert.equal(history.read(run.runId)?.retention.state, "released");
    assert.equal(
      history.observeRead("writer", run.runId, {
        rootCid: historyCid,
        status: "available",
        observedAt: epoch + 35,
      }),
      false,
    );
    assert.equal(
      history.claimArchive("writer", run.runId, { now: epoch + 35, leaseMs: 100 }),
      undefined,
    );
    assert.equal(history.read(run.runId)?.archive.published, undefined);
    assert.deepEqual(store.read(), before);
  });
  test(`${name}: deadline expiry and forgetting cannot resurrect details or requests`, (t) => {
    const { store, history, run, first, second } = setup(t);
    history.finalize("writer", run.runId, { ...historyPolicy, retainUntil: epoch + 20 });
    const a = history.claimArchive("writer", run.runId, { now: epoch + 11, leaseMs: 100 })!;
    assert.equal(a.expiresAt, epoch + 20);
    history.setArchiveRoot("writer", a, historyCid, epoch + 11);
    assert.throws(() => history.readSource(run.runId, epoch + 20), { code: "history_released" });
    assert.equal(history.completeArchive("writer", a, receipt(epoch + 20), epoch + 20), false);
    assert.equal(history.read(run.runId)?.retention.reason, "expired");
    const forget: NewEvent = {
      type: "records.forgotten",
      scope: "",
      occurredAt: time(21),
      data: { taskIds: [first.taskId, second.taskId], runIds: [run.runId] },
    };
    store.append("writer", store.read().facts.watermark, [forget]);
    store.compact("writer", store.read().facts.watermark);
    assert.deepEqual(store.read().facts.runs, {});
    assert.ok(store.read().facts.requests[first.request.requestId]);
    assert.equal(history.completeArchive("writer", a, receipt(epoch + 22), epoch + 22), false);
    assert.equal(
      history.finalize("writer", run.runId, {
        ...historyPolicy,
        now: epoch + 22,
        retainUntil: epoch + 2000,
      }).retention.state,
      "release-requested",
    );
    assert.equal(
      history.claimArchive("writer", run.runId, { now: epoch + 23, leaseMs: 100 }),
      undefined,
    );
    assert.deepEqual(store.read().facts.runs, {});
  });
  test(`${name}: forgetting commits the archive release intent atomically without waiting for pin`, (t) => {
    const { store, history, run, first, second } = setup(t);
    history.finalize("writer", run.runId, historyPolicy);
    const lease: RunHistoryArchiveLease = history.claimArchive("writer", run.runId, {
      now: epoch + 11,
      leaseMs: 100,
    })!;
    history.setArchiveRoot("writer", lease, historyCid, epoch + 11);
    history.completeArchive("writer", lease, receipt(), epoch + 12);
    store.append("writer", store.read().facts.watermark, [
      {
        type: "records.forgotten",
        scope: "",
        occurredAt: time(15),
        data: { taskIds: [first.taskId, second.taskId], runIds: [run.runId] },
      },
    ]);
    assert.equal(history.read(run.runId)?.retention.reason, "record-forgotten");
    assert.equal(history.read(run.runId)?.archive.state, "archived");
    assert.equal(history.read(run.runId)?.attempts[0]?.release?.state, "pending");
    assert.throws(() => history.readSource(run.runId, epoch + 15), { code: "history_released" });
    assert.equal(store.read().facts.runs[run.runId], undefined);
    assert.ok(store.read().facts.requests[first.request.requestId]);
  });
}
