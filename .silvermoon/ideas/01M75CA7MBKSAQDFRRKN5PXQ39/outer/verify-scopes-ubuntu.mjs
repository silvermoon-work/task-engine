import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const root = process.cwd();
const home = join(root, "owned-home");
const data = join(root, "owned-engine");
const bin = fileURLToPath(new URL("./bin.js", import.meta.resolve("@silvermoon-work/task-engine-cli")));
const report = { startedAt: new Date().toISOString(), checks: {}, scopes: {}, commands: [], cleanup: [] };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = (cid) => cid.toV1().toString();
let active = false, upstream, upstreamClosed = false, outbound = 0, url;

async function command(exe, args, { env = {}, allowFailure = false, timeout = 90000 } = {}) {
  const child = spawn(exe, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = [], err = [];
  child.stdout.on("data", (part) => out.push(part));
  child.stderr.on("data", (part) => err.push(part));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  const bytes = Buffer.concat(out), stderr = Buffer.concat(err).toString();
  report.commands.push({ exe: exe === process.execPath ? "node" : exe, args, code, timedOut, stdoutBytes: bytes.length });
  if (!allowFailure) {
    assert.equal(timedOut, false, `Timeout: ${args.join(" ")}`);
    assert.equal(code, 0, `Failed: ${args.join(" ")}\n${stderr.slice(-2000)}`);
  }
  return { code, bytes, stderr };
}
async function cli(args) {
  const result = await command(process.execPath, [bin, ...args], { env: { HOME: home } });
  const parsed = JSON.parse(result.bytes.toString());
  assert.equal(parsed.ok, true);
  return parsed.data;
}
async function stop() {
  if (!active) return;
  await cli(["server", "stop", "--data-dir", data, "--cancel-running"]);
  active = false;
}
async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return server.address().port;
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}
async function start(port, source) {
  const result = await cli(["server", "start", "--data-dir", data, "--port", String(port), "--ipfs-gateway", source]);
  active = true;
  const instance = JSON.parse(await readFile(join(data, "instance.json"), "utf8"));
  process.kill(instance.pid, 0);
  return { ...result, pid: instance.pid };
}
async function archive(roots, blocks) {
  const { writer, out } = CarWriter.create(roots);
  const writing = (async () => {
    try { for (const block of blocks) await writer.put(block); }
    finally { await writer.close(); }
  })();
  const parts = [];
  for await (const part of out) parts.push(part);
  await writing;
  return Buffer.concat(parts);
}
async function readCar(bytes) {
  const reader = await CarReader.fromBytes(bytes);
  assert.equal(reader.version, 1);
  const blocks = [];
  for await (const block of reader.blocks()) {
    assert.equal(block.cid.multihash.code, sha256.code, "identity blocks must not be emitted");
    assert.deepEqual(Buffer.from((await sha256.digest(block.bytes)).digest), Buffer.from(block.cid.multihash.digest));
    blocks.push(block);
  }
  assert.equal(new Set(blocks.map((block) => key(block.cid))).size, blocks.length);
  return blocks;
}
function sameSet(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}
async function get(path, status = 200, options = {}) {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(30000), ...options });
  assert.equal(response.status, status, `${options.method ?? "GET"} ${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (status !== 200 || options.method === "HEAD") assert.equal(bytes.length, 0);
  return { bytes, headers: Object.fromEntries(response.headers) };
}
const request = (cid, scope) => `/ipfs/${cid}?format=car${scope === undefined ? "" : `&dag-scope=${scope}`}`;
async function repo(name) {
  const value = join(root, `kubo-${name}`);
  await command("ipfs", ["init", "--empty-repo"], { env: { IPFS_PATH: value } });
  return value;
}
const ipfs = (path, args, options = {}) => command("ipfs", ["--offline", ...args], { ...options, env: { IPFS_PATH: path } });
async function importCar(name, bytes) {
  const directory = await repo(name);
  const file = join(root, `${name}.car`);
  await writeFile(file, bytes);
  await ipfs(directory, ["dag", "import", "--pin-roots=false", file]);
  return directory;
}

try {
  await mkdir(home);
  report.node = process.version;
  report.kubo = (await command("ipfs", ["version"])).bytes.toString().trim();
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.resolve("@silvermoon-work/task-engine-cli"))), "utf8"));
  assert.equal(manifest.version, "0.2.0-rc.3");
  report.packageVersion = manifest.version;
  await command(process.execPath, [join(root, "fixtures.mjs")]);
  const fixture = JSON.parse(await readFile("scope-fixture/manifest.json", "utf8"));
  const baseBytes = await readFile("scope-fixture/fixture.car");
  const baseBlocks = await readCar(baseBytes);
  const large = randomBytes(3 * 1024 * 1024);
  const largeBlocks = new Map();
  let directoryRoot, fileRoot;
  for await (const entry of importer([{ path: "large.bin", content: large }], {
    async put(cid, bytes) {
      largeBlocks.set(key(cid), { cid, bytes: Uint8Array.from(bytes) });
      return cid;
    },
  }, {
    cidVersion: 1, rawLeaves: true, wrapWithDirectory: true,
    chunker: fixedSize({ chunkSize: 65536 }),
    layout: balanced({ maxChildrenPerNode: 3 }),
    fileImportConcurrency: 1, blockWriteConcurrency: 1,
  })) {
    directoryRoot = entry.cid;
    if (entry.path === "large.bin") fileRoot = entry.cid;
  }
  assert.ok(directoryRoot && fileRoot);
  const largeCar = await archive([directoryRoot], [...largeBlocks.values()]);
  const baseline = await importCar("baseline-large", largeCar);
  const largeExpected = await readCar((await ipfs(baseline, ["dag", "export", "--progress=false", key(fileRoot)])).bytes);
  assert(largeExpected.length > 48, "Must exercise multilevel file, not just leaves");
  const hamtBaseline = await importCar("baseline-hamt", baseBytes);
  const hamtExpected = await readCar((await ipfs(hamtBaseline, ["dag", "export", "--progress=false", fixture.hamt])).bytes);
  const baseFileExpected = await readCar((await ipfs(hamtBaseline, ["dag", "export", "--progress=false", fixture.file])).bytes);
  report.fixture = {
    largeFile: key(fileRoot), directory: key(directoryRoot), fileBytes: large.length, fileSha256: hash(large),
    expectedFileBlocks: largeExpected.length, hamt: fixture.hamt, hamtEntries: fixture.names.length,
    expectedHamtShards: fixture.hamtShards.length, expectedHamtAllBlocks: hamtExpected.length,
    generic: fixture.generic, genericVirtual: fixture.genericVirtual,
  };
  upstream = createServer((_req, response) => { outbound++; response.writeHead(500).end(); });
  const source = `http://127.0.0.1:${await listen(upstream)}`;
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  await cli(["config", "set", "server.carGatewayMaxBlocks", "4096"]);
  await start(port, source);
  await stop();
  await mkdir(join(data, "blocks"), { recursive: true });
  // Offline maintenance is limited to this stopped dedicated instance.
  const stored = new Map([...baseBlocks, ...largeBlocks.values()].map((block) => [key(block.cid), block]));
  for (const [cid, block] of stored) {
    assert.deepEqual(Buffer.from((await sha256.digest(block.bytes)).digest), Buffer.from(block.cid.multihash.digest));
    await writeFile(join(data, "blocks", cid), block.bytes, { flag: "wx" });
  }
  report.instance = await start(port, source);

  const captures = {};
  for (const [name, cid, expectedEntity, expectedAll] of [
    ["file", key(fileRoot), largeExpected.map((block) => key(block.cid)), largeExpected.map((block) => key(block.cid))],
    ["directory", key(directoryRoot), [key(directoryRoot)], [...largeBlocks.keys()]],
    ["hamt", fixture.hamt, fixture.hamtShards, hamtExpected.map((block) => key(block.cid))],
    ["generic", fixture.generic, [fixture.generic], fixture.genericAll],
  ]) {
    const variants = {};
    for (const scope of ["block", "entity", "all", undefined]) {
      const result = await get(request(cid, scope));
      assert.equal(result.headers["content-type"], "application/vnd.ipld.car; version=1; order=dfs; dups=n");
      const blocks = await readCar(result.bytes);
      sameSet(blocks.map((block) => key(block.cid)), scope === "block" ? [cid] : scope === "entity" ? expectedEntity : expectedAll);
      for (const block of blocks) assert.deepEqual(block.bytes, stored.get(key(block.cid)).bytes);
      variants[scope ?? "default"] = { ...result, blocks };
    }
    assert.deepEqual(variants.default.bytes, variants.all.bytes);
    assert.equal(variants.default.headers.etag, variants.all.headers.etag);
    assert.notEqual(variants.block.headers.etag, variants.entity.headers.etag);
    assert.notEqual(variants.entity.headers.etag, variants.all.headers.etag);
    const head = await get(request(cid, "all"), 200, { method: "HEAD" });
    assert.equal(head.headers.etag, variants.all.headers.etag);
    await get(request(cid, "all"), 304, { headers: { "if-none-match": variants.all.headers.etag } });
    captures[name] = variants;
    report.scopes[name] = Object.fromEntries(Object.entries(variants).map(([scope, result]) => [scope, {
      blocks: result.blocks.length, bytes: result.bytes.length, sha256: hash(result.bytes), etag: result.headers.etag,
    }]));
  }
  const recoveredFile = await importCar("file-entity", captures.file.entity.bytes);
  const recovered = (await ipfs(recoveredFile, ["cat", key(fileRoot)])).bytes;
  assert.deepEqual(recovered, large);
  report.checks.completeFileRecoveredOffline = { bytes: recovered.length, sha256: hash(recovered) };
  const blockFile = await importCar("file-block", captures.file.block.bytes);
  assert.notEqual((await ipfs(blockFile, ["cat", key(fileRoot)], { allowFailure: true })).code, 0);
  report.checks.blockCannotMasqueradeFullFile = true;
  const directoryEntity = await importCar("directory-entity", captures.directory.entity.bytes);
  const listing = (await ipfs(directoryEntity, ["ls", "--resolve-type=false", "--size=false", key(directoryRoot)])).bytes.toString();
  assert.match(listing, /large\.bin/);
  assert.notEqual((await ipfs(directoryEntity, ["cat", `${directoryRoot}/large.bin`], { allowFailure: true })).code, 0);
  report.checks.directoryEntityExcludesChildData = true;
  const hamtEntity = await importCar("hamt-entity", captures.hamt.entity.bytes);
  const names = (await ipfs(hamtEntity, ["ls", "--resolve-type=false", "--size=false", fixture.hamt])).bytes.toString().trim().split("\n").map((line) => line.trim().split(/\s+/).at(-1));
  sameSet(names, fixture.names);
  assert.equal(names.length, 500);
  assert.notEqual((await ipfs(hamtEntity, ["cat", `${fixture.hamt}/entry-0`], { allowFailure: true })).code, 0);
  report.checks.hamtEntityEnumeratedWithoutFiles = { names: names.length, shards: fixture.hamtShards.length };
  const hamtAll = await importCar("hamt-all", captures.hamt.all.bytes);
  const reexport = await readCar((await ipfs(hamtAll, ["dag", "export", "--progress=false", fixture.hamt])).bytes);
  sameSet(reexport.map((block) => key(block.cid)), hamtExpected.map((block) => key(block.cid)));
  for (const index of [0, 249, 499]) assert.equal((await ipfs(hamtAll, ["cat", `${fixture.hamt}/entry-${index}`])).bytes.toString(), `entry ${index}\n`);
  report.checks.hamtAllCompleteOfflineReexport = reexport.length;
  const genericAll = await importCar("generic-all", captures.generic.all.bytes);
  const leaf = await ipfs(genericAll, ["dag", "resolve", `${fixture.generic}/left/child`]);
  assert.equal(leaf.bytes.toString().trim(), `/ipfs/${fixture.genericAll[1]}`);
  assert.equal((await ipfs(genericAll, ["block", "get", fixture.genericAll[1]])).bytes.toString(), "general IPLD payload\n");
  assert(!captures.generic.all.blocks.some((block) => key(block.cid) === fixture.genericVirtual));
  report.checks.sharedIdentityGenericDAGVerifiedOffline = true;

  const path = `/ipfs/${directoryRoot}/large.bin?format=car&dag-scope=entity`;
  const pathCar = await get(path);
  sameSet((await readCar(pathCar.bytes)).map((block) => key(block.cid)), largeBlocks.keys());
  const baseMultilevel = await get(request(fixture.file, "entity"));
  sameSet((await readCar(baseMultilevel.bytes)).map((block) => key(block.cid)), baseFileExpected.map((block) => key(block.cid)));
  const rawRoot = await get(`/ipfs/${directoryRoot}?format=raw`);
  assert.deepEqual(rawRoot.bytes, largeBlocks.get(key(directoryRoot)).bytes);
  report.checks.pathProofAndRawRegressions = true;
  const missing = CID.createV1(0x55, await sha256.digest(Buffer.from("known-missing-scope-fixture")));
  for (const scope of ["block", "entity", "all"]) {
    await get(request(missing, scope), 404);
    await get(request(missing, scope), 412, { method: "HEAD", headers: { "cache-control": "only-if-cached" } });
  }
  await get(request(directoryRoot, "invalid"), 400);
  await get(request(fileRoot, "entity") + "&entity-bytes=0:10", 400);
  const unknown = CID.createV1(0x129, await sha256.digest(Buffer.from("unsupported codec")));
  await get(request(unknown, "all"), 501, { method: "HEAD" });
  assert.equal(outbound, 0);
  report.checks.upstreamRequestsBeforeClose = outbound;
  await new Promise((done) => upstream.close(done));
  upstreamClosed = true;
  await get(request(fileRoot, "entity"));

  const lastLeaf = [...largeBlocks.values()].filter((block) => block.cid.code === 0x55).at(-1);
  const leafFile = join(data, "blocks", key(lastLeaf.cid));
  await rename(leafFile, leafFile + ".owned-backup");
  try {
    await assert.rejects(async () => { const response = await fetch(url + request(fileRoot), { signal: AbortSignal.timeout(20000) }); await response.arrayBuffer(); });
    await get(request(fileRoot), 404, { method: "HEAD" });
    await get(request(fileRoot), 404, { headers: { "if-none-match": captures.file.all.headers.etag } });
    await get(request(fileRoot), 412, { method: "HEAD", headers: { "cache-control": "only-if-cached" } });
  } finally { await rename(leafFile + ".owned-backup", leafFile); }
  report.checks.missingRequiredDescendantFails = true;
  const incomplete = await archive([fileRoot], captures.file.entity.blocks.filter((block) => !block.cid.equals(lastLeaf.cid)));
  const incompleteRepo = await importCar("incomplete-file", incomplete);
  assert.notEqual((await ipfs(incompleteRepo, ["cat", key(fileRoot)], { allowFailure: true })).code, 0);
  report.checks.parseableIncompleteCarRejectedOffline = true;
  await get(request(fileRoot, "entity"));
  report.checks.restoredContentAndSlotRecovered = true;
  await stop();
  await cli(["config", "set", "server.carGatewayMaxBlocks", "1"]);
  await start(port, source);
  await get(request(fileRoot), 413, { method: "HEAD" });
  report.checks.traversalBudgetRejected = true;
  assert.equal(outbound, 0);
  report.checks.engineUpstreamRequests = outbound;
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  try { await stop(); report.cleanup.push("owned Engine stopped"); }
  catch (error) { report.cleanup.push(String(error)); report.ok = false; process.exitCode = 1; }
  if (upstream && !upstreamClosed) await new Promise((done) => upstream.close(done));
  if (url) {
    try { await fetch(url, { signal: AbortSignal.timeout(1000) }); report.ok = false; process.exitCode = 1; }
    catch (error) {
      if (error.cause?.code === "ECONNREFUSED") report.cleanup.push("owned listener closed");
      else { report.cleanup.push(String(error)); report.ok = false; process.exitCode = 1; }
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, "scope-deployment-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: report.ok, fixture: report.fixture, scopes: report.scopes, checks: report.checks, error: report.error, cleanup: report.cleanup }, null, 2));
}
