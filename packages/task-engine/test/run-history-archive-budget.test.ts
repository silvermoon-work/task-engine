import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { contentLinks } from "@silvermoon-work/ipfs-store/dag";
import type { RunHistorySource } from "@silvermoon-work/task-protocol";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { historyFixture } from "../../task-protocol/test/run-history-fixtures.js";
import { IpfsStore } from "../src/content.js";
import {
  decodeRunHistoryDag,
  defaultArchivePolicy,
  encodeRunHistoryDag,
  verifyRunHistoryClosure,
} from "../src/run-history-archive.js";
import { encodedArchiveLoader } from "./run-history-archive-fixture.js";

const samples = [100, 1_000, 10_000] as const;

function message(index: number, runId: string, generation: string) {
  return {
    taskId: "01TESTARCHIVE00000000000A1",
    messageId: `01TESTARCHIVE${String(index).padStart(13, "0")}`,
    runId,
    generation,
    caller: { scope: "scope", subject: "actor" },
    payload: { kind: "add" as const, amount: 1, n: index },
    receivedAt: "2020-01-01T00:00:00.000Z",
    state: "accepted" as const,
    resolvedAt: "2020-01-01T00:00:00.000Z",
  };
}

async function sampleSource(count: number): Promise<{
  source: RunHistorySource;
  contentCid: CID;
  bytes: Uint8Array;
}> {
  const bytes = Buffer.from(`typed-content-root:${count}`);
  const contentCid = CID.createV1(0x55, await sha256.digest(bytes));
  const base = historyFixture();
  return {
    contentCid,
    bytes,
    source: {
      dataDomain: "test-domain",
      runId: base.run.runId,
      sourceWatermark: 8,
      finalizedAt: 10,
      run: {
        ...base.run,
        parameters: { data: { text: contentCid.toString() }, cidPaths: [] },
        outcome: {
          kind: "completed",
          occurredAt: "2020-01-01T00:00:01.000Z",
          output: { result: { data: { ok: true }, cidPaths: [] } },
        },
        reclaimedAt: "2020-01-01T00:00:02.000Z",
        exit: { basis: "worker", occurredAt: "2020-01-01T00:00:01.000Z", sequence: 4, code: 0 },
      },
      messages: Array.from({ length: count }, (_, index) =>
        message(index, base.run.runId, base.run.generation),
      ),
      events: [],
      contentRoots: [contentCid.toString()],
      contentAccess: [`ipfs:${contentCid}`],
    },
  };
}

async function dagStats(store: IpfsStore, root: CID) {
  let depth = 0,
    blocks = 0,
    bytes = 0,
    maxBlock = 0;
  const seen = new Set<string>();
  const visit = async (cid: CID, level: number) => {
    const key = cid.toV1().toString();
    if (seen.has(key)) return;
    seen.add(key);
    const data = await store.block.get(key);
    blocks++;
    bytes += data.byteLength;
    maxBlock = Math.max(maxBlock, data.byteLength);
    depth = Math.max(depth, level);
    for (const link of contentLinks(cid, data)) await visit(link, level + 1);
  };
  await visit(root, 0);
  return { blocks, bytes, maxBlock, depth };
}

test("message pages split at the configured limit and limit+1", async () => {
  const two = await sampleSource(2);
  const three = await sampleSource(3);
  const limited = await encodeRunHistoryDag(two.source, { messagePageSize: 2 });
  const overflow = await encodeRunHistoryDag(three.source, { messagePageSize: 2 });
  assert.equal(limited.blocks.size, 2, "two messages fit in one page plus the root");
  assert.equal(overflow.blocks.size, 3, "limit+1 messages require a second page");
  assert.equal(
    contentLinks(limited.root, limited.bytes).filter((link) => link.code === 0x71).length,
    1,
  );
  const decoded = await decodeRunHistoryDag(overflow.bytes, encodedArchiveLoader(overflow));
  assert.equal(decoded.messages.length, 3);
});

test("a message page over the block budget fails, and the exact budget encodes", async () => {
  const { source } = await sampleSource(1);
  source.messages[0]!.payload = { note: "n".repeat(400) };
  const encoded = await encodeRunHistoryDag(source, { messagePageSize: 1 });
  const limit = Math.max(...[...encoded.blocks.values()].map((bytes) => bytes.byteLength));
  await assert.rejects(encodeRunHistoryDag(source, { messagePageSize: 1, blockBytes: limit - 1 }), {
    code: "capacity_exceeded",
  });
  const exact = await encodeRunHistoryDag(source, { messagePageSize: 1, blockBytes: limit });
  assert.equal(exact.blocks.size, encoded.blocks.size);
});

for (const count of samples)
  test(`controlled ${count}-message archive measures segmented DAG size, depth, pin RPC and memory`, {
    timeout: 120_000,
  }, async (t) => {
    const directory = resolve(".cache", `archive-budget-${count}-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const store = new IpfsStore({ dataDir: join(directory, "ipfs") });
    t.after(async () => {
      await store.close().catch(() => {});
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        /* Windows may still hold the data directory */
      }
    });
    const { source, contentCid, bytes } = await sampleSource(count);
    await store.put(contentCid, bytes);
    let pins = 0;
    const retain = store.retain.bind(store);
    store.retain = async (owner, roots, options) => {
      pins++;
      return retain(owner, roots, options);
    };
    const before = process.memoryUsage().heapUsed;
    const encoded = await encodeRunHistoryDag(source, {
      messagePageSize: defaultArchivePolicy.messagePageSize,
    });
    const pages = encoded.blocks.size - 1;
    assert.equal(
      pages,
      Math.ceil(count / defaultArchivePolicy.messagePageSize),
      "messages are paged rather than stored as one unbounded array",
    );
    for (const [key, block] of encoded.blocks) await store.put(CID.parse(key), block);
    await store.retain("archive-measure", [encoded.root.toString()]);
    await store.confirmRetained("archive-measure", [encoded.root.toString()]);
    const heap = process.memoryUsage().heapUsed - before;
    const stats = await dagStats(store, encoded.root);
    const closure = await verifyRunHistoryClosure(store, encoded.root);
    assert.equal(stats.blocks, closure.blockCount);
    assert.equal(stats.bytes, closure.byteLength);
    assert.ok(stats.depth >= 1);
    assert.ok(stats.maxBlock <= store.limits.blockBytes);
    assert.equal(pins, 1, "recursive pin RPC stays one per archive root");
    const decoded = await decodeRunHistoryDag(encoded.bytes, (cid) =>
      store.block.get(cid.toString()),
    );
    assert.equal(decoded.messages.length, count);
    console.log(
      JSON.stringify({
        messages: count,
        pages,
        rootBytes: encoded.bytes.byteLength,
        maxBlockBytes: stats.maxBlock,
        depth: stats.depth,
        totalBytes: stats.bytes,
        blockCount: stats.blocks,
        pinRpc: pins,
        heapDeltaBytes: heap,
      }),
    );
  });
