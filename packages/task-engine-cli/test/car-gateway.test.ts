import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import * as dagPb from "@ipld/dag-pb";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";
import { sha256 } from "multiformats/hashes/sha2";
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
        assert.ok(block);
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
    ["?format=car", "", 400],
    ["?format=car&dag-scope=all", "", 400],
    ["?format=car&dag-scope=entity", "", 400],
    ["?format=car&dag-scope=block&entity-bytes=0:1", "", 400],
    ["?format=car&dag-scope=block&car-version=2", "", 406],
    ["?format=car&dag-scope=block&car-order=unk", "", 406],
    ["?format=car&dag-scope=block&car-dups=y", "", 406],
    ["?format=car&dag-scope=block&format=car", "", 400],
    ["?format=car&dag-scope=block&dag-scope=block", "", 400],
    ["?format=car&dag-scope=block", "text/html", 200],
    ["?format=car&dag-scope=block", media, 200],
    ["?format=car&dag-scope=block", "application/vnd.ipld.car;version=2", 406],
    ["?format=car&dag-scope=block&car-version=1", "application/vnd.ipld.car;version=2", 200],
    ["?format=car&dag-scope=block", "application/vnd.ipld.car;dups=y", 406],
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
    if (status === 200) assert.equal(response.headers.get("content-type"), media);
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
  const unsupported = CID.createV1(0x71, await sha256.digest(Buffer.from("other codec")));
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
    const { url } = await listen(t, async (cid) => {
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
  const path = `${url}/ipfs/${f.root}/dir?format=car&dag-scope=block`;
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

test("paused client applies backpressure instead of reading the complete proof", async (t) => {
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
  const request = httpRequest(
    `${url}/ipfs/${root}/${Array(depth).fill("d").join("/")}?format=car&dag-scope=block`,
  );
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
