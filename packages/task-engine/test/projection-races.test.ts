import assert from "node:assert/strict";
import test from "node:test";
import { at, isPending, isTimedOut, project, reduce } from "@silvermoon-work/task-protocol";
import { caller, flush, harness } from "./fixtures.js";

for (const outcome of ["completed", "failed"] as const) {
  for (const offset of [-1, 0, 1]) {
    for (const tickFirst of [false, true]) {
      test(`M03 shared ${outcome} at eligible${offset >= 0 ? "+" : ""}${offset}, tickFirst=${tickFirst}`, async () => {
        const h = await harness();
        try {
          const original = h.submit({ timeoutMs: 1000 });
          await h.turn();
          await h.turn(10);
          const task = h.submit({ matchPolicy: "terminates-after-eligible" });
          const runId = h.engine.getTask(original.taskId, caller).run!.runId;
          assert.equal(task.run?.runId, runId);
          h.clock.setTime(Date.parse(task.eligibleAt) + offset);
          if (outcome === "completed") await h.finish();
          else {
            h.work[0]?.done.reject(new Error("reliable shared failure after clock adjustment"));
            h.work[0]?.exit.resolve();
            await flush();
          }
          h.clock.setTime(Date.parse(task.deadlineAt) + 1);
          if (tickFirst) h.engine.tick();
          const current = h.engine.getTask(task.taskId, caller);
          assert.equal(current.run?.runId, offset < 0 ? undefined : runId);
          assert.equal(current.stage, offset < 0 ? "initial" : outcome);
          assert.ok(isTimedOut(current));
          const canceled = h.engine.cancelTask(task.taskId, caller);
          assert.equal(canceled.changed, true);
          assert.equal(canceled.stage, offset < 0 ? "initial" : outcome);
          assert.equal(canceled.canceled, true);
          assert.deepEqual(canceled.result, current.result);
          h.clock.setTime(Date.parse(task.eligibleAt) - 1);
          const rollback = h.engine.getTask(task.taskId, caller);
          assert.equal(rollback.stage, offset < 0 ? "initial" : outcome);
          assert.equal(rollback.run?.runId, offset < 0 ? undefined : runId);
          assert.ok(isPending(rollback));
          assert.equal(isTimedOut(rollback), false);
          const view = h.store.read();
          assert.deepEqual(
            project(reduce(view.prefix, view.events), task.taskId, h.clock.now()),
            rollback,
          );
          assert.deepEqual(
            view.events.filter((event) => event.taskId === task.taskId).map((event) => event.type),
            ["task.created", "task.canceled"],
          );
        } finally {
          await h.close();
        }
      });
    }
  }
}

for (const state of ["pending", "eligible", "timeout", "canceled"] as const) {
  test(`M02/M03 invalidated Task only schedules a fresh Run when currently eligible and not canceled: ${state}`, async () => {
    const h = await harness();
    try {
      const owner = h.submit({ timeoutMs: 1000 });
      await h.turn();
      await h.turn(10);
      const follower = h.submit({ matchPolicy: "terminates-after-eligible" });
      const originalRun = h.engine.getTask(owner.taskId, caller).run!.runId;
      assert.equal(follower.run?.runId, originalRun);
      h.clock.setTime(Date.parse(follower.eligibleAt) - 1);
      await h.finish();
      assert.equal(h.engine.getTask(follower.taskId, caller).stage, "initial");
      const before = h.store.read().facts.watermark;
      h.engine.tick();
      assert.equal(h.work.length, 1);
      assert.equal(h.store.read().facts.watermark, before);
      if (state === "timeout") h.clock.setTime(Date.parse(follower.deadlineAt) + 1);
      else if (state !== "pending") h.clock.setTime(Date.parse(follower.eligibleAt));
      if (state === "canceled") h.engine.cancelTask(follower.taskId, caller);
      await h.turn(0);
      const current = h.engine.getTask(follower.taskId, caller);
      if (state === "eligible") {
        assert.equal(h.work.length, 2);
        assert.equal(current.stage, "running");
        assert.notEqual(current.run?.runId, originalRun);
        await h.finish(1);
      } else {
        assert.equal(h.work.length, 1);
        assert.equal(current.stage, "initial");
      }
      assert.equal(h.engine.getRun(originalRun, caller).stage, "completed");
      const view = h.store.read();
      assert.deepEqual(
        project(reduce(view.prefix, view.events), follower.taskId, h.clock.now()),
        h.engine.getTask(follower.taskId, caller),
      );
    } finally {
      await h.close();
    }
  });
}

test("committed stop entry excludes later qualification and a new Run cannot reuse the stopped Worker", async () => {
  const h = await harness();
  try {
    const original = h.submit();
    await h.turn();
    const originalRun = h.engine.getTask(original.taskId, caller).run!.runId;
    const next = h.submit({
      eligibleAt: at(h.clock.now() + 10),
      matchPolicy: "terminates-after-eligible",
    });
    h.engine.cancelTask(original.taskId, caller);
    await h.engine.waitForTaskRelease(original.taskId, caller);
    assert.ok(h.engine.getRun(originalRun, caller).stopRequested);
    await h.turn(10);
    const current = h.engine.getTask(next.taskId, caller);
    assert.equal(current.stage, "running");
    assert.notEqual(current.run?.runId, originalRun);
    assert.ok(
      h.store.read().facts.runs[current.run!.runId]!.startedSequence >
        h.store.read().facts.runs[originalRun]!.stopRequested!.sequence,
    );
    await h.finish(1);
    assert.equal(h.engine.getTask(next.taskId, caller).stage, "completed");
  } finally {
    await h.close();
  }
});

for (const outcome of ["completed", "failed"] as const) {
  for (const late of [false, true]) {
    test(`durable ${outcome}, late=${late}, changes no Task authority and never freezes the now dimension`, async () => {
      const h = await harness();
      try {
        const task = h.submit();
        await h.turn();
        h.clock.setTime(Date.parse(task.deadlineAt) + (late ? 1 : 0));
        const endedAt = at(h.clock.now());
        if (outcome === "completed") await h.finish();
        else {
          h.work[0]?.done.reject(new Error("reliable run failure"));
          h.work[0]?.exit.resolve();
          await flush();
        }
        assert.equal(isTimedOut(h.engine.getTask(task.taskId, caller)), late);
        const prefix = h.store.read().facts;
        assert.equal("snapshot" in prefix.tasks[task.taskId]!, false);
        h.clock.setTime(Date.parse(task.deadlineAt) + 2);
        const saved = JSON.stringify(prefix);
        const before = project(prefix, task.taskId, h.clock.now());
        assert.equal(JSON.stringify(prefix), saved, "projection must not persist a Task judgment");
        assert.deepEqual(before, h.engine.getTask(task.taskId, caller));
        assert.ok(isTimedOut(before));
        assert.equal(
          outcome === "completed" ? before.run?.completedAt : before.run?.failedAt,
          endedAt,
        );
        assert.equal(before.stage, outcome);
        assert.ok(before.termination);
        if (outcome === "completed") assert.deepEqual(before.result, { text: "hello" });
        else assert.equal(before.result, undefined);
        assert.equal(h.engine.cancelTask(task.taskId, caller).stage, outcome);
        h.engine.tick();
        const after = h.engine.getTask(task.taskId, caller);
        assert.equal(after.stage, outcome);
        assert.ok(isTimedOut(after));
        h.clock.setTime(Date.parse(task.eligibleAt) - 1);
        assert.ok(isPending(h.engine.getTask(task.taskId, caller)));
        assert.equal(h.engine.getTask(task.taskId, caller).stage, outcome);
      } finally {
        await h.close();
      }
    });
  }
}

test("projection cannot borrow a time-ineligible completion or a nonexistent Run from a cached Task judgment", async () => {
  const h = await harness();
  try {
    const task = h.submit();
    await h.turn();
    await h.finish();
    const prefix = h.store.read().facts;
    const runId = h.engine.getTask(task.taskId, caller).run!.runId;
    const run = prefix.runs[runId]!;
    const eligible = Math.max(Date.parse(run.startedAt), Date.parse(run.exit!.occurredAt)) + 1;
    for (const matchPolicy of ["starts-after-eligible", "terminates-after-eligible"] as const) {
      const facts = structuredClone(prefix);
      const record = facts.tasks[task.taskId]!;
      record.binding.matchPolicy = matchPolicy;
      record.eligibleAt = at(eligible);
      record.deadlineAt = at(eligible + 100);
      const snapshot = project(facts, task.taskId, eligible + 101);
      assert.equal(snapshot.run, undefined);
      assert.equal(snapshot.stage, "initial");
      assert.ok(isTimedOut(snapshot));
    }
    const missing = structuredClone(prefix);
    delete missing.runs[runId];
    assert.equal(project(missing, task.taskId, h.clock.now()).run, undefined);
  } finally {
    await h.close();
  }
});

test("cancel-first Task keeps its canceled fact but observes later shared completion and current timeout", async () => {
  const h = await harness();
  try {
    const task = h.submit();
    h.submit();
    await h.turn();
    const canceled = h.engine.cancelTask(task.taskId, caller);
    h.clock.setTime(h.clock.now() + 1);
    await h.finish();
    h.clock.setTime(Date.parse(task.deadlineAt) + 1);
    const after = h.engine.getTask(task.taskId, caller);
    assert.equal(after.canceledAt, canceled.canceledAt);
    assert.equal(after.stage, "completed");
    assert.ok(after.run?.completedAt);
    assert.deepEqual(after.result, { text: "hello" });
    assert.ok(isTimedOut(after));
    assert.notEqual(after.revision, canceled.revision);
    assert.notEqual(after.updatedAt, canceled.updatedAt);
  } finally {
    await h.close();
  }
});
