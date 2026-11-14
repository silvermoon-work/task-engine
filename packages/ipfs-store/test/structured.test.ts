import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import {
  ContentRef,
  ContentRefSchema,
  encodePayload,
  encodePayloadBlock,
} from "@silvermoon-work/ipfs-payload";
import { encodeDagCbor } from "@silvermoon-work/ipfs-payload/dag-cbor";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { ContentBlocks, contentLinks } from "../src/dag.js";
import { IpfsStore } from "../src/index.js";
import { kuboFixture } from "./kubo-fixture.js";

async function structured(graph: ContentBlocks, value: unknown): Promise<CID> {
  const bytes = encodeDagCbor(value);
  const cid = CID.createV1(0x71, await sha256.digest(bytes));
  await graph.put(cid, bytes);
  return cid;
}

async function mixedGraph() {
  const graph = new ContentBlocks();
  let directory!: CID;
  const data = Buffer.alloc(1001, 42);
  for await (const entry of importer([{ path: "nested/file", content: data }], graph, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
    chunker: fixedSize({ chunkSize: 100 }),
  }))
    directory = entry.cid;
  const payload = await encodePayloadBlock(
    encodePayload(ContentRefSchema(), ContentRef.fromCID(directory)),
  );
  await graph.put(payload.cid, payload.bytes);
  const missing = CID.createV1(0x55, await sha256.digest(Buffer.from("not a reference")));
  const root = await structured(graph, {
    payload: payload.cid,
    text: missing.toString(),
    lookalike: { cid: missing.toString() },
    spoof: { "/": missing.toString(), bytes: missing.toString() },
  });
  const raw = CID.parse([...graph.blocks.keys()].find((value) => CID.parse(value).code === 0x55)!);
  return { graph, directory, root, raw, data };
}

async function car(root: CID, blocks: ContentBlocks): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root]);
  const collecting = (async () => {
    const parts: Uint8Array[] = [];
    for await (const part of out) parts.push(part);
    return Buffer.concat(parts);
  })();
  for (const [value, bytes] of blocks.blocks) await writer.put({ cid: CID.parse(value), bytes });
  await writer.close();
  return collecting;
}

for (const backend of ["local", "kubo"] as const) {
  test(`${backend}: mixed-codec CAR staging, strong retention and fresh closure validation`, async () => {
    const directory = resolve(".cache", `structured-${randomUUID()}`);
    const fixture = backend === "kubo" ? await kuboFixture() : undefined;
    const store = new IpfsStore(
      fixture
        ? { backend: "kubo", apiUrl: fixture.apiUrl, coordinationDir: directory }
        : { dataDir: directory },
    );
    const { graph, root, raw } = await mixedGraph();
    const reachable = new ContentBlocks(graph);
    await reachable.prepare(root);
    assert.deepEqual(new Set(reachable.blocks.keys()), new Set(graph.blocks.keys()));
    const reader = await CarReader.fromBytes(await car(root, reachable));
    assert.ok((await reader.getRoots())[0]!.equals(root));
    try {
      store.registerOwner("owner", []);
      const rootBlock = await reader.get(root);
      assert.ok(rootBlock);
      await store.stageBlock("owner/import", root, rootBlock.bytes);
      await assert.rejects(store.finishImport("owner/import", root), /unfinished/);
      assert.equal(
        store.pins().includes(root.toString()),
        false,
        "A root alone is not a complete import.",
      );
      for await (const block of reader.blocks())
        if (!block.cid.equals(root)) await store.stageBlock("owner/import", block.cid, block.bytes);
      await store.finishImport("owner/import", root, "owner");
      await store.confirmRetained("owner", [root.toString()]);
      await store.prepare(root);
      assert.ok(store.pins().includes(root.toString()));
      const exported = new ContentBlocks(store);
      await exported.prepare(root);
      const restored = new ContentBlocks();
      const exportedCar = await CarReader.fromBytes(await car(root, exported));
      for await (const block of exportedCar.blocks()) await restored.put(block.cid, block.bytes);
      await restored.prepare(root);
      assert.deepEqual(new Set(restored.blocks.keys()), new Set(graph.blocks.keys()));

      await store.retain("other", [root.toString()]);
      await store.confirmRetained("other", [root.toString()]);
      await store.reconcile("owner", []);
      assert.ok(
        store.pins().includes(root.toString()),
        "Another owner preserves the strong graph.",
      );
      const stale = Buffer.from("now missing or corrupt");
      const rawPath = join(directory, "blocks", raw.toString());
      const original = fixture ? fixture.blocks.get(raw.toString())! : await readFile(rawPath);
      if (fixture) fixture.blocks.delete(raw.toString());
      else await rm(rawPath);
      await assert.rejects(store.pin(root), /unfinished/);
      await assert.rejects(store.retain("owner", [root.toString()]), /unfinished/);
      await assert.rejects(store.reconcile("owner", []), /unfinished/);
      if (fixture) fixture.blocks.set(raw.toString(), stale);
      else await writeFile(rawPath, stale);
      await assert.rejects(store.pin(root), /unfinished/);
      if (fixture) fixture.blocks.set(raw.toString(), original);
      else await writeFile(rawPath, original);
      await store.recoverOwner("owner", []);
      await store.reconcile("owner", []);
      assert.ok(store.pins().includes(root.toString()));
      await store.reconcile("other", []);
      assert.equal(store.pins().includes(root.toString()), false);
      assert.deepEqual(
        await store.block.get(root.toString()),
        Uint8Array.from(rootBlock.bytes),
        "Unpin is not physical deletion.",
      );
      if (fixture) assert.equal(fixture.calls.includes("repo/gc"), false);
    } finally {
      await store.close();
      await fixture?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("mixed graphs reject unsupported codecs/hashes, missing/corrupt blocks and exceeded budgets", async () => {
  const { graph, root, raw } = await mixedGraph();
  const bytes = await graph.block.get(raw.toString());
  const unknown = CID.createV1(0x1234, await sha256.digest(bytes));
  await graph.put(unknown, bytes);
  const unsupportedRoot = await structured(graph, { child: unknown });
  const unsupportedHash = CID.createV1(0x55, await sha512.digest(bytes));
  const hashRoot = await structured(graph, { child: unsupportedHash });
  const missing = CID.createV1(0x55, await sha256.digest(Buffer.from("missing")));
  const missingRoot = await structured(graph, { child: missing });
  for (const [candidate, reason] of [
    [unsupportedRoot, /codec/],
    [hashRoot, /hash/],
    [missingRoot, /Missing/],
  ] as const) {
    const source = {
      block: {
        get: (value: string) =>
          value === unsupportedHash.toString() ? Promise.resolve(bytes) : graph.block.get(value),
      },
    };
    const memory = new ContentBlocks(source);
    const store = IpfsStore.fromClient(source);
    try {
      await assert.rejects(memory.prepare(candidate), reason);
      await assert.rejects(store.prepare(candidate), reason);
    } finally {
      await memory.close();
      await store.close();
    }
  }
  for (const limits of [{ blocks: 1 }, { bytes: 1 }, { blockBytes: 1 }, { depth: 1 }]) {
    const memory = new ContentBlocks(graph, limits);
    const store = IpfsStore.fromClient(graph, limits);
    try {
      await assert.rejects(memory.prepare(root), /capacity/);
      await assert.rejects(store.prepare(root), /capacity/);
    } finally {
      await memory.close();
      await store.close();
    }
  }
  const corrupt = {
    block: {
      get: async (value: string) =>
        value === raw.toString() ? Buffer.from("corrupt") : graph.block.get(value),
    },
  };
  const store = IpfsStore.fromClient(corrupt);
  try {
    await assert.rejects(store.prepare(root), /verification/);
  } finally {
    await store.close();
  }
  assert.throws(() => contentLinks(root, Uint8Array.of(0xff)), /Unexpected|decode|CBOR|data/i);
});

test("shared subgraphs cannot hide over-depth paths after a shallower traversal", async () => {
  const graph = new ContentBlocks();
  const leaf = CID.createV1(0x55, await sha256.digest(Uint8Array.of(1)));
  await graph.put(leaf, Uint8Array.of(1));
  const shared = await structured(graph, [leaf]);
  const branch = await structured(graph, [shared]);
  const root = await structured(graph, [shared, branch]);
  for (const depth of [2, 3]) {
    const store = IpfsStore.fromClient(graph, { depth });
    const memory = new ContentBlocks(graph, { depth });
    try {
      if (depth === 2) {
        await assert.rejects(store.prepare(root), /depth/);
        await assert.rejects(memory.prepare(root), /depth/);
      } else {
        await store.prepare(root);
        await memory.prepare(root);
      }
    } finally {
      await store.close();
      await memory.close();
    }
  }
});

test("CID access streams the shared file/directory DU and only resolves resource paths", async () => {
  const { graph, directory, root, data } = await mixedGraph();
  const store = IpfsStore.fromClient(graph);
  try {
    const node = await store.readContent(directory);
    assert.equal(node.kind, "directory");
    assert.ok(node.kind === "directory");
    const entries = [];
    for await (const entry of node.entries) entries.push(entry);
    assert.deepEqual(
      entries.map(({ name, kind }) => ({ name, kind })),
      [{ name: "nested", kind: "directory" }],
    );
    const fileCid = await store.resolveContent(directory, "nested/file");
    const file = await store.readContent(fileCid);
    assert.ok(file.kind === "file");
    const reader = file.content.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      parts.push(item.value);
    }
    assert.deepEqual(Buffer.concat(parts), data);
    assert.ok((await store.resolveContent(directory, "")).equals(directory));
    for (const path of ["/nested", "../nested", "nested/", "nested//file", "nested\\file"])
      await assert.rejects(store.resolveContent(directory, path), /relative/);
    await assert.rejects(store.resolveContent(fileCid, "anything"), /through a file/);
    await assert.rejects(store.readContent(root), /regular UnixFS/);
    await assert.rejects(store.resolveContent(root, "payload"), /regular UnixFS/);
    const signal = new AbortController();
    const canceled = await store.readContent(directory, { signal: signal.signal });
    assert.ok(canceled.kind === "directory");
    signal.abort(new Error("stop listing"));
    await assert.rejects(canceled.entries[Symbol.asyncIterator]().next(), /stop listing/);
    const fileSignal = new AbortController();
    const canceledFile = await store.readContent(fileCid, { signal: fileSignal.signal });
    assert.ok(canceledFile.kind === "file");
    fileSignal.abort(new Error("stop stream"));
    await assert.rejects(canceledFile.content.getReader().read(), /stop stream/);
  } finally {
    await store.close();
  }
});

test("canceling a pending Web file stream stops that reader without waiting for its source", async () => {
  const { graph, directory } = await mixedGraph();
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const source = {
    block: {
      async get(value: string) {
        if (CID.parse(value).code === 0x55) {
          began();
          return new Promise<Uint8Array>(() => {});
        }
        return graph.block.get(value);
      },
    },
  };
  const store = IpfsStore.fromClient(source);
  try {
    const fileCid = await store.resolveContent(directory, "nested/file");
    const file = await store.readContent(fileCid);
    assert.ok(file.kind === "file");
    const reader = file.content.getReader();
    const pending = reader.read();
    await started;
    await reader.cancel();
    assert.equal((await pending).done, true);
  } finally {
    await store.close();
  }
});
