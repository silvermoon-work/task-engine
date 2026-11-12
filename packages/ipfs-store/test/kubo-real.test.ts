import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { ContentBlocks } from "../src/dag.js";
import { IpfsStore } from "../src/index.js";
import { realKuboFixture } from "./kubo-real-fixture.js";

test("real isolated offline Kubo preserves original DAGs, staging through GC and named participant hints", {
  skip: process.env.KUBO_REAL_TEST !== "1",
}, async () => {
  const fixture = await realKuboFixture();
  const config = {
    backend: "kubo" as const,
    apiUrl: fixture.apiUrl,
    coordinationDir: join(fixture.directory, "coordination"),
  };
  let store = new IpfsStore(config);
  const other = new IpfsStore(config);
  try {
    const graph = new ContentBlocks();
    const payload = Buffer.alloc(8001, 123);
    let root = "";
    for await (const node of importer([{ path: "data.bin", content: payload }], graph, {
      cidVersion: 1,
      rawLeaves: true,
      wrapWithDirectory: true,
      chunker: fixedSize({ chunkSize: 333 }),
    }))
      root = node.cid.toString();
    for (const [cid, bytes] of [...graph.blocks].reverse()) {
      await store.stageBlock("engine-a/import", CID.parse(cid), bytes);
      // Only this disposable repo is GC'd, never a user's daemon or product code.
      await fixture.rpc("repo/gc");
      assert.deepEqual(Buffer.from(await store.block.get(cid)), Buffer.from(bytes));
    }
    await store.finishImport("engine-a/import", root, "engine-a");
    await store.confirmRetained("engine-a", [root]);
    await other.retain("engine-b", [root]);
    await other.confirmRetained("engine-b", [root]);
    await store.close();
    store = new IpfsStore(config);
    await fixture.rpc("repo/gc");
    await store.prepare(root);
    for (const [cid, bytes] of graph.blocks)
      assert.deepEqual(Buffer.from(await store.block.get(cid)), Buffer.from(bytes));
    assert.equal(await store.reconcile("engine-a", []), graph.blocks.size);
    await fixture.rpc("repo/gc");
    await store.prepare(root);
    await other.reconcile("engine-b", []);
    const [pins] = await fixture.rpc("pin/ls", { type: "recursive", names: "true" });
    assert.equal(Object.hasOwn(pins!.Keys as object, root), false);
    assert.deepEqual((await readdir(fixture.directory)).sort(), ["coordination", "daemon"]);
    const cbor = Buffer.from([0xa0]),
      cid = CID.createV1(0x71, await sha256.digest(cbor));
    await store.put(cid, cbor);
    assert.deepEqual(Buffer.from(await other.block.get(cid.toString())), cbor);
    await fixture.rpc("repo/gc");
    const fresh = new IpfsStore(config);
    try {
      await assert.rejects(fresh.block.get(cid.toString()), { code: "missing_block" });
    } finally {
      await fresh.close();
    }
  } finally {
    await store.close();
    await other.close();
    await fixture.close();
  }
});
