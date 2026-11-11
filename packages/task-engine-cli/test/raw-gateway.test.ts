import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { identity } from "multiformats/hashes/identity";
import { DiskContent } from "../src/data.js";
import { createRawGateway, type RawGatewayOptions } from "../src/raw-gateway.js";
import { validateValue } from "../src/config.js";

const profile: RawGatewayOptions = {
  access: "public",
  maxConcurrent: 2,
  maxBlockBytes: 1024,
  timeoutMs: 2000,
};
async function listen(t: test.TestContext, gateway: ReturnType<typeof createRawGateway>) {
  const server = createServer((request, response) => void gateway.handle(request, response));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await gateway.close();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("local raw profile: exact bytes, aliases, identity, negotiation, conditions and zero upstream requests", async (t) => {
  const directory = resolve(".cache", `raw-${randomUUID()}`);
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
  const bytes = Buffer.from([0, 255, 1, 13, 10, 0]);
  const cid = CID.createV0(await sha256.digest(bytes));
  await content.put(cid, bytes);
  const url = await listen(
    t,
    createRawGateway(profile, (cid, options) => content.local(cid, options)),
  );
  const get = (path: string, init?: RequestInit) => fetch(`${url}${path}`, init);
  for (const name of [cid.toString(), cid.toV1().toString()]) {
    const response = await get(`/ipfs/${name}?format=raw`, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(response.headers.get("content-type"), "application/vnd.ipld.raw");
    assert.match(response.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("vary"), "Accept");
    const etag = response.headers.get("etag")!;
    assert.equal(etag, `"${cid.toV1()}.raw"`);
    const head = await get(`/ipfs/${name}?format=raw`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const method of ["GET", "HEAD"]) {
      const cached = await get(`/ipfs/${name}?format=raw`, {
        method,
        headers: { "if-none-match": `"other", W/${etag}` },
      });
      assert.equal(cached.status, 304);
      assert.equal((await cached.arrayBuffer()).byteLength, 0);
    }
    const inline = CID.createV1(0x55, identity.digest(bytes));
    assert.deepEqual(
      Buffer.from(await (await get(`/ipfs/${inline}?format=raw`)).arrayBuffer()),
      bytes,
    );
    const named = await get(`/ipfs/${cid}?format=raw&filename=%E4%BB%BB%E5%8A%A1.bin`);
    assert.match(
      named.headers.get("content-disposition")!,
      /filename\*=UTF-8''%E4%BB%BB%E5%8A%A1.bin/,
    );
    assert.equal(
      (await get(`/ipfs/${name}?format=raw`, { headers: { "if-match": '"wrong"' } })).status,
      412,
    );
    assert.equal(
      (await get(`/ipfs/${name}?format=raw`, { headers: { "if-match": `W/${etag}` } })).status,
      412,
    );
  }
  for (const method of ["GET", "HEAD"]) {
    const probe = await get("/ipfs/bafkqaaa", {
      method,
      headers: { accept: "application/vnd.ipld.raw" },
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.headers.get("content-length"), "0");
    assert.equal((await probe.arrayBuffer()).byteLength, 0);
  }
  for (const [accept, status] of [
    ["application/vnd.ipld.raw", 200],
    ["application/vnd.ipld.raw ; q=0.5", 200],
    ["application/*;q=0.5", 200],
    ["text/html, */*;q=0.1", 200],
    ["application/vnd.ipld.raw;q=0, */*;q=1", 406],
    ["application/vnd.ipld.raw;version=1", 406],
    ["application/vnd.ipld.raw;q=2", 406],
    ["application/vnd.ipld.car", 500],
    ["", 400],
  ] as const)
    assert.equal((await get(`/ipfs/${cid}`, { headers: { accept } })).status, status, accept);
  for (const [path, status] of [
    [`/ipfs/${cid}?format=car`, 500],
    [`/ipfs/${cid}?format=raw&format=raw`, 400],
    [`/ipfs/${cid}/child?format=raw`, 400],
    [`/ipfs/${cid}?format=raw&dag-scope=all`, 400],
    ["/ipfs/invalid?format=raw", 400],
    ["/ipns/example?format=raw", 400],
    [`/ipfs/${CID.createV1(0x55, await sha512.digest(bytes))}?format=raw`, 501],
  ] as const)
    assert.equal((await get(path)).status, status, path);
  assert.equal((await get(`/ipfs/${cid}?format=raw`, { method: "POST" })).status, 405);
  const missing = CID.createV1(0x55, await sha256.digest(Buffer.from("absent")));
  for (const method of ["GET", "HEAD"])
    for (const onlyCached of [false, true]) {
      const response = await get(`/ipfs/${missing}?format=raw`, {
        method,
        headers: onlyCached ? { "cache-control": "max-age=0, Only-If-Cached" } : {},
      });
      assert.equal(response.status, onlyCached ? 412 : 404);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  assert.equal(outbound, 0);
  await new Promise<void>((done) => upstream.close(() => done()));
  assert.equal((await get(`/ipfs/${cid}?format=raw`)).status, 200);
  await writeFile(join(directory, "blocks", cid.toV1().toString()), "corrupt");
  assert.equal((await get(`/ipfs/${cid}?format=raw`)).status, 500);
  assert.equal(
    (await get(`/ipfs/${cid}?format=raw`, { headers: { "if-none-match": "*" } })).status,
    500,
  );
  await rm(join(directory, "blocks", cid.toV1().toString()));
  await mkdir(join(directory, "blocks", cid.toV1().toString()));
  assert.equal((await get(`/ipfs/${cid}?format=raw`)).status, 500);
  assert.equal(outbound, 0);
});

test("disabled/authenticated access does not read local content and tokens are validated", async (t) => {
  let reads = 0;
  const local = async () => {
    reads++;
    return new Uint8Array();
  };
  const disabled = await listen(t, createRawGateway({ ...profile, access: "disabled" }, local));
  const token = "a".repeat(32);
  const secured = await listen(t, createRawGateway({ ...profile, access: "token", token }, local));
  assert.equal((await fetch(`${disabled}/ipfs/bafkqaaa?format=raw`)).status, 404);
  for (const authorization of ["", "Bearer invalid", `Bearer ${"b".repeat(32)}`])
    assert.equal(
      (await fetch(`${secured}/ipfs/bafkqaaa?format=raw`, { headers: { authorization } })).status,
      401,
    );
  const response = await fetch(`${secured}/ipfs/bafkqaaa?format=raw`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /^private,/);
  assert.equal(reads, 0);
  assert.throws(() => createRawGateway({ ...profile, access: "token" }, local));
  assert.throws(() => createRawGateway({ ...profile, access: "unsafe" as "public" }, local));
  assert.throws(() => createRawGateway({ ...profile, maxConcurrent: 0 }, local));
  assert.throws(() => validateValue("server.rawGatewayAccess", "yes"));
  assert.throws(() => validateValue("server.rawGatewayToken", "secret"));
});

test("byte/concurrency budgets, timeout, disconnect and shutdown release independent gateway slots", async (t) => {
  const directory = resolve(".cache", `raw-limits-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = new DiskContent(directory);
  t.after(() => content.close());
  const bytes = Buffer.alloc(33);
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  await content.put(cid, bytes);
  const small = await listen(
    t,
    createRawGateway({ ...profile, maxBlockBytes: 32 }, (cid, options) =>
      content.local(cid, options),
    ),
  );
  assert.equal((await fetch(`${small}/ipfs/${cid}?format=raw`)).status, 413);
  const inline = CID.createV1(0x55, identity.digest(bytes));
  assert.equal((await fetch(`${small}/ipfs/${inline}?format=raw`)).status, 413);
  let entered!: () => void;
  let stopped!: () => void;
  let began = new Promise<void>((done) => {
    entered = done;
  });
  let ended = new Promise<void>((done) => {
    stopped = done;
  });
  const gateway = createRawGateway(
    { ...profile, maxConcurrent: 1, timeoutMs: 100 },
    async (_cid, { signal }) => {
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
      return bytes;
    },
  );
  const url = await listen(t, gateway);
  const path = `${url}/ipfs/${cid}?format=raw`;
  const pending = fetch(path);
  await began;
  assert.equal((await fetch(path)).status, 429);
  assert.equal((await pending).status, 504);
  await ended;
  assert.equal((await fetch(`${url}/ipfs/bafkqaaa?format=raw`)).status, 200);
  began = new Promise<void>((done) => {
    entered = done;
  });
  ended = new Promise<void>((done) => {
    stopped = done;
  });
  const request = httpRequest(path);
  request.on("error", () => {});
  request.end();
  await began;
  request.destroy();
  await ended;
  await new Promise<void>((done) => setImmediate(done));
  assert.equal((await fetch(`${url}/ipfs/bafkqaaa?format=raw`)).status, 200);
  began = new Promise<void>((done) => {
    entered = done;
  });
  ended = new Promise<void>((done) => {
    stopped = done;
  });
  const closingRequest = fetch(path).catch(() => undefined);
  await began;
  await gateway.close();
  await ended;
  await closingRequest;
  assert.equal((await fetch(`${url}/ipfs/bafkqaaa?format=raw`)).status, 503);
});
