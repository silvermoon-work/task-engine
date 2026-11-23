import assert from "node:assert/strict";
import test from "node:test";
import type { RegisteredType } from "@silvermoon-work/task-protocol";
import { historyPolicy, type HistoryStore } from "../../task-protocol/test/run-history-fixtures.js";
import { createTaskEngine } from "../src/engine.js";
import { newId } from "../src/identity.js";
import { VirtualClock } from "../src/testing.js";

export function runHistoryEngineCase(
  name: string,
  create: () => { store: HistoryStore; reopen?(): HistoryStore; dispose(): void },
): void {
  test(`${name}: completed Engine work stays completed across archive failure and Engine restart`, async (t) => {
    const fixture = create();
    let store = fixture.store,
      starts = 0;
    const clock = new VirtualClock();
    const caller = { scope: "scope", subject: "owner" };
    const registration: RegisteredType = {
      type: "run-test",
      version: "1",
      environment: "trusted",
      parametersSchema: {
        type: "object",
        properties: { mode: { enum: ["work", "messages", "mutate"] }, text: { type: "string" } },
        required: ["mode", "text"],
        additionalProperties: false,
      },
      messageSchema: {
        type: "object",
        properties: {
          kind: { enum: ["add", "target", "finish"] },
          amount: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      resultSchema: { type: "object" },
      module: new URL("./run-type.mjs", import.meta.url).href,
      exportName: "createType",
      verifyExportName: "verify",
      configuration: {},
      resourceLifetime: "request",
      resources: {
        prepare: async () => {
          starts++;
          return null;
        },
      },
    };
    const createEngine = () =>
      createTaskEngine({
        store,
        clock,
        types: [registration],
        currentVersions: { "run-test": "1" },
        authorize: () => true,
      });
    let engine = createEngine();
    try {
      await engine.start();
      const task = engine.submit(
        {
          requestId: newId(clock.now()),
          type: "run-test",
          timeoutMs: 5000,
          mode: "work",
          text: "unchanged",
        },
        caller,
      );
      engine.tick();
      await engine.waitForIdle(
        () => !!engine.getTask(task.taskId, caller).termination,
        AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
      );
      const completed = engine.getTask(task.taskId, caller);
      assert.equal(completed.stage, "completed");
      assert.equal(starts, 1);
      assert.deepEqual(
        store.runHistory.list(),
        [],
        "Archiving remains opt-in before the vertical switch.",
      );
      await engine.close();
      store.claim("archiver");
      try {
        store.runHistory.finalize("archiver", completed.run!.runId, historyPolicy);
        const lease = store.runHistory.claimArchive("archiver", completed.run!.runId, {
          now: historyPolicy.now + 1,
          leaseMs: 100,
        })!;
        store.runHistory.failArchive(
          "archiver",
          lease,
          {
            code: "archive_offline",
            message: "Business completion is independent.",
          },
          historyPolicy.now + 2,
        );
      } finally {
        store.release("archiver");
      }
      if (fixture.reopen) {
        store.close();
        store = fixture.reopen();
      }
      engine = createEngine();
      await engine.start();
      engine.tick();
      assert.equal(starts, 1);
      assert.deepEqual(engine.getTask(task.taskId, caller), completed);
      assert.equal(
        store.runHistory.read(completed.run!.runId)?.archive.error?.code,
        "archive_offline",
      );
      assert.equal(Object.keys(store.read().facts.runs).length, 1);
    } finally {
      await engine.close();
      store.close();
      fixture.dispose();
    }
  });
}
