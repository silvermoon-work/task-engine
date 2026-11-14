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
import { realKuboFixture } from "../../ipfs-store/test/kubo-real-fixture.js";
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
  verifyRunHistoryClosure,
} from "../src/run-history-archive.js";
import { VirtualClock } from "../src/testing.js";

export const isolatedKuboSkip =
  process.env.KUBO_REAL_TEST === "1"
    ? false
    : "Isolated Kubo is opt-in (KUBO_REAL_TEST=1). Tests never GC a shared daemon and do not treat mock RPC as Kubo evidence.";

export type OpenedArchive = {
  store: IpfsStore;
  recycle(cids: readonly string[]): Promise<void>;
  reopen(): IpfsStore;
  close(): Promise<void>;
};

export async function openLocalArchive(directory: string): Promise<OpenedArchive> {
  const dataDir = join(directory, "ipfs");
  const store = new IpfsStore({ dataDir });
  return {
    store,
    async recycle(cids) {
      await store.close();
      for (const value of cids)
        rmSync(join(dataDir, "blocks", CID.parse(value).toV1().toString()), { force: true });
    },
    reopen() {
      return new IpfsStore({ dataDir });
    },
    async close() {},
  };
}

export async function openIsolatedKuboArchive(directory: string): Promise<OpenedArchive> {
  const fixture = await realKuboFixture();
  const config = {
    backend: "kubo" as const,
    apiUrl: fixture.apiUrl,
    coordinationDir: join(directory, "coordination"),
  };
  const store = new IpfsStore(config);
  return {
    store,
    async recycle() {
      await fixture.rpc("repo/gc");
    },
    reopen() {
      return new IpfsStore(config);
    },
    async close() {
      await fixture.close();
    },
  };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

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

export function archiveTestType(
  starts: { n: number },
  hold: Promise<void> = Promise.resolve(),
): RegisteredType {
  return {
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
        starts.n++;
        await hold;
        return null;
      },
    },
  };
}

export async function putRawContent(store: IpfsStore, bytes: Uint8Array): Promise<CID> {
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  await store.put(cid, bytes);
  return cid;
}

export function encodedArchiveLoader(encoded: {
  blocks: Map<string, Uint8Array>;
}): (cid: CID) => Promise<Uint8Array> {
  return async (cid) => {
    const bytes = encoded.blocks.get(cid.toString()) ?? encoded.blocks.get(cid.toV1().toString());
    if (!bytes) throw new Error(`Missing encoded archive block ${cid}`);
    return bytes;
  };
}

export function runHistoryArchiveCases(
  name: string,
  create: () => { store: HistoryStore; reopen?(): HistoryStore; dispose(): void },
  openArchive: (directory: string) => Promise<OpenedArchive> = openLocalArchive,
  skip: boolean | string = false,
): void {
  const caller = { scope: "scope", subject: "owner" };
  const options = skip ? { skip } : {};

  async function backend(t: TestContext, label: string) {
    const directory = resolve(".cache", `archive-${label}-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const opened = await openArchive(directory);
    t.after(async () => {
      await opened.close().catch(() => {});
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    return { directory, opened, store: opened.store };
  }

  async function hosted(
    t: TestContext,
    archiveStore: IpfsStore,
    store: HistoryStore,
    extra: { retryDelayMs?: number } = {},
  ) {
    const starts = { n: 0 };
    const hold = deferred<void>();
    const clock = new VirtualClock();
    const bytes = Buffer.from("typed-content-root");
    const contentCid = CID.createV1(0x55, await sha256.digest(bytes));
    await archiveStore.put(contentCid, bytes);
    const engine = createTaskEngine({
      store,
      clock,
      archiveStore,
      types: [archiveTestType(starts, hold.promise)],
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

  test(
    `${name}: Engine archives a completed run into a CID-linked DAG without blocking drain`,
    options,
    async (t) => {
      const fixture = create();
      const { store: inner } = await backend(t, "io");
      const gate = deferred<void>();
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
      await poll(
        () => fixture.store.runHistory.read(runId)?.archive.state === "archived",
        t.signal,
      );
      const record = fixture.store.runHistory.read(runId)!;
      const receipt = record.archive.published!.receipt;
      assert.ok(receipt.blockCount >= 2);
      assert.ok(receipt.byteLength >= 1);
      assert.equal(receipt.rootCid, record.attempts[0]?.rootCid);
      const bytes = await inner.block.get(receipt.rootCid);
      const links = contentLinks(CID.parse(receipt.rootCid), bytes);
      assert.ok(links.some((link) => link.toString() === contentCid.toString()));
      const source = await decodeRunHistoryDag(bytes, (cid) => inner.block.get(cid.toString()));
      assert.equal(source.runId, runId);
      assert.equal(source.sourceWatermark, record.sourceWatermark);
      assert.equal(source.run.outcome?.kind, "completed");
      assert.deepEqual(source.contentRoots, [contentCid.toString()]);
      assert.equal(
        (source.run.parameters as { data?: { text?: string } }).data?.text,
        contentCid.toString(),
      );
      const detail = await engine.readRunHistoryArchive(runId, caller);
      assert.equal(detail.status, "available");
      assert.equal(detail.source?.runId, runId);
      assert.equal(detail.source?.run.outcome?.kind, "completed");
    },
  );

  test(
    `${name}: archive I/O failure keeps completion and does not restart the Worker`,
    options,
    async (t) => {
      const fixture = create();
      let store = fixture.store;
      const { store: inner } = await backend(t, "fail");
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
        types: [archiveTestType(starts)],
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
    },
  );

  test(
    `${name}: write-ahead root is unchanged across restart and eventual complete`,
    options,
    async (t) => {
      const fixture = create();
      let store = fixture.store;
      const { opened, store: inner } = await backend(t, "root");
      let rooted = "";
      const archiveStore = interceptRetain(inner, () => async () => {
        rooted = store.runHistory.list()[0]?.attempts[0]?.rootCid ?? "";
        throw new ContentError("rpc_failed", "Crash after setArchiveRoot.");
      });
      const { engine, clock, starts, task, runId, contentCid } = await hosted(
        t,
        archiveStore,
        store,
      );
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
      const resumed = opened.reopen();
      t.after(() => resumed.close().catch(() => {}));
      const next = createTaskEngine({
        store,
        clock,
        archiveStore: resumed,
        types: [archiveTestType(starts)],
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
      const dag = await decodeRunHistoryDag(
        await resumed.block.get(store.runHistory.read(runId)!.archive.published!.receipt.rootCid),
        (cid) => resumed.block.get(cid.toString()),
      );
      assert.equal(dag.runId, runId);
      assert.deepEqual(dag.contentRoots, [contentCid.toString()]);
    },
  );

  test(
    `${name}: isolated recycle leaves SQLite facts and reports missing details`,
    options,
    async (t) => {
      const fixture = create();
      const { opened, store: archiveStore } = await backend(t, "missing");
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
      });
      await poll(
        () => fixture.store.runHistory.read(runId)?.archive.state === "archived",
        t.signal,
      );
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
      await opened.recycle([rootCid, contentCid.toV1().toString()]);
      const isolated = opened.reopen();
      t.after(() => isolated.close().catch(() => {}));
      await assert.rejects(isolated.block.get(rootCid), (error: unknown) => {
        const code = error instanceof ContentError ? error.code : "";
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          ["missing_block", "rpc_failed", "rpc_unavailable"].includes(code) ||
            /missing|unavailable|ENOENT|not found|rpc/i.test(message),
        );
        return true;
      });
      const detail = await engine.readRunHistoryArchive(runId, caller);
      assert.ok(["missing", "not_archived", "unreachable"].includes(detail.status));
      assert.equal(detail.source, undefined);
      assert.equal(engine.getTask(task.taskId, caller).stage, "completed");
      assert.equal(starts.n, 1);
      assert.equal(
        fixture.store.runHistory.read(runId)?.archive.published?.receipt.rootCid,
        rootCid,
      );
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
        types: [archiveTestType(starts)],
        currentVersions: { "run-test": "1" },
        authorize: () => true,
      });
      t.after(() => restarted.close().catch(() => {}));
      await restarted.start();
      restarted.tick();
      assert.equal(starts.n, 1);
      assert.equal(restarted.getTask(task.taskId, caller).stage, "completed");
      const again = await restarted.readRunHistoryArchive(runId, caller);
      assert.ok(["missing", "not_archived", "unreachable"].includes(again.status));
      assert.equal(again.source, undefined);
      assert.equal(restored.runHistory.read(runId)?.archive.published?.receipt.rootCid, rootCid);
    },
  );

  test(
    `${name}: stale completeArchive cannot resurrect published details after release`,
    options,
    async (t) => {
      const fixture = create();
      const { store: archiveStore } = await backend(t, "stale");
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
      });
      await poll(
        () => fixture.store.runHistory.read(runId)?.archive.state === "archived",
        t.signal,
      );
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
    },
  );

  test(
    `${name}: unpinning the archive owner keeps another owner's pin on the same root`,
    options,
    async (t) => {
      const fixture = create();
      const { store: archiveStore } = await backend(t, "shared");
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
      });
      await poll(
        () => fixture.store.runHistory.read(runId)?.archive.state === "archived",
        t.signal,
      );
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
    },
  );

  test(
    `${name}: same-lease resume after setArchiveRoot keeps the candidate root`,
    options,
    async (t) => {
      const fixture = create();
      const { opened, store: content } = await backend(t, "resume");
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
      });
      const store = fixture.store;
      store.claim("writer");
      const f = historyFixture();
      store.append("writer", 0, f.events);
      store.writeContentBlock!("writer", contentCid.toString(), bytes);
      store.retainRunContent!("writer", f.run.runId, contentCid.toString());
      store.runHistory.finalize("writer", f.run.runId, historyPolicy);
      const lease = store.runHistory.claimArchive("writer", f.run.runId, {
        now: historyPolicy.now + 1,
        leaseMs: 10_000,
      })!;
      const source = store.runHistory.readSource(f.run.runId, historyPolicy.now + 1);
      const dag = await encodeRunHistoryDag(source);
      for (const [key, block] of dag.blocks)
        await content.stageBlock(`${lease.owner}/archive`, CID.parse(key), block);
      await content.stageBlock(`${lease.owner}/archive`, contentCid, bytes);
      assert.equal(
        store.runHistory.setArchiveRoot(
          "writer",
          lease,
          dag.root.toString(),
          historyPolicy.now + 2,
        ),
        true,
      );
      await content.close();
      const resumed = opened.reopen();
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
    },
  );

  test(
    `${name}: history export authorizes the caller and verifies archive closure`,
    options,
    async (t) => {
      const fixture = create();
      const { store: archiveStore } = await backend(t, "export");
      const { engine, task, runId } = await hosted(t, archiveStore, fixture.store);
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
      });
      await poll(
        () => fixture.store.runHistory.read(runId)?.archive.state === "archived",
        t.signal,
      );
      const root = fixture.store.runHistory.read(runId)!.archive.published!.receipt.rootCid;
      const detail = await engine.readRunHistoryArchive(runId, caller);
      assert.equal(detail.status, "available");
      assert.equal(detail.source?.runId, runId);
      const closure = await verifyRunHistoryClosure(archiveStore, CID.parse(root));
      assert.equal(detail.record?.archive.published?.receipt.blockCount, closure.blockCount);
      assert.equal(detail.record?.archive.published?.receipt.byteLength, closure.byteLength);
      await assert.rejects(
        engine.readRunHistoryArchive(runId, { scope: "other", subject: "outsider" }),
        { code: "forbidden" },
      );
      assert.throws(
        () => engine.getRunHistory(runId, {}, { scope: "other", subject: "outsider" }),
        {
          code: "forbidden",
        },
      );
      assert.throws(
        () => engine.getTaskHistory(task.taskId, {}, { scope: "other", subject: "outsider" }),
        {
          code: "forbidden",
        },
      );
      const events = engine.getRunHistory(runId, {}, caller);
      assert.ok(events.events.length > 0);
    },
  );
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
        parametersSchema: { type: "object" },
        environment: "trusted",
        scope: "scope",
        subject: "owner",
        matchPolicy: "starts-after-eligible",
      },
      parameters: {
        data: {
          text: contentCid.toString(),
          lookalike: { "/": contentCid.toString(), bytes: contentCid.toString() },
        },
        cidPaths: [],
      },
      startedAt: "2020-01-01T00:00:00.000Z",
      startedSequence: 1,
      updatedAt: "2020-01-01T00:00:00.000Z",
      outcome: {
        kind: "completed",
        occurredAt: "2020-01-01T00:00:01.000Z",
        output: { result: { data: { ok: true }, cidPaths: [] } },
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
  const source = await decodeRunHistoryDag(encoded.bytes, encodedArchiveLoader(encoded));
  assert.equal(
    (source.run.parameters as { data?: { text?: string } }).data?.text,
    contentCid.toString(),
  );
  assert.deepEqual((source.run.parameters as { data?: { lookalike?: unknown } }).data?.lookalike, {
    "/": contentCid.toString(),
    bytes: contentCid.toString(),
  });
  assert.deepEqual(
    source.run.outcome && "output" in source.run.outcome
      ? source.run.outcome.output.result
      : undefined,
    { data: { ok: true }, cidPaths: [] },
  );
  assert.deepEqual(source.contentRoots, [contentCid.toString()]);
}
