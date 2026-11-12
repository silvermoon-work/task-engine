import assert from "node:assert/strict";
import test from "node:test";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { acquireBlock, ContentBlocks, expandContent, linkContent } from "../src/dag.js";

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
  const files = await expandContent(imported, original);
  assert.deepEqual(files.find((file) => file.path === "model.bin")?.bytes, Buffer.from(payload));

  const parent = new ContentBlocks();
  let root: CID | undefined;
  for await (const entry of importer(
    [
      { path: "worker.cjs", content: Buffer.from("/* worker */") },
      { path: "resources/import/model.bin", content: payload },
      { path: "resources/import/nested/notes.txt", content: Buffer.from("original\r\nbytes\r\n") },
    ],
    parent,
    { wrapWithDirectory: true, cidVersion: 1, rawLeaves: true },
  ))
    root = entry.cid;
  assert.ok(root);
  for (const [cid, bytes] of original.blocks) {
    await parent.put(CID.parse(cid), bytes);
  }
  root = await linkContent(root, "resources/import", imported, parent);
  const resolved = await exporter(`${root}/resources/import`, parent);
  assert.ok(resolved.cid.equals(imported));
  const restored = new ContentBlocks();
  // Transfer only reachable blocks into a new store with no source or original cache.
  const reachable = new ContentBlocks(parent);
  await reachable.prepare(root);
  for (const [cid, bytes] of reachable.blocks) await restored.put(CID.parse(cid), bytes);
  const expanded = await expandContent(root, restored);
  assert.deepEqual(
    expanded.find((file) => file.path === "resources/import/model.bin")?.bytes,
    Buffer.from(payload),
  );
  const file = await exporter(`${root}/resources/import/model.bin`, restored);
  assert.equal(file.type, "file");
  if (file.type === "file") {
    assert.equal(file.unixfs.mode, 0o640);
    assert.deepEqual(file.unixfs.mtime, { secs: 123n, nsecs: 456 });
  }
  const bad = new ContentBlocks();
  await assert.rejects(bad.put(imported, Buffer.from("corrupt")), /verification/);
  const missing = new ContentBlocks();
  await missing.put(root, await restored.block.get(root.toString()));
  await assert.rejects(missing.prepare(root), /Missing local content/);
  const limited = new ContentBlocks(restored, { blocks: 1 });
  await assert.rejects(limited.prepare(root), /capacity/);
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
