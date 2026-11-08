import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { StoredRunLogs } from "@silvermoon-work/task-protocol";
import { openSqliteStore } from "../src/index.js";

test("diagnostic lock contention never waits for the lifecycle busy timeout or retains a transaction", async () => {
  const directory = resolve(".cache", `log-lock-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const filename = join(directory, "tasks.sqlite");
  const store = openSqliteStore(filename, { busyTimeoutMs: 5000 });
  const competing = new DatabaseSync(filename);
  const record: StoredRunLogs = {
    runId: "run",
    updatedAt: 1000,
    bytes: 0,
    entries: [],
    state: {
      availability: "available",
      completeness: "open",
      dropped: 0,
      firstSequence: 1,
      lastSequence: 0,
    },
  };
  store.claim("owner");
  try {
    store.writeRunLogs("owner", record);
    competing.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    assert.throws(() => store.writeRunLogs("owner", record), /locked/);
    assert.throws(() => store.pruneRunLogs("owner", 0, 1000, 10), /locked/);
    assert.throws(() => store.markRunLogsUnavailable("owner", "run", 1000), /locked/);
    assert.ok(
      performance.now() - start < 2000,
      "Three diagnostic operations must not each wait 5000 ms.",
    );
    competing.exec("ROLLBACK");
    store.append("owner", 0, []);
    assert.equal(store.read().facts.watermark, 0);
    store.writeRunLogs("owner", record);
    assert.deepEqual(store.readRunLogs("run"), record);
  } finally {
    competing.close();
    store.release("owner");
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
