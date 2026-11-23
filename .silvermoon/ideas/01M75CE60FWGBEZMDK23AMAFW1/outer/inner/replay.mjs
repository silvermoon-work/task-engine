import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// 仅使用已安装的公开 CLI、Builder 和第三方公开编码接口；不导入仓库源码。
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const consumer = resolve(option("consumer", "."));
const treeRoot = resolve(option("tree-root", consumer));
const work = resolve(option("work", `.recursive-replay-${randomUUID()}`));
const reportPath = option("report");
const profile = Object.freeze({
  gatewayMode: "recursive", rawGatewayAccess: "public", rawGatewayMaxConcurrent: 16,
  recursiveGatewayMaxConcurrent: 2, recursiveGatewayMaxBlockBytes: 1024,
  recursiveGatewayTimeoutMs: 2000, recursiveGatewayAttemptTimeoutMs: 1500,
});
const limits = Object.freeze({ loopRequests: 3, loopMs: 2500, taskMs: 30000, loadRequests: 24 });
function resolveImport(name, cwd = consumer) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `console.log(import.meta.resolve(${JSON.stringify(name)}))`], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const cli = fileURLToPath(resolveImport("@silvermoon-work/task-engine-cli"));
const bin = join(dirname(cli), "bin.js");
const { CID } = await import(resolveImport("multiformats/cid", dirname(cli)));
const { sha256 } = await import(resolveImport("multiformats/hashes/sha2", dirname(cli)));
const env = { ...process.env, HOME: work, USERPROFILE: work, LOCALAPPDATA: join(work, "config") };
await mkdir(work, { recursive: false });
const instances = new Set();
const servers = [];
const commands = [];
const measurements = {};
const sourceName = `.recursive-proof-${randomUUID()}.mjs`;
const source = join(consumer, sourceName);
async function command(...argv) {
  commands.push(argv.join(" "));
  const child = spawn(process.execPath, [bin, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  const timer = setTimeout(() => child.kill(), 35000);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, `${argv.join(" ")}\n${stdout}\n${stderr}`);
  const value = JSON.parse(stdout);
  assert.equal(value.ok, true, stdout);
  return value.data;
}
const config = (key, value) => command("config", "set", `server.${key}`, String(value));
async function port() {
  const server = createServer();
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const value = server.address().port;
  await new Promise(done => server.close(done));
  return value;
}
async function start(data, listenPort) {
  // 启动若部分失败也按自有路径尝试 stop；不清理不属于本脚本的实例。
  instances.add(data);
  await command("server", "start", "--data-dir", data, "--port", String(listenPort));
  assert.equal((await fetch(`http://127.0.0.1:${listenPort}/ipfs/bafkqaaa?format=raw`)).status, 200);
}
async function stop(data) {
  await command("server", "stop", "--data-dir", data);
  instances.delete(data);
}
let failure;
try {
  let outbound = 0, mode = "good", release;
  const pending = new Promise(done => { release = done; });
  const bytes = Buffer.from("recursive public registry proof");
  const cid = CID.createV0(await sha256.digest(bytes));
  const upstream = createServer(async (_request, response) => {
    outbound++;
    if (mode === "hold") await pending;
    if (response.destroyed) return;
    if (mode === "offline") return void response.writeHead(503).end();
    response.writeHead(200, { "content-type": "application/vnd.ipld.raw" });
    response.flushHeaders();
    if (mode === "stall") response.write("x");
    else response.end(bytes);
  });
  servers.push(upstream);
  await new Promise(done => upstream.listen(0, "127.0.0.1", done));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  for (const [key, value] of Object.entries(profile)) await config(key, value);
  await config("recursiveGatewayUpstreams", upstreamUrl);
  const data = join(work, "a"), listenPort = await port(), url = `http://127.0.0.1:${listenPort}`;
  await start(data, listenPort);
  const raw = `${url}/ipfs/${cid}?format=raw`;
  for (const method of ["GET", "HEAD"])
    assert.equal((await fetch(raw, { method, headers: { "cache-control": "only-if-cached" } })).status, 412);
  assert.equal(outbound, 0);
  mode = "hold";
  const waiter = new AbortController();
  const first = fetch(raw, { signal: waiter.signal }).catch(error => error);
  for (let i = 0; i < 100 && !outbound; i++) await delay(5);
  assert.equal(outbound, 1);
  const second = fetch(`${url}/ipfs/${cid.toV1()}?format=raw`);
  // CLI status 验证第二等待者已加入，而不是依赖固定 sleep。
  for (let i = 0; i < 10; i++) {
    if ((await command("server", "status", "--data-dir", data)).gateway.recursive.joined === 1) break;
    if (i === 9) assert.fail("singleflight waiter did not join");
  }
  for (const format of ["raw", "car"])
    assert.equal((await fetch(`${url}/ipfs/${cid}?format=${format}`, {
      headers: { "cache-control": "only-if-cached" },
    })).status, 412);
  waiter.abort();
  assert.ok(await first instanceof Error);
  release();
  const response = await second;
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(outbound, 1);
  mode = "offline";
  await stop(data);
  await start(data, listenPort);
  assert.deepEqual(Buffer.from(await (await fetch(raw)).arrayBuffer()), bytes);
  assert.equal(outbound, 1);
  measurements.coldWarmOutbound = outbound;
  // 通过已发布 Builder 的公开接口构造并执行真实任务，不用 mock 代替 service availability。
  const { buildTaskBundle } = await import(resolveImport("@silvermoon-work/task-builder"));
  const { directoryTree } = await import(resolveImport("@silvermoon-work/task-builder-cli/node"));
  const { encodeTaskBundleCar } = await import(resolveImport("@silvermoon-work/task-builder/car"));
  await writeFile(source, "export default async input => ({value: input.value});\n");
  const tree = await buildTaskBundle(await directoryTree(treeRoot), {
    name: "recursive-service-proof", runtime: { minVersion: "22.13.0" },
    source: { entry: relative(treeRoot, source).split(sep).join("/"), mode: "callback",
      contract: { input: { type: "object" }, result: true, message: false } },
  });
  const encoded = await encodeTaskBundleCar(tree);
  const parts = [];
  try { for await (const part of encoded.stream) parts.push(part); }
  finally { await encoded.close(); }
  const car = join(work, "task.car"), input = join(work, "input.json");
  await writeFile(car, Buffer.concat(parts));
  await writeFile(input, '{"value":42}');
  mode = "stall";
  const before = outbound;
  const load = await Promise.all(Array.from({ length: limits.loadRequests }, async (_, i) => {
    const missing = CID.createV1(0x55, await sha256.digest(Buffer.from(`load-${i}`)));
    return `${url}/ipfs/${missing}?format=raw`;
  }));
  const pressure = load.map(target => fetch(target).then(async response => {
    await response.arrayBuffer();
    assert.ok([429, 502, 504].includes(response.status), `load: ${response.status}`);
    return response.status;
  }));
  for (let i = 0; i < 100 && outbound < before + 2; i++) await delay(5);
  assert.equal(outbound, before + 2);
  const began = performance.now();
  const task = await command("run", "--engine", url, "--car", car, "--input", input);
  measurements.taskMs = performance.now() - began;
  assert.equal(task.status, "succeeded", JSON.stringify(task));
  assert.equal(task.output.result.value, 42);
  assert.ok(measurements.taskMs < limits.taskMs);
  measurements.loadStatuses = await Promise.all(pressure);
  measurements.loadOutbound = outbound - before;
  assert.ok(measurements.loadOutbound <= 2);
  measurements.gateway = (await command("server", "status", "--data-dir", data)).gateway;
  assert.ok(measurements.gateway.recursive.peakActive <= 2);
  assert.equal(measurements.gateway.recursive.active, 0);
  await stop(data);
  // A/B 使用独立实例、独立数据目录；同 CID 循环必须先检查自身 hop 再 join。
  const b = join(work, "b"), bPort = await port(), bUrl = `http://127.0.0.1:${bPort}`;
  await config("recursiveGatewayUpstreams", url);
  await start(b, bPort);
  await config("recursiveGatewayUpstreams", bUrl);
  await start(data, listenPort);
  const absent = CID.createV1(0x55, await sha256.digest(Buffer.from("reciprocal")));
  const loopBegan = performance.now();
  assert.equal((await fetch(`${url}/ipfs/${absent}?format=raw`)).status, 502);
  measurements.loopMs = performance.now() - loopBegan;
  const aStats = (await command("server", "status", "--data-dir", data)).gateway;
  const bStats = (await command("server", "status", "--data-dir", b)).gateway;
  // 每个实例 start 的 identity 就绪探测各占一次；除此之外最多三次请求。
  measurements.loopRequests = aStats.requests + bStats.requests - 2;
  assert.ok(measurements.loopRequests <= limits.loopRequests);
  assert.ok(measurements.loopMs < limits.loopMs);
  await stop(b);
  await stop(data);
  // 默认 local 与 disabled 即使保留上游配置也严格零回源。
  const baseline = outbound;
  await config("recursiveGatewayUpstreams", upstreamUrl);
  await config("gatewayMode", "local");
  await start(data, listenPort);
  assert.equal((await fetch(`${url}/ipfs/${absent}?format=raw`)).status, 404);
  await stop(data);
  await config("gatewayMode", "recursive");
  await config("rawGatewayAccess", "disabled");
  instances.add(data);
  await command("server", "start", "--data-dir", data, "--port", String(listenPort));
  assert.equal((await fetch(`${url}/ipfs/${absent}?format=raw`)).status, 404);
  assert.equal(outbound, baseline);
} catch (error) {
  failure = error;
} finally {
  const cleanup = [];
  for (const data of [...instances]) {
    try { await stop(data); } catch (error) { cleanup.push(error); }
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
  await rm(source, { force: true });
  if (!instances.size) await rm(work, { recursive: true, force: true });
  else cleanup.push(new Error(`Unreleased owned instances retained: ${[...instances].join(", ")}`));
  if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify({
    node: process.version, profile, limits, commands, measurements,
    cleanup: cleanup.map(error => String(error)), error: failure ? String(failure) : undefined,
  }, null, 2)}\n`);
  if (cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "Replay cleanup failed.");
}
if (failure) throw failure;
console.log(JSON.stringify({ ok: true, profile, limits, measurements }));
