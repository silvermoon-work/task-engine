import assert from "node:assert/strict";
import test from "node:test";
import {
  at,
  emptyFacts,
  isTimedOut,
  json,
  reduce,
  type TaskSnapshot,
  taskBundleSchema,
  taskSchemaUri,
  validateTaskBundle,
} from "../src/index.js";

test("the sole unreleased Task v1 includes diagnostics; removed v2 and future schemas are rejected", () => {
  const declaration = {
    $schema: taskSchemaUri,
    name: "V1 diagnostics",
    runtime: { type: "node", minVersion: "22.13.0" },
    entry: "worker.cjs",
    binary: [],
    include: ["task.yaml", "worker.cjs"],
    parametersSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
  };
  assert.equal(validateTaskBundle(declaration).$schema, taskSchemaUri);
  assert.equal(taskBundleSchema.$id, taskSchemaUri);
  assert.match(taskBundleSchema.$comment, /log\/log-ack/);
  for (const version of ["v2", "v3", "v999"])
    assert.throws(
      () => validateTaskBundle({ ...declaration, $schema: taskSchemaUri.replace("v1", version) }),
      { code: "invalid_bundle" },
    );
});

test("finite JSON never invokes accessors/toJSON and rejects non-JSON structures", () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      invoked++;
      return 1;
    },
  });
  const toJSON = {
    toJSON() {
      invoked++;
      return 1;
    },
  };
  const sparse = new Array(2);
  const decorated: unknown[] & { extra?: number } = [1];
  decorated.extra = 2;
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const value of [
    accessor,
    toJSON,
    sparse,
    decorated,
    cyclic,
    new Date(),
    Object.create(null),
    Infinity,
    NaN,
    undefined,
    1n,
    { a: undefined },
    Object.assign({}, { [Symbol()]: 1 }),
  ])
    assert.throws(() => json(value));
  assert.equal(invoked, 0);
  assert.deepEqual(json({ x: [1, null, false, "text"] }), { x: [1, null, false, "text"] });
  assert.throws(() => json("💡".repeat(100), 20), { code: "payload_too_large" });
});

test("time projection stays independent of cancellation and terminal stage, including deadline equality", () => {
  const snapshot: TaskSnapshot = {
    taskId: "t",
    requestId: "r",
    seriesId: "s",
    stage: "initial",
    receivedAt: at(0),
    eligibleAt: at(0),
    deadlineAt: at(10),
    timestamp: at(10),
    revision: "test-domain:0",
    dataDomain: "test-domain",
    updatedAt: at(0),
    canceled: false,
  };
  assert.equal(isTimedOut(snapshot), false);
  assert.equal(isTimedOut({ ...snapshot, timestamp: at(11) }), true);
  assert.equal(
    isTimedOut({ ...snapshot, timestamp: at(100), canceled: true, canceledAt: at(10) }),
    true,
  );
  assert.equal(isTimedOut({ ...snapshot, timestamp: at(100), canceledAt: at(11) }), true);
  for (const stage of ["completed", "failed", "stopped"] as const)
    assert.equal(isTimedOut({ ...snapshot, stage, timestamp: at(100) }), true);
  assert.throws(() => at(Number.MAX_SAFE_INTEGER));
});

test("pure reducer rejects gaps and derived notifications", () => {
  assert.throws(() => reduce(emptyFacts(), [{ sequence: 2, type: "task.updated" } as never]), {
    code: "history_gap",
  });
  assert.throws(
    () => reduce(emptyFacts(), [{ sequence: 1, type: "task.updated", occurredAt: at(0) } as never]),
    {
      code: "invalid_fact",
    },
  );
});
