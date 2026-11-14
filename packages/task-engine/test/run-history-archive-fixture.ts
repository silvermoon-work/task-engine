import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { ContentError } from "@silvermoon-work/ipfs-store";
import { contentLinks } from "@silvermoon-work/ipfs-store/dag";
import type { RegisteredType } from "@silvermoon-work/task-protocol";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  type HistoryStore,
  historyFixture,
  historyPolicy,
} from "../../task-protocol/test/run-history-fixtures.js";
import { IpfsStore } from "../src/content.js";
import { createTaskEngine } from "../src/engine.js";
import { newId } from "../src/identity.js";
import {
  decodeRunHistoryDag,
  encodeRunHistoryDag,
  publishRunHistoryArchive,
} from "../src/run-history-archive.js";
import { VirtualClock } from "../src/testing.js";

export async function poll(
  check: () => boolean | Promise<boolean>,
  signal: AbortSignal,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new Error("Timed out waiting for archive progress.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function interceptRetain(
  store: IpfsStore,
  hook: (next: IpfsStore["retain"]) => IpfsStore["retain"],
): IpfsStore {
  const original = store.retain.bind(store);
  store.retain = hook(original);
  return store;
}

function registration(
  starts: { n: number },
  hold: Promise<void> = Promise.resolve(),
): RegisteredType {
  return {
    type: "run-test",
    version: "1",
    environment: "trusted",
    inputSchema: {
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
        starts.n++;
        await hold;
        return null;
      },
    },
  };
}

export function runHistoryArchiveCases(
  name: string,
  create: () => { store: HistoryStore; reopen?(): HistoryStore; dispose(): void },
): void {
  const caller = { scope: "scope", subject: "owner" };

  async function hosted(
    t: TestContext,
    archiveStore: IpfsStore,
    store: HistoryStore,
    extra: { retryDelayMs?: number } = {},
  ) {
    const starts = { n: 0 };
    const hold = Promise.withResolvers<void>();
    const clock = new VirtualClock();
    const bytes = Buffer.from("typed-content-root");
    const contentCid = CID.createV1(0x55, await sha256.digest(bytes));
    await archiveStore.put(contentCid, bytes);
    const engine = createTaskEngine({
      store,
      clock,
      archiveStore,
      types: [registration(starts, hold.promise)],
      currentVersions: { "run-test": "1" },
      authorize: () => true,
      archive: { retryDelayMs: extra.retryDelayMs ?? 1, leaseMs: 10_000, maxAttempts: 8 },
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
    return { engine, clock, starts, task, runId, contentCid, bytes };
  }

  test(`${name}: Engine archives a completed run into a CID-linked DAG without blocking drain`, async (t) => {
    const fixture = create();
    const directory = resolve(".cache", `archive-io-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const inner = new IpfsStore({ dataDir: join(directory, "ipfs") });
    const gate = Promise.withResolvers<void>();
    let retainEntered = false;
    const archiveStore = interceptRetain(inner, (next) => async (owner, roots, options) => {
      retainEntered = true;
      await Promise.race([
        gate.promise,
        new Promise<never>((_, reject) => {
          const signal = options?.signal;
          if (!signal) return;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      return next(owner, roots, options);
    });
    const { engine, starts, task, runId, contentCid } = await hosted(
      t,
      archiveStore,
      fixture.store,
    );
    t.after(async () => {
      gate.resolve();
      await engine.close().catch(() => {});
      await inner.close().catch(() => {});
      try {
        fixture.store.close();
      } catch {
        /* released or already closed */
      }
      try {
        fixture.dispose();
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    const completed = engine.getTask(task.taskId, caller);
    assert.equal(completed.stage, "completed");
    assert.equal(starts.n, 1);
    await poll(
      () => retainEntered || fixture.store.runHistory.read(runId)?.archive.state === "archived",
      t.signal,
    );
    assert.notEqual(fixture.store.runHistory.read(runId)?.archive.state, "archived");
    assert.equal(engine.errors.length, 0);
    gate.resolve();
    await poll(() => fixture.store.runHistory.read(runId)?.archive.state === "archived", t.signal);
    const record = fixture.store.runHistory.read(runId)!;
    const receipt = record.archive.published!.receipt;
    assert.ok(receipt.blockCount >= 2);
    assert.ok(receipt.byteLength >= 1);
    assert.equal(receipt.rootCid, record.attempts[0]?.rootCid);
    const bytes = await inner.block.get(receipt.rootCid);
    const links = contentLinks(CID.parse(receipt.rootCid), bytes);
    assert.ok(links.some((link) => link.toString() === contentCid.toString()));
    const source = decodeRunHistoryDag(bytes);
    assert.equal(source.runId, runId);
    assert.equal(source.sourceWatermark, record.sourceWatermark);
    assert.equal(source.run.outcome?.kind, "completed");
    assert.deepEqual(source.contentRoots, [contentCid.toString()]);
    assert.equal(source.run.input.text, contentCid.toString());
    const detail = await engine.readRunHistoryArchive(runId);
    assert.equal(detail.status, "available");
    assert.equal(detail.source?.runId, runId);
    assert.equal(detail.source?.run.outcome?.kind, "completed");
  });

  test(`${name}: archive I/O failure keeps completion and does not restart the Worker`, async (t) => {
    const fixture = create();
    let store = fixture.store;
    const directory = resolve(".cache", `archive-fail-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const inner = new IpfsStore({ dataDir: join(directory, "ipfs") });
    const archiveStore = interceptRetain(inner, () => async () => {
      throw new ContentError("rpc_unavailable", "Archive backend is offline.");
    });
    const clock = new VirtualClock();
    const { engine, task, runId, starts } = await hosted(t, archiveStore, store, {
      retryDelayMs: 60_000,
    });
    t.after(async () => {
      await engine.close().catch(() => {});
      await inner.close().catch(() => {});
      try {
        store.close();
      } catch {
        /* released or already closed */
      }
      try {
        fixture.dispose();
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    assert.equal(engine.getTask(task.taskId, caller).stage, "completed");
    assert.equal(starts.n, 1);
    await poll(() => store.runHistory.read(runId)?.archive.state === "failed", t.signal);
    assert.equal(store.runHistory.read(runId)?.archive.error?.code, "rpc_unavailable");
    await engine.close();
    if (fixture.reopen) {
      store.close();
      store = fixture.reopen();
    }
    const restarted = createTaskEngine({
      store,
      clock,
      archiveStore,
      types: [registration(starts)],
      currentVersions: { "run-test": "1" },
      authorize: () => true,
      archive: { retryDelayMs: 60_000, leaseMs: 10_000 },
    });
    t.after(() => restarted.close().catch(() => {}));
    await restarted.start();
    restarted.tick();
    assert.equal(starts.n, 1);
    assert.equal(restarted.getTask(task.taskId, caller).stage, "completed");
    assert.equal(store.runHistory.read(runId)?.archive.state, "failed");
  });

  test(`${name}: write-ahead root is unchanged across restart and eventual complete`, async (t) => {
    const fixture = create();
    let store = fixture.store;
    const directory = resolve(".cache", `archive-root-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const inner = new IpfsStore({ dataDir: join(directory, "ipfs") });
    let rooted = "";
    const archiveStore = interceptRetain(inner, () => async () => {
      rooted = store.runHistory.list()[0]?.attempts[0]?.rootCid ?? "";
      throw new ContentError("rpc_failed", "Crash after setArchiveRoot.");
    });
    const { engine, clock, starts, task, runId, contentCid } = await hosted(t, archiveStore, store);
    t.after(async () => {
      await engine.close().catch(() => {});
      await inner.close().catch(() => {});
      try {
        store.close();
      } catch {
        /* released or already closed */
      }
      try {
        fixture.dispose();
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    await poll(() => store.runHistory.read(runId)?.archive.state === "failed", t.signal);
    assert.ok(rooted);
    assert.equal(store.runHistory.read(runId)?.attempts[0]?.rootCid, rooted);
    await engine.close();
    await inner.close();
    if (fixture.reopen) {
      store.close();
      store = fixture.reopen();
    }
    const resumed = new IpfsStore({ dataDir: join(directory, "ipfs") });
    t.after(() => resumed.close().catch(() => {}));
    const next = createTaskEngine({
      store,
      clock,
      archiveStore: resumed,
      types: [registration(starts)],
      currentVersions: { "run-test": "1" },
      authorize: () => true,
      archive: { retryDelayMs: 1, leaseMs: 10_000 },
    });
    t.after(() => next.close().catch(() => {}));
    clock.setTime(clock.now() + 1_000);
    await next.start();
    next.tick();
    await poll(() => store.runHistory.read(runId)?.archive.state === "archived", t.signal);
    assert.equal(store.runHistory.read(runId)!.archive.published!.receipt.rootCid, rooted);
    assert.equal(starts.n, 1);
    assert.equal(next.getTask(task.taskId, caller).stage, "completed");
    const dag = decodeRunHistoryDag(
      await resumed.block.get(store.runHistory.read(runId)!.archive.published!.receipt.rootCid),
    );
    assert.equal(dag.runId, runId);
    assert.deepEqual(dag.contentRoots, [contentCid.toString()]);
  });

  test(`${name}: isolated recycle leaves SQLite facts and reports missing details`, async (t) => {
    const fixture = create();
    const directory = resolve(".cache", `archive-missing-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const archiveStore = new IpfsStore({ dataDir: join(directory, "ipfs") });
    const { engine, starts, task, runId, contentCid } = await hosted(
      t,
      archiveStore,
      fixture.store,
    );
    t.after(async () => {
      await engine.close().catch(() => {});
      await archiveStore.close().catch(() => {});
      try {
        fixture.store.close();
      } catch {
        /* released or already closed */
      }
      try {
        fixture.dispose();
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    await poll(() => fixture.store.runHistory.read(runId)?.archive.state === "archived", t.signal);
    const rootCid = fixture.store.runHistory.read(runId)!.archive.published!.receipt.rootCid;
    engine.requestRunHistoryRelease(runId);
    await poll(
      () =>
        fixture.store.runHistory
          .read(runId)
          ?.attempts.every(
            (attempt) => !attempt.release || attempt.release.state === "released",
          ) === true,
      t.signal,
    );
    await archiveStore.close();
    rmSync(join(directory, "ipfs", "blocks", CID.parse(rootCid).toV1().toString()), {
      force: true,
    });
    rmSync(join(directory, "ipfs", "blocks", contentCid.toV1().toString()), { force: true });
    const isolated = new IpfsStore({ dataDir: join(directory, "ipfs") });
    t.after(() => isolated.close().catch(() => {}));
    await assert.rejects(isolated.block.get(rootCid), /missing|unavailable|ENOENT|not found/i);
    const detail = await engine.readRunHistoryArchive(runId);
    assert.ok(detail.status === "missing" || detail.status === "not_archived");
    assert.equal(detail.source, undefined);
    assert.equal(engine.getTask(task.taskId, caller).stage, "completed");
    assert.equal(starts.n, 1);
    assert.equal(fixture.store.runHistory.read(runId)?.archive.published?.receipt.rootCid, rootCid);
    if (!fixture.reopen) return;
    await engine.close();
    fixture.store.close();
    const restored = fixture.reopen();
    t.after(() => {
      try {
        restored.close();
      } catch {
        /* engine still owns it until restarted.close */
      }
    });
    const restarted = createTaskEngine({
      store: restored,
      archiveStore: isolated,
      types: [registration(starts)],
      currentVersions: { "run-test": "1" },
      authorize: () => true,
    });
    t.after(() => restarted.close().catch(() => {}));
    await restarted.start();
    restarted.tick();
    assert.equal(starts.n, 1);
    assert.equal(restarted.getTask(task.taskId, caller).stage, "completed");
    const again = await restarted.readRunHistoryArchive(runId);
    assert.ok(again.status === "missing" || again.status === "not_archived");
    assert.equal(again.source, undefined);
    assert.equal(restored.runHistory.read(runId)?.archive.published?.receipt.rootCid, rootCid);
  });

  test(`${name}: stale completeArchive cannot resurrect published details after release`, async (t) => {
    const fixture = create();
    const directory = resolve(".cache", `archive-stale-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const archiveStore = new IpfsStore({ dataDir: join(directory, "ipfs") });
    const { engine, runId, clock } = await hosted(t, archiveStore, fixture.store);
    t.after(async () => {
      await engine.close().catch(() => {});
      await archiveStore.close().catch(() => {});
      try {
        fixture.store.close();
      } catch {
        /* released or already closed */
      }
      try {
        fixture.dispose();
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    await poll(() => fixture.store.runHistory.read(runId)?.archive.state === "archived", t.signal);
    const lease = fixture.store.runHistory.read(runId)!.attempts[0]!.lease;
    const receipt = fixture.store.runHistory.read(runId)!.archive.published!.receipt;
    engine.requestRunHistoryRelease(runId);
    await poll(
      () => fixture.store.runHistory.read(runId)?.retention.state !== "retained",
      t.signal,
    );
    await poll(
      () =>
        fixture.store.runHistory
          .read(runId)
          ?.attempts.every(
            (attempt) => !attempt.release || attempt.release.state === "released",
          ) === true,
      t.signal,
    );
    await engine.close();
    fixture.store.claim("inspector");
    t.after(() => {
      try {
        fixture.store.release("inspector");
      } catch {
        /* already released */
      }
    });
    assert.equal(
      fixture.store.runHistory.completeArchive(
        "inspector",
        lease,
        { ...receipt, verifiedAt: clock.now(), retainedAt: clock.now() },
        clock.now() + 1,
      ),
      false,
    );
    const record = fixture.store.runHistory.read(runId)!;
    assert.equal(record.retention.state === "retained", false);
    assert.equal(record.archive.published?.receipt.rootCid, receipt.rootCid);
  });

  test(`${name}: unpinning the archive owner keeps another owner's pin on the same root`, async (t) => {
    const fixture = create();
    const directory = resolve(".cache", `archive-shared-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const archiveStore = new IpfsStore({ dataDir: join(directory, "ipfs") });
    const { engine, runId } = await hosted(t, archiveStore, fixture.store);
    t.after(async () => {
      await engine.close().catch(() => {});
      await archiveStore.close().catch(() => {});
      try {
        fixture.store.close();
      } catch {
        /* released or already closed */
      }
      try {
        fixture.dispose();
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    await poll(() => fixture.store.runHistory.read(runId)?.archive.state === "archived", t.signal);
    const root = fixture.store.runHistory.read(runId)!.archive.published!.receipt.rootCid;
    await archiveStore.retain("external-owner", [root]);
    await archiveStore.confirmRetained("external-owner", [root]);
    assert.ok(archiveStore.pins().includes(root));
    engine.requestRunHistoryRelease(runId);
    await poll(
      () =>
        fixture.store.runHistory
          .read(runId)
          ?.attempts.every(
            (attempt) => !attempt.release || attempt.release.state === "released",
          ) === true,
      t.signal,
    );
    assert.ok(archiveStore.pins().includes(root), "External owner still retains the DAG.");
    await archiveStore.reconcile("external-owner", []);
    assert.equal(archiveStore.pins().includes(root), false);
  });

  test(`${name}: same-lease resume after setArchiveRoot keeps the candidate root`, async (t) => {
    const fixture = create();
    const directory = resolve(".cache", `archive-resume-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const content = new IpfsStore({ dataDir: join(directory, "ipfs") });
    const bytes = Buffer.from("typed-content-root");
    const contentCid = CID.createV1(0x55, await sha256.digest(bytes));
    await content.put(contentCid, bytes);
    t.after(async () => {
      await content.close().catch(() => {});
      try {
        fixture.store.release("writer");
      } catch {
        /* already released */
      }
      try {
        fixture.store.close();
      } catch {
        /* released or already closed */
      }
      try {
        fixture.dispose();
      } catch {
        /* Windows may keep a closed SQLite handle briefly */
      }
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    const store = fixture.store;
    store.claim("writer");
    const f = historyFixture();
    store.append("writer", 0, f.events);
    store.writeContentBlock("writer", contentCid.toString(), bytes);
    store.retainRunContent("writer", f.run.runId, contentCid.toString());
    store.runHistory.finalize("writer", f.run.runId, historyPolicy);
    const lease = store.runHistory.claimArchive("writer", f.run.runId, {
      now: historyPolicy.now + 1,
      leaseMs: 10_000,
    })!;
    const source = store.runHistory.readSource(f.run.runId, historyPolicy.now + 1);
    const dag = await encodeRunHistoryDag(source);
    await content.stageBlock(`${lease.owner}/archive`, dag.root, dag.bytes);
    await content.stageBlock(`${lease.owner}/archive`, contentCid, bytes);
    assert.equal(
      store.runHistory.setArchiveRoot("writer", lease, dag.root.toString(), historyPolicy.now + 2),
      true,
    );
    await content.close();
    const resumed = new IpfsStore({ dataDir: join(directory, "ipfs") });
    t.after(() => resumed.close().catch(() => {}));
    assert.equal(
      await publishRunHistoryArchive(
        {
          owner: "writer",
          history: store.runHistory,
          content: resumed,
          now: () => historyPolicy.now + 3,
          readContentBlock: (cid) => store.readContentBlock?.(cid),
        },
        lease,
      ),
      true,
    );
    assert.equal(store.runHistory.read(f.run.runId)?.attempts[0]?.rootCid, dag.root.toString());
    assert.equal(
      store.runHistory.read(f.run.runId)?.archive.published?.receipt.rootCid,
      dag.root.toString(),
    );
    store.release("writer");
  });
}

export async function runHistoryDagCodecCase(): Promise<void> {
  const bytes = Buffer.from("lookalike-root");
  const contentCid = CID.createV1(0x55, await sha256.digest(bytes));
  const encoded = await encodeRunHistoryDag({
    dataDomain: "test-domain",
    runId: "01TESTARCHIVE0000000000001",
    sourceWatermark: 8,
    finalizedAt: 10,
    run: {
      runId: "01TESTARCHIVE0000000000001",
      generation: "01TESTARCHIVE0000000000002",
      binding: {
        type: "run-test",
        version: "1",
        contractRevision: "rev",
        inputSchema: { type: "object" },
        environment: "trusted",
        scope: "scope",
        subject: "owner",
        matchPolicy: "starts-after-eligible",
      },
      input: {
        text: contentCid.toString(),
        lookalike: { "/": contentCid.toString(), bytes: contentCid.toString() },
      },
      startedAt: "2020-01-01T00:00:00.000Z",
      startedSequence: 1,
      updatedAt: "2020-01-01T00:00:00.000Z",
      outcome: {
        kind: "completed",
        occurredAt: "2020-01-01T00:00:01.000Z",
        output: { result: { ok: true }, cid: contentCid.toString() },
      },
      reclaimedAt: "2020-01-01T00:00:02.000Z",
      exit: { basis: "worker", occurredAt: "2020-01-01T00:00:01.000Z", sequence: 4, code: 0 },
    },
    messages: [],
    events: [],
    contentRoots: [contentCid.toString()],
    contentAccess: [`ipfs:${contentCid}`],
  });
  const links = contentLinks(encoded.root, encoded.bytes);
  assert.ok(links.some((link) => link.toString() === contentCid.toString()));
  const source = decodeRunHistoryDag(encoded.bytes);
  assert.equal(source.run.input.text, contentCid.toString());
  assert.deepEqual(source.run.input.lookalike, {
    "/": contentCid.toString(),
    bytes: contentCid.toString(),
  });
  assert.equal(
    source.run.outcome && "output" in source.run.outcome
      ? source.run.outcome.output.cid
      : undefined,
    contentCid.toString(),
  );
  assert.deepEqual(source.contentRoots, [contentCid.toString()]);
}
