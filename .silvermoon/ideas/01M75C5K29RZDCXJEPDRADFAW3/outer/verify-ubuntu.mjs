import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskBundle } from "@silvermoon-work/task-builder";
import { encodeTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { directoryTree, writeDirectory, writeStreamFile } from "@silvermoon-work/task-builder-cli/node";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const root = process.cwd();
const bin = fileURLToPath(new URL("./bin.js", import.meta.resolve("@silvermoon-work/task-engine-cli")));
const report = { startedAt: new Date().toISOString(), node: process.version, checks: {}, commands: [], cleanup: [] };
const a = join(root, "engine-a");
const b = join(root, "engine-b");
const homeA = join(root, "home-a");
const homeB = join(root, "home-b");
const started = new Set();
let outbound = 0;
const upstream = createServer((_request, response) => {
  outbound++;
  response.writeHead(500).end();
});
let upstreamClosed = false;

async function cli(args, home = homeA) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 90000);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  const safeArgs = [...args];
  if (args[0] === "config" && args[2] === "server.rawGatewayToken") safeArgs[3] = "<redacted>";
  report.commands.push({ args: safeArgs, code, timedOut });
  assert.equal(timedOut, false, `CLI timeout: ${safeArgs.join(" ")}`);
  assert.equal(code, 0, `CLI failed: ${safeArgs.join(" ")}\n${stderr}\n${args[2] === "server.rawGatewayToken" ? "<redacted>" : stdout}`);
  if (args[0] === "--version") return stdout.trim();
  const response = JSON.parse(stdout);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

async function port() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
async function stop(directory, home) {
  if (!started.has(directory)) return;
  await cli(["server", "stop", "--data-dir", directory, "--cancel-running"], home);
  started.delete(directory);
}
async function start(directory, home, value, gateway) {
  const result = await cli(["server", "start", "--data-dir", directory, "--port", String(value), "--ipfs-gateway", gateway], home);
  started.add(directory);
  const instance = JSON.parse(await readFile(join(directory, "instance.json"), "utf8"));
  assert.ok(Number.isSafeInteger(instance.pid) && instance.pid > 0);
  process.kill(instance.pid, 0);
  return { ...result, pid: instance.pid };
}
async function checkStatus(url, expected, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options });
  assert.equal(response.status, expected, `${options.method ?? "GET"} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (options.method === "HEAD" || expected !== 200) assert.equal(bytes.length, 0);
  return { headers: response.headers, bytes };
}
async function verified(url, value, options = {}) {
  const result = await checkStatus(`${url}/ipfs/${value}?format=raw`, 200, options);
  const cid = CID.parse(value);
  if (cid.multihash.code === 0) assert.deepEqual(result.bytes, Buffer.from(cid.multihash.digest));
  else assert.deepEqual(Buffer.from((await sha256.digest(result.bytes)).digest), Buffer.from(cid.multihash.digest));
  assert.equal(result.headers.get("content-type"), "application/vnd.ipld.raw");
  return result;
}

try {
  await Promise.all([mkdir(homeA), mkdir(homeB)]);
  assert.equal(await cli(["--version"]), "0.2.0-rc.1");
  report.packageVersion = "0.2.0-rc.1";
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const portA = await port(), portB = await port();
  const urlA = `http://127.0.0.1:${portA}`, urlB = `http://127.0.0.1:${portB}`;
  const payload = randomBytes(600000).toString("base64");
  await writeFile(join(root, "entry.ts"),
    `const payload=${JSON.stringify(payload)};\nexport default async (input: {value:string}) => ({echo:input.value,bytes:payload.length,prefix:payload.slice(0,8)});\n`);
  const tree = await buildTaskBundle(await directoryTree(root), {
    name: "Registry raw gateway verification",
    runtime: { minVersion: "22.13.0" },
    source: {
      entry: "entry.ts",
      mode: "callback",
      contract: { input: { type: "object" }, result: true, message: false },
    },
    include: [],
    binary: [],
  });
  const bundleDir = join(root, "bundle");
  await writeDirectory(tree, bundleDir);
  const encoded = await encodeTaskBundleCar(await directoryTree(bundleDir));
  const car = join(root, "bundle.car");
  try { await writeStreamFile(encoded.stream, car); }
  finally { await encoded.close(); }
  report.bundleCid = encoded.cid;
  const input = join(root, "input.json");
  await writeFile(input, JSON.stringify({ value: "ubuntu-registry-independent" }));
  const expected = { echo: "ubuntu-registry-independent", bytes: payload.length, prefix: payload.slice(0, 8) };
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  report.instances = {
    a: await start(a, homeA, portA, upstreamUrl),
    b: await start(b, homeB, portB, urlA),
  };
  assert.notEqual(report.instances.a.pid, report.instances.b.pid);
  const primed = await cli(["run", "--engine", urlA, "--car", car, "--input", input]);
  assert.equal(primed.status, "succeeded");
  assert.deepEqual(primed.output.result, expected);
  const rootResponse = await verified(urlA, encoded.cid);
  await checkStatus(`${urlA}/ipfs/${encoded.cid}?format=raw`, 200, { method: "HEAD" });
  await checkStatus(`${urlA}/ipfs/${encoded.cid}?format=raw`, 304, { headers: { "if-none-match": rootResponse.headers.get("etag") } });
  await verified(urlA, "bafkqaaa");
  await checkStatus(`${urlA}/ipfs/bafkqaaa?format=raw`, 200, { method: "HEAD" });
  const missing = CID.createV1(0x55, await sha256.digest(Buffer.from("known-missing-raw-gateway-rc1"))).toString();
  for (const method of ["GET", "HEAD"]) {
    await checkStatus(`${urlA}/ipfs/${missing}?format=raw`, 404, { method });
    await checkStatus(`${urlA}/ipfs/${missing}?format=raw`, 412, { method, headers: { "cache-control": "only-if-cached" } });
  }
  assert.equal(outbound, 0);
  report.checks.upstreamRequestsBeforeClose = outbound;
  await new Promise((done) => upstream.close(done));
  upstreamClosed = true;
  await checkStatus(`${urlB}/ipfs/${encoded.cid}?format=raw`, 404);
  const executed = await cli(["run", "--engine", urlB, "--cid", encoded.cid, "--input", input], homeB);
  assert.equal(executed.status, "succeeded");
  assert.deepEqual(executed.output.result, expected);
  report.checks.independentResult = executed.output;
  const blockNames = await readdir(join(a, "blocks"));
  assert.ok(blockNames.length >= 5, "Fixture must exercise multi-block content");
  for (const name of blockNames) {
    const raw = await verified(urlA, name);
    assert.deepEqual(raw.bytes, await readFile(join(b, "blocks", name)));
  }
  report.checks.verifiedBundleBlocks = blockNames.length;
  await verified(urlA, primed.output.cid);
  report.checks.persistentOutputRootVerified = true;
  report.checks.upstreamRequestsAfterClose = outbound;
  report.checks.defaultDisabled = true;
  report.checks.headProbeConditionalAndMisses = true;

  const rootFile = join(a, "blocks", CID.parse(encoded.cid).toV1().toString());
  const saved = await readFile(rootFile);
  try {
    await writeFile(rootFile, "deliberately-corrupt-owned-fixture");
    await checkStatus(`${urlA}/ipfs/${encoded.cid}?format=raw`, 500);
  } finally { await writeFile(rootFile, saved); }
  report.checks.corruptionRejected = true;
  await stop(a, homeA);
  const token = randomBytes(32).toString("base64url");
  await cli(["config", "set", "server.rawGatewayToken", token]);
  await cli(["config", "set", "server.rawGatewayAccess", "token"]);
  await start(a, homeA, portA, upstreamUrl);
  await checkStatus(`${urlA}/ipfs/${encoded.cid}?format=raw`, 401);
  await checkStatus(`${urlA}/ipfs/${missing}?format=raw`, 401);
  const authorized = await verified(urlA, encoded.cid, { headers: { authorization: `Bearer ${token}` } });
  assert.match(authorized.headers.get("cache-control"), /^private,/);
  report.checks.tokenAuthorization = true;
  await stop(a, homeA);
  await cli(["config", "reset", "server.rawGatewayToken"]);
  await cli(["config", "reset", "server.rawGatewayAccess"]);
  await start(a, homeA, portA, upstreamUrl);
  await checkStatus(`${urlA}/ipfs/${encoded.cid}?format=raw`, 404);
  report.checks.explicitDisabled = true;
  await stop(a, homeA);
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  await cli(["config", "set", "server.rawGatewayMaxBlockBytes", "32"]);
  await start(a, homeA, portA, upstreamUrl);
  await checkStatus(`${urlA}/ipfs/${encoded.cid}?format=raw`, 413);
  report.checks.blockByteBudget = true;
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  process.exitCode = 1;
} finally {
  for (const [directory, home] of [[b, homeB], [a, homeA]]) {
    try { await stop(directory, home); report.cleanup.push({ instance: directory, stopped: true }); }
    catch (error) { report.cleanup.push({ instance: directory, stopped: false, error: String(error) }); report.ok = false; process.exitCode = 1; }
  }
  if (!upstreamClosed) await new Promise((done) => upstream.close(done));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, "smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
