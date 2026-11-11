import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 仅通过已安装包的公开入口、CLI 和 HTTP 验证；不导入源码或内部模块。
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const consumer = resolve(option("consumer", "."));
const treeRoot = resolve(option("tree-root", consumer));
function resolveImport(name, cwd = consumer) {
  const resolved = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `console.log(import.meta.resolve(${JSON.stringify(name)}))`,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(resolved.status, 0, resolved.stderr);
  return resolved.stdout.trim();
}
const cli = fileURLToPath(resolveImport("@silvermoon-work/task-engine-cli"));
const dependency = (name) => resolveImport(name, dirname(cli));
const { CarReader } = await import(dependency("@ipld/car/reader"));
const { CID } = await import(dependency("multiformats/cid"));
const { sha256 } = await import(dependency("multiformats/hashes/sha2"));
const work = resolve(option("work", `.gateway-replay-${randomUUID()}`));
const data = join(work, "data");
const reportPath = option("report");
const port = Number(option("port", "0"));
const holdMs = Number(option("hold-ms", "0"));
const fixtures = option("fixtures");
const token = option("token");
const sourceName = `.gateway-load-${randomUUID()}.mjs`;
const sourcePath = join(consumer, sourceName);
const bin = join(dirname(cli), "bin.js");
const env = {
  ...process.env,
  HOME: work,
  USERPROFILE: work,
  LOCALAPPDATA: join(work, "config"),
};
await mkdir(work, { recursive: false });
let started = false;
const commands = [];
async function command(...argv) {
  const expectedError =
    typeof argv[0] === "object" ? argv.shift().error : undefined;
  const child = spawn(process.execPath, [bin, ...argv], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  const value = JSON.parse(stdout);
  assert.equal(
    code,
    expectedError ? 1 : 0,
    `${argv.join(" ")}\n${stdout}\n${stderr}`,
  );
  assert.equal(value.ok, !expectedError, stdout);
  if (expectedError) assert.equal(value.error.code, expectedError, stdout);
  commands.push(argv.slice(0, 2).join(" "));
  return value.data;
}
const report = { commands, fixtures: [], measurements: {} };
try {
  await command(
    "config",
    "set",
    "server.rawGatewayAccess",
    token ? "token" : "public",
  );
  if (token) await command("config", "set", "server.rawGatewayToken", token);
  for (const [key, value] of Object.entries({
    rawGatewayMaxConcurrent: 2,
    rawGatewayMaxBlockBytes: 2097152,
    rawGatewayTimeoutMs: 1000,
    carGatewayMaxBytes: 8388608,
    carGatewayMaxBlocks: fixtures ? 4096 : 128,
  }))
    await command("config", "set", `server.${key}`, String(value));
  let listenPort = port;
  if (!listenPort) {
    const probe = createServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    listenPort = probe.address().port;
    await new Promise((done) => probe.close(done));
  }
  await command(
    "server",
    "start",
    "--data-dir",
    data,
    "--port",
    String(listenPort),
  );
  started = true;
  const url = `http://127.0.0.1:${listenPort}`;
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const probe = await fetch(`${url}/ipfs/bafkqabtimvwgy3yk?format=raw`, {
    headers,
  });
  assert.equal(probe.status, 200);
  assert.equal(await probe.text(), "hello\n");
  assert.equal(probe.headers.get("access-control-allow-origin"), "*");
  assert.equal(probe.headers.get("access-control-allow-credentials"), null);
  report.url = url;
  // 外部 fixture 仅写入自有实例的已校验本地块缓存，不启动替代 HTTP 网关。
  if (fixtures) {
    const files = [];
    async function walk(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const name = join(path, entry.name);
        if (entry.isDirectory()) await walk(name);
        else if (entry.name.endsWith(".car")) files.push(name);
      }
    }
    await walk(resolve(fixtures));
    await mkdir(join(data, "blocks"), { recursive: true });
    for (const file of files.sort()) {
      const bytes = await readFile(file);
      const reader = await CarReader.fromBytes(bytes);
      for await (const block of reader.blocks()) {
        if (block.cid.multihash.code !== 0x12) continue;
        assert.deepEqual(
          (await sha256.digest(block.bytes)).digest,
          block.cid.multihash.digest,
        );
        await writeFile(
          join(data, "blocks", block.cid.toV1().toString()),
          block.bytes,
        );
      }
      report.fixtures.push({
        file: file.slice(resolve(fixtures).length + 1).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  if (option("load", "no") === "yes") {
    const bytes = Buffer.alloc(1048576, 42);
    const cid = CID.createV1(0x55, await sha256.digest(bytes));
    await mkdir(join(data, "blocks"), { recursive: true });
    await writeFile(join(data, "blocks", cid.toString()), bytes);
    const body = await fetch(`${url}/ipfs/${cid}?format=raw`, { headers });
    assert.deepEqual(Buffer.from(await body.arrayBuffer()), bytes);
    // 已安装 Builder 的公开 tree/CAR API 构造离线真实任务。
    const { buildTaskBundle } = await import(
      resolveImport("@silvermoon-work/task-builder")
    );
    const { directoryTree } = await import(
      resolveImport("@silvermoon-work/task-builder-cli/node")
    );
    const { encodeTaskBundleCar } = await import(
      resolveImport("@silvermoon-work/task-builder/car")
    );
    await writeFile(
      sourcePath,
      `export default async input => {
      const statuses = [];
      if (input.gateway) for (let i = 0; i < 4; i++) {
        const response = await fetch(input.gateway, {headers: input.headers});
        statuses.push(response.status);
        if (response.status === 200) {
          let length = 0;
          for await (const bytes of response.body) {
            length += bytes.length;
            if (bytes.some(byte => byte !== 42)) throw new Error("Bad block bytes");
          }
          if (length !== 1048576) throw new Error("Bad block length");
        } else if (response.status !== 429) throw new Error("Unexpected gateway status");
      }
      return {value: input.value, statuses};
    };`,
    );
    const tree = await buildTaskBundle(await directoryTree(treeRoot), {
      name: "gateway-load",
      runtime: { minVersion: "22.13.0" },
      source: {
        entry: relative(treeRoot, sourcePath).split(sep).join("/"),
        mode: "callback",
        contract: { input: { type: "object" }, result: true, message: false },
      },
    });
    const encoded = await encodeTaskBundleCar(tree);
    const archive = join(work, "task.car");
    const parts = [];
    for await (const part of encoded.stream) parts.push(part);
    await encoded.close();
    await writeFile(archive, Buffer.concat(parts));
    const input = join(work, "input.json");
    const loadInput = join(work, "load-input.json");
    await writeFile(input, '{"value":42}');
    await writeFile(
      loadInput,
      JSON.stringify({
        value: 42,
        gateway: `${url}/ipfs/${cid}?format=raw`,
        headers,
      }),
    );
    async function task(inputPath = input) {
      const began = performance.now();
      const result = await command(
        "run",
        "--engine",
        url,
        "--car",
        archive,
        "--input",
        inputPath,
      );
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(result.output.result.value, 42);
      return {
        latency: performance.now() - began,
        statuses: result.output.result.statuses,
      };
    }
    const baseline = [];
    for (let i = 0; i < 4; i++) baseline.push((await task()).latency);
    const status = () => command("server", "status", "--data-dir", data);
    const before = await status();
    // 八个真实 Worker 各执行四次读取，避免负载在 CLI 启动前就结束的伪共载。
    const tasks = await Promise.all(
      Array.from({ length: 8 }, () => task(loadInput)),
    );
    const latencies = tasks.map((result) => result.latency);
    const loadStatus = tasks.flatMap((result) => result.statuses);
    const after = await status();
    assert.ok(loadStatus.includes(429), JSON.stringify(loadStatus));
    assert.ok(loadStatus.includes(200));
    assert.equal(loadStatus.length, 32);
    assert.ok(after.gateway.peakActive <= 2);
    assert.ok(
      Math.max(...latencies) <= Math.max(Math.max(...baseline) * 5, 2000),
    );
    const rssGrowth = after.peakRssBytes - before.rssBytes;
    assert.ok(rssGrowth <= 134217728, `RSS growth ${rssGrowth}`);
    const dagPb = await import(dependency("@ipld/dag-pb"));
    const links = [];
    for (let i = 0; i < 7; i++) {
      const block = Buffer.alloc(1048576, i + 1);
      const child = CID.createV1(0x55, await sha256.digest(block));
      await writeFile(join(data, "blocks", child.toString()), block);
      links.push({ Hash: child });
    }
    const parent = dagPb.encode({ Links: links });
    const parentCid = CID.createV1(dagPb.code, await sha256.digest(parent));
    await writeFile(join(data, "blocks", parentCid.toString()), parent);
    async function paused() {
      return new Promise((done, reject) => {
        const req = request(
          `${url}/ipfs/${parentCid}?format=car`,
          { headers },
          (res) => {
            res.pause();
            done({ req, res });
          },
        );
        req.on("error", reject);
        req.end();
      });
    }
    const slow = [];
    for (let i = 0; i < 2; i++) {
      slow.push(await paused());
    }
    assert.equal(
      (await fetch(`${url}/ipfs/${cid}?format=raw`, { headers })).status,
      429,
    );
    const began = performance.now();
    for (const item of slow) {
      item.res.destroy();
      item.req.destroy();
    }
    let recovered;
    do {
      recovered = await status();
    } while (recovered.gateway.active && performance.now() - began < 3000);
    assert.equal(recovered.gateway.active, 0);
    const recoveryMs = performance.now() - began;
    assert.ok(recoveryMs < 3000);
    await task();
    await command(
      { error: "DATA_IN_USE" },
      "data",
      "prune",
      "--data-dir",
      data,
      "--cache",
    );
    const absent = CID.createV1(
      0x55,
      await sha256.digest(Buffer.from("absent")),
    );
    assert.equal(
      (await fetch(`${url}/ipfs/${absent}?format=raw`, { headers })).status,
      404,
    );
    await writeFile(join(data, "blocks", cid.toString()), "corruption");
    assert.equal(
      (await fetch(`${url}/ipfs/${cid}?format=raw`, { headers })).status,
      500,
    );
    await writeFile(join(data, "blocks", cid.toString()), bytes);
    await rm(join(data, "blocks", cid.toString()));
    assert.equal(
      (await fetch(`${url}/ipfs/${cid}?format=raw`, { headers })).status,
      404,
    );
    const faultMetrics = (await status()).gateway;
    assert.ok(faultMetrics.misses >= 2 && faultMetrics.storageErrors >= 1);
    await task();
    const finalMemory = await status();
    const totalRssGrowth = finalMemory.peakRssBytes - before.rssBytes;
    assert.ok(
      totalRssGrowth <= 134217728,
      `Total RSS growth ${totalRssGrowth}`,
    );
    report.measurements = {
      baseline,
      latencies,
      statuses: loadStatus,
      before: before.gateway,
      after: after.gateway,
      recovered: recovered.gateway,
      recoveryMs,
      faultMetrics,
      baselineRssBytes: before.rssBytes,
      peakRssBytes: finalMemory.peakRssBytes,
      rssGrowth: totalRssGrowth,
      workerLoadRssGrowth: rssGrowth,
    };
    const shutdownClient = await paused();
    const shutdownStart = performance.now();
    await command("server", "stop", "--data-dir", data);
    started = false;
    shutdownClient.res.destroy();
    shutdownClient.req.destroy();
    const shutdownMs = performance.now() - shutdownStart;
    assert.ok(shutdownMs < 3000, `Shutdown ${shutdownMs}`);
    const gc = await command("data", "prune", "--data-dir", data, "--cache");
    assert.ok(gc.deletedCacheBlocks >= 8);
    report.measurements.shutdownMs = shutdownMs;
    report.measurements.gc = gc;
  }
  console.log(
    JSON.stringify({
      ready: started,
      completed: !started,
      url,
      work,
      fixture: "/ipfs/bafkqabtimvwgy3yk?format=raw",
    }),
  );
  if (reportPath)
    await writeFile(
      resolve(reportPath),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  if (holdMs) await new Promise((done) => setTimeout(done, holdMs));
} finally {
  let stopped = !started;
  try {
    if (started)
      await command("server", "stop", "--data-dir", data, "--cancel-running");
    stopped = true;
  } finally {
    await rm(sourcePath, { force: true });
    if (stopped) await rm(work, { recursive: true, force: true });
    else console.error(`停止未确认，保留自有实例身份和诊断数据：${work}`);
  }
}
