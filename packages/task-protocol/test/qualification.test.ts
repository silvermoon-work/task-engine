import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyFacts,
  isPending,
  isTimedOut,
  matchedRun,
  project,
  projectRun,
  reduce,
  wouldQualify,
} from "../src/index.js";
import { epoch, fixture, time } from "./fact-fixtures.js";
import { sharingCases, sharingFacts } from "./sharing-fixtures.js";

for (const scenario of sharingCases)
  test(`cold source projection uses bound Schema Equals: ${scenario.name}`, () => {
    const f = sharingFacts(scenario);
    const follower = f.facts.tasks[f.follower.taskId];
    assert.ok(follower);
    assert.equal(matchedRun(f.facts, follower)?.runId, scenario.equal ? f.run.runId : undefined);
    const cold = structuredClone(f.facts);
    for (const record of [...Object.values(cold.tasks), ...Object.values(cold.runs)])
      Object.assign(record, { equivalenceKey: "untrusted-independent-key" });
    assert.equal(
      project(cold, f.follower.taskId, epoch).run?.runId,
      scenario.equal ? f.run.runId : undefined,
    );
    assert.deepEqual(
      project(cold, f.follower.taskId, epoch),
      project(f.facts, f.follower.taskId, epoch),
    );
  });

function seed() {
  const f = fixture();
  const b = f.task(1, -20);
  const run = f.run(2, -10);
  const a = f.task(3, 0, 10);
  return { f, a, b, run };
}
test("Q08: GET does not match at the clock boundary; one raw witness qualifies without mutating Task facts", () => {
  const { f, a, run } = seed();
  const accepted = structuredClone(f.facts.tasks[a.taskId]);
  const before = project(f.facts, a.taskId, epoch + 10);
  assert.equal(before.stage, "initial");
  assert.equal(isPending(before), false);
  assert.equal(before.revision, "domain:3");
  assert.equal(f.facts.watermark, 3);
  assert.equal(wouldQualify(f.facts, time(10)), true);
  f.append({
    type: "qualification-time-observed",
    scope: "",
    occurredAt: time(10),
    data: { observedAt: time(10) },
  });
  const qualified = project(f.facts, a.taskId, epoch + 10);
  assert.equal(qualified.run?.runId, run.runId);
  assert.equal(qualified.stage, "running");
  assert.equal(qualified.revision, "domain:4");
  assert.equal(qualified.updatedAt, time(10));
  assert.deepEqual(f.facts.tasks[a.taskId], accepted);
  assert.equal("snapshot" in (f.facts.tasks[a.taskId] ?? {}), false);
  assert.deepEqual(reduce(emptyFacts("domain"), f.events), f.facts);
  assert.deepEqual(project(structuredClone(f.facts), a.taskId, epoch + 10), qualified);
  assert.equal(wouldQualify(f.facts, time(11)), false);
  assert.throws(
    () =>
      f.append({
        type: "qualification-time-observed",
        scope: "",
        occurredAt: time(11),
        data: { observedAt: time(11) },
      }),
    { code: "invalid_fact" },
  );
});
test("M03: pure rollback preserves matching; an actual early exit invalidates terminates matching", () => {
  const { f, a, run } = seed();
  f.append({
    type: "qualification-time-observed",
    scope: "",
    occurredAt: time(10),
    data: { observedAt: time(10) },
  });
  const rollback = project(f.facts, a.taskId, epoch + 5);
  assert.equal(rollback.stage, "running");
  assert.equal(isPending(rollback), true);
  assert.equal(rollback.run?.runId, run.runId);
  f.append({
    type: "run.outcome",
    scope: "scope",
    runId: run.runId,
    occurredAt: time(5),
    data: { outcome: { kind: "completed", output: { result: { ok: true } }, occurredAt: time(5) } },
  });
  assert.equal(project(f.facts, a.taskId, epoch + 5).stage, "running");
  assert.equal(project(f.facts, a.taskId, epoch + 5).output?.result, undefined);
  assert.equal(projectRun(f.facts, run.runId, epoch + 5).outcome?.kind, "completed");
  f.append({
    type: "run.exited",
    scope: "scope",
    runId: run.runId,
    occurredAt: time(5),
    data: { basis: "worker", code: 0 },
  });
  const invalidated = project(f.facts, a.taskId, epoch + 5);
  assert.equal(invalidated.stage, "initial");
  assert.equal(invalidated.run, undefined);
  assert.equal(invalidated.output?.result, undefined);
  assert.equal(invalidated.updatedAt, time(5));
  assert.equal(invalidated.revision, "domain:6");
  assert.equal(projectRun(f.facts, run.runId, epoch + 5).stage, "completed");
  assert.equal(isPending(invalidated), true);
  assert.equal(isTimedOut(project(f.facts, a.taskId, epoch + 1001)), true);
  f.append({
    type: "task.canceled",
    taskId: a.taskId,
    scope: "scope",
    occurredAt: time(1001),
    data: {},
  });
  const canceled = project(f.facts, a.taskId, epoch + 1001);
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.stage, "initial");
  assert.equal(canceled.output?.result, undefined);
  assert.deepEqual(
    project(reduce(emptyFacts("domain"), f.events), a.taskId, epoch + 1001),
    canceled,
  );
});
test("Q08: pending cancellation cannot borrow a later witness and later objects cannot borrow an older witness", async () => {
  const { f, a } = seed();
  f.append({
    type: "task.canceled",
    taskId: a.taskId,
    scope: "scope",
    occurredAt: time(5),
    data: {},
  });
  await test("M03/M04: invalidation cannot borrow a historical witness for another Run; later qualification uses its own source", () => {
    const { f, a, run } = seed();
    f.append({
      type: "qualification-time-observed",
      scope: "",
      occurredAt: time(10),
      data: { observedAt: time(10) },
    });
    const replacement = f.run(4, 11);
    assert.equal(project(f.facts, a.taskId, epoch + 11).run?.runId, run.runId);
    f.append({
      type: "run.exited",
      scope: "scope",
      runId: run.runId,
      occurredAt: time(5),
      data: { basis: "worker", code: 1 },
    });
    const invalidated = project(f.facts, a.taskId, epoch + 5);
    assert.equal(invalidated.stage, "initial");
    assert.equal(invalidated.updatedAt, time(5));
    assert.equal(invalidated.revision, "domain:6");
    assert.equal(wouldQualify(f.facts, time(5)), false);
    assert.equal(wouldQualify(f.facts, time(1001)), false);
    assert.equal(wouldQualify(f.facts, time(10)), true);
    f.append({
      type: "qualification-time-observed",
      scope: "",
      occurredAt: time(10),
      data: { observedAt: time(10) },
    });
    const rematched = project(f.facts, a.taskId, epoch + 10);
    assert.equal(rematched.run?.runId, replacement.runId);
    assert.equal(rematched.run?.matchedAt, time(10));
    assert.equal(rematched.updatedAt, time(10));
    assert.equal(rematched.revision, "domain:7");
    assert.deepEqual(
      project(reduce(emptyFacts("domain"), f.events), a.taskId, epoch + 10),
      rematched,
    );
  });
  await test("M03: starts policy retains its match after an earlier actual exit; canceled invalidated Tasks cannot rematch", () => {
    const f = fixture();
    const a = f.task(1, 0, 10, "starts-after-eligible");
    const run = f.run(2, 10);
    f.append({
      type: "run.exited",
      scope: "scope",
      runId: run.runId,
      occurredAt: time(5),
      data: { basis: "worker", code: 1 },
    });
    assert.equal(project(f.facts, a.taskId, epoch + 5).run?.runId, run.runId);
    const g = seed();
    g.f.append({
      type: "qualification-time-observed",
      scope: "",
      occurredAt: time(10),
      data: { observedAt: time(10) },
    });
    g.f.append({
      type: "task.canceled",
      taskId: g.a.taskId,
      scope: "scope",
      occurredAt: time(11),
      data: {},
    });
    g.f.append({
      type: "run.exited",
      scope: "scope",
      runId: g.run.runId,
      occurredAt: time(5),
      data: { basis: "worker", code: 1 },
    });
    g.f.run(4, 12);
    assert.equal(project(g.f.facts, g.a.taskId, epoch + 12).stage, "initial");
    assert.equal(project(g.f.facts, g.a.taskId, epoch + 12).canceled, true);
    assert.equal(wouldQualify(g.f.facts, time(12)), false);
  });
  assert.equal(wouldQualify(f.facts, time(10)), false);
  assert.equal(project(f.facts, a.taskId, epoch + 10).run, undefined);
  const g = seed();
  g.f.append({
    type: "qualification-time-observed",
    scope: "",
    occurredAt: time(10),
    data: { observedAt: time(10) },
  });
  const later = g.f.task(4, 5, 10);
  assert.equal(project(g.f.facts, later.taskId, epoch + 10).stage, "initial");
  assert.equal(wouldQualify(g.f.facts, time(10)), true);
  g.f.append({
    type: "qualification-time-observed",
    scope: "",
    occurredAt: time(10),
    data: { observedAt: time(10) },
  });
  assert.equal(project(g.f.facts, later.taskId, epoch + 10).stage, "running");
});
test("Q08: stop first excludes qualification while prior qualification remains through stopping and stopped", () => {
  for (const first of ["stop", "qualification"]) {
    const { f, a, b, run } = seed();
    if (first === "qualification")
      f.append({
        type: "qualification-time-observed",
        scope: "",
        occurredAt: time(10),
        data: { observedAt: time(10) },
      });
    f.append({
      type: "run.stop.requested",
      runId: run.runId,
      scope: "scope",
      occurredAt: time(10),
      data: { reason: "shutdown" },
    });
    assert.equal(project(f.facts, b.taskId, epoch + 10).stage, "running");
    assert.equal(wouldQualify(f.facts, time(10)), false);
    f.append({
      type: "run.stopping",
      runId: run.runId,
      scope: "scope",
      occurredAt: time(10),
      data: {},
    });
    assert.equal(
      project(f.facts, a.taskId, epoch + 10).stage,
      first === "stop" ? "initial" : "stopping",
    );
    f.append({
      type: "run.exited",
      runId: run.runId,
      scope: "scope",
      occurredAt: time(11),
      data: { basis: "worker", code: 1, forced: true },
    });
    assert.equal(
      project(f.facts, a.taskId, epoch + 11).stage,
      first === "stop" ? "initial" : "stopped",
    );
  }
});
test("Q08: recovery replays the original qualification and does not invent physical exit or a new binding", () => {
  const { f, a, run } = seed();
  f.append({
    type: "qualification-time-observed",
    scope: "",
    occurredAt: time(10),
    data: { observedAt: time(10) },
  });
  f.append({
    type: "run.exited",
    runId: run.runId,
    scope: "scope",
    occurredAt: time(5),
    data: { basis: "recovery" },
  });
  const replayed = reduce(emptyFacts("domain"), f.events);
  const snapshot = project(replayed, a.taskId, epoch + 5);
  assert.equal(snapshot.stage, "stopped");
  assert.equal(snapshot.run?.runId, run.runId);
  assert.equal(isPending(snapshot), true);
  assert.equal(replayed.runs[run.runId]?.reclaimedAt, undefined);
  assert.ok(replayed.runs[run.runId]?.cleanupUnknown);
});
test("Q08: genuine facts establish qualification; later progress alone never updates a Task", () => {
  const f = fixture(),
    a = f.task(1, 0, 10);
  assert.equal(wouldQualify(f.facts, time(10)), false);
  const run = f.run(2, 10);
  assert.equal(matchedRun(f.facts, a)?.runId, run.runId);
  assert.equal(wouldQualify(f.facts, time(11)), false);
  const before = project(f.facts, a.taskId, epoch + 11);
  f.append({
    type: "run.progress",
    runId: run.runId,
    scope: "scope",
    occurredAt: time(12),
    data: { progress: { stage: "execution", message: "only progress" } },
  });
  assert.equal(project(f.facts, a.taskId, epoch + 12).updatedAt, before.updatedAt);
  assert.equal(projectRun(f.facts, run.runId, epoch + 12).updatedAt, time(12));
});
test("earliest start sequence wins despite equal or backward wall times; one source qualifies all members", () => {
  const f = fixture();
  const first = f.run(1, 10),
    second = f.run(2, 0);
  const a = f.task(3, 1, 20),
    b = f.task(4, 2, 20);
  f.append({
    type: "qualification-time-observed",
    scope: "",
    occurredAt: time(20),
    data: { observedAt: time(20) },
  });
  assert.equal(project(f.facts, a.taskId, epoch + 20).run?.runId, first.runId);
  assert.equal(project(f.facts, b.taskId, epoch + 20).run?.runId, first.runId);
  assert.notEqual(first.runId, second.runId);
  assert.equal(
    project(f.facts, a.taskId, epoch + 20).revision,
    project(f.facts, b.taskId, epoch + 20).revision,
  );
});
