import assert from "node:assert/strict";
import test from "node:test";
import { TaskError } from "@silvermoon-work/task-protocol";
import { RunLogs } from "../src/logs.js";
import { MemoryStore } from "../src/testing.js";

test("diagnostic per-entry, per-Run, total bytes, metadata and retention budgets are separate from facts", () => {
  const store = new MemoryStore();
  store.claim("owner");
  let now = 1000;
  const logs = new RunLogs(store, "owner", () => now, {
    entryBytes: 200,
    runBytes: 500,
    totalBytes: 200,
    maxRuns: 2,
    retentionMs: 100,
  });
  const entry = { level: "info" as const, message: "entry" };
  logs.initialize("a");
  assert.equal(logs.write("a", entry).state, "stored");
  now++;
  logs.initialize("b");
  assert.equal(logs.write("b", entry).state, "stored");
  now++;
  logs.initialize("c");
  assert.equal(logs.write("c", entry).state, "stored");
  assert.equal(logs.page("a", {}, true, "complete").state.reason, "metadata_evicted");
  assert.equal(logs.page("b", {}, true, "complete").state.availability, "expired");
  assert.equal(logs.page("b", {}, true, "complete").gap, true);
  assert.equal(logs.write("c", { ...entry, message: "x".repeat(300) }).state, "dropped");
  assert.equal(logs.page("c", {}, true, "open").state.dropped, 1);
  assert.equal(store.read().facts.watermark, 0, "Diagnostic writes never create lifecycle facts.");
  now += 101;
  assert.equal(logs.page("c", {}, true, "complete").state.availability, "expired");
  assert.throws(() => logs.page("c", { afterSequence: 0.5 }, true, "complete"), {
    code: "invalid_log_cursor",
  });
  assert.throws(() => logs.write("c", { level: "fatal", message: "bad" } as never), {
    code: "invalid_log",
  });
  store.release("owner");
  store.close();
});
test("diagnostic status failures do not become an empty successful page or poison lifecycle store", () => {
  const store = new MemoryStore();
  store.claim("owner");
  const logs = new RunLogs(store, "owner", () => 1000);
  logs.initialize("a");
  store.beforeLogCommit = () => {
    throw new Error("write failure");
  };
  assert.deepEqual(logs.write("a", { level: "info", message: "lost" }), {
    state: "unavailable",
    reason: "storage",
  });
  assert.equal(logs.page("a", {}, true, "complete").state.availability, "unavailable");
  store.readRunLogs = () => {
    throw new TaskError("storage_failure", "Status service offline.");
  };
  assert.throws(() => logs.page("a", {}, true, "complete"), { code: "log_storage_unavailable" });
  assert.equal(store.read().facts.watermark, 0);
  store.release("owner");
  store.close();
});
test("large configured pages remain below the fixed transport byte ceiling and continue without sequence gaps", () => {
  const store = new MemoryStore();
  store.claim("owner");
  const logs = new RunLogs(store, "owner", () => 1000, { runBytes: 4_194_304, pageSize: 1000 });
  logs.initialize("a");
  for (let index = 0; index < 160; index++)
    assert.equal(logs.write("a", { level: "info", message: "x".repeat(8192) }).state, "stored");
  const first = logs.page("a", {}, true, "complete");
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1_048_576);
  assert.equal(first.hasMore, true);
  const next = logs.page("a", { afterSequence: first.nextSequence }, true, "complete");
  assert.equal(next.gap, false);
  assert.equal(next.entries[0]?.sequence, first.nextSequence + 1);
  assert.equal(first.entries.length + next.entries.length, 160);
  store.release("owner");
  store.close();
});
