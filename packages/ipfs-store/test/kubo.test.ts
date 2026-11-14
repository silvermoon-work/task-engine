import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as dagPb from "@ipld/dag-pb";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { ContentBlocks } from "../src/dag.js";
import { IpfsStore } from "../src/index.js";
import { readContentConfiguration } from "../src/node.js";
import { kuboFixture } from "./kubo-fixture.js";

const directories: string[] = [];
test.after(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function raw(bytes: Uint8Array) {
  return CID.createV1(0x55, await sha256.digest(bytes));
}
async function graph() {
  const blocks = new ContentBlocks();
  const payload = Buffer.alloc(8001, 123);
  let root = "";
  for await (const node of importer([{ path: "data.bin", content: payload }], blocks, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
    chunker: fixedSize({ chunkSize: 333 }),
  }))
    root = node.cid.toString();
  return { blocks, payload, root };
}
async function fixture(t: test.TestContext) {
  const rpc = await kuboFixture();
  const directory = resolve(".cache", `kubo-${randomUUID()}`);
  directories.push(directory);
  const config = { backend: "kubo" as const, apiUrl: rpc.apiUrl, coordinationDir: directory };
  const store = new IpfsStore(config);
  t.after(async () => {
    await store.close();
    await rpc.close();
  });
  return { rpc, directory, config, store };
}

test("strict backend union validates JSON, legacy local options and branch-specific overrides", async (t) => {
  const directory = resolve(".cache", `kubo-config-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = [
    { backend: "kubo", apiUrl: "http://localhost:5001", dataDir: directory },
    { backend: "kubo", apiUrl: "file:///repo" },
    { backend: "local", dataDir: directory, apiUrl: "http://localhost" },
    { backend: null, dataDir: directory },
    { dataDir: directory, limits: { bytes: 0 } },
    { dataDir: directory, limits: { unknown: 1 } },
    { backend: "kubo", apiUrl: "http://localhost", timeoutMs: 1.5 },
  ];
  for (const value of invalid) assert.throws(() => new IpfsStore(value as never));
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      backend: "kubo",
      apiUrl: "https://trusted.example/rpc",
      coordinationDir: "coord",
      limits: { bytes: 4096 },
    }),
  );
  const config = await readContentConfiguration({}, path);
  assert.equal(config.backend, "kubo");
  assert.equal(config.coordinationDir, join(directory, "coord"));
  const injected = await readContentConfiguration(
    { backend: "kubo", apiUrl: "https://trusted.example" },
    join(directory, "absent.json"),
  );
  assert.equal(injected.backend, "kubo");
  await assert.rejects(readContentConfiguration({ dataDir: directory }, path), /backend-specific/);
  const local = new IpfsStore({ dataDir: directory });
  assert.equal(local.configuration.backend, "local");
  await local.close();
});

test("raw Kubo blocks retain exact DAG bytes/CIDs and UnixFS behavior without application disk blocks", async (t) => {
  const { rpc, store, directory } = await fixture(t);
  const { blocks, root, payload } = await graph();
  for (const [cid, bytes] of blocks.blocks) await store.put(CID.parse(cid), bytes);
  assert.equal(rpc.pins.size, 0, "put is not pin");
  await store.prepare(root);
  assert.equal(rpc.pins.size, 0, "prepare is not pin");
  for (const [cid, bytes] of blocks.blocks) assert.deepEqual(rpc.blocks.get(cid), bytes);
  const node = await store.read(`${root}/data.bin`);
  assert.ok(node.type === "file" || node.type === "raw");
  const parts: Uint8Array[] = [];
  for await (const part of node.content()) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), payload);
  await store.pin(root);
  assert.match(rpc.pins.get(root)!.Name, /^@silvermoon-work\/task-engine\//);
  assert.equal(rpc.pins.get(root)!.Type, "recursive");
  assert.ok(!(await readdir(directory)).includes("blocks"));
  await store.unpin(root);
  assert.equal(rpc.pins.size, 0);
  const source = IpfsStore.fromClient(store);
  t.after(() => source.close());
  await source.put(CID.parse(root), blocks.blocks.get(root)!);
  assert.equal(source.supportsRetention, false);
  await assert.rejects(source.pin(root), {
    code: "read_only",
  });
});

test("Kubo enforces measured single-block, cumulative bytes, unique blocks and DAG depth limits", async (t) => {
  const { rpc, config } = await fixture(t);
  const data = Buffer.alloc(17, 1),
    cid = await raw(data);
  rpc.blocks.set(cid.toString(), data);
  const limited = new IpfsStore({ ...config, limits: { blockBytes: 17, bytes: 17 } });
  t.after(() => limited.close());
  assert.deepEqual(Buffer.from(await limited.block.get(cid.toString())), data);
  assert.equal(limited.retainedBytes, 17);
  const tooLarge = Buffer.alloc(18, 2),
    largeCid = await raw(tooLarge);
  rpc.blocks.set(largeCid.toString(), tooLarge);
  await assert.rejects(limited.block.get(largeCid.toString()), { code: "capacity_exceeded" });
  const { blocks, root } = await graph();
  for (const [cid, bytes] of blocks.blocks) rpc.blocks.set(cid, bytes);
  for (const limits of [{ bytes: 333 }, { blocks: 1 }, { depth: 1 }]) {
    const store = new IpfsStore({ ...config, limits });
    try {
      await assert.rejects(store.prepare(root), /capacity|exceeded/);
    } finally {
      await store.close();
    }
  }
  const corrupt = new IpfsStore(config);
  t.after(() => corrupt.close());
  rpc.blocks.set(cid.toString(), Buffer.alloc(17, 9));
  await assert.rejects(corrupt.block.get(cid.toString()), /verification/);
});

test("bounded RPC bodies, cancellation, timeout, scope and close never shut down or unpin the daemon", async (t) => {
  const { rpc, store, config, directory } = await fixture(t);
  const data = Buffer.from("waiting"),
    cid = await raw(data);
  rpc.blocks.set(cid.toString(), data);
  let started = () => {};
  const pending = new Promise<void>((done) => {
    started = done;
  });
  rpc.setHook(async (command) => {
    if (command === "block/get") {
      started();
      return true;
    }
    return undefined;
  });
  const scope = store.scope();
  const cancel = new AbortController();
  const canceled = assert.rejects(
    scope.block.get(cid.toString(), { signal: cancel.signal }),
    /cancel caller/,
  );
  await pending;
  cancel.abort(new Error("cancel caller"));
  await canceled;
  await scope.close();
  const timed = new IpfsStore({ ...config, timeoutMs: 25 });
  await assert.rejects(timed.block.get(cid.toString()), /timeout|aborted/i);
  await timed.close();
  const closing = assert.rejects(store.block.get(cid.toString()), /closed/);
  await store.close();
  await closing;
  await assert.rejects(store.pin(cid), /closed/);
  await assert.rejects(store.stageBlock("closed", cid, data), /closed/);
  await assert.rejects(
    readdir(directory),
    { code: "ENOENT" },
    "Closed stores cannot lazily create a coordinator or leak SQLite handles",
  );
  assert.equal(rpc.calls.includes("shutdown"), false);
  assert.equal(rpc.calls.includes("pin/rm"), false);
  rpc.setHook(async (command, _url, response) => {
    if (command !== "block/get") return;
    response.writeHead(200).end(Buffer.alloc(1025));
    return true;
  });
  const bounded = new IpfsStore({ ...config, limits: { blockBytes: 1024 } });
  t.after(() => bounded.close());
  await assert.rejects(bounded.block.get(cid.toString()), { code: "capacity_exceeded" });
});

test("durable participant references preserve other Engines, external names and last-reference pruning", async (t) => {
  const { rpc, store: a, config } = await fixture(t);
  const bytes = Buffer.from("shared"),
    cid = (await raw(bytes)).toString();
  rpc.blocks.set(cid, bytes);
  const b = new IpfsStore(config);
  await a.retain("engine-a", [cid]);
  await a.confirmRetained("engine-a", [cid]);
  await b.retain("engine-b", [cid]);
  await b.confirmRetained("engine-b", [cid]);
  const name = rpc.pins.get(cid)!.Name;
  await b.close();
  assert.equal(await a.reconcile("engine-a", []), 0);
  const restarted = new IpfsStore(config);
  t.after(() => restarted.close());
  assert.equal(await restarted.reconcile("engine-b", []), 1);
  assert.equal(rpc.pins.has(cid), false);
  for (const external of ["external/manual", ""]) {
    rpc.pins.set(cid, { Type: "recursive", Name: external });
    await a.pin(cid);
    assert.equal(rpc.pins.get(cid)!.Name, external);
    await a.reconcile("engine-a", []);
    assert.equal(rpc.pins.get(cid)!.Name, external);
  }
  rpc.pins.set(cid, { Type: "recursive", Name: name });
  await a.pin(cid);
  rpc.pins.set(cid, { Type: "recursive", Name: "external/replaced" });
  await a.unpin(cid);
  assert.equal(rpc.pins.get(cid)!.Name, "external/replaced");
});

test("complete marking, concurrent publication intents and operation-outcome recovery fail safe", async (t) => {
  const { rpc, store, config } = await fixture(t);
  const { blocks, root } = await graph();
  for (const [cid, bytes] of blocks.blocks) rpc.blocks.set(cid, bytes);
  await store.retain("old", [root]);
  await store.confirmRetained("old", [root]);
  const child = [...blocks.blocks.keys()].find((key) => CID.parse(key).code === 0x55)!;
  rpc.blocks.delete(child);
  const before = rpc.calls.filter((call) => call === "pin/rm").length;
  await assert.rejects(store.reconcile("sweeper", []), { code: "retention_unfinished" });
  assert.equal(rpc.calls.filter((call) => call === "pin/rm").length, before);
  rpc.blocks.set(child, blocks.blocks.get(child)!);
  const extra = Buffer.from("new reference"),
    next = (await raw(extra)).toString();
  rpc.blocks.set(next, extra);
  let released = () => {},
    began = () => {};
  const started = new Promise<void>((done) => {
    began = done;
  });
  const gate = new Promise<void>((done) => {
    released = done;
  });
  rpc.setHook(async (command, url) => {
    if (command === "pin/add" && url.searchParams.get("arg") === next) {
      began();
      await gate;
    }
  });
  const retaining = store.retain("new", [next]);
  await started;
  const other = new IpfsStore(config);
  t.after(() => other.close());
  const sweeping = other.reconcile("new", () => []);
  released();
  await retaining;
  await sweeping;
  assert.equal(rpc.pins.has(next), true, "unconfirmed publication remains protected");
  rpc.setHook(undefined);
  await store.confirmRetained("new", [next]);
  rpc.failAfter("pin/add");
  await assert.rejects(store.pin(next), { code: "retention_unfinished" });
  assert.equal(rpc.pins.has(next), true);
  await store.recoverOwner("new", []);
  rpc.failAfter("pin/rm");
  await assert.rejects(store.reconcile("new", []), { code: "retention_unfinished" });
  assert.equal(rpc.pins.has(next), false);
  await store.reconcile("new", []);
  assert.equal(rpc.pins.has(root), true, "other persisted owner remains retained");
});

test("local pin markers survive restart, are not put/prepare and detect manual content deletion", async (t) => {
  const directory = resolve(".cache", `local-pin-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = Buffer.from("local retained"),
    cid = await raw(data);
  const store = new IpfsStore({ dataDir: directory });
  await store.put(cid, data);
  await store.prepare(cid);
  assert.deepEqual(store.pins(), []);
  await store.pin(cid);
  await store.close();
  const restarted = new IpfsStore({ dataDir: directory });
  assert.deepEqual(restarted.pins(), [cid.toString()]);
  await restarted.unpin(cid);
  assert.deepEqual(restarted.pins(), []);
  await rm(join(directory, "blocks", cid.toString()));
  await assert.rejects(restarted.pin(cid), { code: "retention_unfinished" });
  await restarted.close();
});

test("overlapping publications of one owner and CID keep independent pending intent counts", async (t) => {
  const { rpc, store } = await fixture(t);
  const bytes = Buffer.from("overlapping references"),
    cid = (await raw(bytes)).toString();
  rpc.blocks.set(cid, bytes);
  await Promise.all([store.retain("same-owner", [cid]), store.retain("same-owner", [cid])]);
  await store.confirmRetained("same-owner", [cid]);
  await store.recoverOwner("same-owner", () => [], { isIdle: () => false });
  assert.equal(await store.reconcile("same-owner", () => []), 0);
  assert.ok(rpc.pins.has(cid), "The second publication is not yet committed");
  await store.confirmRetained("same-owner", [cid]);
  assert.equal(await store.reconcile("same-owner", () => []), 1);
  await store.retain("same-owner", [cid]);
  await store.recoverOwner("same-owner", () => [], { isIdle: () => true });
  assert.equal(
    await store.reconcile("same-owner", () => []),
    1,
    "An idle owner can retire abandoned publication intents under the mutex",
  );
});

test("an interrupted absent-before staging claim remains unfinished until the unnamed pin is recovered", async (t) => {
  const { rpc, store, config, directory } = await fixture(t);
  const bytes = Buffer.from("interrupted before staging name");
  const cid = await raw(bytes),
    root = cid.toString();
  rpc.setHook(async (command, _url, response) => {
    if (command !== "pin/add") return undefined;
    response.writeHead(503).end('{"Message":"name assignment failed before effect"}');
    return true;
  });
  await assert.rejects(store.stageBlock("review-owner/import", cid, bytes), {
    code: "retention_unfinished",
  });
  assert.equal(rpc.pins.get(root)!.Name, "");
  await store.close();
  const restarted = new IpfsStore(config);
  t.after(() => restarted.close());
  await restarted.recoverOwner("review-owner", []);
  await assert.rejects(restarted.reconcile("review-owner", []), { code: "retention_unfinished" });
  assert.equal(rpc.calls.includes("pin/rm"), false);
  const metadata = new DatabaseSync(join(directory, "retention.sqlite"), { readOnly: true });
  try {
    assert.ok(metadata.prepare("SELECT 1 FROM stage_claims WHERE cid=?").get(root));
    assert.ok(metadata.prepare("SELECT 1 FROM pins WHERE cid=?").get(root));
  } finally {
    metadata.close();
  }
  rpc.setHook(undefined);
  assert.equal(await restarted.reconcile("review-owner", []), 1);
  assert.equal(rpc.pins.has(root), false);
});

test("a genuinely preexisting external unnamed pin is never claimed by staging or recovery", async (t) => {
  const { rpc, store, config, directory } = await fixture(t);
  const bytes = Buffer.from("preexisting external unnamed pin");
  const cid = await raw(bytes),
    root = cid.toString();
  rpc.blocks.set(root, bytes);
  rpc.pins.set(root, { Type: "recursive", Name: "" });
  await store.stageBlock("review-owner/import", cid, bytes);
  await store.close();
  const restarted = new IpfsStore(config);
  t.after(() => restarted.close());
  await restarted.recoverOwner("review-owner", []);
  assert.equal(await restarted.reconcile("review-owner", []), 0);
  assert.equal(rpc.pins.get(root)!.Name, "");
  assert.equal(rpc.calls.includes("pin/add"), false);
  assert.equal(rpc.calls.includes("pin/rm"), false);
  const metadata = new DatabaseSync(join(directory, "retention.sqlite"), { readOnly: true });
  try {
    assert.equal(metadata.prepare("SELECT count(*) AS n FROM stage_claims").get()!.n, 0);
  } finally {
    metadata.close();
  }
});

test("partial DAG imports use separate durable staging pins and can recover without block copies", async (t) => {
  const { rpc, store, config } = await fixture(t);
  const leaf = Buffer.from("staged leaf"),
    child = await raw(leaf);
  const bytes = dagPb.encode({ Links: [{ Hash: child, Name: "leaf" }] });
  const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
  await store.stageBlock("engine/import", child, leaf);
  assert.equal(rpc.pins.get(child.toString())!.Type, "recursive");
  await assert.rejects(store.finishImport("engine/import", root, "engine"), {
    code: "retention_unfinished",
  });
  await store.stageBlock("engine/import", root, bytes);
  await store.finishImport("engine/import", root, "engine");
  await store.confirmRetained("engine", [root.toString()]);
  await store.close();
  const restarted = new IpfsStore(config);
  t.after(() => restarted.close());
  await restarted.recoverOwner("engine", [root.toString()]);
  await restarted.reconcile("engine", [root.toString()]);
  assert.equal(rpc.pins.get(root.toString())!.Type, "recursive");
  assert.equal(
    rpc.pins.has(child.toString()),
    false,
    "recursive root replaces temporary raw-leaf hint",
  );
});

test("coordination locks and incomplete root providers prevent every sweep", async (t) => {
  const { rpc, store, directory } = await fixture(t);
  const bytes = Buffer.from("safe while coordination fails"),
    cid = (await raw(bytes)).toString();
  rpc.blocks.set(cid, bytes);
  await store.pin(cid);
  const mutex = new DatabaseSync(join(directory, "mutex.sqlite"));
  mutex.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(store.reconcile("owner", [], { signal: AbortSignal.timeout(25) }), {
      name: "TimeoutError",
    });
    assert.equal(rpc.calls.includes("pin/rm"), false);
  } finally {
    mutex.exec("ROLLBACK");
    mutex.close();
  }
  await assert.rejects(
    store.reconcile("owner", () => {
      throw new Error("mark source unavailable");
    }),
    { code: "retention_unfinished" },
  );
  assert.equal(rpc.calls.includes("pin/rm"), false);
  rpc.pins.set(cid, { Type: "direct", Name: "external/direct" });
  await assert.rejects(store.pin(cid), { code: "retention_unfinished" });
  assert.equal(rpc.pins.get(cid)!.Name, "external/direct");
});

test("close cancels an uncertain pin without daemon ownership; restart reconciles its durable intent", async (t) => {
  const { rpc, store, config } = await fixture(t);
  const bytes = Buffer.from("uncertain pin"),
    cid = (await raw(bytes)).toString();
  rpc.blocks.set(cid, bytes);
  let began = () => {};
  const started = new Promise<void>((done) => {
    began = done;
  });
  rpc.setHook(async (command, url) => {
    if (command === "pin/add") {
      rpc.pins.set(cid, { Type: "recursive", Name: url.searchParams.get("name")! });
      began();
      return true;
    }
    return undefined;
  });
  const pin = assert.rejects(store.pin(cid), /closed/);
  await started;
  await store.close();
  await pin;
  assert.ok(rpc.pins.has(cid), "closing must not undo an uncertain daemon mutation");
  rpc.setHook(undefined);
  const restarted = new IpfsStore(config);
  try {
    await restarted.recoverOwner("owner", []);
    assert.equal(await restarted.reconcile("owner", []), 1);
    assert.equal(rpc.pins.has(cid), false);
    assert.equal(rpc.calls.includes("shutdown"), false);
  } finally {
    await restarted.close();
  }
});

test("Kubo adapter never reconfigures daemon networking, bootstrap or gateway policy", async (t) => {
  const { rpc, store } = await fixture(t);
  const bytes = Buffer.from("policy-unchanged");
  const cid = await raw(bytes);
  await store.put(cid, bytes);
  await store.prepare(cid);
  await store.pin(cid.toString());
  await store.unpin(cid.toString());
  await store.block.get(cid.toString());
  assert.equal(
    rpc.calls.every((command) => /^(block\/(get|put)|pin\/(add|rm|ls))$/.test(command)),
    true,
    rpc.calls.join(","),
  );
  assert.equal(
    rpc.calls.some((command) =>
      /^(config|swarm|bootstrap|dht|routing|name|gateway|shutdown|id)/.test(command),
    ),
    false,
  );
});
