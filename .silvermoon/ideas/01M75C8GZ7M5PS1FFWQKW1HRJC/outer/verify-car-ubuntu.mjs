import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskBundle } from "@silvermoon-work/task-builder";
import { encodeTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { directoryTree, writeDirectory, writeStreamFile } from "@silvermoon-work/task-builder-cli/node";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const root = process.cwd();
const home = join(root, "owned-home");
const data = join(root, "owned-engine");
const bin = fileURLToPath(new URL("./bin.js", import.meta.resolve("@silvermoon-work/task-engine-cli")));
const media = "application/vnd.ipld.car; version=1; order=dfs; dups=n";
const report = { startedAt: new Date().toISOString(), checks: {}, proofs: {}, commands: [], cleanup: [] };
let engineStarted = false, upstream, upstreamClosed = false, outbound = 0, url;
const canonical = (cid) => cid.toV1().toString();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function command(exe, args, { env = {}, allowFailure = false, timeout = 90000 } = {}) {
  const child = spawn(exe, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  child.stdout.on("data", (part) => stdout.push(part));
  child.stderr.on("data", (part) => stderr.push(part));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  const bytes = Buffer.concat(stdout), error = Buffer.concat(stderr).toString();
  const safe = [...args];
  if (safe[3] === "server.rawGatewayToken") safe[4] = "<redacted>";
  report.commands.push({ exe: exe === process.execPath ? "node" : exe, args: safe, code, timedOut });
  if (!allowFailure) {
    assert.equal(timedOut, false, `Command timed out: ${safe.join(" ")}`);
    assert.equal(code, 0, `Command failed: ${safe.join(" ")}\n${error.slice(-2000)}`);
  }
  return { code, bytes, stderr: error };
}
async function cli(args) {
  const result = await command(process.execPath, [bin, ...args], { env: { HOME: home } });
  const parsed = JSON.parse(result.bytes.toString());
  assert.equal(parsed.ok, true);
  return parsed.data;
}
async function stop() {
  if (!engineStarted) return;
  await cli(["server", "stop", "--data-dir", data, "--cancel-running"]);
  engineStarted = false;
}
async function start(port, source) {
  const result = await cli(["server", "start", "--data-dir", data, "--port", String(port), "--ipfs-gateway", source]);
  engineStarted = true;
  const instance = JSON.parse(await readFile(join(data, "instance.json"), "utf8"));
  process.kill(instance.pid, 0);
  return { ...result, pid: instance.pid };
}
async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return server.address().port;
}
async function port() {
  const server = createServer();
  const value = await listen(server);
  await new Promise((done) => server.close(done));
  return value;
}
async function response(path, expected, options = {}) {
  const result = await fetch(url + path, { signal: AbortSignal.timeout(20000), ...options });
  assert.equal(result.status, expected, `${options.method ?? "GET"} ${path}`);
  const bytes = new Uint8Array(await result.arrayBuffer());
  if (options.method === "HEAD" || expected !== 200) assert.equal(bytes.length, 0);
  return { bytes, headers: Object.fromEntries(result.headers) };
}
const pathFor = (cid, path = "") => `/ipfs/${cid}${path ? "/" + path.split("/").map(encodeURIComponent).join("/") : ""}`;
const carFor = (cid, path = "") => pathFor(cid, path) + "?format=car&dag-scope=block";

async function blocksOf(bytes) {
  const reader = await CarReader.fromBytes(bytes);
  assert.equal(reader.version, 1);
  const blocks = [];
  for await (const block of reader.blocks()) {
    assert.equal(block.cid.multihash.code, sha256.code);
    assert.deepEqual(Buffer.from((await sha256.digest(block.bytes)).digest), Buffer.from(block.cid.multihash.digest));
    blocks.push(block);
  }
  return blocks;
}
async function verify(bytes, requestRoot, path) {
  const blocks = await blocksOf(bytes);
  const stored = new Map(blocks.map((block) => [canonical(block.cid), block.bytes]));
  let cid = CID.parse(requestRoot);
  const required = [];
  for (const segment of [...(path ? path.split("/") : []), undefined]) {
    const key = canonical(cid);
    required.push(key);
    const block = stored.get(key);
    assert.ok(block, `Proof missing ${key}`);
    if (segment === undefined) break;
    assert.equal(cid.code, dagPb.code);
    const link = dagPb.decode(block).Links.find((link) => link.Name === segment);
    assert.ok(link, `Proof missing named edge ${segment}`);
    cid = link.Hash;
  }
  assert.deepEqual(blocks.map((block) => canonical(block.cid)), required, "Must contain exact root-to-terminal path, no unrelated blocks");
  return { blocks, required, terminal: cid };
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
async function kuboVerify(label, bytes, requestRoot, path, shouldPass = true) {
  const repo = join(root, `kubo-${label}`);
  const file = join(root, `${label}.car`);
  await writeFile(file, bytes);
  const env = { IPFS_PATH: repo };
  await command("ipfs", ["init", "--empty-repo"], { env });
  const imported = await command("ipfs", ["--offline", "dag", "import", "--pin-roots=false", file], { env, allowFailure: !shouldPass });
  const resolved = await command("ipfs", ["--offline", "resolve", `/ipfs/${requestRoot}/${path}`], { env, allowFailure: !shouldPass });
  let exists = false, terminal;
  if (resolved.code === 0) {
    terminal = resolved.bytes.toString().trim().split("/").at(-1);
    const found = await command("ipfs", ["--offline", "block", "get", terminal], { env, allowFailure: !shouldPass });
    exists = found.code === 0;
  }
  if (shouldPass) {
    assert.equal(imported.code, 0);
    assert.equal(resolved.code, 0);
    assert(exists, "Resolved endpoint must also be present");
  } else assert(imported.code !== 0 || resolved.code !== 0 || !exists, "Incomplete proof accepted by isolated Kubo");
  return { imported: imported.code, resolved: resolved.code, terminalPresent: exists, terminal };
}
async function rawBytes(cid) {
  return (await response(pathFor(cid) + "?format=raw", 200)).bytes;
}

try {
  await mkdir(home);
  report.node = process.version;
  report.kubo = (await command("ipfs", ["version"])).bytes.toString().trim();
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.resolve("@silvermoon-work/task-engine-cli"))), "utf8"));
  assert.equal(manifest.version, "0.2.0-rc.2");
  report.packageVersion = manifest.version;
  const payload = randomBytes(3000000);
  await writeFile(join(root, "worker.ts"), `
import {Buffer} from "node:buffer";
const bytes=Buffer.from(${JSON.stringify(payload.toString("base64"))},"base64");
export default async (input,context)=>{
 let offset=0;
 await context.output.write("/nested/deep/payload.bin",new ReadableStream({
  pull(controller){if(offset===bytes.length){controller.close();return;}
  const end=Math.min(offset+262144,bytes.length);controller.enqueue(bytes.subarray(offset,end));offset=end;}
 }));
 return {echo:input.value,bytes:bytes.length};
};`);
  await mkdir(join(root, "assets", "nested"), { recursive: true });
  await writeFile(join(root, "assets", "nested", "proof.txt"), "CAR proof resource");
  const tree = await buildTaskBundle(await directoryTree(root), {
    name: "Registry CAR path proof verification",
    runtime: { minVersion: "22.13.0" },
    source: { entry: "worker.ts", mode: "callback", contract: { input: { type: "object" }, result: true, message: false } },
    include: [{ from: "assets/**", to: "resources/" }], binary: [],
  });
  const bundleDir = join(root, "bundle");
  await writeDirectory(tree, bundleDir);
  const encoded = await encodeTaskBundleCar(await directoryTree(bundleDir));
  try { await writeStreamFile(encoded.stream, join(root, "bundle.car")); }
  finally { await encoded.close(); }
  report.bundleCid = encoded.cid;
  await writeFile(join(root, "input.json"), '{"value":"independent-car-path"}');
  upstream = createServer((_req, res) => { outbound++; res.writeHead(500).end(); });
  const source = `http://127.0.0.1:${await listen(upstream)}`;
  const enginePort = await port();
  url = `http://127.0.0.1:${enginePort}`;
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  report.instance = await start(enginePort, source);
  report.task = await cli(["run", "--engine", url, "--car", join(root, "bundle.car"), "--input", join(root, "input.json")]);
  assert.equal(report.task.status, "succeeded");
  assert.deepEqual(report.task.output.result, { echo: "independent-car-path", bytes: payload.length });
  report.outputCid = report.task.output.cid;
  assert.equal(outbound, 0);
  const proofs = {};
  for (const [label, cid, path] of [
    ["bundle", report.bundleCid, "resources/nested/proof.txt"],
    ["output", report.outputCid, "nested/deep/payload.bin"],
  ]) {
    const result = await response(carFor(cid, path), 200);
    assert.equal(result.headers["content-type"], media);
    assert.match(result.headers["content-disposition"], /^attachment;/);
    const proof = await verify(result.bytes, cid, path);
    assert.equal(proof.blocks.length, 4);
    for (const block of proof.blocks) assert.deepEqual(await rawBytes(block.cid), block.bytes);
    const head = await response(carFor(cid, path), 200, { method: "HEAD" });
    assert.equal(head.headers.etag, result.headers.etag);
    await response(carFor(cid, path), 304, { headers: { "if-none-match": result.headers.etag } });
    const independent = await kuboVerify(label, result.bytes, cid, path);
    assert.equal(canonical(CID.parse(independent.terminal)), canonical(proof.terminal));
    proofs[label] = { ...proof, bytes: result.bytes, path, root: cid };
    report.proofs[label] = {
      requestRoot: cid, path, blockCount: proof.blocks.length, cids: proof.required,
      carBytes: result.bytes.length, carSha256: hash(result.bytes), terminal: canonical(proof.terminal),
      kubo: independent, headers: result.headers,
    };
  }
  const terminal = proofs.output.blocks.at(-1);
  assert.equal(terminal.cid.code, dagPb.code);
  const children = dagPb.decode(terminal.bytes).Links;
  assert(children.length > 1, "Output fixture must have a multi-block payload DAG");
  assert(children.every((link) => !proofs.output.required.includes(canonical(link.Hash))));
  report.checks.blockScopeExcludesPayloadDescendants = children.length;

  const original = proofs.bundle;
  await assert.rejects(verify(original.bytes.subarray(0, original.bytes.length - 1), original.root, original.path));
  for (const [label, blocks] of [
    ["missing-parent", original.blocks.filter((_block, index) => index !== 1)],
    ["missing-terminal", original.blocks.slice(0, -1)],
  ]) {
    const bytes = await archive([CID.parse(original.root)], blocks);
    await assert.rejects(verify(bytes, original.root, original.path));
    report.checks[label] = await kuboVerify(label, bytes, original.root, original.path, false);
  }
  const foreignBytes = Buffer.from("unrelated valid raw block");
  const foreign = { cid: CID.createV1(0x55, await sha256.digest(foreignBytes)), bytes: foreignBytes };
  const replaced = await archive([CID.parse(original.root)], [...original.blocks.slice(0, -1), foreign]);
  await assert.rejects(verify(replaced, original.root, original.path));
  const tampered = await archive([CID.parse(original.root)], original.blocks.map((block, index) => index === 1 ? { ...block, bytes: Uint8Array.of(255) } : block));
  await assert.rejects(verify(tampered, original.root, original.path));
  const misleading = await archive([foreign.cid], original.blocks);
  await verify(misleading, original.root, original.path);
  await assert.rejects(verify(misleading, canonical(foreign.cid), original.path));
  report.checks.independentNegativeProofs = ["truncated", "missing-parent", "missing-terminal", "replaced-terminal", "tampered-bytes", "wrong-trust-root"];
  report.checks.carHeaderRootsNotTrusted = true;
  const probe = await response("/ipfs/bafkqaaa?format=car", 200);
  assert.equal((await blocksOf(probe.bytes)).length, 0);
  await response("/ipfs/bafkqaaa?format=car", 200, { method: "HEAD" });
  const rootOnly = await response(carFor(report.bundleCid), 200);
  assert.equal((await verify(rootOnly.bytes, report.bundleCid, "")).blocks.length, 1);
  const missing = CID.createV1(0x55, await sha256.digest(Buffer.from("known-missing-car-rc2")));
  for (const method of ["GET", "HEAD"]) {
    await response(carFor(missing), 404, { method });
    await response(carFor(missing), 412, { method, headers: { "cache-control": "only-if-cached" } });
  }
  await response(pathFor(report.bundleCid) + "?format=car", 400);
  await response(pathFor(report.bundleCid) + "?format=car&dag-scope=all", 400);
  await response(pathFor(report.bundleCid) + "?format=car&dag-scope=entity", 400);
  await response(carFor(report.bundleCid) + "&car-version=2", 406);
  await response(carFor(report.bundleCid) + "&car-dups=y", 406);
  await response(carFor(report.bundleCid) + "&entity-bytes=0:1", 400);
  await response(pathFor(report.bundleCid) + "?dag-scope=block", 200, { headers: { accept: media } });
  report.checks.headProbeConditionsNegotiationAndMisses = true;
  assert.equal(outbound, 0);
  report.checks.upstreamRequestsBeforeClose = outbound;
  await new Promise((done) => upstream.close(done));
  upstreamClosed = true;
  await response(carFor(report.bundleCid, original.path), 200);
  report.checks.closedUpstreamStillServes = true;

  const parentFile = join(data, "blocks", original.required[1]);
  await rename(parentFile, parentFile + ".owned-backup");
  try {
    await assert.rejects(async () => {
      const result = await fetch(url + carFor(original.root, original.path), { signal: AbortSignal.timeout(15000) });
      await result.arrayBuffer();
    });
    await response(carFor(original.root, original.path), 404, { method: "HEAD" });
    await response(carFor(original.root, original.path), 404, { headers: { "if-none-match": "*" } });
  } finally { await rename(parentFile + ".owned-backup", parentFile); }
  report.checks.missingChildAbortsTransport = true;
  await response(carFor(original.root, original.path), 200);
  report.checks.slotRecoveredAfterFailure = true;
  await stop();
  const token = randomBytes(32).toString("base64url");
  await cli(["config", "set", "server.rawGatewayToken", token]);
  await cli(["config", "set", "server.rawGatewayAccess", "token"]);
  await start(enginePort, source);
  await response(carFor(original.root, original.path), 401);
  const secured = await response(carFor(original.root, original.path), 200, { headers: { authorization: `Bearer ${token}` } });
  assert.match(secured.headers["cache-control"], /^private,/);
  await stop();
  await cli(["config", "reset", "server.rawGatewayToken"]);
  await cli(["config", "reset", "server.rawGatewayAccess"]);
  await start(enginePort, source);
  await response(carFor(original.root, original.path), 404);
  await stop();
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  await cli(["config", "set", "server.carGatewayMaxBlocks", "1"]);
  await start(enginePort, source);
  await response(carFor(original.root, original.path), 413, { method: "HEAD" });
  report.checks.authDisabledAndTraversalBudget = true;
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
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      report.ok = false; report.cleanup.push("owned listener unexpectedly open"); process.exitCode = 1;
    } catch (error) {
      if (error.cause?.code === "ECONNREFUSED") report.cleanup.push("owned listener closed");
      else { report.ok = false; report.cleanup.push(`unexpected listener check: ${error}`); process.exitCode = 1; }
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, "car-deployment-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks, proofs: report.proofs, error: report.error, cleanup: report.cleanup }, null, 2));
}
