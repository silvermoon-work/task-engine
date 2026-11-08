import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { emptyFacts } from "@silvermoon-work/task-protocol";
import { openSqliteStore } from "../src/index.js";

async function bytes(root: string) {
  return Promise.all(
    (await readdir(root)).sort().map(async (name) => [name, await readFile(join(root, name))]),
  );
}

for (const version of [0, 1, 3, 4, 99]) {
  test(`version ${version} occupied database is rejected without changing bytes or sidecars`, async () => {
    const root = resolve(".cache", `format-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filename = join(root, "old.sqlite");
    try {
      const old = new DatabaseSync(filename);
      old.exec(
        `CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('history'); PRAGMA user_version=${version};`,
      );
      old.close();
      if (version !== 0) {
        await writeFile(`${filename}-wal`, "preserve existing WAL bytes");
        await writeFile(`${filename}-shm`, "preserve existing SHM bytes");
        await writeFile(`${filename}.owner`, "preserve ownership bytes");
      }
      const before = await bytes(root);
      assert.throws(
        () => openSqliteStore(filename),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "unsupported_version" &&
          error.message.includes("new database"),
      );
      assert.deepEqual(await bytes(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const invalid of ["checkpoint", "facts", "binding"] as const) {
  test(`new SQLite header cannot disguise old ${invalid}`, async () => {
    const root = resolve(".cache", `format-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filename = join(root, "old.sqlite");
    try {
      openSqliteStore(filename).close();
      const db = new DatabaseSync(filename);
      if (invalid === "checkpoint") db.exec("UPDATE checkpoint SET projection_version=1");
      else {
        const facts = emptyFacts();
        const payload =
          invalid === "facts"
            ? { ...facts, projectionVersion: 1 }
            : {
                ...facts,
                runs: { old: { binding: { matchPolicy: "completed-after-eligible" } } },
              };
        db.prepare("UPDATE checkpoint SET payload=?").run(JSON.stringify(payload));
      }
      db.close();
      const before = await bytes(root);
      assert.throws(() => openSqliteStore(filename), { code: "unsupported_version" });
      assert.deepEqual(await bytes(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("only empty stores initialize v5 and reopen with unchanged identity", async () => {
  const root = resolve(".cache", `format-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const filename = join(root, "new.sqlite");
  try {
    const blank = new DatabaseSync(filename);
    blank.close();
    const store = openSqliteStore(filename);
    const before = store.read();
    store.close();
    const reopened = openSqliteStore(filename);
    assert.deepEqual(reopened.read(), before);
    reopened.close();
    const inspect = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 5);
      assert.equal(
        inspect.prepare("SELECT projection_version FROM checkpoint").get()?.projection_version,
        5,
      );
      assert.equal(before.facts.projectionVersion, 5);
    } finally {
      inspect.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("old checkpoint in a live WAL is rejected without modifying its files", async () => {
  const root = resolve(".cache", `format-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const filename = join(root, "wal.sqlite");
  openSqliteStore(filename).close();
  const writer = new DatabaseSync(filename);
  try {
    writer.exec("UPDATE checkpoint SET projection_version=1");
    const before = await bytes(root);
    assert.throws(() => openSqliteStore(filename), { code: "unsupported_version" });
    assert.deepEqual(await bytes(root), before);
  } finally {
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});
