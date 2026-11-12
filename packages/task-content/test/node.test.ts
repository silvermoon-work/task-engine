import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { readContentConfiguration, SharedContent } from "../src/node.js";

test("public defaults and independent overrides use content-only storage", async () => {
  const directory = resolve(`.content-config-${randomUUID()}`);
  await mkdir(directory);
  try {
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({ gateway: "http://127.0.0.1:12345", dataDir: "shared" }),
    );
    const builder = await readContentConfiguration({}, config);
    const engine = await readContentConfiguration({}, config);
    assert.deepEqual(engine, builder);
    assert.equal(builder.dataDir, join(directory, "shared"));
    const independent = await readContentConfiguration(
      { dataDir: join(directory, "other") },
      config,
    );
    assert.equal(independent.gateway, builder.gateway);
    assert.notEqual(independent.dataDir, builder.dataDir);
    assert.equal(
      (await readContentConfiguration({ gateway: "http://127.0.0.1:23456" }, config)).dataDir,
      builder.dataDir,
    );
    await writeFile(config, '{"server.dataDir":"not-content"}');
    await assert.rejects(readContentConfiguration({}, config), /Invalid public content/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple processes publish verified blocks atomically and closing never removes shared data", async () => {
  const directory = resolve(`.content-concurrency-${randomUUID()}`);
  await mkdir(directory);
  const bytes = Buffer.alloc(100_001, 123);
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  const child = `
import {SharedContent} from ${JSON.stringify(new URL("../dist/node.js", import.meta.url).href)};
import {CID} from ${JSON.stringify(new URL("../node_modules/multiformats/dist/src/cid.js", import.meta.url).href)};
const store = new SharedContent(process.argv[1]);
await store.put(CID.parse(process.argv[2]), Buffer.alloc(100001, 123));
await store.close();`;
  try {
    await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(
          process.execPath,
          ["--input-type=module", "--eval", child, directory, cid.toString()],
          { cwd: fileURLToPath(new URL("..", import.meta.url)) },
        ),
      ),
    );
    assert.deepEqual(await readdir(join(directory, "blocks")), [cid.toString()]);
    const a = new SharedContent(directory),
      b = new SharedContent(directory);
    assert.deepEqual(Buffer.from(await a.block.get(cid.toString())), bytes);
    await a.close();
    assert.deepEqual(Buffer.from(await b.block.get(cid.toString())), bytes);
    await writeFile(join(directory, "blocks", ".pending-interrupted"), "partial");
    assert.deepEqual(Buffer.from(await b.block.get(cid.toString())), bytes);
    await assert.rejects(b.put(cid, Buffer.from("modified")), /verification/);
    assert.deepEqual(await readFile(join(directory, "blocks", cid.toString())), bytes);
    await b.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canceling one reader does not cancel another reader sharing the same acquisition", async () => {
  const directory = resolve(`.content-readers-${randomUUID()}`);
  const bytes = Buffer.from("shared acquisition");
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  let release = () => {};
  let reads = 0;
  const client = new SharedContent(directory, {
    block: {
      get: async (_cid, options = {}) =>
        new Promise<Uint8Array>((resolve, reject) => {
          reads++;
          const abort = () => reject(options.signal?.reason);
          options.signal?.addEventListener("abort", abort, { once: true });
          release = () => {
            options.signal?.removeEventListener("abort", abort);
            resolve(bytes);
          };
        }),
    },
  });
  const canceled = new AbortController();
  const first = assert.rejects(
    client.block.get(cid.toString(), { signal: canceled.signal }),
    /one reader canceled/,
  );
  const second = client.block.get(cid.toString()).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    const deadline = Date.now() + 2000;
    while (!reads) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    canceled.abort(new Error("one reader canceled"));
    await first;
    release();
    const result = await second;
    assert.equal(
      "error" in result,
      false,
      "Another reader must keep the shared acquisition alive.",
    );
    if ("value" in result) assert.deepEqual(Buffer.from(result.value), bytes);
    assert.equal(reads, 1);
  } finally {
    release();
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
