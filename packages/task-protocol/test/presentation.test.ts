import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTaskStatus,
  type Stage,
  type TaskDisplayStatus,
  type TaskStatusInput,
  type TaskStatusQualifier,
} from "../src/index.js";

const eligibleAt = "2026-10-31T00:00:01.000Z";
const deadlineAt = "2026-10-31T00:00:02.000Z";
const eligible = Date.parse(eligibleAt);
const deadline = Date.parse(deadlineAt);
const stages: Stage[] = ["initial", "running", "stopping", "completed", "failed", "stopped"];
const boundaries = [
  { name: "before eligibility", now: eligible - 1, initial: "pending" },
  { name: "at eligibility", now: eligible, initial: "waiting" },
  { name: "within eligibility", now: eligible + 1, initial: "waiting" },
  { name: "at deadline", now: deadline, initial: "waiting" },
  { name: "after deadline", now: deadline + 1, initial: "timedOut" },
] satisfies { name: string; now: number; initial: TaskDisplayStatus }[];

for (const stage of stages)
  for (const canceled of [false, true])
    for (const boundary of boundaries)
      test(`${stage}, canceled=${canceled}, ${boundary.name}`, () => {
        const task = Object.freeze({ stage, canceled, eligibleAt, deadlineAt });
        const terminal = stage === "completed" || stage === "failed" || stage === "stopped";
        const expectedStatus: TaskDisplayStatus = terminal
          ? stage
          : canceled
            ? "canceled"
            : boundary.now > deadline
              ? "timedOut"
              : stage === "initial"
                ? boundary.initial
                : stage;
        const expectedQualifiers: TaskStatusQualifier[] =
          terminal && canceled
            ? ["demandWithdrawn"]
            : !terminal && stage !== "initial" && (canceled || boundary.now > deadline)
              ? ["runNotEnded"]
              : [];
        assert.deepEqual(aggregateTaskStatus(task, boundary.now), {
          status: expectedStatus,
          qualifiers: expectedQualifiers,
        });
        assert.deepEqual(task, { stage, canceled, eligibleAt, deadlineAt });
      });

test("presentation depends only on explicit time, not snapshot timestamp or result timing", () => {
  const task = {
    stage: "initial",
    canceled: false,
    eligibleAt,
    deadlineAt,
    timestamp: "2000-01-01T00:00:00.000Z",
  } satisfies TaskStatusInput & { timestamp: string };
  assert.equal(aggregateTaskStatus(task, deadline + 1).status, "timedOut");
  assert.equal(aggregateTaskStatus(task, eligible - 1).status, "pending");
  assert.deepEqual(aggregateTaskStatus({ ...task, stage: "completed" }, deadline + 1), {
    status: "completed",
    qualifiers: [],
  });
  const first = aggregateTaskStatus(task, deadline + 1);
  first.qualifiers.push("runNotEnded");
  assert.deepEqual(aggregateTaskStatus(task, deadline + 1), {
    status: "timedOut",
    qualifiers: [],
  });
});

test("invalid time, boundaries and state fail explicitly", () => {
  const task: TaskStatusInput = { stage: "initial", canceled: false, eligibleAt, deadlineAt };
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 253_402_300_800_000])
    assert.throws(() => aggregateTaskStatus(task, now), { code: "invalid_request" });
  for (const invalid of [
    { ...task, eligibleAt: "not-a-date" },
    { ...task, deadlineAt: "not-a-date" },
    { ...task, eligibleAt: "2026-10-31T00:00:01Z" },
    { ...task, eligibleAt: deadlineAt, deadlineAt: eligibleAt },
  ])
    assert.throws(() => aggregateTaskStatus(invalid, eligible), { code: "invalid_request" });
  for (const invalid of [
    { ...task, stage: "unknown" },
    { ...task, canceled: "false" },
  ])
    assert.throws(() => Reflect.apply(aggregateTaskStatus, undefined, [invalid, eligible]), {
      code: "invalid_request",
    });
});
