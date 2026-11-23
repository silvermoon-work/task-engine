import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Fixed before execution: no adaptive budgets, server-clock changes or private-key files.
const policy = Object.freeze({
  commandMs: 45_000, requestMs: 5000, shortLifetimeMs: 15_000,
  expiryWaitMs: 20_000, gatewayConcurrent: 2, gatewayTimeoutMs: 5000,
});
const args = process.argv.slice(2);
const expectedVersion = args[args.indexOf("--expected-version") + 1];
assert.ok(args.includes("--expected-version") && /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(expectedVersion),
  "Pass --expected-version <exact installed CLI version>.");
assert.ok(args.every((arg, index) =>
  ["--expected-version", "--kubo", "--source"].includes(arg) ||
  ["--expected-version", "--kubo"].includes(args[index - 1])), "Unknown replay argument.");
const require = createRequire(resolve("package.json"));
const consumerManifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const findPackage = (name) => consumerManifest.name === name ? process.cwd()
  : (require.resolve.paths(name) ?? []).map((path) => join(path, name))
    .find((path) => existsSync(join(path, "package.json")));
const dependencyVersions = {
  ipns: "11.0.1", "@libp2p/crypto": "5.2.0", "@libp2p/peer-id": "6.0.18", multiformats: "14.0.5",
};
for (const [name, expected] of Object.entries(dependencyVersions)) {
  const root = findPackage(name);
  assert.ok(root, `Install consumer dependency ${name}@${expected}.`);
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, expected);
}
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const { generateKeyPair } = await load("@libp2p/crypto/keys");
const { peerIdFromPublicKey } = await load("@libp2p/peer-id");
const { base36 } = await load("multiformats/bases/base36");
const { createIPNSRecordWithExpiration, marshalIPNSRecord, multihashToIPNSRoutingKey } = await load("ipns");
const { ipnsValidator } = await load("ipns/validator");
const packageRoot = findPackage("@silvermoon-work/task-engine-cli");
assert.ok(packageRoot, "Install the exact CLI into the current consumer directory first.");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.version, expectedVersion);
const source = args.includes("--source");
if (!source) assert.ok(packageRoot.includes("node_modules"), "Registry replay must use an installed consumer package; use --source only for source-local evidence.");
const exec = promisify(execFile);
const directory = resolve(".cache", `ipns-record-replay-${randomUUID()}`);
const data = join(directory, "instance");
const env = { ...process.env, HOME: directory, LOCALAPPDATA: join(directory, "config"), IPFS_PATH: join(directory, "unused-kubo") };
const cli = async (argv, ok = true) => {
  let stdout;
  let code = 0;
  try {
    ({ stdout } = await exec(process.execPath, [join(packageRoot, "dist", "bin.js"), ...argv],
      { env, timeout: policy.commandMs, maxBuffer: 1_048_576 }));
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    code = error.code;
    stdout = error.stdout;
  }
  const result = JSON.parse(stdout);
  assert.equal(code === 0, ok, `${argv.slice(0, 2).join(" ")}: ${JSON.stringify(result)}`);
  assert.equal(result.ok, ok);
  return result;
};
const server = createServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const origin = `http://127.0.0.1:${port}`;
const privateKey = await generateKeyPair("Ed25519");
const peer = peerIdFromPublicKey(privateKey.publicKey);
const key = peer.toCID().toString(base36);
const wrongPeer = peerIdFromPublicKey((await generateKeyPair("Ed25519")).publicKey);
const wrongKey = wrongPeer.toCID().toString(base36);
const record = async (sequence, lifetimeMs, v1Compatible = false) => {
  const until = Date.now() + lifetimeMs;
  const bytes = marshalIPNSRecord(await createIPNSRecordWithExpiration(
    privateKey, "/ipfs/bafkqaaa", sequence, new Date(until).toISOString(),
    { v1Compatible, ttlNs: 1_800_000_000_000n }));
  const file = join(directory, `record-${sequence}.ipns-record`);
  await writeFile(file, bytes);
  return { bytes, file, until };
};
const importRecord = (record, name = key, ok = true) =>
  cli(["data", "import-ipns", "--data-dir", data, "--key", name, "--record", record.file], ok);
const start = () => cli(["server", "start", "--data-dir", data, "--port", String(port)]);
const stop = () => cli(["server", "stop", "--data-dir", data, "--cancel-running"]);
const get = (suffix = "?format=ipns-record", init) =>
  fetch(`${origin}/ipns/${key}${suffix}`, { ...init, signal: AbortSignal.timeout(policy.requestMs) });
const checks = [];
let stopped = true;
let kubo = { status: "not-requested" };
let inspect;
await mkdir(directory, { recursive: true });
try {
if (args.includes("--kubo")) {
  const executable = args[args.indexOf("--kubo") + 1];
  assert.ok(executable && !executable.startsWith("--"), "--kubo requires an executable path.");
  const help = await exec(executable, ["name", "inspect", "--help"], { env, timeout: policy.commandMs });
  assert.match(help.stdout, /--verify/);
  const version = (await exec(executable, ["version", "--number"], { env, timeout: policy.commandMs })).stdout.trim();
  kubo = { status: "capable", version, checks: 0 };
  inspect = async (name, file, valid) => {
    const { stdout } = await exec(executable,
      ["name", "inspect", "--enc=json", "--dump=false", `--verify=${name}`, file],
      { env, timeout: policy.commandMs, maxBuffer: 1_048_576 });
    const result = JSON.parse(stdout);
    // Kubo inspect exits zero for invalid signatures; never mistake that for validation.
    assert.equal(result.Validation?.Valid, valid, stdout);
    kubo.checks++;
  };
}
  await start(); stopped = false;
  assert.equal((await get()).status, 404);
  await stop(); stopped = true;
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  await cli(["config", "set", "server.rawGatewayMaxConcurrent", String(policy.gatewayConcurrent)]);
  await cli(["config", "set", "server.rawGatewayTimeoutMs", String(policy.gatewayTimeoutMs)]);
  const older = await record(0, 180_000, true);
  const first = await record(1, 180_000);
  await importRecord(older);
  await importRecord(first);
  assert.equal((await importRecord(older, key, false)).error.code, "IPNS_RECORD_ROLLBACK");
  await importRecord(first, wrongKey, false);
  const tampered = { file: join(directory, "tampered.ipns-record") };
  const damaged = Uint8Array.from(first.bytes);
  damaged[2] ^= 1;
  await writeFile(tampered.file, damaged);
  await importRecord(tampered, key, false);
  await assert.rejects(ipnsValidator(multihashToIPNSRoutingKey(wrongPeer.toMultihash()), first.bytes));
  await assert.rejects(ipnsValidator(multihashToIPNSRoutingKey(peer.toMultihash()), damaged));
  await inspect?.(key, first.file, true);
  await inspect?.(wrongKey, first.file, false);
  await inspect?.(key, tampered.file, false);
  await start(); stopped = false;
  const busy = await importRecord(first, key, false);
  assert.equal(busy.error.code, "DATA_IN_USE");
  const response = await get();
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(bytes, first.bytes);
  await ipnsValidator(multihashToIPNSRoutingKey(peer.toMultihash()), bytes);
  const received = join(directory, "received.ipns-record");
  await writeFile(received, bytes);
  await inspect?.(key, received, true);
  const etag = response.headers.get("etag");
  assert.ok(etag);
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(response.headers.get("content-type"), "application/vnd.ipfs.ipns-record");
  assert.equal((await get("", { headers: { accept: "application/vnd.ipfs.ipns-record" } })).status, 200);
  assert.equal((await get("?format=raw")).status, 406);
  const head = await get(undefined, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await get(undefined, { headers: { "if-none-match": etag } })).status, 304);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  checks.push("offline provision, default disabled, original bytes, independent request-key validation, wrong-key/tamper rejection, busy import, GET/HEAD/Accept/ETag/CORS");
  await stop(); stopped = true;
  const short = await record(2, policy.shortLifetimeMs);
  await importRecord(short);
  await start(); stopped = false;
  const updated = await get();
  assert.equal(updated.status, 200);
  assert.deepEqual(new Uint8Array(await updated.arrayBuffer()), short.bytes);
  const shortEtag = updated.headers.get("etag");
  assert.notEqual(shortEtag, etag);
  const age = Number(/max-age=(\d+)/.exec(updated.headers.get("cache-control"))?.[1]);
  assert.ok(age >= 0 && age <= Math.floor((short.until - Date.now()) / 1000) + 1);
  await stop(); stopped = true;
  assert.equal((await importRecord(first, key, false)).error.code, "IPNS_RECORD_ROLLBACK");
  await start(); stopped = false;
  assert.equal((await get(undefined, { headers: { "if-none-match": shortEtag } })).status, 304);
  const delay = Math.max(0, short.until - Date.now() + 150);
  assert.ok(delay <= policy.expiryWaitMs);
  await new Promise((done) => setTimeout(done, delay));
  for (const method of ["GET", "HEAD"]) {
    const expired = await get(undefined, { method, headers: { "if-none-match": shortEtag } });
    assert.equal(expired.status, 404);
    assert.equal(expired.headers.get("etag"), null);
    assert.equal(expired.headers.get("cache-control"), "no-store");
  }
  await assert.rejects(ipnsValidator(multihashToIPNSRoutingKey(peer.toMultihash()), short.bytes));
  await inspect?.(key, short.file, false);
  await stop(); stopped = true;
  assert.equal((await importRecord(first, key, false)).error.code, "IPNS_RECORD_ROLLBACK");
  const latest = await record(3, 180_000);
  await importRecord(latest);
  await start(); stopped = false;
  const final = await get();
  assert.equal(final.status, 200);
  assert.deepEqual(new Uint8Array(await final.arrayBuffer()), latest.bytes);
  await stop(); stopped = true;
  checks.push("higher sequence, restart, real 15s expiry, clipped caching, no expired 200/304, expired newer rollback boundary, valid recovery");
} finally {
  if (!stopped) { await stop(); stopped = true; }
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({
  ok: true, mode: source ? "source-local" : "registry-consumer",
  cliVersion: manifest.version, dependencyVersions, node: process.version, policy, key, checks, kubo,
  cleanup: { instanceStopped: stopped, ownedDirectoryRemoved: true, privateKeyFiles: 0 },
}));
