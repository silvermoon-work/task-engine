import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TaskService } from "@silvermoon-work/task-protocol";
import { IpfsStore } from "../../task-engine/src/content.js";
import { createTaskEngine } from "../../task-engine/src/engine.js";
import { newId } from "../../task-engine/src/identity.js";
import { MemoryStore } from "../../task-engine/src/memory-store.js";
import { VirtualClock } from "../../task-engine/src/testing.js";
import {
  archiveTestType,
  deferred,
  poll,
  putRawContent,
} from "../../task-engine/test/run-history-archive-fixture.js";
import { createTaskHandler } from "../src/index.js";

const caller = { scope: "scope", subject: "owner" };

test("HTTP archive export uses Engine history authorization and returns a verified closure", async (t) => {
  const directory = resolve(".cache", `http-archive-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const archiveStore = new IpfsStore({ dataDir: join(directory, "ipfs") });
  const store = new MemoryStore();
  const starts = { n: 0 };
  const hold = deferred<void>();
  const clock = new VirtualClock();
  const bytes = Buffer.from("http-archive-root");
  const contentCid = await putRawContent(archiveStore, bytes);
  const engine = createTaskEngine({
    store,
    clock,
    archiveStore,
    types: [archiveTestType(starts, hold.promise)],
    currentVersions: { "run-test": "1" },
    authorize: (current, _operation, scope) => current.scope === scope,
    archive: { retryDelayMs: 1, leaseMs: 10_000, maxAttempts: 8 },
  });
  t.after(async () => {
    await engine.close().catch(() => {});
    await archiveStore.close().catch(() => {});
    store.close();
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* Windows may still hold the data directory */
    }
  });
  await engine.start();
  const task = engine.submit(
    {
      requestId: newId(clock.now()),
      type: "run-test",
      timeoutMs: 5000,
      mode: "work",
      text: contentCid.toString(),
    },
    caller,
  );
  engine.tick();
  await poll(() => starts.n === 1, t.signal);
  const runId = Object.keys(engine.facts().facts.runs)[0]!;
  engine.writeContentBlock(contentCid.toString(), bytes);
  engine.retainRunContent(runId, contentCid.toString());
  hold.resolve();
  await engine.waitForIdle(
    () => !!engine.getTask(task.taskId, caller).termination,
    AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
  );
  await poll(() => store.runHistory.read(runId)?.archive.state === "archived", t.signal);
  const handler = createTaskHandler({
    service: engine as unknown as TaskService,
    resolveCaller: (request) => {
      const subject = request.headers.get("authorization") ?? caller.subject;
      return subject === "outsider"
        ? { scope: "other", subject }
        : { scope: caller.scope, subject };
    },
  });
  const granted = await handler(
    new Request(`http://host/runs/${runId}/archive`, {
      headers: { authorization: caller.subject },
    }),
  );
  assert.equal(granted.status, 200);
  const body = (await granted.json()) as {
    status: string;
    source?: { runId: string };
    record?: { archive?: { published?: { receipt?: { blockCount: number; byteLength: number } } } };
  };
  assert.equal(body.status, "available");
  assert.equal(body.source?.runId, runId);
  assert.ok((body.record?.archive?.published?.receipt?.blockCount ?? 0) >= 2);
  const history = await handler(
    new Request(`http://host/runs/${runId}/history`, {
      headers: { authorization: caller.subject },
    }),
  );
  assert.equal(history.status, 200);
  const denied = await handler(
    new Request(`http://host/runs/${runId}/archive`, { headers: { authorization: "outsider" } }),
  );
  assert.equal(denied.status, 403);
  const deniedHistory = await handler(
    new Request(`http://host/runs/${runId}/history`, { headers: { authorization: "outsider" } }),
  );
  assert.equal(deniedHistory.status, 403);
});
