import assert from "node:assert/strict";
import test from "node:test";
import {
  historyCid,
  historyFixture,
  historyPolicy,
  runHistoryCases,
} from "../../task-protocol/test/run-history-fixtures.js";
import { MemoryStore } from "../src/memory-store.js";
import { runHistoryEngineCase } from "./run-history-engine-fixture.js";

runHistoryCases("MemoryStore", () => ({ store: new MemoryStore(), dispose() {} }));
runHistoryEngineCase("MemoryStore", () => ({ store: new MemoryStore(), dispose() {} }));

test("MemoryStore archive transaction rolls back faults and detects reentrant source changes", () => {
  const store = new MemoryStore(),
    f = historyFixture();
  store.claim("writer");
  try {
    store.append("writer", 0, f.events);
    store.beforeCommit = () => {
      throw new Error("injected commit fault");
    };
    assert.throws(
      () => store.runHistory.finalize("writer", f.run.runId, historyPolicy),
      /injected/,
    );
    assert.equal(store.runHistory.read(f.run.runId), undefined);
    store.beforeCommit = () => {
      store.retainRunContent("writer", f.run.runId, historyCid);
    };
    assert.throws(() => store.runHistory.finalize("writer", f.run.runId, historyPolicy), {
      code: "storage_conflict",
    });
    assert.equal(store.runHistory.read(f.run.runId), undefined);
    delete store.beforeCommit;
    store.runHistory.finalize("writer", f.run.runId, historyPolicy);
    assert.deepEqual(store.runHistory.readSource(f.run.runId, historyPolicy.now).contentRoots, [
      historyCid,
    ]);
    store.release("writer");
    store.claim("next-owner");
    assert.equal(store.runHistory.read(f.run.runId)?.archive.state, "pending");
    assert.throws(() => store.runHistory.recover("writer", f.run.runId, historyPolicy.now), {
      code: "store_owned",
    });
    store.release("next-owner");
  } finally {
    store.close();
  }
});
