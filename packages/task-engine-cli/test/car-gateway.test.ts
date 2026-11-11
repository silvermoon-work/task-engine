import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { UnixFS } from "ipfs-unixfs";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { DiskContent } from "../src/data.js";
import { createRawGateway, type RawGatewayOptions, type LocalRead } from "../src/raw-gateway.js";

const profile: RawGatewayOptions = {
  access: "public",
  maxConcurrent: 2,
  maxBlockBytes: 2_097_152,
  timeoutMs: 2000,
};
const media = "application/vnd.ipld.car; version=1; order=dfs; dups=n";
const key = (cid: CID) => cid.toV1().toString();
const missing = () => Object.assign(new Error("Missing local block."), { code: "ENOENT" });
async function listen(t: test.TestContext, local: LocalRead, options = profile) {
  const gateway = createRawGateway(options, local);
  const server = createServer((request, response) => void gateway.handle(request, response));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await gateway.close();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return { gateway, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
async function fixture(shard = false) {
  const blocks = new Map<string, Uint8Array>();
  const entries = new Map<string, CID>();
  const store = {
    async put(cid: CID, bytes: Uint8Array | AsyncIterable<Uint8Array>) {
      assert.ok(bytes instanceof Uint8Array);
      blocks.set(key(cid), Uint8Array.from(bytes));
      return cid;
    },
    async *get(cid: CID) {
      const bytes = blocks.get(key(cid));
      if (!bytes) throw missing();
      yield bytes;
    },
  };
  const path = "dir/deep/文 件%2F.bin";
  const files = [
    { path, content: Buffer.alloc(256, 42) },
    { path: "unrelated.bin", content: Buffer.from("do not fetch") },
  ];
  if (shard)
    for (let i = 0; i < 500; i++) files.push({ path: `entry-${i}`, content: Buffer.from(`${i}`) });
  let root!: CID;
  for await (const entry of importer(files, store, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
    shardSplitThresholdBytes: shard ? 1 : Number.MAX_SAFE_INTEGER,
    chunker: fixedSize({ chunkSize: 32 }),
    fileImportConcurrency: 1,
    blockWriteConcurrency: 1,
  })) {
    root = entry.cid;
    if (entry.path) entries.set(entry.path, entry.cid);
  }
  return { root, path, entries, blocks, store };
}
async function archive(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]) {
  const { writer, out } = CarWriter.create(roots);
  const writing = (async () => {
    for (const block of blocks) await writer.put(block);
    await writer.close();
  })();
  const parts: Uint8Array[] = [];
  for await (const part of out) parts.push(part);
  await writing;
  return Buffer.concat(parts);
}
async function readArchive(bytes: Uint8Array) {
  const car = await CarReader.fromBytes(bytes);
  assert.equal(car.version, 1);
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  for await (const block of car.blocks()) {
    const digest =
      block.cid.multihash.code === 0
        ? identity.digest(block.bytes)
        : await sha256.digest(block.bytes);
    assert.deepEqual(digest.bytes, block.cid.multihash.bytes, "each block must match its CID");
    blocks.push(block);
  }
  return { car, blocks };
}
// Independent flat-directory proof verifier: trust only the caller's root and path,
// never CAR roots, response headers, or the server's traversal/export helper.
async function verify(bytes: Uint8Array, root: CID, path: string) {
  const { blocks } = await readArchive(bytes);
  const store = new Map(blocks.map((block) => [key(block.cid), block.bytes]));
  const required: string[] = [];
  let cid = root;
  for (const segment of [...path.split("/"), undefined]) {
    required.push(key(cid));
    const block = cid.multihash.code === 0 ? cid.multihash.digest : store.get(key(cid));
    assert.ok(block, `proof missing ${cid}`);
    if (segment === undefined) break;
    assert.equal(cid.code, dagPb.code);
    const link = dagPb.decode(block).Links.find((link) => link.Name === segment);
    assert.ok(link, `proof has no named link ${segment}`);
    cid = link.Hash;
  }
  return { cid, required };
}

test("block CAR: exact root/path/terminal blocks, original bytes, independent negative proofs and zero upstream", async (t) => {
  const f = await fixture();
  const directory = resolve(".cache", `car-gateway-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  let outbound = 0;
  const upstream = createServer((_request, response) => {
    outbound++;
    response.writeHead(500).end();
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => upstream.close(() => done())));
  const content = new DiskContent(
    directory,
    `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  );
  t.after(() => content.close());
  const expected = [
    f.root,
    f.entries.get("dir")!,
    f.entries.get("dir/deep")!,
    f.entries.get(f.path)!,
  ];
  // No payload leaf or sibling exists locally. block scope must not need them.
  for (const cid of expected) await content.put(cid, f.blocks.get(key(cid))!);
  const reads: string[] = [];
  const { url } = await listen(t, (cid, options) => {
    reads.push(key(cid));
    return content.local(cid, options);
  });
  const path = `/ipfs/${f.root}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
  const query = "?format=car&dag-scope=block";
  const response = await fetch(url + path + query);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), media);
  assert.match(response.headers.get("content-disposition")!, /^attachment;.*\.car/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("vary"), "Accept");
  assert.equal(
    response.headers.get("ipfs-uri"),
    `ipfs://${key(f.root)}/${f.path.split("/").map(encodeURIComponent).join("/")}`,
  );
  assert.match(response.headers.get("content-location")!, /car-version=1&car-order=dfs&car-dups=n/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { blocks } = await readArchive(bytes);
  assert.deepEqual(
    blocks.map((b) => key(b.cid)),
    expected.map(key),
  );
  assert.deepEqual(
    reads,
    expected.map(key),
    "read only path proof once, not payload DAG or siblings",
  );
  for (const block of blocks) assert.deepEqual(block.bytes, f.blocks.get(key(block.cid)));
  const proof = await verify(bytes, f.root, f.path);
  await assert.rejects(verify(bytes.subarray(0, bytes.length - 1), f.root, f.path));
  assert.equal(key(proof.cid), key(expected.at(-1)!));
  assert.deepEqual(proof.required, expected.map(key));
  const foreign = CID.createV1(0x55, await sha256.digest(Buffer.from("untrusted CAR root")));
  const misleadingRoots = await archive([foreign], blocks);
  assert.equal(key((await verify(misleadingRoots, f.root, f.path)).cid), key(proof.cid));
  await assert.rejects(verify(misleadingRoots, foreign, f.path));
  await assert.rejects(
    verify(
      await archive(
        [f.root],
        blocks.filter((_b, i) => i !== 1),
      ),
      f.root,
      f.path,
    ),
  );
  await assert.rejects(verify(await archive([f.root], blocks.slice(0, -1)), f.root, f.path));
  await assert.rejects(
    verify(
      await archive(
        [f.root],
        [...blocks.slice(0, -1), { cid: foreign, bytes: Buffer.from("untrusted CAR root") }],
      ),
      f.root,
      f.path,
    ),
  );
  const tampered = blocks.map((b, i) => (i === 1 ? { ...b, bytes: Uint8Array.of(1, 2, 3) } : b));
  await assert.rejects(verify(await archive([f.root], tampered), f.root, f.path));
  const head = await fetch(url + path + query, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), response.headers.get("etag"));
  assert.equal(head.headers.get("content-type"), media);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get("content-length"), null);
  for (const method of ["GET", "HEAD"]) {
    const cached = await fetch(url + path + query, {
      method,
      headers: { "if-none-match": `W/${response.headers.get("etag")}` },
    });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    assert.equal(
      (await fetch(url + path + query, { method, headers: { "if-match": '"different"' } })).status,
      412,
    );
  }
  const rootOnly = await fetch(`${url}/ipfs/${f.root}${query}`);
  assert.notEqual(rootOnly.headers.get("etag"), response.headers.get("etag"));
  assert.deepEqual(
    (await readArchive(new Uint8Array(await rootOnly.arrayBuffer()))).blocks.map((b) => key(b.cid)),
    [key(f.root)],
  );
  const absent = CID.createV1(0x55, await sha256.digest(Buffer.from("absent")));
  for (const method of ["GET", "HEAD"])
    for (const cached of [false, true]) {
      const miss = await fetch(`${url}/ipfs/${absent}${query}`, {
        method,
        headers: cached ? { "cache-control": "Only-If-Cached" } : {},
      });
      assert.equal(miss.status, cached ? 412 : 404);
      assert.equal((await miss.arrayBuffer()).byteLength, 0);
    }
  for (const scope of ["entity", "all"])
    assert.equal(
      (await fetch(url + path + `?format=car&dag-scope=${scope}`, { method: "HEAD" })).status,
      404,
      "locally missing descendants never invoke the configured upstream",
    );
  assert.equal(
    (
      await fetch(url + path + "?format=car&entity-bytes=0:1", {
        method: "HEAD",
      })
    ).status,
    404,
    "range misses also remain strictly local",
  );
  assert.equal(outbound, 0);
});

test("HAMT path proof includes routing subshards, no siblings or file payload", async (t) => {
  const f = await fixture(true);
  const targets = ["dir/deep/文 件%2F.bin", ...Array.from({ length: 500 }, (_, i) => `entry-${i}`)];
  let chosen!: { path: string; required: string[] };
  for (const path of targets) {
    const required: string[] = [];
    const store = {
      async *get(cid: CID) {
        required.push(key(cid));
        yield f.blocks.get(key(cid))!;
      },
    };
    await exporter(`${f.root}/${path}`, store);
    if (new Set(required).size > path.split("/").length + 1) {
      chosen = { path, required: [...new Set(required)] };
      break;
    }
  }
  assert.ok(chosen, "fixture must exercise at least one actual HAMT subshard");
  const reads: string[] = [];
  const { url } = await listen(t, async (cid) => {
    reads.push(key(cid));
    assert.ok(chosen.required.includes(key(cid)), "no overfetch");
    return f.blocks.get(key(cid))!;
  });
  const response = await fetch(
    `${url}/ipfs/${f.root}/${chosen.path.split("/").map(encodeURIComponent).join("/")}?format=car&dag-scope=block`,
  );
  assert.equal(response.status, 200);
  const { blocks } = await readArchive(new Uint8Array(await response.arrayBuffer()));
  assert.deepEqual(
    blocks.map((b) => key(b.cid)),
    chosen.required,
  );
  assert.deepEqual(reads, chosen.required);
  for (const block of blocks) assert.deepEqual(block.bytes, f.blocks.get(key(block.cid)));
  const carStore = {
    async *get(cid: CID) {
      const block = blocks.find((b) => key(b.cid) === key(cid));
      assert.ok(block);
      yield block.bytes;
    },
  };
  const terminal = await exporter(`${f.root}/${chosen.path}`, carStore);
  assert.equal(key(terminal.cid), key(blocks.at(-1)!.cid));
  await assert.rejects(
    exporter(`${f.root}/${chosen.path}`, {
      async *get(cid: CID) {
        const block = blocks.find((b, i) => i !== 1 && key(b.cid) === key(cid));
        // Node 22 can hang extracting an implicit message from this transpiled negative case.
        assert.ok(block, "incomplete proof is missing a required HAMT routing shard");
        yield block.bytes;
      },
    }),
  );
});

test("CAR negotiation, explicit scope, identity probes, URL decoding and honest unsupported variants", async (t) => {
  const f = await fixture();
  const { url } = await listen(t, async (cid) => {
    const bytes = f.blocks.get(key(cid));
    if (!bytes) throw missing();
    return bytes;
  });
  const base = `${url}/ipfs/${f.root}`;
  for (const [query, accept, status] of [
    ["?format=car", "", 200],
    ["?format=car&dag-scope=all", "", 200],
    ["?format=car&dag-scope=entity", "", 200],
    ["?format=car&dag-scope=invalid", "", 400],
    ["?format=car&dag-scope=block&entity-bytes=0:1", "", 200],
    ["?format=car&dag-scope=block&car-version=2", "", 406],
    ["?format=car&dag-scope=block&car-order=unk", "", 200],
    ["?format=car&dag-scope=block&car-dups=y", "", 200],
    ["?format=car&dag-scope=block&format=car", "", 400],
    ["?format=car&dag-scope=block&dag-scope=block", "", 400],
    ["?format=car&dag-scope=block", "text/html", 200],
    ["?format=car&dag-scope=block", media, 200],
    ["?format=car&dag-scope=block", "application/vnd.ipld.car;version=2", 406],
    ["?format=car&dag-scope=block&car-version=1", "application/vnd.ipld.car;version=2", 200],
    ["?format=car&dag-scope=block", "application/vnd.ipld.car;dups=y", 200],
    ["?format=car&dag-scope=block", "application/vnd.ipld.car;q=0,*/*;q=1", 406],
    ["?format=car&dag-scope=block", "application/vnd.ipld.car;q=2", 406],
    [
      "?format=car&dag-scope=block",
      'application/vnd.ipld.car;version="1";order="dfs";dups="n"',
      200,
    ],
    ["?dag-scope=block", "application/vnd.ipld.car", 200],
    [
      "?dag-scope=block",
      "application/vnd.ipld.car;order=nope,application/vnd.ipld.car;order=dfs;q=0.5",
      200,
    ],
    [
      "?dag-scope=block",
      "text/html,application/vnd.ipld.car;q=0.9,application/vnd.ipld.raw;q=0.2",
      200,
    ],
  ] as const) {
    const response = await fetch(base + query, { headers: { accept } });
    assert.equal(response.status, status, `${query} ${accept}`);
    if (status === 200)
      assert.equal(
        response.headers.get("content-type"),
        query.includes("car-dups=y") || accept.includes("dups=y")
          ? media.replace("dups=n", "dups=y")
          : media,
      );
    await response.arrayBuffer();
  }
  for (const method of ["GET", "HEAD"])
    for (const query of ["?format=car", "?format=car&dag-scope=block", ""]) {
      const probe = await fetch(`${url}/ipfs/bafkqaaa${query}`, {
        method,
        headers: { accept: media },
      });
      assert.equal(probe.status, 200);
      assert.equal(probe.headers.get("content-type"), media);
      const bytes = new Uint8Array(await probe.arrayBuffer());
      if (method === "HEAD") assert.equal(bytes.length, 0);
      else {
        const { car, blocks } = await readArchive(bytes);
        assert.deepEqual((await car.getRoots()).map(String), ["bafkqaaa"]);
        assert.equal(
          blocks.length,
          0,
          "identity blocks are virtual and must be omitted with dups=n",
        );
      }
    }
  const inline = CID.createV1(0x55, identity.digest(Buffer.from("inline")));
  const identityResponse = await fetch(`${url}/ipfs/${inline}?format=car&dag-scope=block`);
  assert.equal(
    (await readArchive(new Uint8Array(await identityResponse.arrayBuffer()))).blocks.length,
    0,
  );
  for (const path of [
    `dir//deep/${encodeURIComponent("文 件%2F.bin")}`,
    `dir%2Fdeep%2F${encodeURIComponent("文 件%2F.bin")}`,
    `dir%2Fwrong%2F..%2Fdeep/${encodeURIComponent("文 件%2F.bin")}`,
  ]) {
    const response = await fetch(`${base}/${path}?format=car&dag-scope=block`);
    assert.equal(response.status, 200);
    assert.equal(
      key((await verify(new Uint8Array(await response.arrayBuffer()), f.root, f.path)).cid),
      key(f.entries.get(f.path)!),
    );
  }
  for (const path of ["bad%ZZ", "dir%5Cdeep", "%00", "%2F..%2Foutside"]) {
    const response = await fetch(`${base}/${path}?format=car&dag-scope=block`);
    assert.equal(response.status, 400, path);
  }
  for (const path of [
    `${f.path.split("/").map(encodeURIComponent).join("/")}/extra`,
    `dir/deep/${encodeURIComponent("文 件%2F.bin").replace("%20", "+")}`,
  ]) {
    const response = await fetch(`${base}/${path}?format=car&dag-scope=block`, { method: "HEAD" });
    assert.equal(response.status, 404, "file suffixes and literal '+' must not alias valid paths");
  }
  const unsupported = CID.createV1(0x129, await sha256.digest(Buffer.from("other codec")));
  assert.equal((await fetch(`${url}/ipfs/${unsupported}?format=car&dag-scope=block`)).status, 501);
  const disabled = await listen(
    t,
    async () => {
      throw new Error("must not read");
    },
    { ...profile, access: "disabled" },
  );
  assert.equal((await fetch(`${disabled.url}/ipfs/bafkqaaa?format=car`)).status, 404);
  const denied = await listen(
    t,
    async () => {
      throw new Error("must not read");
    },
    { ...profile, access: "token", token: "a".repeat(32) },
  );
  assert.equal((await fetch(`${denied.url}/ipfs/bafkqaaa?format=car`)).status, 401);
  const secured = await fetch(`${denied.url}/ipfs/bafkqaaa?format=car`, {
    headers: { authorization: `Bearer ${"a".repeat(32)}` },
  });
  assert.equal(secured.status, 200);
  assert.match(secured.headers.get("cache-control")!, /^private,/);
  await secured.arrayBuffer();
});

test("missing/tampered children fail transport, HEAD preflights, traversal/output limits and root integrity", async (t) => {
  const f = await fixture();
  const parent = f.entries.get("dir")!;
  const query = `/ipfs/${f.root}/dir/deep/${encodeURIComponent("文 件%2F.bin")}?format=car&dag-scope=block`;
  for (const corrupt of [false, true]) {
    const { gateway, url } = await listen(t, async (cid) => {
      if (key(cid) === key(parent)) {
        if (corrupt) return Uint8Array.of(255);
        throw missing();
      }
      return f.blocks.get(key(cid))!;
    });
    await assert.rejects(async () => {
      const response = await fetch(url + query);
      await response.arrayBuffer();
    });
    const head = await fetch(url + query, { method: "HEAD" });
    assert.equal(head.status, corrupt ? 500 : 404);
    const conditional = await fetch(url + query, { headers: { "if-none-match": "*" } });
    assert.equal(conditional.status, corrupt ? 500 : 404, "incomplete proof must not return 304");
    assert.equal(gateway.snapshot().cancellations, 0, "server failures are not client aborts");
  }
  for (const options of [{ maxTraversalBlocks: 1 }, { maxCarBytes: 1 }]) {
    const { url } = await listen(t, async (cid) => f.blocks.get(key(cid))!, {
      ...profile,
      ...options,
    });
    const head = await fetch(url + query, { method: "HEAD" });
    assert.equal(head.status, 413);
    await assert.rejects(async () => {
      const response = await fetch(url + query);
      if (response.status === 413) throw new Error("budget rejected before output");
      await response.arrayBuffer();
    });
  }
  const { url } = await listen(t, async () => Uint8Array.of(255));
  const root = await fetch(`${url}/ipfs/${f.root}?format=car&dag-scope=block`, {
    headers: { "if-none-match": "*" },
  });
  assert.equal(root.status, 500);
  const rawBytes = Buffer.from("valid raw block");
  const rawCid = CID.createV1(0x55, await sha256.digest(rawBytes));
  const framed = await listen(t, async () => rawBytes, {
    ...profile,
    maxCarBytes: rawBytes.length,
  });
  for (const method of ["GET", "HEAD"]) {
    const rejected = await fetch(`${framed.url}/ipfs/${rawCid}?format=car&dag-scope=block`, {
      method,
    });
    assert.equal(rejected.status, 413, "budget includes CAR framing, not just block bytes");
  }
});

test("CAR slow local read timeout, concurrency, client cancellation and shutdown recover slots", async (t) => {
  const f = await fixture();
  let entered!: () => void;
  let stopped!: () => void;
  const began = new Promise<void>((done) => {
    entered = done;
  });
  const ended = new Promise<void>((done) => {
    stopped = done;
  });
  const { gateway, url } = await listen(
    t,
    async (cid, { signal }) => {
      if (key(cid) === key(f.root)) return f.blocks.get(key(cid))!;
      entered();
      await new Promise<void>((done) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped();
            done();
          },
          { once: true },
        ),
      );
      signal.throwIfAborted();
      throw new Error("unreachable");
    },
    { ...profile, maxConcurrent: 1, timeoutMs: 200 },
  );
  const path = `${url}/ipfs/${f.root}?format=car&dag-scope=all`;
  const pending = fetch(path).then((response) => response.arrayBuffer());
  const failure = assert.rejects(pending);
  await began;
  assert.equal((await fetch(`${url}/ipfs/bafkqaaa?format=car`)).status, 429);
  await failure;
  await ended;
  for (const mode of ["disconnect", "shutdown"]) {
    const request = httpRequest(path);
    request.on("error", () => {});
    request.end();
    await new Promise<void>((done) =>
      request.once("response", (response) => {
        response.once("data", () => done());
      }),
    );
    if (mode === "disconnect") request.destroy();
    else await gateway.close();
    await new Promise<void>((done) => setTimeout(done, 20));
    const probe = await fetch(`${url}/ipfs/bafkqaaa?format=car`);
    assert.equal(probe.status, mode === "shutdown" ? 503 : 200);
    await probe.arrayBuffer();
    request.destroy();
  }
});

test("paused client applies backpressure instead of reading the complete DAG", async (t) => {
  const blocks = new Map<string, Uint8Array>();
  let root: CID = CID.createV1(0x55, await sha256.digest(Buffer.from("terminal")));
  blocks.set(key(root), Buffer.from("terminal"));
  const depth = 32;
  // A valid directory with a large unrelated link name pads each proof block.
  for (let i = 0; i < depth; i++) {
    const bytes = dagPb.encode({
      Data: Uint8Array.of(8, 1),
      Links: [
        { Name: "d", Hash: root },
        { Name: "z".repeat(512 * 1024), Hash: root },
      ],
    });
    root = CID.createV1(dagPb.code, await sha256.digest(bytes));
    blocks.set(key(root), bytes);
  }
  let reads = 0;
  const { url } = await listen(
    t,
    async (cid) => {
      reads++;
      return blocks.get(key(cid))!;
    },
    { ...profile, maxConcurrent: 1, timeoutMs: 300 },
  );
  const request = httpRequest(`${url}/ipfs/${root}?format=car&dag-scope=all`);
  request.on("error", () => {});
  const received = new Promise<void>((done) =>
    request.once("response", (response) => {
      response.pause();
      done();
    }),
  );
  request.end();
  await received;
  await new Promise<void>((done) => setTimeout(done, 100));
  assert.ok(reads < depth, `backpressure must bound read-ahead (read ${reads}/${depth})`);
  assert.equal((await fetch(`${url}/ipfs/bafkqaaa?format=car`)).status, 429);
  await new Promise<void>((done) => setTimeout(done, 250));
  request.destroy();
  const probe = await fetch(`${url}/ipfs/bafkqaaa?format=car`);
  assert.equal(probe.status, 200);
  await probe.arrayBuffer();
});

async function scopeFixture() {
  const blocks = new Map<string, Uint8Array>();
  const put = async (code: number, bytes: Uint8Array) => {
    const cid = CID.createV1(code, await sha256.digest(bytes));
    blocks.set(key(cid), Uint8Array.from(bytes));
    return cid;
  };
  const aBytes = Buffer.from("first chunk\n");
  const bBytes = Buffer.from("second chunk\n");
  const a = await put(0x55, aBytes);
  const b = await put(0x55, bBytes);
  const file = async (links: CID[], sizes: bigint[]) =>
    put(
      dagPb.code,
      dagPb.encode({
        Data: new UnixFS({ type: "file", blockSizes: sizes }).marshal(),
        Links: links.map((Hash) => ({ Hash, Name: "" })),
      }),
    );
  const branch = await file([a, b], [BigInt(aBytes.length), BigInt(bBytes.length)]);
  const whole = Buffer.concat([aBytes, bBytes, aBytes]);
  const target = await file(
    [branch, a],
    [BigInt(aBytes.length + bBytes.length), BigInt(aBytes.length)],
  );
  const root = await put(
    dagPb.code,
    dagPb.encode({
      Data: new UnixFS({ type: "directory" }).marshal(),
      Links: [{ Name: "file", Hash: target }],
    }),
  );
  return { blocks, put, root, target, branch, a, b, whole };
}

test("entity recovers a multilevel shared UnixFS file exactly; directories stop, all/default include DFS descendants", async (t) => {
  const f = await scopeFixture();
  const reads: string[] = [];
  const { url } = await listen(t, async (cid) => {
    reads.push(key(cid));
    const bytes = f.blocks.get(key(cid));
    if (!bytes) throw missing();
    return bytes;
  });
  const results = new Map<string, string>();
  for (const [path, scope, expected] of [
    ["", "block", [f.root]],
    ["", "entity", [f.root]],
    ["", "all", [f.root, f.target, f.branch, f.a, f.b]],
    ["", "", [f.root, f.target, f.branch, f.a, f.b]],
    ["/file", "block", [f.root, f.target]],
    ["/file", "entity", [f.root, f.target, f.branch, f.a, f.b]],
    ["/file", "all", [f.root, f.target, f.branch, f.a, f.b]],
  ] as const) {
    reads.length = 0;
    const response = await fetch(
      `${url}/ipfs/${f.root}${path}?format=car${scope ? `&dag-scope=${scope}` : ""}`,
    );
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { blocks } = await readArchive(bytes);
    assert.deepEqual(
      blocks.map((b) => key(b.cid)),
      expected.map(key),
    );
    assert.deepEqual(reads, expected.map(key), "shared descendants are read only once");
    results.set(path + scope, response.headers.get("etag")!);
    if (path && scope !== "block") {
      // Independent maintained UnixFS reader sees only the returned CAR.
      const entry = await exporter(`${f.root}/file`, {
        async *get(cid: CID) {
          const block = blocks.find((block) => block.cid.equals(cid));
          assert.ok(block, `missing recovery block ${cid}`);
          yield block.bytes;
        },
      });
      assert.equal(entry.type, "file");
      if (entry.type !== "file") throw new Error("not a file");
      const chunks = [];
      for await (const chunk of entry.content()) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), f.whole);
      assert.throws(() => {
        const incomplete = new Set(
          blocks.filter((block) => !block.cid.equals(f.b)).map((block) => key(block.cid)),
        );
        for (const required of [f.target, f.branch, f.a, f.b])
          assert.ok(incomplete.has(key(required)), "incomplete proof is missing a required block");
      });
    }
  }
  assert.equal(results.get("all"), results.get(""));
  assert.notEqual(results.get("all"), results.get("entity"));
  assert.notEqual(results.get("block"), results.get("entity"));
});

test("entity HAMT enumerates every real shard without child payloads; all recovers full directory", async (t) => {
  const f = await fixture(true);
  const expectedShards: string[] = [];
  const directory = await exporter(f.root, {
    async *get(cid: CID) {
      if (!expectedShards.includes(key(cid))) expectedShards.push(key(cid));
      yield f.blocks.get(key(cid))!;
    },
  });
  assert.equal(directory.type, "directory");
  if (directory.type !== "directory") throw new Error("not a directory");
  const expectedNames: string[] = [];
  for await (const entry of directory.entries()) expectedNames.push(entry.name);
  assert.ok(expectedShards.length > 1, "must have real routing subshards");
  let allowed: Set<string> | undefined = new Set(expectedShards);
  const { url } = await listen(
    t,
    async (cid) => {
      if (allowed) assert.ok(allowed.has(key(cid)), `entity overfetch ${cid}`);
      const bytes = f.blocks.get(key(cid));
      if (!bytes) throw missing();
      return bytes;
    },
    { ...profile, maxTraversalBlocks: 4096, timeoutMs: 10000 },
  );
  const response = await fetch(`${url}/ipfs/${f.root}?format=car&dag-scope=entity`);
  const { blocks } = await readArchive(new Uint8Array(await response.arrayBuffer()));
  assert.deepEqual(
    blocks.map((b) => key(b.cid)),
    expectedShards,
  );
  const recovered = await exporter(f.root, {
    async *get(cid: CID) {
      const block = blocks.find((block) => block.cid.equals(cid));
      assert.ok(block);
      yield block.bytes;
    },
  });
  assert.equal(recovered.type, "directory");
  const names: string[] = [];
  if (recovered.type === "directory")
    for await (const entry of recovered.entries()) names.push(entry.name);
  assert.deepEqual(names, expectedNames);
  allowed = undefined;
  const all = await fetch(`${url}/ipfs/${f.root}?format=car&dag-scope=all`);
  const full = await readArchive(new Uint8Array(await all.arrayBuffer()));
  assert.ok(full.blocks.length > blocks.length);
  assert.deepEqual(new Set(full.blocks.map((b) => key(b.cid))), new Set(f.blocks.keys()));
});

test("general DAG-CBOR and DAG-PB, shared and identity descendants: entity is block, all is complete DFS", async (t) => {
  const f = await scopeFixture();
  const virtual = CID.createV1(dagCbor.code, identity.digest(dagCbor.encode({ child: f.b })));
  const pb = await f.put(dagPb.code, dagPb.encode({ Links: [{ Hash: f.a }] }));
  const root = await f.put(dagCbor.code, dagCbor.encode({ a: [pb, virtual], b: f.a, "10": f.b }));
  const reads: string[] = [];
  const { url } = await listen(t, async (cid) => {
    reads.push(key(cid));
    const bytes = f.blocks.get(key(cid));
    if (!bytes) throw missing();
    return bytes;
  });
  for (const scope of ["block", "entity", "all", ""]) {
    reads.length = 0;
    const response = await fetch(
      `${url}/ipfs/${root}?format=car${scope ? `&dag-scope=${scope}` : ""}`,
    );
    const { blocks } = await readArchive(new Uint8Array(await response.arrayBuffer()));
    const expected = scope === "block" || scope === "entity" ? [root] : [root, pb, f.a, f.b];
    assert.deepEqual(
      blocks.map((b) => key(b.cid)),
      expected.map(key),
    );
    assert.deepEqual(
      reads,
      expected.map(key),
      "identity is validated/traversed without local reads",
    );
    for (const block of blocks) assert.deepEqual(block.bytes, f.blocks.get(key(block.cid)));
  }
  const pathRoot = await f.put(dagCbor.code, dagCbor.encode({ files: { leaf: f.a } }));
  const pathResponse = await fetch(`${url}/ipfs/${pathRoot}/files/leaf?format=car`);
  assert.equal(pathResponse.status, 200);
  const pathProof = await readArchive(new Uint8Array(await pathResponse.arrayBuffer()));
  assert.deepEqual(
    pathProof.blocks.map((block) => key(block.cid)),
    [pathRoot, f.a].map(key),
  );
  for (const unknown of [
    CID.createV1(0x129, await sha256.digest(Buffer.from("unknown codec"))),
    CID.createV1(0x55, await sha512.digest(Buffer.from("unknown hash"))),
    CID.createV1(
      dagCbor.code,
      identity.digest(
        dagCbor.encode({
          child: CID.createV1(0x129, await sha256.digest(Buffer.from("unknown inline descendant"))),
        }),
      ),
    ),
  ]) {
    const parent = await f.put(dagCbor.code, dagCbor.encode({ child: unknown }));
    for (const method of ["HEAD", "GET"]) {
      if (method === "HEAD") {
        const response = await fetch(`${url}/ipfs/${parent}?format=car`, { method });
        assert.equal(response.status, 501);
      } else {
        await assert.rejects(async () => {
          const response = await fetch(`${url}/ipfs/${parent}?format=car`);
          await response.arrayBuffer();
        });
      }
    }
  }
});

test("missing CAR path ends a valid parent proof without disguising missing payload blocks", async (t) => {
  const f = await fixture();
  const { gateway, url } = await listen(t, async (cid) => {
    const bytes = f.blocks.get(key(cid));
    if (!bytes) throw missing();
    return bytes;
  });
  const path = `${url}/ipfs/${f.root}/dir/absent?format=car`;
  const response = await fetch(path);
  assert.equal(response.status, 200);
  const proof = await readArchive(new Uint8Array(await response.arrayBuffer()));
  assert.deepEqual(
    proof.blocks.map((block) => key(block.cid)),
    [f.root, f.entries.get("dir")!].map(key),
  );
  assert.equal(gateway.snapshot().misses, 1);
  assert.equal(gateway.snapshot().failures, 1);
  assert.equal((await fetch(path, { method: "HEAD" })).status, 404);
  assert.equal((await fetch(path, { headers: { "if-none-match": "*" } })).status, 404);
});

async function rangeFixture() {
  const f = await scopeFixture();
  const chunks = Array.from({ length: 8 }, (_, i) =>
    Buffer.from(Array.from({ length: 32768 }, (_, j) => (i * 31 + j * 7) % 251)),
  );
  const leaves = await Promise.all(chunks.map((bytes) => f.put(0x55, bytes)));
  const file = (links: CID[], sizes: number[]) =>
    f.put(
      dagPb.code,
      dagPb.encode({
        Data: new UnixFS({ type: "file", blockSizes: sizes.map(BigInt) }).marshal(),
        Links: links.map((Hash) => ({ Hash, Name: "" })),
      }),
    );
  const branches = [
    await file(leaves.slice(0, 4), Array<number>(4).fill(32768)),
    await file(leaves.slice(4), Array<number>(4).fill(32768)),
  ];
  const target = await file(branches, [131072, 131072]);
  const directory = (Name: string, Hash: CID) =>
    f.put(
      dagPb.code,
      dagPb.encode({
        Data: new UnixFS({ type: "directory" }).marshal(),
        Links: [{ Name, Hash }],
      }),
    );
  const deep = await directory("file", target);
  const root = await directory("deep", deep);
  return { ...f, root, deep, target, branches, leaves, whole: Buffer.concat(chunks) };
}

test("entity-bytes minimal multilevel proof: exact independent CID sets, ranges, byte recovery and bounded reads", async (t) => {
  const f = await rangeFixture();
  const reads: string[] = [];
  const { url } = await listen(t, async (cid) => {
    reads.push(key(cid));
    const bytes = f.blocks.get(key(cid));
    if (!bytes) throw missing();
    return bytes;
  });
  const base = `${url}/ipfs/${f.root}/deep/file?format=car`;
  // Expected indexes come from the original fixed chunk layout, not CAR roots or product traversal.
  const cases: [string, number, number, number[]][] = [
    ["32749:32805", 32749, 32805, [0, 1]],
    ["131059:131095", 131059, 131095, [3, 4]],
    ["-73:*", f.whole.length - 73, f.whole.length - 1, [7]],
    ["0:0", 0, 0, [0]],
    ["32768:65535", 32768, 65535, [1]],
    ["0:-262140", 0, 4, [0]],
    ["-262150:5", 0, 5, [0]],
    ["262140:99999999999999999999999", 262140, 262143, [7]],
    ["0:*", 0, 262143, [0, 1, 2, 3, 4, 5, 6, 7]],
    ["262144:*", 262144, 262143, []],
    ["99999999999999999999999:*", 262144, 262143, []],
    ["0:-99999999999999999999999", 0, -1, []],
    ["19:18", 19, 18, []],
  ];
  let fullCarBytes = 0;
  let smallCarBytes = 0;
  const tags = new Map<string, string>();
  for (const [range, from, to, indexes] of cases) {
    reads.length = 0;
    const response = await fetch(`${base}&dag-scope=all&entity-bytes=${range}`);
    assert.equal(response.status, 200, range);
    assert.match(response.headers.get("content-location")!, /dag-scope=entity/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { blocks } = await readArchive(bytes);
    const expected = [f.root, f.deep, f.target];
    for (let branch = 0; branch < 2; branch++) {
      const selected = indexes.filter((i) => Math.floor(i / 4) === branch);
      if (selected.length) expected.push(f.branches[branch]!, ...selected.map((i) => f.leaves[i]!));
    }
    assert.deepEqual(
      blocks.map((b) => key(b.cid)),
      expected.map(key),
      range,
    );
    assert.deepEqual(reads, expected.map(key), "no unrelated blocks or repeated resolver reads");
    const proof = await verify(bytes, f.root, "deep/file");
    assert.equal(key(proof.cid), key(f.target));
    const recovered =
      indexes.length === 0
        ? Buffer.alloc(0)
        : Buffer.concat(
            indexes.map((i) => {
              const block = blocks.find((b) => b.cid.equals(f.leaves[i]!));
              assert.ok(block);
              return block.bytes;
            }),
          ).subarray(from - indexes[0]! * 32768, to - indexes[0]! * 32768 + 1);
    assert.deepEqual(recovered, f.whole.subarray(from, to + 1), range);
    tags.set(range, response.headers.get("etag")!);
    if (range === "0:*") fullCarBytes = bytes.length;
    if (range === "-73:*") smallCarBytes = bytes.length;
    if (range === "32749:32805") {
      const foreign = f.a;
      const oracle = async (candidate: Uint8Array) => {
        const received = await readArchive(candidate);
        assert.deepEqual(
          received.blocks.map((b) => key(b.cid)),
          expected.map(key),
        );
        assert.equal(key((await verify(candidate, f.root, "deep/file")).cid), key(f.target));
        const data = Buffer.concat(
          indexes.map((i) => {
            const block = received.blocks.find((b) => b.cid.equals(f.leaves[i]!));
            assert.ok(block, "requested leaf required independently of the CAR header");
            return block.bytes;
          }),
        ).subarray(from - indexes[0]! * 32768, to - indexes[0]! * 32768 + 1);
        assert.deepEqual(data, f.whole.subarray(from, to + 1));
      };
      await oracle(await archive([foreign], blocks));
      for (const index of [1, blocks.length - 1]) {
        const incomplete = await archive(
          [f.root],
          blocks.filter((_b, i) => i !== index),
        );
        await assert.rejects(oracle(incomplete));
      }
      const tampered = blocks.map((block, i) =>
        i === blocks.length - 1 ? { ...block, bytes: Uint8Array.of(1, 2, 3) } : block,
      );
      await assert.rejects(oracle(await archive([f.root], tampered)));
    }
  }
  assert.ok(smallCarBytes < fullCarBytes / 4, `${smallCarBytes} vs ${fullCarBytes}`);
  assert.equal(new Set(tags.values()).size, tags.size, "different requested ranges cannot alias");
  const entity = await fetch(base + "&dag-scope=entity");
  assert.notEqual(entity.headers.get("etag"), tags.get("0:*"));
  await entity.arrayBuffer();
  for (const range of ["262144:*", "1000000:*", "19:18", "0:-262145"]) {
    const rootRequest = await fetch(`${url}/ipfs/${f.target}?format=car&entity-bytes=${range}`);
    assert.equal(rootRequest.status, 400, "known unsatisfiable root range");
    await rootRequest.arrayBuffer();
  }
});

test("range syntax, non-byte entities, empty and raw files, exact BigInt offsets and required-set preflight", async (t) => {
  const f = await rangeFixture();
  let absent: string | undefined;
  const reads: string[] = [];
  const { url } = await listen(t, async (cid) => {
    reads.push(key(cid));
    if (key(cid) === absent) throw missing();
    const bytes = f.blocks.get(key(cid));
    if (!bytes) throw missing();
    return bytes;
  });
  for (const range of [
    "",
    ":",
    "1",
    "*:2",
    "+1:2",
    "1:2:3",
    "1.5:2",
    "1:NaN",
    "1:%202",
    "1:2&entity-bytes=2:3",
  ]) {
    assert.equal(
      (await fetch(`${url}/ipfs/${f.target}?format=car&entity-bytes=${range}`, { method: "HEAD" }))
        .status,
      400,
    );
  }
  const generic = await f.put(dagCbor.code, dagCbor.encode({ link: f.a }));
  const empty = await f.put(
    dagPb.code,
    dagPb.encode({ Data: new UnixFS({ type: "file" }).marshal(), Links: [] }),
  );
  for (const cid of [f.root, generic, empty]) {
    const response = await fetch(
      `${url}/ipfs/${cid}?format=car&dag-scope=all&entity-bytes=999:1000`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await readArchive(new Uint8Array(await response.arrayBuffer()))).blocks.map((b) =>
        key(b.cid),
      ),
      [key(cid)],
    );
  }
  const raw = await fetch(`${url}/ipfs/${f.a}?format=car&entity-bytes=-2:*`);
  assert.equal(raw.status, 200);
  assert.deepEqual(
    (await readArchive(new Uint8Array(await raw.arrayBuffer()))).blocks.map((b) => key(b.cid)),
    [key(f.a)],
  );
  const inline = CID.createV1(0x55, identity.digest(Buffer.from("inline")));
  const virtual = await fetch(`${url}/ipfs/${inline}?format=car&entity-bytes=1:2&car-dups=y`);
  assert.equal((await readArchive(new Uint8Array(await virtual.arrayBuffer()))).blocks.length, 0);
  const huge = 9007199254740993n;
  const hugeBranch = await f.put(
    dagPb.code,
    dagPb.encode({
      Data: new UnixFS({ type: "file", blockSizes: [huge, 32768n] }).marshal(),
      Links: [
        { Name: "", Hash: f.leaves[0]! },
        { Name: "", Hash: f.leaves[7]! },
      ],
    }),
  );
  reads.length = 0;
  const exact = await fetch(
    `${url}/ipfs/${hugeBranch}?format=car&entity-bytes=${huge}:${huge + 2n}`,
  );
  assert.equal(exact.status, 200);
  assert.deepEqual(
    (await readArchive(new Uint8Array(await exact.arrayBuffer()))).blocks.map((b) => key(b.cid)),
    [key(hugeBranch), key(f.leaves[7]!)],
  );
  assert.deepEqual(reads, [key(hugeBranch), key(f.leaves[7]!)]);
  const inconsistent = await f.put(
    dagPb.code,
    dagPb.encode({
      Data: new UnixFS({ type: "file", blockSizes: [1n] }).marshal(),
      Links: [{ Name: "", Hash: f.leaves[0]! }],
    }),
  );
  const inconsistentUrl = `${url}/ipfs/${inconsistent}?format=car&entity-bytes=0:0`;
  assert.equal((await fetch(inconsistentUrl, { method: "HEAD" })).status, 500);
  await assert.rejects(async () => {
    const response = await fetch(inconsistentUrl);
    await response.arrayBuffer();
  });
  const rangeUrl = `${url}/ipfs/${f.root}/deep/file?format=car&entity-bytes=32749:32805`;
  const first = await fetch(rangeUrl);
  const etag = first.headers.get("etag")!;
  await first.arrayBuffer();
  absent = key(f.leaves[7]!);
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(rangeUrl, { method, headers: { "if-none-match": etag } });
    assert.equal(response.status, 304, "unrequested missing leaf is irrelevant");
  }
  for (const missingCid of [f.deep, f.leaves[1]!]) {
    absent = key(missingCid);
    for (const method of ["HEAD", "GET"]) {
      const response = await fetch(rangeUrl, { method, headers: { "if-none-match": etag } });
      assert.equal(response.status, 404, "required path/leaf must preflight before 304");
      await response.arrayBuffer();
    }
    await assert.rejects(async () => {
      const response = await fetch(rangeUrl);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    });
  }
  absent = undefined;
  for (const budget of [{ maxTraversalBlocks: 5 }, { maxCarBytes: 500 }]) {
    const limited = await listen(t, async (cid) => f.blocks.get(key(cid))!, {
      ...profile,
      ...budget,
    });
    assert.equal(
      (
        await fetch(`${limited.url}/ipfs/${f.root}/deep/file?format=car&entity-bytes=32749:32805`, {
          method: "HEAD",
        })
      ).status,
      413,
    );
  }
});

test("CAR actual DFS duplicate occurrences, weighted negotiation, query precedence and representation ETags", async (t) => {
  const f = await scopeFixture();
  const virtual = CID.createV1(dagCbor.code, identity.digest(dagCbor.encode([f.b, f.a])));
  const branch = await f.put(dagCbor.code, dagCbor.encode([f.a, virtual]));
  const root = await f.put(dagCbor.code, dagCbor.encode([branch, f.a, branch]));
  const { url } = await listen(t, async (cid) => f.blocks.get(key(cid))!);
  const tags = [];
  for (const dups of ["n", "y"]) {
    const response = await fetch(`${url}/ipfs/${root}?format=car&car-dups=${dups}`);
    const { blocks } = await readArchive(new Uint8Array(await response.arrayBuffer()));
    assert.deepEqual(
      blocks.map((b) => key(b.cid)),
      (dups === "n"
        ? [root, branch, f.a, f.b]
        : [root, branch, f.a, f.b, f.a, f.a, branch, f.a, f.b, f.a]
      ).map(key),
    );
    tags.push(response.headers.get("etag"));
  }
  assert.notEqual(tags[0], tags[1]);
  const branchSize = BigInt(Buffer.from("first chunk\nsecond chunk\n").length);
  const sharedFile = await f.put(
    dagPb.code,
    dagPb.encode({
      Data: new UnixFS({ type: "file", blockSizes: [branchSize, branchSize] }).marshal(),
      Links: [
        { Name: "", Hash: f.branch },
        { Name: "", Hash: f.branch },
      ],
    }),
  );
  for (const dups of ["n", "y"]) {
    const partial = await fetch(
      `${url}/ipfs/${sharedFile}?format=car&car-dups=${dups}&entity-bytes=${branchSize - 1n}:${branchSize}`,
    );
    assert.deepEqual(
      (await readArchive(new Uint8Array(await partial.arrayBuffer()))).blocks.map((b) =>
        key(b.cid),
      ),
      (dups === "n"
        ? [sharedFile, f.branch, f.b, f.a]
        : [sharedFile, f.branch, f.b, f.branch, f.a]
      ).map(key),
      "shared subtree at different offsets must select both different leaves",
    );
  }
  // Resolver re-reads of the final UnixFS file must not masquerade as graph occurrences.
  const response = await fetch(`${url}/ipfs/${f.root}/file?format=car&dag-scope=entity&car-dups=y`);
  assert.deepEqual(
    (await readArchive(new Uint8Array(await response.arrayBuffer()))).blocks.map((b) => key(b.cid)),
    [f.root, f.target, f.branch, f.a, f.b, f.a].map(key),
  );
  for (const [query, accept, status, dups] of [
    ["", `${media};q=0.1,application/vnd.ipld.car;dups=y;q=0.9`, 200, "y"],
    ["", "application/vnd.ipld.car;dups=y;q=0,application/vnd.ipld.car;q=0.8", 200, "n"],
    ["&car-dups=n", "application/vnd.ipld.car;dups=y", 200, "n"],
    ["&car-dups=y", media, 200, "y"],
    [
      "&car-version=1&car-order=dfs",
      "application/vnd.ipld.car;version=2;order=nope;dups=y",
      200,
      "y",
    ],
    ["", "application/vnd.ipld.car;dups=y;dups=n", 406, ""],
    ["", "application/vnd.ipld.car;dups=y;dups=n,application/vnd.ipld.car", 406, ""],
    ["", "application/vnd.ipld.car;q=0.1234", 406, ""],
    ["", "application/vnd.ipld.car;q=bad,*/*;q=1", 406, ""],
    ["", "application/vnd.ipld.car;dups", 406, ""],
    ["", "application/vnd.ipld.car;dups=unknown", 406, ""],
    ["&car-dups=", media, 406, ""],
    ["&car-dups=y&car-dups=n", media, 400, ""],
    ["&car-version=1&car-version=1", media, 400, ""],
  ] as const) {
    const negotiated = await fetch(`${url}/ipfs/${root}?format=car${query}`, {
      headers: { accept },
    });
    assert.equal(negotiated.status, status, query + accept);
    if (status === 200)
      assert.equal(negotiated.headers.get("content-type"), media.replace("dups=n", `dups=${dups}`));
    await negotiated.arrayBuffer();
  }
});
test("range reads preserve backpressure, timeout and client-abort cancellation", async (t) => {
  const f = await scopeFixture();
  const leaves: CID[] = [];
  for (let i = 0; i < 32; i++) {
    const bytes = Buffer.alloc(512 * 1024, i);
    leaves.push(await f.put(0x55, bytes));
  }
  const root = await f.put(
    dagPb.code,
    dagPb.encode({
      Data: new UnixFS({ type: "file", blockSizes: leaves.map(() => 524288n) }).marshal(),
      Links: leaves.map((Hash) => ({ Name: "", Hash })),
    }),
  );
  let reads = 0;
  const slow = await listen(
    t,
    async (cid) => {
      reads++;
      return f.blocks.get(key(cid))!;
    },
    { ...profile, maxConcurrent: 1, timeoutMs: 300 },
  );
  const request = httpRequest(`${slow.url}/ipfs/${root}?format=car&entity-bytes=0:*`);
  request.on("error", () => {});
  const received = new Promise<void>((done) =>
    request.once("response", (response) => {
      response.pause();
      done();
    }),
  );
  request.end();
  await received;
  await new Promise<void>((done) => setTimeout(done, 100));
  assert.ok(reads < leaves.length / 2, `range read-ahead ${reads}/${leaves.length}`);
  assert.equal((await fetch(`${slow.url}/ipfs/bafkqaaa?format=car`)).status, 429);
  request.destroy();
  await new Promise<void>((done) => setTimeout(done, 30));
  const recovered = await fetch(`${slow.url}/ipfs/bafkqaaa?format=car`);
  assert.equal(recovered.status, 200);
  await recovered.arrayBuffer();
  for (const mode of ["abort", "timeout"]) {
    let entered!: () => void;
    let stopped!: () => void;
    const began = new Promise<void>((done) => {
      entered = done;
    });
    const ended = new Promise<void>((done) => {
      stopped = done;
    });
    const blocked = await listen(
      t,
      async (cid, { signal }) => {
        if (cid.equals(root)) return f.blocks.get(key(cid))!;
        entered();
        await new Promise<void>((done) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped();
              done();
            },
            { once: true },
          );
          if (signal.aborted) {
            stopped();
            done();
          }
        });
        signal.throwIfAborted();
        throw new Error("unreachable");
      },
      { ...profile, maxConcurrent: 1, timeoutMs: 150 },
    );
    const controller = new AbortController();
    const pending = fetch(`${blocked.url}/ipfs/${root}?format=car&entity-bytes=0:1`, {
      signal: controller.signal,
    }).then((response) => response.arrayBuffer());
    const failed = assert.rejects(pending);
    await began;
    if (mode === "abort") controller.abort();
    await failed;
    await ended;
    await new Promise<void>((done) => setTimeout(done, 10));
    const probe = await fetch(`${blocked.url}/ipfs/bafkqaaa?format=car`);
    assert.equal(probe.status, 200);
    await probe.arrayBuffer();
  }
});

test("descendant deletion/GC fails HTTP and independent completeness; conditional/HEAD and budgets preflight all", async (t) => {
  const f = await scopeFixture();
  let prune = false;
  const { url } = await listen(t, async (cid) => {
    if (prune && cid.equals(f.branch)) f.blocks.delete(key(f.b));
    const bytes = f.blocks.get(key(cid));
    if (!bytes) throw missing();
    return bytes;
  });
  const path = `${url}/ipfs/${f.root}/file?format=car`;
  const valid = await fetch(path);
  await valid.arrayBuffer();
  const etag = valid.headers.get("etag")!;
  prune = true;
  await assert.rejects(async () => {
    const response = await fetch(path);
    await response.arrayBuffer();
  });
  for (const method of ["HEAD", "GET"])
    for (const cached of [false, true]) {
      const response = await fetch(path, {
        method,
        headers: {
          "if-none-match": etag,
          ...(cached ? { "cache-control": "only-if-cached" } : {}),
        },
      });
      assert.equal(
        response.status,
        cached ? 412 : 404,
        "no success/304 after pruning a descendant",
      );
    }
  for (const budget of [{ maxTraversalBlocks: 3 }, { maxCarBytes: 150 }]) {
    const clean = await scopeFixture();
    const limited = await listen(t, async (cid) => clean.blocks.get(key(cid))!, {
      ...profile,
      ...budget,
    });
    const path = `${limited.url}/ipfs/${clean.root}?format=car`;
    assert.equal((await fetch(path, { method: "HEAD" })).status, 413);
    await assert.rejects(async () => {
      const response = await fetch(path);
      if (response.status === 413) throw new Error("rejected before output");
      await response.arrayBuffer();
    });
  }
  let deep = f.a;
  for (let i = 0; i < 66; i++) deep = await f.put(dagCbor.code, dagCbor.encode({ child: deep }));
  assert.equal((await fetch(`${url}/ipfs/${deep}?format=car`, { method: "HEAD" })).status, 413);
});
