import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CarReader } from "@ipld/car/reader";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { fixture, expected, verifyRange, ranges, key, digest } from "./range-proof.mjs";

const root = process.cwd(), home = join(root, "owned-home"), data = join(root, "engine-data");
const bin = fileURLToPath(new URL("./bin.js", import.meta.resolve("@silvermoon-work/task-engine-cli")));
const report = { startedAt: new Date().toISOString(), checks: {}, ranges: {}, commands: [], cleanup: [] };
let active = false, upstream, upstreamClosed = false, outbound = 0, url;
async function command(exe, args, { env = {}, allowFailure = false } = {}) {
  const child = spawn(exe, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = [], err = [];
  child.stdout.on("data", (part) => out.push(part));
  child.stderr.on("data", (part) => err.push(part));
  const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
  const code = await new Promise((done, reject) => {
    child.once("error", reject); child.once("close", done);
  }).finally(() => clearTimeout(timer));
  const bytes = Buffer.concat(out), stderr = Buffer.concat(err).toString();
  report.commands.push({ exe: exe === process.execPath ? "node" : exe, args, code, stdoutBytes: bytes.length });
  if (!allowFailure) assert.equal(code, 0, `${args.join(" ")}\n${stderr.slice(-2000)}`);
  return { code, bytes, stderr };
}
async function cli(args) {
  const result = await command(process.execPath, [bin, ...args], { env: { HOME: home } });
  const value = JSON.parse(result.bytes.toString()); assert.equal(value.ok, true); return value.data;
}
async function stop() {
  if (active) { await cli(["server", "stop", "--data-dir", data, "--cancel-running"]); active = false; }
}
async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done)); return server.address().port;
}
async function freePort() {
  const server = createServer(), port = await listen(server);
  await new Promise((done) => server.close(done)); return port;
}
async function get(path, status = 200, options = {}) {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(20000), ...options });
  assert.equal(response.status, status, `${options.method ?? "GET"} ${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (status !== 200 || options.method === "HEAD") assert.equal(bytes.length, 0);
  return { bytes, headers: Object.fromEntries(response.headers) };
}
async function sequence(bytes) {
  const result = [];
  for await (const block of (await CarReader.fromBytes(bytes)).blocks()) {
    assert.deepEqual(Buffer.from((await sha256.digest(block.bytes)).digest), Buffer.from(block.cid.multihash.digest));
    result.push(key(block.cid));
  }
  return result;
}
try {
  await mkdir(home);
  report.node = process.version;
  report.kubo = (await command("ipfs", ["version"])).bytes.toString().trim();
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.resolve("@silvermoon-work/task-engine-cli"))), "utf8"));
  assert.equal(manifest.version, "0.2.0-rc.4"); report.packageVersion = manifest.version;
  const f = await fixture();
  await command(process.execPath, [join(root, "range-proof.mjs"), "create", "range-fixture"]);
  upstream = createServer((_req, response) => { outbound++; response.writeHead(500).end(); });
  const source = `http://127.0.0.1:${await listen(upstream)}`, port = await freePort();
  url = `http://127.0.0.1:${port}`;
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  await cli(["server", "start", "--data-dir", data, "--port", String(port), "--ipfs-gateway", source]); active = true;
  await stop();
  await command(process.execPath, [join(root, "range-proof.mjs"), "seed", "range-fixture", data]);
  report.instance = await cli(["server", "start", "--data-dir", data, "--port", String(port), "--ipfs-gateway", source]); active = true;
  const path = `/ipfs/${f.root}/deep/file.bin?format=car`;
  const full = await get(path + "&dag-scope=entity");
  assert.deepEqual(await sequence(full.bytes), expected(f, 0, f.whole.length - 1).map(key));
  report.fullFileCarBytes = full.bytes.length;
  for (const [name, [from, to]] of Object.entries(ranges)) {
    const query = name === "tail" ? "-73:*" : `${from}:${to}`;
    const result = await get(path + `&entity-bytes=${query}`);
    const verified = await verifyRange(result.bytes, f, from, to);
    assert(result.bytes.length < full.bytes.length);
    const head = await get(path + `&entity-bytes=${query}`, 200, { method: "HEAD" });
    assert.equal(head.headers.etag, result.headers.etag);
    await get(path + `&entity-bytes=${query}`, 304, { headers: { "if-none-match": result.headers.etag } });
    assert.notEqual(result.headers.etag, full.headers.etag);
    const file = join(root, "range-fixture", `${name}.car`);
    await writeFile(file, result.bytes);
    const repo = join(root, `kubo-${name}`), env = { IPFS_PATH: repo };
    await command("ipfs", ["init", "--empty-repo"], { env });
    await command("ipfs", ["--offline", "dag", "import", "--pin-roots=false", file], { env });
    const recovered = await command("ipfs", ["--offline", "cat", "--offset", String(from), "--length", String(to - from + 1), `/ipfs/${f.root}/deep/file.bin`], { env });
    assert.deepEqual(recovered.bytes, f.whole.subarray(from, to + 1));
    report.ranges[name] = { ...verified, sha256: digest(recovered.bytes), contentType: result.headers["content-type"], etag: result.headers.etag };
  }
  assert(report.ranges.tail.carBytes < full.bytes.length / 4);
  for (const dups of ["n", "y"]) {
    const result = await get(`/ipfs/${f.shared}?format=car&car-dups=${dups}`);
    assert.equal(result.headers["content-type"], `application/vnd.ipld.car; version=1; order=dfs; dups=${dups}`);
    const wanted = dups === "n" ? [f.shared, f.leaves[0], f.leaves[1]] : [f.shared, f.leaves[0], f.leaves[1], f.leaves[0], f.leaves[1]];
    assert.deepEqual(await sequence(result.bytes), wanted.map(key));
    report.checks[`dups-${dups}`] = { cids: wanted.map(key), bytes: result.bytes.length, etag: result.headers.etag };
  }
  assert.notEqual(report.checks["dups-n"].etag, report.checks["dups-y"].etag);
  const preferred = await get(`/ipfs/${f.shared}`, 200, { headers: { accept: "application/vnd.ipld.car;dups=y;q=0.9,application/vnd.ipld.car;dups=n;q=0.1" } });
  assert.match(preferred.headers["content-type"], /dups=y/);
  const override = await get(`/ipfs/${f.shared}?format=car&car-dups=n`, 200, { headers: { accept: "application/vnd.ipld.car;dups=y" } });
  assert.match(override.headers["content-type"], /dups=n/);
  await get(path + "&car-version=2", 406);
  await get(path + "&entity-bytes=bad", 400);
  await get(path + "&entity-bytes=0:1&entity-bytes=2:3", 400);
  await get(`/ipfs/${f.target}?format=car&entity-bytes=${f.whole.length}:*`, 400);
  const beyondPath = await get(path + `&entity-bytes=${f.whole.length}:*`);
  assert.deepEqual(await sequence(beyondPath.bytes), [f.root, f.deep, f.target].map(key));
  const nonbyte = await get(`/ipfs/${f.root}?format=car&entity-bytes=0:1`);
  assert.deepEqual(await sequence(nonbyte.bytes), [key(f.root)]);
  const raw = await get(`/ipfs/${f.root}?format=raw`);
  assert.deepEqual(Buffer.from(raw.bytes), Buffer.from(f.blocks.get(key(f.root))));
  const defaultAll = await get(`/ipfs/${f.root}?format=car`);
  assert.deepEqual(await sequence(defaultAll.bytes), expected(f, 0, f.whole.length - 1).map(key));
  report.checks.negotiationBoundaryAndFullScopeRegressions = true;
  const missing = CID.createV1(0x55, await sha256.digest(Buffer.from("known-missing-range-fixture")));
  await get(`/ipfs/${missing}?format=car`, 404);
  await get(`/ipfs/${missing}?format=car`, 412, { method: "HEAD", headers: { "cache-control": "only-if-cached" } });
  assert.equal(outbound, 0); report.checks.upstreamRequestsBeforeClose = outbound;
  await new Promise((done) => upstream.close(done)); upstreamClosed = true;
  const tailPath = path + "&entity-bytes=-73:*";
  const tailEtag = report.ranges.tail.etag;
  const unrelated = join(data, "blocks", key(f.leaves[0]));
  await rename(unrelated, unrelated + ".owned-backup");
  try { await get(tailPath, 304, { headers: { "if-none-match": tailEtag } }); }
  finally { await rename(unrelated + ".owned-backup", unrelated); }
  const required = join(data, "blocks", key(f.leaves[7]));
  await rename(required, required + ".owned-backup");
  try {
    await assert.rejects(async () => { const response = await fetch(url + tailPath, { signal: AbortSignal.timeout(15000) }); await response.arrayBuffer(); });
    await get(tailPath, 404, { method: "HEAD" });
    await get(tailPath, 412, { headers: { "cache-control": "only-if-cached", "if-none-match": tailEtag } });
  } finally { await rename(required + ".owned-backup", required); }
  await get(tailPath);
  report.checks.requiredVsUnrelatedLeafAndRecovery = true;
  report.checks.engineUpstreamRequests = outbound;
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
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
  await writeFile(join(root, "range-deployment-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: report.ok, fullFileCarBytes: report.fullFileCarBytes, ranges: report.ranges, checks: report.checks, error: report.error, cleanup: report.cleanup }, null, 2));
}
