import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runHistoryEngineCase } from "../../task-engine/test/run-history-engine-fixture.js";
import { epoch } from "../../task-protocol/test/fact-fixtures.js";
import {
  historyCid,
  historyFixture,
  historyPolicy,
  receipt,
  runHistoryCases,
} from "../../task-protocol/test/run-history-fixtures.js";
import { openSqliteStore } from "../src/index.js";

function location() {
  const directory = resolve(".cache", `run-history-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return {
    file: join(directory, "facts.sqlite"),
    dispose: () => rmSync(directory, { force: true, recursive: true }),
  };
}
runHistoryCases("SqliteStore", () => {
  const files = location();
  return { store: openSqliteStore(files.file), dispose: files.dispose };
});
runHistoryEngineCase("SqliteStore", () => {
  const files = location();
  return {
    store: openSqliteStore(files.file),
    reopen: () => openSqliteStore(files.file),
    dispose: files.dispose,
  };
});

for (const fault of ["beforeCommit", "afterCommit"] as const) {
  test(`SQLite archive ${fault} failure reopens to the exact durable boundary`, () => {
    const files = location(),
      f = historyFixture();
    let armed = false;
    const store = openSqliteStore(files.file, {
      fault(point) {
        if (armed && point === fault) throw new Error("injected crash");
      },
    });
    store.claim("writer");
    store.append("writer", 0, f.events);
    const facts = store.read();
    armed = true;
    assert.throws(
      () => store.runHistory.finalize("writer", f.run.runId, historyPolicy),
      /injected crash/,
    );
    store.release("writer");
    store.close();
    const reopened = openSqliteStore(files.file);
    reopened.claim("new-writer");
    try {
      assert.deepEqual(reopened.read(), facts);
      assert.equal(!!reopened.runHistory.read(f.run.runId), fault === "afterCommit");
      reopened.runHistory.finalize("new-writer", f.run.runId, historyPolicy);
      assert.equal(reopened.runHistory.read(f.run.runId)?.sourceWatermark, facts.facts.watermark);
    } finally {
      reopened.release("new-writer");
      reopened.close();
      files.dispose();
    }
  });
  test(`SQLite archive completion ${fault} fault never changes the completed Run`, () => {
    const files = location(),
      f = historyFixture();
    let armed = false;
    const store = openSqliteStore(files.file, {
      fault(point) {
        if (armed && point === fault) throw new Error("completion crash");
      },
    });
    store.claim("writer");
    store.append("writer", 0, f.events);
    store.runHistory.finalize("writer", f.run.runId, historyPolicy);
    const lease = store.runHistory.claimArchive("writer", f.run.runId, {
      now: epoch + 11,
      leaseMs: 100,
    })!;
    store.runHistory.setArchiveRoot("writer", lease, historyCid, epoch + 11);
    const before = store.read();
    armed = true;
    assert.throws(
      () => store.runHistory.completeArchive("writer", lease, receipt(), epoch + 12),
      /completion crash/,
    );
    store.release("writer");
    store.close();
    const reopened = openSqliteStore(files.file);
    reopened.claim("recovery");
    try {
      assert.equal(
        reopened.runHistory.read(f.run.runId)?.archive.state,
        fault === "beforeCommit" ? "archiving" : "archived",
      );
      assert.equal(
        reopened.runHistory.completeArchive("recovery", lease, receipt(), epoch + 13),
        true,
      );
      assert.equal(
        reopened.runHistory.read(f.run.runId)?.archive.published?.receipt.rootCid,
        historyCid,
      );
      assert.deepEqual(reopened.read(), before);
    } finally {
      reopened.release("recovery");
      reopened.close();
      files.dispose();
    }
  });
}

test("SQLite process exit after intent commit preserves sources and fences recovery without Worker replay", () => {
  const files = location(),
    f = historyFixture();
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { openSqliteStore } from './src/index.ts';
      import { historyFixture, historyPolicy, historyCid } from '../task-protocol/test/run-history-fixtures.ts';
      const store = openSqliteStore(process.argv[1]), f = historyFixture();
      store.claim('dead-process');
      store.append('dead-process', 0, f.events);
      store.runHistory.finalize('dead-process', f.run.runId, historyPolicy);
      const lease = store.runHistory.claimArchive('dead-process', f.run.runId, {now: historyPolicy.now + 1, leaseMs: 10});
      store.runHistory.setArchiveRoot('dead-process', lease, historyCid, historyPolicy.now + 1);
      process.exit(0);
    `,
        files.file,
      ],
      { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const reopened = openSqliteStore(files.file);
    reopened.claim("recovery");
    try {
      const before = reopened.read();
      const old = reopened.runHistory.read(f.run.runId)!.attempts[0]!.lease;
      assert.equal(
        reopened.runHistory.readSource(f.run.runId, epoch + 12).run.outcome?.kind,
        "completed",
      );
      assert.equal(
        reopened.runHistory.claimArchive("recovery", f.run.runId, { now: epoch + 12, leaseMs: 10 }),
        undefined,
      );
      reopened.runHistory.recover("recovery", f.run.runId, epoch + 21);
      assert.equal(reopened.runHistory.read(f.run.runId)?.attempts[0]?.release?.state, "pending");
      const next = reopened.runHistory.claimArchive("recovery", f.run.runId, {
        now: epoch + 31,
        leaseMs: 10,
      })!;
      assert.notEqual(next.owner, old.owner);
      assert.equal(
        reopened.runHistory.completeArchive("recovery", old, receipt(epoch + 32), epoch + 32),
        false,
      );
      assert.deepEqual(reopened.read(), before);
    } finally {
      reopened.release("recovery");
      reopened.close();
    }
  } finally {
    files.dispose();
  }
});

test("SQLite release intent survives record deletion, compaction, crash and delayed completion", () => {
  const files = location(),
    f = historyFixture();
  let armed = false;
  const store = openSqliteStore(files.file, {
    fault(point) {
      if (armed && point === "afterCommit") throw new Error("lost commit response");
    },
  });
  store.claim("writer");
  store.append("writer", 0, f.events);
  store.runHistory.finalize("writer", f.run.runId, historyPolicy);
  const lease = store.runHistory.claimArchive("writer", f.run.runId, {
    now: epoch + 11,
    leaseMs: 100,
  })!;
  store.runHistory.setArchiveRoot("writer", lease, historyCid, epoch + 11);
  armed = true;
  assert.throws(
    () =>
      store.append("writer", store.read().facts.watermark, [
        {
          type: "records.forgotten",
          scope: "",
          occurredAt: new Date(epoch + 12).toISOString(),
          data: { runIds: [f.run.runId], taskIds: [f.first.taskId, f.second.taskId] },
        },
      ]),
    /lost commit response/,
  );
  store.release("writer");
  store.close();
  const reopened = openSqliteStore(files.file);
  reopened.claim("recovery");
  try {
    assert.equal(reopened.read().facts.runs[f.run.runId], undefined);
    assert.equal(reopened.runHistory.read(f.run.runId)?.retention.reason, "record-forgotten");
    reopened.compact("recovery", reopened.read().facts.watermark);
    const release = reopened.runHistory.claimRelease("recovery", f.run.runId, 1, {
      now: epoch + 13,
      leaseMs: 100,
    })!;
    reopened.runHistory.completeRelease("recovery", release, epoch + 14);
    assert.equal(
      reopened.runHistory.completeArchive("recovery", lease, receipt(epoch + 15), epoch + 15),
      false,
    );
    assert.equal(reopened.runHistory.read(f.run.runId)?.retention.state, "release-requested");
    assert.equal(reopened.runHistory.completeRelease("recovery", release, epoch + 16), false);
    assert.deepEqual(reopened.read().facts.runs, {});
    assert.ok(reopened.read().facts.requests[f.first.request.requestId]);
  } finally {
    reopened.release("recovery");
    reopened.close();
    files.dispose();
  }
});

test("SQLite archive layout is additive, and incompatible owned layouts are rejected without modification", () => {
  const files = location();
  try {
    const store = openSqliteStore(files.file);
    const before = store.read();
    assert.deepEqual(store.runHistory.list(), []);
    store.close();
    const db = new DatabaseSync(files.file);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='run_history_archives'").get(),
      undefined,
    );
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 5);
    db.exec("CREATE TABLE run_history_archives(old_layout TEXT)");
    db.close();
    const bytes = () =>
      readdirSync(dirname(files.file))
        .sort()
        .map((name) => [name, readFileSync(join(dirname(files.file), name))]);
    const preserved = bytes();
    assert.throws(() => openSqliteStore(files.file), { code: "unsupported_version" });
    assert.deepEqual(bytes(), preserved);
    assert.equal(before.facts.projectionVersion, 5);
  } finally {
    files.dispose();
  }
});
