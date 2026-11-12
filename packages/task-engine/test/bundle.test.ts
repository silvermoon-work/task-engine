import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { MemoryIpfsClient } from "../src/testing.js";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { BundleCache, defaultBundleLimits, inspectTaskBundle } from "../src/bundle.js";

function files(extra: Record<string, Buffer> = {}) {
  return new Map(
    Object.entries({
      "task.yaml": Buffer.from(
        JSON.stringify({
          $schema: taskSchemaUri,
          name: "same name",
          runtime: { type: "node", minVersion: "22.13.0" },
          entry: "worker.cjs",
          binary: ["resources/data.bin"],
          include: [
            "task.yaml",
            "worker.cjs",
            "resources/data.bin",
            ...Object.keys(extra).filter(
              (path) => !["task.yaml", "worker.cjs", "resources/data.bin"].includes(path),
            ),
          ],
          inputSchema: { type: "object" },
          resultSchema: true,
          messageSchema: false,
        }),
      ),
      "worker.cjs": Buffer.from("module.exports = {};"),
      "resources/data.bin": Buffer.alloc(600_000, 42),
      ...extra,
    }),
  );
}
test("full admission validates all default text while binary stays opaque", async () => {
  for (const bytes of [Buffer.from([255]), Buffer.from("a\r\n"), Buffer.from("a\rb")]) {
    const client = new MemoryIpfsClient();
    const tree = files({ "resources/data.bin": bytes });
    const declaration = JSON.parse(tree.get("task.yaml")!.toString());
    declaration.binary = [];
    tree.set("task.yaml", Buffer.from(JSON.stringify(declaration)));
    const cache = new BundleCache({ ipfsClient: client });
    try {
      await assert.rejects(cache.acquire(await client.import(tree)), /resources\/data.bin/);
      declaration.binary = ["resources/data.bin"];
      tree.set("task.yaml", Buffer.from(JSON.stringify(declaration)));
      const binary = await cache.acquire(await client.import(tree));
      binary.release();
      declaration.binary = [];
      tree.set("task.yaml", Buffer.from(JSON.stringify(declaration)));
      tree.set("resources/data.bin", Buffer.from("\uFEFFvalid\n"));
      const text = await cache.acquire(await client.import(tree));
      text.release();
    } finally {
      await cache.close();
    }
  }
});
test("neutral artifact primitives preserve strict declarations, portable paths and runtime admission", () => {
  assert.equal(defaultBundleLimits.bytes, 64 * 1024 * 1024);
  assert.equal(defaultBundleLimits.fileBytes, 64 * 1024 * 1024);
  assert.equal(defaultBundleLimits.files, 256);
  assert.equal(defaultBundleLimits.paths, 512);
  const yaml = files().get("task.yaml");
  assert.ok(yaml);
  const declaration = yaml.toString("utf8");
  for (const tree of [
    files({
      "task.yaml": Buffer.from(
        declaration.replace('"name":"same name"', '"name":"same name","name":"duplicate"'),
      ),
    }),
    files({ "task.yaml": Buffer.from("name: &name Echo\ncopy: *name\n") }),
    files({ "worker.cjs": Buffer.from([0xff]) }),
    files({ "resources/CON": Buffer.from("reserved") }),
    files({ "resources/e\u0301.txt": Buffer.from("noncanonical") }),
  ]) {
    assert.throws(() => inspectTaskBundle(tree), { code: "invalid_bundle" });
  }
  assert.throws(
    () =>
      inspectTaskBundle(
        files({ "task.yaml": Buffer.from(declaration.replace("22.13.0", "999.0.0")) }),
      ),
    { code: "unsupported_runtime" },
  );
});
test("standard UnixFS imports are reproducible; full admission and verified chunked reads do not need directories", async () => {
  const client = new MemoryIpfsClient();
  const tree = files();
  const cid = await client.import(tree);
  const alias = (await client.pin.add(cid)).toV0().toString();
  assert.equal(await client.import(new Map([...tree].reverse())), cid);
  const cache = new BundleCache({ ipfsClient: client });
  try {
    const [a, b] = await Promise.all([
      cache.acquire(cid),
      cache.acquire({ cid, hint: ["http://unused", "http://also-unused"] }),
    ]);
    assert.equal(a.cid, b.cid);
    assert.equal(await cache.available(alias), true);
    assert.equal(await cache.evict(cid), false);
    assert.equal(await cache.evict(alias), false);
    // Engine-owned bounded verified blocks protect active content even if the node GC runs.
    client.blocks.clear();
    const iterator = await a.read("resources/data.bin", new AbortController().signal);
    const chunks: Uint8Array[] = [];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      chunks.push(item.value);
    }
    assert.ok(chunks.length > 1);
    assert.deepEqual(Buffer.concat(chunks), tree.get("resources/data.bin"));
    await assert.rejects(a.read("../worker.cjs", new AbortController().signal), {
      code: "invalid_bundle",
    });
    await assert.rejects(a.read("resources/missing", new AbortController().signal), {
      code: "invalid_bundle",
    });
    const controller = new AbortController();
    const canceled = await a.read("resources/data.bin", controller.signal);
    await canceled.next();
    controller.abort();
    await assert.rejects(canceled.next());
    a.release();
    a.release();
    assert.equal(await cache.evict(cid), false);
    b.release();
    assert.equal(await cache.evict(alias), true);
    const retained = await cache.acquire(cid);
    retained.release();
  } finally {
    await cache.close();
  }
});
test("gateway raw blocks are CID verified, ordered and subject to host access policy", async (t) => {
  const source = new MemoryIpfsClient();
  const cid = await source.import(files());
  const visited: string[] = [];
  const urls = await Promise.all(
    ["blocked", "corrupt", "good"].map(async (name) => {
      const server = createServer((request, response) => {
        visited.push(name);
        assert.equal(request.method, "GET");
        const url = new URL(request.url!, "http://localhost");
        assert.match(url.pathname, /^\/ipfs\//);
        assert.equal(url.search, "?format=raw");
        const bytes =
          name === "corrupt"
            ? Uint8Array.of(0)
            : source.blocks.get(url.pathname.split("/").at(-1)!);
        response.writeHead(bytes ? 200 : 404, { "content-type": "application/vnd.ipld.raw" });
        response.end(bytes);
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      t.after(() => new Promise<void>((done) => server.close(() => done())));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    }),
  );
  const cache = new BundleCache({
    ipfsClient: {
      block: {
        get: async () => {
          throw new Error("offline");
        },
      },
    },
    allowGateway: (url) => {
      assert.match(url.pathname, /^\/ipfs\//);
      assert.equal(url.search, "?format=raw");
      return url.origin !== urls[0];
    },
  });
  try {
    const bundle = await cache.acquire({
      cid,
      hint: urls,
    });
    assert.equal(bundle.cid, cid);
    assert.deepEqual(visited.slice(0, 2), ["corrupt", "good"]);
    assert.equal(visited.includes("blocked"), false);
    bundle.release();
  } finally {
    await cache.close();
  }
});
test("missing/corrupt blocks, non-directory roots, invalid files, incomplete schemas and budgets fail before admission", async () => {
  const client = new MemoryIpfsClient();
  const cid = await client.import(files());
  const corrupt = new BundleCache({
    ipfsClient: { block: { get: async () => new Uint8Array([1]) } },
  });
  await assert.rejects(corrupt.acquire(cid), { code: "bundle_fetch_failed" });
  await corrupt.close();
  for (const [tree, limits, code] of [
    [files({ "unexpected.txt": Buffer.from("bad") }), {}, "invalid_bundle"],
    [
      files({ "resources/A": Buffer.from("a"), "resources/a": Buffer.from("b") }),
      {},
      "invalid_bundle",
    ],
    [files({ "worker.cjs": Buffer.alloc(0) }), {}, "invalid_bundle"],
    [files({ "schemas/invalid.json": Buffer.from("{}") }), {}, "invalid_schema"],
    [files(), { bytes: 100 }, "capacity_exceeded"],
    [files(), { fileBytes: 100 }, "capacity_exceeded"],
    [files(), { files: 1 }, "capacity_exceeded"],
    [files(), { paths: 1 }, "capacity_exceeded"],
    [files(), { blocks: 1 }, "capacity_exceeded"],
    [files(), { retainedBytes: 100 }, "capacity_exceeded"],
  ] as const) {
    const root = await client.import(tree);
    const cache = new BundleCache({ ipfsClient: client, limits });
    await assert.rejects(cache.acquire(root), { code });
    await cache.close();
  }
  assert.throws(() => inspectTaskBundle(files({ "../outside": Buffer.from("bad") })), {
    code: "invalid_bundle",
  });
  const leaf = [...client.blocks].find(([, bytes]) => bytes.length === 262_144 && bytes[0] === 42)!;
  const fileRoot = new BundleCache({ ipfsClient: client });
  await assert.rejects(fileRoot.acquire(leaf[0]), { code: "invalid_bundle" });
  await fileRoot.close();
  client.blocks.delete(leaf[0]);
  const missingLeaf = new BundleCache({ ipfsClient: client });
  await assert.rejects(missingLeaf.acquire(cid), { code: "bundle_fetch_failed" });
  await missingLeaf.close();
  client.blocks.delete(cid);
  const absent = new BundleCache({ ipfsClient: client });
  await assert.rejects(absent.acquire(cid), { code: "bundle_fetch_failed" });
  await absent.close();
});
test("closing one Engine cache never closes shared client or removes anyone else's pins/protection", async () => {
  const client = new MemoryIpfsClient();
  let closed = 0,
    unpinned = 0;
  Object.assign(client, {
    close: () => {
      closed++;
    },
    pin: {
      rm: () => {
        unpinned++;
      },
    },
  });

  const cid = await client.import(files());
  const a = new BundleCache({ ipfsClient: client }),
    b = new BundleCache({ ipfsClient: client });
  const first = await a.acquire(cid),
    second = await b.acquire(cid);
  await a.close();
  const stream = await second.read("resources/data.bin", new AbortController().signal);
  assert.equal((await stream.next()).done, false);
  first.release();
  second.release();
  await b.close();
  assert.equal(closed, 0);
  assert.equal(unpinned, 0);
});
test("unique block retention is bounded, shared across roots and never reclaimed by metadata eviction", async () => {
  const client = new MemoryIpfsClient();
  const cid = await client.import(files());
  const firstBytes = [...client.blocks.values()].reduce((sum, block) => sum + block.byteLength, 0);
  const other = await client.import(files({ "resources/extra": Buffer.from("another root") }));
  const cache = new BundleCache({
    ipfsClient: client,
    limits: { retainedBytes: firstBytes },
  });
  try {
    const first = await cache.acquire(cid);
    await assert.rejects(cache.acquire(other), { code: "capacity_exceeded" });
    first.release();
    assert.equal(await cache.evict(cid), true);
    await assert.rejects(cache.acquire(other), { code: "capacity_exceeded" });
  } finally {
    await cache.close();
  }
  const shared = new BundleCache({ ipfsClient: client });
  try {
    const a = await shared.acquire(cid),
      b = await shared.acquire(other);
    assert.ok(b.retainedBytes < 2 * firstBytes);
    a.release();
    b.release();
  } finally {
    await shared.close();
  }
});
