import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { newId } from "@silvermoon-work/task-engine";
import { createTaskEngine as createProductionEngine } from "../../task-engine/src/engine.js";
import { at, type NewEvent, project } from "@silvermoon-work/task-protocol";
import { createFixtureEngine as createTaskEngine } from "../../task-engine/test/driver.js";
import { caller, harness } from "../../task-engine/test/fixtures.js";
import { openSqliteStore } from "../src/index.js";

test("SQLite v4 source updates, original validators, restart and protected compact without Task update authority", async () => {
  const root = resolve(".cache", `catalog-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const filename = join(root, "history.sqlite");
  const h = await harness();
  try {
    const canceled = h.submit();
    const live = h.submit();
    await h.turn();
    const matchedAt = h.engine.getTask(live.taskId, caller).updatedAt;
    h.clock.setTime(h.clock.now() + 10);
    h.engine.cancelTask(canceled.taskId, caller);
    const canceledAt = at(h.clock.now());
    h.clock.setTime(h.clock.now() + 10);
    h.work[0]?.permit.progress({ stage: "execution", percent: 50, message: "" });
    const history = h.store.read();
    const seed = openSqliteStore(filename);
    seed.claim("seed");
    seed.append(
      "seed",
      0,
      history.events.map(({ sequence: _sequence, ...event }) => event as NewEvent),
    );
    assert.throws(() => seed.compact("seed", history.facts.watermark), {
      code: "protected_history",
    });
    seed.release("seed");
    seed.close();
    const store = openSqliteStore(filename);
    try {
      const recovered = store.read();
      assert.equal(project(recovered.facts, live.taskId, h.clock.now()).updatedAt, matchedAt);
      assert.equal(project(recovered.facts, canceled.taskId, h.clock.now()).updatedAt, canceledAt);
      assert.ok(Object.values(recovered.facts.tasks).every((task) => !("updatedAt" in task)));
      const unsupported = createTaskEngine({
        store,
        clock: h.clock,
        types: [{ ...h.type, version: "2" }],
        currentVersions: { echo: "2" },
        authorize: () => true,
      });
      await assert.rejects(unsupported.start(), { code: "unsupported_version" });
      const changedSchema = createTaskEngine({
        store,
        clock: h.clock,
        types: [{ ...h.type, parametersSchema: { type: "object" } }],
        currentVersions: { echo: "1" },
        authorize: () => true,
      });
      await assert.rejects(changedSchema.start(), { code: "unsupported_contract" });
      assert.throws(
        () =>
          createProductionEngine({
            store,
            clock: h.clock,
            types: [h.type as unknown as import("@silvermoon-work/task-protocol").RegisteredType],
            currentVersions: { echo: "1" },
            authorize: () => true,
          }),
        { code: "invalid_type" },
      );
      assert.deepEqual(store.read().facts, recovered.facts);
      h.clock.setTime(h.clock.now() + 100);
      const engine = createTaskEngine({
        store,
        clock: h.clock,
        types: [h.type],
        currentVersions: { echo: "1" },
        authorize: () => true,
      });
      await engine.start();
      const page = engine.listTasks({}, {}, caller);
      assert.equal(
        page.tasks.find((item) => item.taskId === canceled.taskId)?.updatedAt,
        at(h.clock.now()),
      );
      assert.equal(
        page.tasks.find((item) => item.taskId === live.taskId)?.updatedAt,
        at(h.clock.now()),
        "recovery stop is a genuine source fact, not a read-time refresh",
      );
      assert.equal(
        (engine.getRequest(live.requestId, caller).parameters as { data: { text: string } }).data
          .text,
        "hello",
      );
      assert.equal(engine.getRequest(live.requestId, caller).version, undefined);
      await engine.close();
      const persistent = store.read();
      store.close();
      const reopened = openSqliteStore(filename);
      try {
        assert.deepEqual(reopened.read().facts, persistent.facts);
        const second = createTaskEngine({
          store: reopened,
          clock: h.clock,
          types: [h.type],
          currentVersions: { echo: "1" },
          authorize: () => true,
        });
        await second.start();
        assert.deepEqual(second.listTasks({}, {}, caller).tasks, page.tasks);
        await second.close();
        reopened.claim("compact");
        const view = reopened.read();
        reopened.append("compact", view.facts.watermark, [
          {
            type: "records.forgotten",
            scope: caller.scope,
            occurredAt: at(h.clock.now()),
            data: {
              taskIds: Object.keys(view.facts.tasks),
              runIds: Object.keys(view.facts.runs),
            },
          },
        ]);
        const boundary = reopened.read().facts.watermark;
        reopened.compact("compact", boundary);
        reopened.release("compact");
        const afterCompact = createTaskEngine({
          store: reopened,
          clock: h.clock,
          types: [h.type],
          currentVersions: { echo: "1" },
          authorize: () => true,
        });
        await afterCompact.start();
        assert.equal(afterCompact.listTasks({}, {}, caller).tasks.length, 0);
        const fresh = afterCompact.submit(
          {
            requestId: newId(h.clock.now()),
            type: "echo",
            text: "retained",
            timeoutMs: 1_000,
            eligibleAt: at(h.clock.now() + 100_000),
          },
          caller,
        );
        await afterCompact.close();
        reopened.close();
        const final = openSqliteStore(filename);
        try {
          assert.equal(final.read().floor, boundary);
          assert.equal(
            project(final.read().facts, fresh.taskId, h.clock.now()).updatedAt,
            fresh.receivedAt,
          );
        } finally {
          final.close();
        }
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
