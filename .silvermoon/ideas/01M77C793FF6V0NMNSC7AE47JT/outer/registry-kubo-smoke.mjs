import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = resolve(process.argv[2]);
const owner = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
assert.equal(owner.session, "a1b35ae0-90d2-428a-8d9f-c868f5c1247c");
assert.equal(owner.uid, process.getuid());
assert.equal(process.version, "v24.11.1");
const consumer = join(root, "consumer");
assert.equal(
  dirname(fileURLToPath(import.meta.url)),
  consumer,
  "Run this driver inside its registry consumer.",
);
const expected = {
  "ipfs-store": "0.1.0-rc.2",
  "task-builder": "0.2.0-rc.3",
  "task-builder-cli": "0.2.0-rc.3",
  "task-engine": "0.2.0-rc.3",
  "task-engine-cli": "0.2.0-rc.11",
  "task-protocol": "0.2.0-rc.1",
  "task-sdk": "0.2.0-rc.1",
  "task-engine-storage": "0.2.0-rc.0",
};
const checks = [];
const paths = {};
const lock = JSON.parse(
  await readFile(join(consumer, "package-lock.json"), "utf8"),
);
for (const [id, version] of Object.entries(expected)) {
  const name = `@silvermoon-work/${id}`;
  const directory = join(consumer, "node_modules", "@silvermoon-work", id);
  assert.equal(
    await realpath(directory),
    directory,
    `No source/workspace link: ${id}`,
  );
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  const entry = lock.packages[`node_modules/${name}`];
  assert.equal(entry.version, version);
  assert.equal(new URL(entry.resolved).origin, "https://registry.npmjs.org");
  assert.match(entry.integrity, /^sha512-/);
  paths[id] = directory;
}
const load = (name) => import(name);
const { IpfsStore } = await load("@silvermoon-work/ipfs-store");
const { ContentBlocks } = await load("@silvermoon-work/ipfs-store/dag");
const { buildTaskBundle } = await load("@silvermoon-work/task-builder");
const { encodeTaskBundleCar, readTaskBundleCar } = await load(
  "@silvermoon-work/task-builder/car",
);
const { memoryFile } = await load("@silvermoon-work/task-builder/tree");
const { directoryTree, writeDirectory } = await load(
  "@silvermoon-work/task-builder-cli/node",
);
const {
  createTaskEngine,
  newId,
  IpfsStore: EngineStore,
} = await load("@silvermoon-work/task-engine");
const { openSqliteStore } = await load("@silvermoon-work/task-engine-storage");
assert.equal(EngineStore, IpfsStore);
const { CID } = await load("multiformats/cid");
const { sha256 } = await load("multiformats/hashes/sha2");
checks.push({
  id: "registry-identity",
  passed: true,
  versions: expected,
  paths,
});

const work = join(root, "work");
await mkdir(work);
const binary = join(root, "tools", "kubo", "ipfs");
const repo = join(work, "kubo-repo");
const ipfsEnv = { ...process.env, IPFS_PATH: repo };
const ipfs = (...args) =>
  execFileSync(binary, args, {
    env: ipfsEnv,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
assert.equal(ipfs("version"), "ipfs version 0.43.1");
async function port() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
const apiPort = await port();
const api = `http://127.0.0.1:${apiPort}`;
async function rpc(command, args = {}) {
  const url = new URL(`/api/v0/${command}`, api);
  for (const [key, value] of Object.entries(args))
    url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  assert.ok(text.length <= 8 * 1024 * 1024);
  assert.ok(response.ok, `${command}: HTTP ${response.status}`);
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((value) => JSON.parse(value));
}
let daemon;
let daemonExited;
let log = "";
let expectedPeer;
async function startKubo() {
  daemon = spawn(binary, ["--offline", "daemon", "--routing=none"], {
    env: ipfsEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemonExited = once(daemon, "exit");
  daemon.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-16_384);
  });
  daemon.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-16_384);
  });
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    assert.equal(daemon.exitCode, null, log);
    try {
      const [identity] = await rpc("id");
      assert.equal(
        identity.ID,
        expectedPeer,
        "RPC must belong to this isolated repo.",
      );
      assert.deepEqual(identity.Addresses ?? [], []);
      return identity.ID;
    } catch (error) {
      last = error;
      await sleep(100);
    }
  }
  throw new Error(`Owned Kubo readiness failed: ${last?.message}; ${log}`);
}
async function stopKubo() {
  if (!daemon || daemon.exitCode !== null) return;
  daemon.kill("SIGTERM");
  let timer;
  try {
    await Promise.race([
      daemonExited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Kubo did not stop.")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGKILL");
      await daemonExited;
    }
  }
}
async function bytes(store, path) {
  const node = await store.read(path);
  assert.ok(node.type === "file" || node.type === "raw");
  const parts = [];
  let length = 0;
  for await (const chunk of node.content()) {
    length += chunk.byteLength;
    assert.ok(length <= 4 * 1024 * 1024);
    parts.push(chunk);
  }
  return Buffer.concat(parts, length);
}
async function gc() {
  for (const item of await rpc("repo/gc")) assert.equal(item.Error, undefined);
}
const config = {
  backend: "kubo",
  apiUrl: api,
  timeoutMs: 2000,
  coordinationDir: join(work, "coordination"),
};
let content;
let databases = [];
let engines = [];
let decoded;
let managedAttempted = false;
let managedDir = join(work, "managed");
const cliBin = join(paths["task-engine-cli"], "dist", "bin.js");
const cliHome = join(work, "cli-home");
const contentConfig = join(work, "content.json");
const cliEnv = {
  ...process.env,
  HOME: cliHome,
  TASK_CONTENT_CONFIG: contentConfig,
};
const invoke = promisify(execFile);
async function cli(args, success = true) {
  let result;
  try {
    result = await invoke(process.execPath, [cliBin, ...args], {
      cwd: consumer,
      env: cliEnv,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (success || error.code !== 1) throw error;
    result = error;
  }
  const value = JSON.parse(String(result.stdout).trim());
  assert.equal(value.ok, success, JSON.stringify(value));
  return value;
}
async function waitFor(engine, taskId, caller) {
  const end = Date.now() + 30_000;
  for (;;) {
    const task = engine.getTask(taskId, caller);
    if (["completed", "failed", "stopped"].includes(task.stage)) {
      assert.equal(task.stage, "completed", JSON.stringify(task));
      await engine.waitForTaskRelease(taskId, caller);
      return task;
    }
    assert.ok(Date.now() < end, "Task did not complete.");
    await sleep(20);
  }
}
let failure;
let cleanupError;
try {
  const payload = Buffer.from("default local without a daemon");
  const localCid = CID.createV1(0x55, await sha256.digest(payload));
  const local = new IpfsStore({ dataDir: join(work, "local") });
  await local.put(localCid, payload);
  assert.deepEqual(await bytes(local, localCid), payload);
  await local.close();
  checks.push({ id: "local-default", passed: true, daemonStarted: false });

  await mkdir(repo);
  ipfs("init", "--profile=test", "--empty-repo");
  expectedPeer = JSON.parse(await readFile(join(repo, "config"), "utf8"))
    .Identity.PeerID;
  ipfs("config", "Addresses.API", `/ip4/127.0.0.1/tcp/${apiPort}`);
  ipfs("config", "Addresses.Gateway", "/ip4/127.0.0.1/tcp/0");
  ipfs("config", "--json", "Bootstrap", "[]");
  const peer = await startKubo();
  content = new IpfsStore(config);
  await content.put(localCid, payload);

  const source = join(consumer, "author");
  await mkdir(source);
  await writeFile(
    join(source, "main.ts"),
    `export default async (input, context) => {
    const output = new Uint8Array(input.bytes).fill(123);
    await context.output.write("/out.bin", new ReadableStream({
      start(controller) { controller.enqueue(output); controller.close(); }
    }));
    return { bytes: output.byteLength };
  };`,
  );
  const tree = await buildTaskBundle(await directoryTree(consumer), {
    name: "Registry Kubo smoke",
    runtime: { minVersion: "22.15.0" },
    source: {
      entry: "author/main.ts",
      mode: "callback",
      contract: { input: true, result: true, message: false },
    },
    imports: { "resources/external.txt": localCid.toString() },
    content,
  });
  const bundleDir = join(work, "bundle");
  await writeDirectory(tree, bundleDir);
  const encoded = await encodeTaskBundleCar(await directoryTree(bundleDir));
  const chunks = [];
  try {
    for await (const chunk of encoded.stream) chunks.push(chunk);
  } finally {
    await encoded.close();
  }
  const car = Buffer.concat(chunks);
  assert.ok(car.length < 8 * 1024 * 1024);
  const carPath = join(work, "fixture.car");
  await writeFile(carPath, car);
  decoded = await readTaskBundleCar(memoryFile(car));
  const graph = new ContentBlocks(decoded);
  await graph.prepare(decoded.cid);
  for (const [cid, block] of [...graph.blocks].reverse())
    await content.stageBlock("smoke-import", CID.parse(cid), block);
  await content.finishImport("smoke-import", decoded.cid);
  for (const [cid, block] of graph.blocks)
    assert.deepEqual(
      Buffer.from(await content.block.get(cid)),
      Buffer.from(block),
    );
  checks.push({
    id: "raw-dag-fidelity",
    passed: true,
    cid: decoded.cid,
    blocks: graph.blocks.size,
  });

  const pathsDb = [join(work, "a.sqlite"), join(work, "b.sqlite")];
  const caller = { scope: "registry-kubo", subject: "smoke" };
  databases = pathsDb.map((path) => openSqliteStore(path));
  engines = databases.map((store) =>
    createTaskEngine({
      store,
      ipfsStore: content,
      authorize: () => true,
      limits: { retentionMs: 1 },
    }),
  );
  await Promise.all(engines.map((engine) => engine.start()));
  const completed = [];
  for (const engine of engines) {
    const requestId = newId();
    await engine.submit(
      {
        requestId,
        bundle: decoded.cid,
        timeoutMs: 15_000,
        bytes: 2 * 1024 * 1024,
      },
      caller,
    );
    const decision = await engine.getRequestStatus(
      requestId,
      { waitMs: 5000 },
      caller,
    );
    assert.equal(decision.status, "accepted", JSON.stringify(decision));
    completed.push(await waitFor(engine, decision.taskId, caller));
  }
  const output = completed[0].output.cid;
  assert.equal(completed[1].output.cid, output);
  assert.deepEqual(completed[0].output.result, { bytes: 2 * 1024 * 1024 });
  for (const store of databases)
    assert.equal(store.readContentBlock(output), undefined);
  for (const path of pathsDb) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM ipfs_blocks").get().n,
        0,
      );
    } finally {
      db.close();
    }
  }
  await Promise.all(engines.map((engine) => engine.close()));
  engines = [];
  for (const store of databases) store.close();
  databases = [];
  const [beforeClose] = await rpc("pin/ls", { type: "recursive", names: true });
  await content.close();
  content = undefined;
  const [afterClose] = await rpc("pin/ls", { type: "recursive", names: true });
  assert.deepEqual(afterClose, beforeClose);
  await stopKubo();
  assert.equal(await startKubo(), peer);
  await gc();
  content = new IpfsStore(config);
  const outputBytes = await bytes(content, `${output}/out.bin`);
  assert.equal(outputBytes.length, 2 * 1024 * 1024);
  assert.equal(
    createHash("sha256").update(outputBytes).digest("hex"),
    createHash("sha256")
      .update(Buffer.alloc(2 * 1024 * 1024, 123))
      .digest("hex"),
  );
  databases = pathsDb.map((path) => openSqliteStore(path));
  engines = databases.map((store) =>
    createTaskEngine({
      store,
      ipfsStore: content,
      authorize: () => true,
      limits: { retentionMs: 1 },
    }),
  );
  await Promise.all(engines.map((engine) => engine.start()));
  checks.push({ id: "persistent-roots-restart-gc", passed: true, output });
  const restore = new ContentBlocks(content);
  await restore.prepare(output);
  await engines[0].reconcileContent();
  await rpc("pin/rm", { arg: output, recursive: true });
  await gc();
  const manuallyCleared = new IpfsStore(config);
  try {
    await assert.rejects(manuallyCleared.block.get(output), {
      code: "missing_block",
    });
  } finally {
    await manuallyCleared.close();
  }
  for (const [cid, block] of [...restore.blocks].reverse())
    await content.stageBlock("smoke-restore", CID.parse(cid), block);
  await content.finishImport("smoke-restore", output);
  await engines[0].reconcileContent();
  checks.push({
    id: "manual-pin-removal",
    passed: true,
    restoredExplicitly: true,
  });
  await stopKubo();
  const cold = new IpfsStore(config);
  try {
    await assert.rejects(cold.block.get(decoded.cid), {
      code: "rpc_unavailable",
    });
  } finally {
    await cold.close();
  }
  assert.equal(
    engines[0].getTask(completed[0].taskId, caller).stage,
    "completed",
  );
  await assert.rejects(engines[0].reconcileContent(), {
    code: "retention_unfinished",
  });
  assert.equal(await startKubo(), peer);
  await engines[0].reconcileContent();
  checks.push({ id: "rpc-failure-db-independent", passed: true });
  await sleep(20);
  await engines[0].collect();
  let [pins] = await rpc("pin/ls", { type: "recursive", names: true });
  assert.ok(pins.Keys[output], "Second Engine still retains output.");
  await engines[1].collect();
  [pins] = await rpc("pin/ls", { type: "recursive", names: true });
  assert.equal(pins.Keys[output], undefined);
  checks.push({ id: "last-reference-prune", passed: true });
  await Promise.all(engines.map((engine) => engine.close()));
  engines = [];
  for (const store of databases) store.close();
  databases = [];

  const foreignBytes = Buffer.from("foreign named pin");
  const foreign = CID.createV1(
    0x55,
    await sha256.digest(foreignBytes),
  ).toString();
  await content.put(CID.parse(foreign), foreignBytes);
  await rpc("pin/add", {
    arg: foreign,
    recursive: true,
    name: "external/manual",
  });
  await content.pin(foreign);
  await content.reconcile("smoke-unowned", []);
  [pins] = await rpc("pin/ls", { arg: foreign, names: true });
  assert.equal(pins.Keys[foreign].Name, "external/manual");
  checks.push({ id: "foreign-pin-name", passed: true });

  await mkdir(cliHome);
  await writeFile(contentConfig, JSON.stringify(config));
  const input = join(work, "input.json");
  await writeFile(input, JSON.stringify({ bytes: 2 * 1024 * 1024 }));
  const cliPort = await port();
  const start = () =>
    cli([
      "server",
      "start",
      "--data-dir",
      managedDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(cliPort),
    ]);
  const stop = () =>
    cli(["server", "stop", "--data-dir", managedDir, "--cancel-running"]);
  managedAttempted = true;
  const started = await start();
  const engineUrl = started.data.engineUrl;
  const run = await cli([
    "run",
    "--car",
    carPath,
    "--input",
    input,
    "--engine",
    engineUrl,
  ]);
  assert.equal(run.data.status, "succeeded", JSON.stringify(run));
  assert.deepEqual(run.data.output.result, { bytes: 2 * 1024 * 1024 });
  const cliOutput = run.data.output.cid;
  await stop();
  const db = new DatabaseSync(join(managedDir, "tasks.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM ipfs_blocks").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM tasks WHERE car IS NOT NULL").get()
        .n,
      0,
    );
  } finally {
    db.close();
  }
  assert.equal((await readdir(managedDir)).includes("blocks"), false);
  await gc();
  const restarted = await start();
  const query = await cli([
    "task",
    "query",
    "--id",
    run.data.taskId,
    "--engine",
    restarted.data.engineUrl,
  ]);
  assert.equal(query.data.items[0].output.cid, cliOutput);
  await stopKubo();
  const queryOffline = await cli([
    "task",
    "query",
    "--id",
    run.data.taskId,
    "--engine",
    restarted.data.engineUrl,
  ]);
  assert.equal(queryOffline.data.items[0].status, "succeeded");
  await cli(
    [
      "run",
      "--cid",
      decoded.cid,
      "--input",
      input,
      "--engine",
      restarted.data.engineUrl,
    ],
    false,
  );
  await stop();
  assert.equal(await startKubo(), peer);
  await start();
  await stop();
  const pruned = await cli([
    "data",
    "prune",
    "--task",
    run.data.taskId,
    "--cache",
    "--data-dir",
    managedDir,
  ]);
  assert.equal(pruned.data.deletedTasks, 1);
  assert.ok(pruned.data.unpinnedRoots >= 1);
  [pins] = await rpc("pin/ls", { type: "recursive", names: true });
  assert.equal(pins.Keys[cliOutput], undefined);
  assert.equal(pins.Keys[foreign].Name, "external/manual");
  checks.push({
    id: "registry-managed-cli",
    passed: true,
    output: cliOutput,
    counts: pruned.data,
  });
  await gc();
  const fresh = new IpfsStore(config);
  try {
    await assert.rejects(fresh.block.get(cliOutput), { code: "missing_block" });
  } finally {
    await fresh.close();
  }
  checks.push({ id: "external-clearing-errors", passed: true });
  await content.close();
  content = undefined;
  assert.equal((await rpc("id"))[0].ID, peer);
  checks.push({ id: "store-close-borrows-daemon", passed: true });
} catch (error) {
  failure = { message: error.message, stack: error.stack };
} finally {
  const failures = [];
  const cleanup = async (action) => {
    try {
      await action();
    } catch (error) {
      failures.push({ message: error.message, stack: error.stack });
    }
  };
  if (managedAttempted)
    await cleanup(() =>
      cli(["server", "stop", "--data-dir", managedDir, "--cancel-running"]),
    );
  for (const engine of engines) await cleanup(() => engine.close());
  for (const store of databases) await cleanup(() => store.close());
  await cleanup(() => content?.close());
  await cleanup(() => decoded?.close());
  await cleanup(() => stopKubo());
  if (failures.length) cleanupError = failures;
}
const result = {
  ok: !failure && !cleanupError,
  observedAt: new Date().toISOString(),
  node: process.version,
  kubo: "0.43.1",
  source: "exact registry-installed packages",
  checks,
  ...(failure ? { failure } : {}),
  cleanup: {
    ok: !cleanupError,
    ...(cleanupError ? { error: cleanupError } : {}),
  },
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
