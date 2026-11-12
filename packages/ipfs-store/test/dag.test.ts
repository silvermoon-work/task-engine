import assert from "node:assert/strict";
import test from "node:test";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { acquireBlock, ContentBlocks } from "../src/dag.js";

test("nondefault UnixFS file chunks and directory metadata survive a fresh-store transfer", async () => {
  const original = new ContentBlocks();
  const payload = Uint8Array.from({ length: 10_001 }, (_, i) => i % 251);
  let imported: CID | undefined;
  for await (const entry of importer(
    [
      { path: "model.bin", content: payload, mode: 0o640, mtime: { secs: 123n, nsecs: 456 } },
      { path: "nested/notes.txt", content: Buffer.from("original\r\nbytes\r\n") },
    ],
    original,
    {
      wrapWithDirectory: true,
      cidVersion: 1,
      rawLeaves: false,
      chunker: fixedSize({ chunkSize: 777 }),
    },
  ))
    imported = entry.cid;
  assert.ok(imported);
  const restored = new ContentBlocks();
  // Transfer only reachable blocks into a new store with no source or original cache.
  const reachable = new ContentBlocks(original);
  await reachable.prepare(imported);
  for (const [cid, bytes] of reachable.blocks) await restored.put(CID.parse(cid), bytes);
  const file = await exporter(`${imported}/model.bin`, restored);
  assert.equal(file.type, "file");
  if (file.type === "file") {
    assert.equal(file.unixfs.mode, 0o640);
    assert.deepEqual(file.unixfs.mtime, { secs: 123n, nsecs: 456 });
    const parts: Uint8Array[] = [];
    for await (const part of file.content()) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), Buffer.from(payload));
  }
  const bad = new ContentBlocks();
  await assert.rejects(bad.put(imported, Buffer.from("corrupt")), /verification/);
  const missing = new ContentBlocks();
  await missing.put(imported, await restored.block.get(imported.toString()));
  await assert.rejects(missing.prepare(imported), /Missing local content/);
  const limited = new ContentBlocks(restored, { blocks: 1 });
  await assert.rejects(limited.prepare(imported), /capacity/);
});

test("injected uncooperative content ports cannot defeat cancellation or acquisition timeouts", async () => {
  const cid = CID.parse("bafkreigh2akiscaildcjlywwfme6ngynt5kwhr6bpcf3r7nnbyurphdisi");
  const source = { block: { get: async () => new Promise<Uint8Array>(() => {}) } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("stop acquisition")), 100);
  try {
    await assert.rejects(acquireBlock(source, cid, { timeoutMs: 10 }), /timeout|aborted/i);
    await assert.rejects(
      acquireBlock(source, cid, { signal: controller.signal }),
      /stop acquisition/,
    );
  } finally {
    clearTimeout(timer);
  }
});
