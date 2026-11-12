import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { resolve, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import { DiskContent } from "../src/data.js";
import { createRawGateway, type RawGatewayOptions } from "../src/raw-gateway.js";
import {
  createRecursiveGateway,
  recursiveEndpoints,
  recursiveHopHeader,
} from "../src/recursive-gateway.js";
import { validateValue } from "../src/config.js";

// Frozen before execution: two acquisition slots, no queue, 1KiB TOTAL received bytes,
// 400ms total / 150ms attempt, <=2 upstreams, four hops, A/B <=3 requests / 1000ms.
const policy = {
  maxConcurrent: 2,
  maxBlockBytes: 1024,
  timeoutMs: 400,
  attemptTimeoutMs: 150,
};
const raw: RawGatewayOptions = {
  access: "public",
  maxConcurrent: 16,
  maxBlockBytes: 1024,
  timeoutMs: 1500,
};
async function listen(
  t: test.TestContext,
  handler: RequestListener,
  server = createServer(handler),
) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function cache(t: test.TestContext) {
  const directory = resolve(".cache", `recursive-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const content = new DiskContent(directory);
  t.after(async () => {
    await content.close();
    await rm(directory, { recursive: true, force: true });
  });
  return content;
}
async function fixture(t: test.TestContext, handler: RequestListener) {
  const upstream = await listen(t, handler);
  const content = await cache(t);
  const gateway = createRawGateway(
    { ...raw, recursive: { ...policy, upstreams: [upstream] } },
    (cid, options) => content.local(cid, options),
    (cid, bytes, signal) => content.put(cid, bytes, signal),
  );
  const url = await listen(t, (request, response) => void gateway.handle(request, response));
  t.after(() => gateway.close());
  return { content, gateway, url };
}
const bytes = Buffer.from("recursive verified content");
const cid = CID.createV0(await sha256.digest(bytes));
const path = `/ipfs/${cid}?format=raw`;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("State did not settle in 500ms");
}

test("recursive allowlist rejects credentials, hints, paths and normalized duplicates", () => {
  for (const value of [
    "",
    "http://u:p@localhost",
    "http://@localhost",
    "http://localhost/path",
    "http://localhost/a/..",
    "http:localhost",
    "http://localhost?",
    "http://localhost#",
    "http://localhost?x",
    "http://localhost#x",
    "file:///a",
    "http://localhost.",
    "http://local%68ost",
    "http://localhost\\@evil",
    "http://localhost,http://LOCALHOST:80",
    "http://a,http://b,http://c",
    " http://localhost",
  ])
    assert.throws(() => recursiveEndpoints(value), { code: "INVALID_CONFIG_VALUE" }, value);
  assert.deepEqual(recursiveEndpoints("http://127.0.0.1:1234,https://example.com"), [
    "http://127.0.0.1:1234",
    "https://example.com",
  ]);
  assert.throws(() => validateValue("server.gatewayMode", "proxy"));
});

test("canonical singleflight, isolated waiter cancellation, strict only-if-cached GET/HEAD/CAR, durable warm reopen", async (t) => {
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const f = await fixture(t, async (_request, response) => {
    requests++;
    await gate;
    response.writeHead(200, { "content-type": "application/vnd.ipld.raw" }).end(bytes);
  });
  const aborted = new AbortController();
  const first = fetch(`${f.url}${path}`, { signal: aborted.signal }).catch(
    (error: unknown) => error,
  );
  await until(() => requests === 1);
  const second = fetch(`${f.url}/ipfs/${cid.toV1()}?format=raw`);
  await until(() => f.gateway.snapshot().recursive?.joined === 1);
  const restricted = await fetch(`${f.url}${path}`, {
    headers: { [recursiveHopHeader]: randomUUID() },
  });
  assert.equal(restricted.status, 502);
  assert.equal(requests, 1);
  for (const method of ["GET", "HEAD"])
    for (const format of ["raw", "car"]) {
      const cached = await fetch(`${f.url}/ipfs/${cid}?format=${format}`, {
        method,
        headers: { "cache-control": "Only-If-Cached" },
      });
      assert.equal(cached.status, 412);
    }
  assert.equal(requests, 1);
  assert.equal(f.gateway.snapshot().recursive?.joined, 1);
  aborted.abort();
  assert.ok((await first) instanceof Error);
  release();
  const response = await second;
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await f.gateway.close();
  const reopened = new DiskContent(f.content.directory);
  assert.deepEqual(await reopened.local(cid), bytes);
  const warm = createRawGateway(raw, (cid, opts) => reopened.local(cid, opts));
  t.after(() => warm.close());
  const warmUrl = await listen(t, (req, res) => void warm.handle(req, res));
  assert.deepEqual(Buffer.from(await (await fetch(`${warmUrl}${path}`)).arrayBuffer()), bytes);
  await reopened.close();
  assert.equal(requests, 1);
});

test("default, disabled, authentication and corrupt local cache do not acquire", async (t) => {
  let requests = 0;
  const upstream = await listen(t, (_request, response) => {
    requests++;
    response.end();
  });
  const content = await cache(t);
  for (const options of [
    raw,
    { ...raw, access: "disabled" as const, recursive: { ...policy, upstreams: [upstream] } },
    {
      ...raw,
      access: "token" as const,
      token: "a".repeat(32),
      recursive: { ...policy, upstreams: [upstream] },
    },
  ]) {
    const gateway = createRawGateway(
      options,
      (cid, opts) => content.local(cid, opts),
      (cid, bytes, signal) => content.put(cid, bytes, signal),
    );
    t.after(() => gateway.close());
    const url = await listen(t, (req, res) => void gateway.handle(req, res));
    assert.equal(
      (await fetch(`${url}${path}`)).status,
      options.access === "disabled" ? 404 : options.access === "token" ? 401 : 404,
    );
  }
  const f = await fixture(t, (_req, res) => {
    requests++;
    res.end();
  });
  await mkdir(join(f.content.directory, "blocks"));
  await writeFile(join(f.content.directory, "blocks", cid.toV1().toString()), "corruption");
  assert.equal((await fetch(`${f.url}${path}`)).status, 500);
  assert.equal(requests, 0);
});

test("wrong CID, content type, declared/streamed oversize, redirect and stalled bodies never cache", async (t) => {
  for (const fault of [
    "cid",
    "type",
    "length",
    "stream",
    "redirect",
    "stall",
    "headers",
  ] as const) {
    let redirected = 0;
    const target = await listen(t, (_request, response) => {
      redirected++;
      response.end(bytes);
    });
    const f = await fixture(t, (_request, response) => {
      if (fault === "redirect") return void response.writeHead(302, { location: target }).end();
      if (fault === "headers") return;
      response.writeHead(200, {
        "content-type": fault === "type" ? "text/html" : "application/vnd.ipld.raw",
        ...(fault === "length" ? { "content-length": "1025" } : {}),
      });
      response.flushHeaders();
      if (fault === "stall") response.write("x");
      else
        response.end(fault === "cid" ? "wrong" : fault === "stream" ? Buffer.alloc(1025) : bytes);
    });
    const start = performance.now();
    const response = await fetch(`${f.url}${path}`);
    assert.ok([502, 504].includes(response.status), `${fault}: ${response.status}`);
    assert.ok(performance.now() - start < 1000, fault);
    await assert.rejects(f.content.local(cid), { code: "ENOENT" });
    assert.equal(redirected, 0);
    assert.equal(f.gateway.snapshot().recursive?.active, 0);
    const files = await readdir(f.content.directory);
    assert.deepEqual(files, []);
  }
});

test("ordered fallback has a shared byte/deadline budget and never hides persistence errors", async (t) => {
  let first = 0,
    second = 0;
  const upstreams = [
    await listen(t, (_req, res) => {
      first++;
      res.writeHead(200, { "content-type": "application/vnd.ipld.raw" }).end(Buffer.alloc(1000));
    }),
    await listen(t, (_req, res) => {
      second++;
      res.writeHead(200, { "content-type": "application/vnd.ipld.raw" }).end(bytes);
    }),
  ];
  const content = await cache(t);
  const client = createRecursiveGateway(
    { ...policy, upstreams },
    (cid, opts) => content.local(cid, opts),
    (cid, bytes, signal) => content.put(cid, bytes, signal),
  );
  t.after(() => client.close());
  await assert.rejects(client.read(cid, { signal: new AbortController().signal, maxBytes: 1024 }), {
    code: "RECURSIVE_FAILED",
  });
  assert.equal(first, 1);
  assert.equal(second, 1);
  await assert.rejects(content.local(cid), { code: "ENOENT" });
  const broken = createRecursiveGateway(
    { ...policy, upstreams: [upstreams[1]!, upstreams[0]!] },
    (cid, opts) => content.local(cid, opts),
    async () => {
      throw new Error("storage broken");
    },
  );
  t.after(() => broken.close());
  await assert.rejects(
    broken.read(cid, { signal: new AbortController().signal, maxBytes: 1024 }),
    /storage broken/,
  );
  assert.equal(first, 1);
  assert.equal(second, 2);
  const stalled = await listen(t, () => {});
  const fallback = createRecursiveGateway(
    { ...policy, upstreams: [stalled, upstreams[1]!] },
    (cid, opts) => content.local(cid, opts),
    (cid, bytes, signal) => content.put(cid, bytes, signal),
  );
  t.after(() => fallback.close());
  assert.deepEqual(
    await fallback.read(cid, { signal: new AbortController().signal, maxBytes: 1024 }),
    bytes,
  );
  assert.equal(fallback.snapshot().timeouts, 1);
  assert.equal(fallback.snapshot().attempts, 2);
});

test("verified persistence uses the total deadline, not the completed upstream attempt deadline", async (t) => {
  for (const expires of [false, true])
    await t.test(
      expires ? "total deadline cancels persistence" : "attempt deadline ends before persistence",
      async (t) => {
        const upstream = await listen(t, (_request, response) => {
          response.writeHead(200, { "content-type": "application/vnd.ipld.raw" }).end(bytes);
        });
        const content = await cache(t);
        let entered!: (signal: AbortSignal) => void;
        const persisting = new Promise<AbortSignal>((resolve) => {
          entered = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const client = createRecursiveGateway(
          { ...policy, upstreams: [upstream] },
          (cid, options) => content.local(cid, options),
          async (cid, bytes, signal) => {
            entered(signal);
            await gate;
            await content.put(cid, bytes, signal);
          },
        );
        t.after(() => client.close());
        const result = client.read(cid, {
          signal: new AbortController().signal,
          maxBytes: policy.maxBlockBytes,
        });
        try {
          const signal = await persisting;
          t.mock.timers.tick(expires ? policy.timeoutMs : policy.attemptTimeoutMs);
          assert.equal(signal.aborted, expires);
          assert.equal(client.snapshot().timeouts, expires ? 1 : 0);
          release();
          if (expires) {
            await assert.rejects(result, { code: "RECURSIVE_TIMEOUT" });
            await assert.rejects(content.local(cid), { code: "ENOENT" });
          } else {
            assert.deepEqual(await result, bytes);
            assert.deepEqual(await content.local(cid), bytes);
          }
        } finally {
          release();
          await Promise.allSettled([result]);
        }
      },
    );
});

test("all waiter cancellation aborts acquisition, rejects queue, and close seals/awaits owned work", async (t) => {
  let requests = 0;
  let active = 0;
  const upstream = await listen(t, (request, response) => {
    requests++;
    active++;
    response.once("close", () => {
      active--;
    });
    request.resume();
  });
  const content = await cache(t);
  const client = createRecursiveGateway(
    { ...policy, upstreams: [upstream] },
    (cid, opts) => content.local(cid, opts),
    (cid, bytes, signal) => content.put(cid, bytes, signal),
  );
  t.after(() => client.close());
  const a = new AbortController(),
    b = new AbortController();
  const one = client.read(cid, { signal: a.signal, maxBytes: 1024 }).catch((e: unknown) => e);
  const two = client
    .read(cid.toV1(), { signal: b.signal, maxBytes: 1024 })
    .catch((e: unknown) => e);
  await until(() => requests === 1);
  a.abort();
  assert.ok((await one) instanceof Error);
  assert.equal(client.snapshot().active, 1);
  b.abort();
  assert.ok((await two) instanceof Error);
  await until(() => client.snapshot().active === 0);
  await until(() => active === 0);
  assert.equal(client.snapshot().cancellations, 1);
  const pending = Array.from({ length: 2 }, async (_, index) => {
    const other = CID.createV1(0x55, await sha256.digest(Buffer.from(`pending${index}`)));
    return client
      .read(other, { signal: new AbortController().signal, maxBytes: 1024 })
      .catch((e: unknown) => e);
  });
  await until(() => client.snapshot().active === 2);
  await assert.rejects(client.read(cid, { signal: new AbortController().signal, maxBytes: 1024 }), {
    code: "RECURSIVE_BUSY",
  });
  const start = performance.now();
  await client.close();
  await Promise.all(pending);
  await until(() => active === 0);
  assert.ok(performance.now() - start < 1000);
  assert.equal(client.snapshot().active, 0);
  await assert.rejects(client.read(cid, { signal: new AbortController().signal, maxBytes: 1024 }), {
    code: "ENGINE_CLOSING",
  });
});

test("total acquisition deadline aborts transport before the per-attempt limit", async (t) => {
  const upstream = await listen(t, () => {});
  const content = await cache(t);
  const client = createRecursiveGateway(
    { ...policy, timeoutMs: 40, upstreams: [upstream] },
    (cid, opts) => content.local(cid, opts),
    (cid, bytes, signal) => content.put(cid, bytes, signal),
  );
  t.after(() => client.close());
  const start = performance.now();
  await assert.rejects(
    client.read(cid, {
      signal: new AbortController().signal,
      maxBytes: 1024,
    }),
    { code: "RECURSIVE_TIMEOUT" },
  );
  assert.ok(performance.now() - start < 1000);
  assert.equal(client.snapshot().attempts, 1);
  assert.equal(client.snapshot().timeouts, 1);
  assert.equal(client.snapshot().active, 0);
});

test("self loop, reciprocal A/B and spoofed headers terminate within frozen count/time bounds", async (t) => {
  for (const reciprocal of [false, true]) {
    const gateways: ReturnType<typeof createRawGateway>[] = [];
    let requests = 0;
    const servers: Server[] = [createServer(), createServer()];
    const urls: string[] = [];
    for (const server of servers) urls.push(await listen(t, () => {}, server));
    for (let i = 0; i < 2; i++) {
      const content = await cache(t);
      const gateway = createRawGateway(
        {
          ...raw,
          recursive: { ...policy, upstreams: [urls[reciprocal ? 1 - i : i]!] },
        },
        (cid, opts) => content.local(cid, opts),
        (cid, bytes, signal) => content.put(cid, bytes, signal),
      );
      gateways.push(gateway);
      t.after(() => gateway.close());
      servers[i]!.on("request", (req, res) => {
        requests++;
        void gateway.handle(req, res);
      });
    }
    const start = performance.now();
    assert.equal((await fetch(`${urls[0]}${path}`)).status, 502);
    assert.ok(performance.now() - start < 1000);
    assert.ok(requests <= 3, `${requests} requests`);
    const before = requests;
    assert.equal(
      (
        await fetch(`${urls[0]}${path}`, {
          headers: { [recursiveHopHeader]: "spoof" },
        })
      ).status,
      502,
    );
    assert.equal(requests, before + 1);
    assert.equal(gateways[0]!.snapshot().recursive?.active, 0);
  }
});

test("CAR missing descendant remains honest and only-if-cached never fills it", async (t) => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => {
    requests++;
    res.writeHead(404).end();
  });
  const rootBytes = dagCbor.encode({ child: cid });
  const root = CID.createV1(dagCbor.code, await sha256.digest(rootBytes));
  await f.content.put(root, rootBytes);
  const url = `${f.url}/ipfs/${root}?format=car`;
  const only = await fetch(url, { headers: { "cache-control": "only-if-cached" } });
  if (only.status === 200) await assert.rejects(only.arrayBuffer());
  else assert.equal(only.status, 412);
  assert.equal(requests, 0);
  const head = await fetch(url, { method: "HEAD", headers: { "cache-control": "only-if-cached" } });
  assert.equal(head.status, 412);
  assert.equal(requests, 0);
  const recursive = await fetch(url);
  if (recursive.status === 200) await assert.rejects(recursive.arrayBuffer());
  else assert.equal(recursive.status, 502);
  assert.equal(requests, 1);
});

test("cancelled recursive persistence does not poison managed storage health", async (t) => {
  const content = await cache(t);
  const controller = new AbortController();
  let failures = 0;
  const writer = new DiskContent(
    content.directory,
    undefined,
    () => {
      failures++;
    },
    () => controller.abort(),
  );
  t.after(() => writer.close());
  await assert.rejects(writer.put(cid, bytes, controller.signal));
  assert.equal(failures, 0);
  await assert.rejects(content.local(cid), { code: "ENOENT" });
  assert.deepEqual(await readdir(content.directory), []);
});
