import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runHistoryArchiveCases } from "../../task-engine/test/run-history-archive-fixture.js";
import { openSqliteStore } from "../src/index.js";

function location() {
  const directory = resolve(".cache", `run-history-archive-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return {
    file: join(directory, "facts.sqlite"),
    dispose: () => {
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
    },
  };
}

runHistoryArchiveCases("SqliteStore", () => {
  const files = location();
  return {
    store: openSqliteStore(files.file),
    reopen: () => openSqliteStore(files.file),
    dispose: files.dispose,
  };
});
