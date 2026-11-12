import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const work = resolve(process.cwd());
assert.match(basename(work), /^task-engine-ipfs-rc-smoke-/);
assert.equal(process.platform, "linux");
const author = join(work, "author");
const consumer = join(work, "consumer");
const runtime = join(work, "runtime");
const cliHome = join(work, "cli-home");
const expected = {
  "task-builder": "0.2.0-rc.1",
  "task-builder-cli": "0.2.0-rc.1",
  "task-engine": "0.2.0-rc.1",
  "task-engine-cli": "0.2.0-rc.9",
};
const cliEnv = {
  ...process.env,
  HOME: cliHome,
  XDG_CONFIG_HOME: join(cliHome, "config"),
  LOCALAPPDATA: join(cliHome, "config"),
};
const redact = (value) => String(value).replaceAll(work, "<work>").replaceAll(homedir(), "<home>");
const report = {
  startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, architecture: process.arch,
};
async function command(binary, args, options = {}) {
  const { expectedCode = 0, ...selected } = options;
  const began = Date.now();
  let response;
  let code = 0;
  try {
    response = await execute(binary, args, {
      cwd: work, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...selected,
    });
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    code = error.code;
    response = { stdout: error.stdout, stderr: error.stderr };
  }
  await appendFile(join(work, "commands.jsonl"), JSON.stringify({
    command: binary === process.execPath ? "node" : binary,
    observedAt: new Date().toISOString(),
    args: args.map(redact), code, durationMs: Date.now() - began,
    stdout: redact(response.stdout), stderr: redact(response.stderr),
  }) + "\n");
  assert.equal(code, expectedCode, redact(response.stdout + response.stderr));
  return {
    ...response, code,
    json: () => JSON.parse(response.stdout),
  };
}
async function installed(directory, id) {
  const root = join(directory, "node_modules", "@silvermoon-work", id);
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  assert.ok((await realpath(root)).startsWith(directory + sep));
  const manifest = JSON.parse(await readFile(join(root, "package.json")));
  const lock = JSON.parse(await readFile(join(directory, "package-lock.json")));
  const locked = lock.packages[`node_modules/@silvermoon-work/${id}`];
  assert.equal(manifest.version, expected[id]);
  assert.equal(locked.version, expected[id]);
  assert.match(locked.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.ok(locked.integrity);
  return {
    root, manifest,
    evidence: {
      name: manifest.name, version: manifest.version, path: relative(work, root),
      resolved: locked.resolved, integrity: locked.integrity,
    },
  };
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function exited(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
async function until(read) {
  const end = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("部署进程退出观察超时。");
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function cjsFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await cjsFiles(path));
    else if (entry.name.endsWith(".cjs")) result.push(relative(work, path));
  }
  return result;
}
for (const directory of [author, consumer, runtime, cliHome])
  await mkdir(directory, { recursive: true });
await writeFile(join(author, "package.json"), JSON.stringify({
  name: "registry-ipfs-smoke-author", private: true, type: "module",
}));
await writeFile(join(consumer, "package.json"), JSON.stringify({
  name: "registry-ipfs-smoke-consumer", private: true, type: "module",
}));
report.npm = (await command("npm", ["--version"])).stdout.trim();
report.registry = (await command("npm", ["config", "get", "registry"])).stdout.trim();
assert.equal(report.registry, "https://registry.npmjs.org/");
await command("npm", [
  "--cache", "./npm-cache", "--prefix", "./author", "install", "--ignore-scripts",
  "--include=optional", "--no-audit", "--no-fund", "--save-exact",
  "@silvermoon-work/task-builder@0.2.0-rc.1",
  "@silvermoon-work/task-builder-cli@0.2.0-rc.1",
  "@silvermoon-work/task-sdk@0.2.0-rc.0",
], { timeout: 600_000 });
await command("npm", [
  "--cache", "./npm-cache", "--prefix", "./consumer", "install", "--ignore-scripts",
  "--include=optional", "--no-audit", "--no-fund", "--save-exact",
  "@silvermoon-work/task-engine@0.2.0-rc.1",
  "@silvermoon-work/task-engine-cli@0.2.0-rc.9",
], { timeout: 600_000 });
const packages = {};
for (const [id] of Object.entries(expected))
  packages[id] = await installed(id.startsWith("task-builder") ? author : consumer, id);
report.packages = Object.values(packages).map((value) => value.evidence);
const graph = (await command("npm", [
  "--prefix", "./consumer", "ls", "--omit=dev", "--all", "--json",
])).json();
const graphNames = new Set();
function visitGraph(value) {
  for (const [name, dependency] of Object.entries(value.dependencies ?? {})) {
    graphNames.add(name);
    visitGraph(dependency);
  }
}
visitGraph(graph);
for (const name of ["task-builder", "task-builder-cli", "task-sdk"])
  assert.equal(graphNames.has(`@silvermoon-work/${name}`), false);
report.consumerSilvermoonGraph = [...graphNames].filter((name) =>
  name.startsWith("@silvermoon-work/")).sort();
report.engineRuntimeDependencies = Object.keys(packages["task-engine"].manifest.dependencies).sort();
await writeFile(join(work, "consumer-install-graph.json"), JSON.stringify(graph, null, 2));
const builderPackage = packages["task-builder-cli"];
const builderBin = join(builderPackage.root, builderPackage.manifest.bin["task-builder"]);
const enginePackage = packages["task-engine-cli"];
const engineBin = join(enginePackage.root, enginePackage.manifest.bin["task-engine"]);
assert.equal((await command(process.execPath, [builderBin, "--version"])).stdout.trim(), expected["task-builder-cli"]);
assert.equal((await command(process.execPath, [engineBin, "--version"])).stdout.trim(), expected["task-engine-cli"]);
const cli = (args, options) => command(process.execPath, [engineBin, ...args], {
  env: cliEnv, ...options,
});
await mkdir(join(author, "src"), { recursive: true });
await mkdir(join(author, "assets"), { recursive: true });
await writeFile(join(author, "assets", "payload.bin"), Buffer.alloc(600_000, 42));
await writeFile(join(author, "contract.json"), JSON.stringify({
  input: { type: "object" }, result: true, message: false,
}));
await writeFile(join(author, "src", "main.ts"), `
globalThis.ipfsSmokeEvaluations = (globalThis.ipfsSmokeEvaluations ?? 0) + 1;
export default async (input, context) => {
  const moduleURL = import.meta.url;
  const cid = __filename.slice(7, -11);
  const receipt = await context.log({level: "info", message: "ipfs-entry:" + input.mode});
  await context.progress({stage: "execution", message: "ipfs-entry:" + input.mode});
  if (input.mode === "block") { for (;;) {} }
  if (input.mode === "wait") {
    if (!context.signal.aborted)
      await new Promise(resolve => context.signal.addEventListener("abort", resolve, {once: true}));
    return {cancelled: context.signal.aborted, moduleURL};
  }
  const first = Reflect.apply(module.require, module, [__filename]);
  const second = Reflect.apply(module.require, module, [__filename]);
  let nativeIPFSResolve;
  try { nativeIPFSResolve = require.resolve(__filename); }
  catch (error) { nativeIPFSResolve = error.code; }
  const result = {
    moduleURL, filename: __filename, dirname: __dirname,
    evaluations: globalThis.ipfsSmokeEvaluations,
    sameSelf: first === second && first === require.cache[__filename].exports,
    cached: require.cache[__filename] === module,
    requireType: typeof require, cacheType: typeof require.cache,
    resolveType: typeof require.resolve, pathsType: typeof require.resolve.paths,
    resolvedBuiltin: require.resolve("node:path"),
    builtinType: typeof require("node:crypto").createHash,
    sourceVisible: "bundleSource" in require("node:worker_threads").workerData,
    nativeIPFSResolve, receipt, runId: context.runId, nonce: input.nonce ?? null
  };
  if (input.mode === "reject") {
    const addresses = [
      "ipfs://" + cid + "/resources/payload.bin",
      "ipfs://" + input.foreignCID + "/worker.cjs", "ipfs://invalid/worker.cjs",
      "ipfs://user:secret@" + cid + "/worker.cjs",
      "ipfs://" + cid + "/a/../worker.cjs", "ipfs://" + cid + "/%77orker.cjs",
      "ipfs://" + cid + "/%2e%2e/worker.cjs",
      "ipfs://" + cid + "/worker.cjs?query", "ipfs://" + cid + "/worker.cjs#fragment",
      "ipfs://" + cid + "/worker.cjs?", "ipfs://" + cid + "/worker.cjs#",
      "ipfs://" + cid + "/worker.cjs/extra", "./resources/payload.bin",
      "file:///unverified.cjs", "https://user:secret@example.invalid/code.js", "unbundled-package"
    ];
    result.denials = addresses.map(address => {
      try { Reflect.apply(module.require, module, [address]); return {loaded: true}; }
      catch(error) { return {code: error.code, message: error.message}; }
    });
    return result;
  }
  const resource = await context.bundle.root.resolve("resources/payload.bin").read();
  if (resource.kind !== "file") throw Error("Expected binary resource.");
  const reader = resource.content.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  return {...result, bytes};
};
`);
await writeFile(join(author, "src", "startup.ts"), 'throw new Error("registry IPFS startup failure");\n');
const builds = {};
for (const [name, entry, mode] of [
  ["main", "src/main.ts", "callback"],
  ["foreign", "src/main.ts", "callback"],
  ["startup", "src/startup.ts", "explicit"],
]) {
  const config = {
    name: `Registry IPFS ${name}`,
    runtime: { minVersion: "22.15.0" },
    source: { entry, contract: "contract.json", mode },
    include: [{ from: "assets/**", to: "resources/" }],
    binary: ["resources/payload.bin"], outDirectory: `dist/${name}`,
  };
  const file = join(author, `${name}.build.json`);
  await writeFile(file, JSON.stringify(config));
  builds[name] = (await command(process.execPath, [builderBin, "build", file], { cwd: author })).json().data;
}
assert.notEqual(builds.main.cid, builds.foreign.cid);
report.artifacts = Object.fromEntries(Object.entries(builds).map(([name, value]) => [name, {
  cid: value.cid, car: redact(value.car.path),
}]));
let upstreamRequests = 0;
const upstream = createServer((_request, response) => {
  upstreamRequests++;
  response.writeHead(500).end();
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const servers = [];
async function start(name, gateway) {
  const port = await freePort();
  const data = join(runtime, name);
  const response = (await cli([
    "server", "start", "--data-dir", data, "--port", String(port), "--ipfs-gateway", gateway,
  ])).json();
  assert.equal(response.data.state, "ready");
  const instance = JSON.parse(await readFile(join(data, "instance.json")));
  assert.ok(Number.isInteger(instance.pid) && instance.pid > 0);
  const server = { name, data, pid: instance.pid, url: `http://127.0.0.1:${port}`, stopped: false };
  servers.push(server);
  return server;
}
async function stop(server) {
  if (server.stopped) return;
  await cli(["server", "stop", "--data-dir", server.data, "--cancel-running"]);
  const status = (await cli(["server", "status", "--data-dir", server.data])).json();
  assert.equal(status.data.state, "stopped");
  await until(() => exited(server.pid));
  server.stopped = true;
}
try {
  await cli(["config", "set", "server.rawGatewayAccess", "public"]);
  const publisher = await start("publisher", `http://127.0.0.1:${upstream.address().port}`);
  await cli(["config", "reset", "server.rawGatewayAccess"]);
  for (const name of ["main", "foreign"]) {
    const input = join(work, `${name}-prime.json`);
    await writeFile(input, JSON.stringify({ mode: "echo", nonce: `prime-${name}` }));
    const response = (await cli([
      "run", "--engine", publisher.url, "--car", builds[name].car.path, "--input", input,
    ])).json();
    assert.equal(response.data.status, "succeeded");
    assert.equal(response.data.output.result.moduleURL, `ipfs://${builds[name].cid}/worker.cjs`);
    assert.equal(response.data.output.result.bytes, 600_000);
  }
  const consumerServer = await start("consumer", publisher.url);
  const input = join(work, "consumer-input.json");
  await writeFile(input, JSON.stringify({ mode: "echo", nonce: "real-cid-gateway" }));
  const response = (await cli([
    "run", "--engine", consumerServer.url, "--cid", builds.main.cid, "--input", input,
  ])).json();
  assert.equal(response.data.status, "succeeded");
  assert.equal(response.data.output.result.moduleURL, `ipfs://${builds.main.cid}/worker.cjs`);
  assert.equal(response.data.output.result.cached, true);
  assert.equal(response.data.output.result.bytes, 600_000);
  const logs = (await cli([
    "task", "logs", response.data.taskId, "--engine", consumerServer.url,
  ])).json();
  assert.ok(logs.data.logs.some((entry) => entry.message === "ipfs-entry:echo"));
  report.cli = {
    taskId: response.data.taskId, status: response.data.status,
    output: response.data.output, logs: logs.data.logs,
  };
  report.probes = [];
  for (const mode of ["isolation", "reject", "startup", "missing", "corrupt", "cancel", "force"]) {
    const selectedCID = mode === "startup" ? builds.startup.cid : builds.main.cid;
    const result = (await command(process.execPath, [
      join(work, "registry-engine-probe.mjs"), work, publisher.url, selectedCID, mode, builds.foreign.cid,
    ])).json();
    assert.equal(result.ok, true);
    report.probes.push({ ...result, probeProcessExitedNaturally: true });
  }
  const waitInput = join(work, "wait-input.json");
  await writeFile(waitInput, JSON.stringify({ mode: "wait", nonce: "active-shutdown" }));
  const active = (await cli([
    "run", "--engine", consumerServer.url, "--cid", builds.main.cid,
    "--input", waitInput, "--async",
  ])).json();
  assert.ok(active.data.taskId);
  await until(async () => {
    const logs = (await cli([
      "task", "logs", active.data.taskId, "--engine", consumerServer.url,
    ])).json();
    return logs.data.logs.some((entry) => entry.message === "ipfs-entry:wait");
  });
  const deniedStop = (await cli([
    "server", "stop", "--data-dir", consumerServer.data,
  ], { expectedCode: 1 })).json();
  assert.equal(deniedStop.error.code, "ACTIVE_TASKS");
  await stop(consumerServer);
  report.activeShutdown = { taskId: active.data.taskId, refusedWithoutCancellation: true, exited: true };
  assert.equal(upstreamRequests, 0);
  report.unexpectedUpstreamRequests = upstreamRequests;
} finally {
  const stopped = await Promise.allSettled([...servers].reverse().map(stop));
  await new Promise((done) => upstream.close(done));
  const errors = stopped.filter((value) => value.status === "rejected");
  if (errors.length) throw new AggregateError(errors.map((value) => value.reason), "部署服务器清理失败。");
}
report.servers = servers.map(({ name, pid, stopped }) => ({ name, pid, stopped }));
report.runtimeBundleSourceFiles = await cjsFiles(runtime);
assert.deepEqual(report.runtimeBundleSourceFiles, []);
report.ok = true;
report.completedAt = new Date().toISOString();
await writeFile(join(work, "registry-smoke-result.json"), redact(JSON.stringify(report, null, 2)) + "\n");
console.log(JSON.stringify({ ok: true, packages: report.packages, artifacts: report.artifacts,
  probes: report.probes.map(({ mode, node, engineClosed, closeError }) => ({ mode, node, engineClosed, closeError })),
  servers: report.servers, runtimeBundleSourceFiles: report.runtimeBundleSourceFiles }));
