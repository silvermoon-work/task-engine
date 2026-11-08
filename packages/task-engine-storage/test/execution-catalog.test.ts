import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { NewEvent } from "@silvermoon-work/task-protocol";
import { createFixtureEngine } from "../../task-engine/test/driver.js";
import { caller, harness } from "../../task-engine/test/fixtures.js";
import { openSqliteStore } from "../src/index.js";

test("Execution directory reads persisted SQLite facts after reopen and rejects prior-process cursors", async () => {
  const root = resolve(".cache", `execution-catalog-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const h = await harness();
  try {
    h.submit({ text: "one" });
    h.submit({ text: "two" });
    await h.turn();
    await h.finish(0);
    await h.finish(1);
    await h.turn();
    const filename = resolve(root, "store.sqlite");
    let store = openSqliteStore(filename);
    store.claim("seed");
    store.append(
      "seed",
      0,
      h.store.read().events.map(({ sequence: _sequence, ...event }) => event as NewEvent),
    );
    store.release("seed");
    const options = {
      clock: h.clock,
      types: [h.type],
      currentVersions: { echo: "1" },
      authorize: () => true,
      limits: { pageSize: 1 },
    };
    const one = createFixtureEngine({ ...options, store });
    await one.start();
    const page = one.listRuns({}, {}, caller);
    assert.ok(page.next);
    assert.equal(page.runs[0]!.state.reclaimed, true);
    await one.close();
    store.close();
    store = openSqliteStore(filename);
    const two = createFixtureEngine({ ...options, store });
    await two.start();
    try {
      assert.deepEqual(two.listRuns({}, {}, caller).runs, page.runs);
      assert.throws(() => two.listRuns({}, { cursor: page.next! }, caller), {
        code: "query_expired",
      });
      assert.equal(
        two.listRuns({}, { cursor: two.listRuns({}, {}, caller).next! }, caller).runs.length,
        1,
      );
    } finally {
      await two.close();
      store.close();
    }
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
