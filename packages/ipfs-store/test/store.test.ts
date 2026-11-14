import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { ContentBlocks } from "../src/dag.js";
import { IpfsStore } from "../src/index.js";

async function bytes(store: IpfsStore, cid: string, signal?: AbortSignal) {
  const node = await store.read(cid, signal ? { signal } : {});
  assert.ok(node.type === "file" || node.type === "raw");
  const parts: Uint8Array[] = [];
  for await (const part of node.content(signal ? { signal } : {})) parts.push(part);
  return Buffer.concat(parts);
}

test("cold verified UnixFS nodes stream files, traverse generic names, cache originals and then stay offline", async (t) => {
  const directory = resolve(".cache", `store-${randomUUID()}`);
  const graph = new ContentBlocks();
  const payload = Buffer.alloc(20_001, 123);
  let root = "";
  for await (const node of importer(
    [{ path: "CON", content: payload, mode: 0o640, mtime: { secs: 123n } }],
    graph,
    {
      wrapWithDirectory: true,
      cidVersion: 1,
      rawLeaves: false,
      chunker: fixedSize({ chunkSize: 777 }),
    },
  ))
    root = node.cid.toString();
  let calls = 0;
  let corrupt = false;
  const server = createServer((request, response) => {
    calls++;
    const cid = new URL(request.url!, "http://localhost").pathname.split("/").at(-1)!;
    const block = graph.blocks.get(cid);
    response.writeHead(block ? 200 : 404).end(corrupt ? Buffer.from("corrupt") : block);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const gateway = `http://127.0.0.1:${address.port}/gateway`;
  const store = new IpfsStore({ dataDir: directory, gateway });
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  await store.prepare(root);
  assert.equal(calls, graph.blocks.size, "One acquisition per unique CID.");
  const node = await store.read(root);
  assert.equal(node.type, "directory");
  assert.ok(node.type === "directory");
  const entries = [];
  for await (const entry of node.entries()) entries.push(entry);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["CON"],
    "No task portable-path policy.",
  );
  const canceledDirectory = new AbortController();
  canceledDirectory.abort(new Error("stop directory reader"));
  await assert.rejects(
    node.entries({ signal: canceledDirectory.signal }).next(),
    /stop directory reader/,
  );
  assert.deepEqual(await bytes(store, `${root}/CON`), payload);
  for (const [cid, block] of graph.blocks)
    assert.deepEqual(await readFile(join(directory, "blocks", cid)), Buffer.from(block));
  const warmed = calls;
  corrupt = true;
  const independent = new IpfsStore({ dataDir: directory, gateway });
  try {
    await independent.prepare(root);
    assert.deepEqual(await bytes(independent, `${root}/CON`), payload);
    assert.equal(calls, warmed, "Local disk hits never contact a configured gateway.");
  } finally {
    await independent.close();
  }
  const badBytes = Buffer.from("not published");
  const missing = CID.createV1(0x55, await sha256.digest(badBytes));
  await graph.put(missing, badBytes);
  await assert.rejects(store.block.get(missing.toString()), /verification/);
  assert.equal((await readdir(join(directory, "blocks"))).includes(missing.toString()), false);
  const local = new IpfsStore({ dataDir: directory });
  try {
    await local.prepare(root);
    await assert.rejects(local.read(missing), /Missing local content block/);
    assert.equal(calls, warmed + 1);
  } finally {
    await local.close();
  }
});

test("canceling a file stream does not interrupt another stream of its shared chunk", async () => {
  const graph = new ContentBlocks();
  const payload = Buffer.alloc(600_001, 123);
  let root = "";
  for await (const entry of importer([{ content: payload }], graph, {
    cidVersion: 1,
    rawLeaves: true,
  }))
    root = entry.cid.toString();
  const chunk = [...graph.blocks.keys()].find((cid) => CID.parse(cid).code === 0x55)!;
  let release = () => {},
    began = () => {};
  const started = new Promise<void>((done) => {
    began = done;
  });
  const source = {
    block: {
      get: async (cid: string) => {
        if (cid === chunk) {
          began();
          await new Promise<void>((done) => {
            release = done;
          });
        }
        return graph.block.get(cid);
      },
    },
  };
  const store = IpfsStore.fromClient(source);
  const canceled = new AbortController();
  const first = assert.rejects(bytes(store, root, canceled.signal), /stop file reader/);
  const second = bytes(store, root);
  try {
    await started;
    canceled.abort(new Error("stop file reader"));
    await first;
    release();
    assert.deepEqual(await second, payload);
    assert.deepEqual(await bytes(store, root), payload);
  } finally {
    release();
    await store.close();
  }
});

test("store close cancels even an uncooperative source without owning its close", async () => {
  const cid = CID.createV1(0x55, await sha256.digest(Buffer.from("absent")));
  let began = () => {};
  const started = new Promise<void>((done) => {
    began = done;
  });
  let closed = 0;
  const source = {
    block: {
      get: async () => {
        began();
        return new Promise<Uint8Array>(() => {});
      },
    },
    async close() {
      closed++;
    },
  };
  const store = IpfsStore.fromClient(source);
  const reading = assert.rejects(store.read(cid), /closed/);
  await started;
  await Promise.all([store.close(), store.close(), reading]);
  assert.equal(closed, 0);
});

test("concurrent close waits for owned publications and preserves previously shared blocks", async () => {
  const directory = resolve(".cache", `store-close-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  const original = Buffer.from("published before closing");
  const cid = CID.createV1(0x55, await sha256.digest(original));
  try {
    await store.put(cid, original);
    const data = Buffer.alloc(100_001, 123);
    const next = CID.createV1(0x55, await sha256.digest(data));
    const pending = store.put(next, data).then(
      () => undefined,
      (error: unknown) => error,
    );
    const a = store.close(),
      b = store.close();
    assert.equal(a, b);
    await Promise.all([a, b, pending]);
    assert.ok(
      (await readdir(join(directory, "blocks"))).every((name) => !name.startsWith(".pending")),
    );
    const other = new IpfsStore({ dataDir: directory });
    try {
      assert.deepEqual(await bytes(other, cid.toString()), original);
    } finally {
      await other.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reader cancellation and scope close do not own shared acquisition or caller resources", async () => {
  const payload = Buffer.from("one immutable node");
  const cid = CID.createV1(0x55, await sha256.digest(payload));
  let calls = 0,
    closed = 0;
  let release = () => {};
  const source = {
    block: {
      get: async () => {
        calls++;
        await new Promise<void>((done) => {
          release = done;
        });
        return payload;
      },
    },
    async close() {
      closed++;
    },
  };
  const store = IpfsStore.fromClient(source);
  const first = store.scope(),
    second = store.scope();
  const controller = new AbortController();
  const canceled = assert.rejects(
    bytes(first, cid.toString(), controller.signal),
    /reader canceled/,
  );
  const survivor = bytes(second, cid.toString());
  try {
    const deadline = Date.now() + 2000;
    while (!calls) {
      assert.ok(Date.now() < deadline);
      await new Promise((done) => setTimeout(done, 5));
    }
    controller.abort(new Error("reader canceled"));
    await canceled;
    await first.close();
    release();
    assert.deepEqual(await survivor, payload);
    assert.equal(calls, 1);
    const a = store.close(),
      b = store.close();
    assert.equal(a, b);
    await Promise.all([a, b, second.close()]);
    assert.equal(closed, 0, "Injected sources remain caller-owned.");
    await assert.rejects(store.read(cid), /closed/);
  } finally {
    release();
    await Promise.all([first.close(), second.close(), store.close()]);
  }
});

test("reader budgets account unique blocks, while a narrower full-prepare budget fails explicitly", async () => {
  const graph = new ContentBlocks();
  let root = "";
  for await (const entry of importer(
    [
      { path: "a", content: Buffer.from("shared") },
      { path: "b", content: Buffer.from("shared") },
    ],
    graph,
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true },
  ))
    root = entry.cid.toString();
  const store = IpfsStore.fromClient(graph);
  try {
    await store.prepare(root);
    assert.equal(store.retainedBytes, graph.retainedBytes);
    await store.prepare(root);
    assert.equal(store.retainedBytes, graph.retainedBytes);
    const limited = store.scope({ blocks: 1 });
    try {
      await assert.rejects(limited.prepare(root), /capacity/);
    } finally {
      await limited.close();
    }
    assert.deepEqual(await bytes(store, `${root}/a`), Buffer.from("shared"));
  } finally {
    await store.close();
  }
});

test("structured block preparation does not expand the file/directory resource profile", async () => {
  const directory = resolve(".cache", `store-codec-${randomUUID()}`);
  const store = new IpfsStore({ dataDir: directory });
  const bytes = Uint8Array.of(0xa0);
  const cid = CID.createV1(0x71, await sha256.digest(bytes));
  try {
    await store.put(cid, bytes);
    assert.deepEqual(await store.block.get(cid.toString()), bytes);
    await store.prepare(cid);
    await assert.rejects(store.read(cid), /regular UnixFS files/);
    await assert.rejects(store.readContent(cid), /regular UnixFS files/);
    await assert.rejects(store.resolveContent(cid, ""), /regular UnixFS files/);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
