import assert from "node:assert/strict";
import test from "node:test";
import {
  type JsonObject,
  project,
  reduce,
  type TaskSnapshot,
} from "@silvermoon-work/task-protocol";
import { sharingCases } from "../../task-protocol/test/sharing-fixtures.js";
import { MemoryStore } from "../src/testing.js";
import { createFixtureEngine } from "./driver.js";
import { caller, harness } from "./fixtures.js";

for (const scenario of sharingCases)
  test(`Schema Equals reservations, live, history, collection and recovery: ${scenario.name}`, async () => {
    const h = await harness({ parametersSchema: scenario.schema });
    const copy = new MemoryStore();
    let restored: ReturnType<typeof createFixtureEngine> | undefined;
    try {
      const owner = h.submit(scenario.left);
      const reserved = h.submit(scenario.right);
      await h.turn();
      const runId = h.engine.getTask(owner.taskId, caller).run?.runId;
      assert.ok(runId);
      assert.equal(h.work.length, scenario.equal ? 1 : 2);
      assert.equal(h.engine.getTask(reserved.taskId, caller).run?.runId === runId, scenario.equal);
      assert.deepEqual(h.work[0]?.input, scenario.left, "original Input is not projected away");
      const baseline = h.engine.listTasks({ runId }, {}, caller);
      const follower = h.submit({
        ...scenario.right,
        matchPolicy: "terminates-after-eligible",
      });
      assert.equal(follower.run?.runId === runId, scenario.equal);
      const request = h.engine.getRequest(owner.requestId, caller);
      assert.throws(
        () =>
          h.engine.submit(
            { ...request, ...scenario.right, timeoutMs: request.timeoutMs + 1 },
            caller,
          ),
        {
          code: "idempotency_conflict",
        },
      );
      const members = h.engine.subscribeTasks({ runId }, baseline.revision, caller);
      try {
        assert.deepEqual(
          members.pull().flatMap((envelope) => envelope.changes.map((change) => change.id)),
          scenario.equal ? [follower.taskId] : [],
        );
      } finally {
        members.close();
      }
      const history = h.engine.getTaskHistory(follower.taskId, {}, caller);
      const last = history.events.at(-1);
      assert.ok(last);
      const snapshot = (last.data as JsonObject).snapshot as unknown as TaskSnapshot;
      assert.equal(snapshot.run?.runId, follower.run?.runId);
      const view = h.store.read();
      assert.deepEqual(
        project(reduce(view.prefix, view.events), follower.taskId, h.clock.now()),
        follower,
      );
      copy.claim("copy");
      copy.append(
        "copy",
        0,
        view.events.map(({ sequence: _sequence, ...event }) => event),
      );
      copy.release("copy");
      restored = createFixtureEngine({
        store: copy,
        clock: h.clock,
        types: [h.type],
        currentVersions: { echo: "1" },
        authorize: () => true,
      });
      await restored.start();
      assert.equal(restored.getTask(follower.taskId, caller).run?.runId, follower.run?.runId);
      assert.equal(restored.getTask(follower.taskId, caller).stage, "stopped");
      const recovered = restored;
      assert.throws(() => recovered.subscribeTasks({ runId }, baseline.revision, caller), {
        code: "invalid_revision",
      });
      const copiedAnchor = `${copy.read().storeId}:${baseline.revision.split(":").at(-1)}`;
      const replay = restored.subscribeTasks({ runId }, copiedAnchor, caller);
      try {
        const joins = replay
          .pull()
          .flatMap((envelope) =>
            envelope.changes
              .filter((change) => change.kind === "joined")
              .map((change) => change.id),
          );
        assert.deepEqual(joins, scenario.equal ? [follower.taskId] : []);
      } finally {
        replay.close();
      }
    } finally {
      await restored?.close();
      copy.close();
      await h.close();
    }
  });
