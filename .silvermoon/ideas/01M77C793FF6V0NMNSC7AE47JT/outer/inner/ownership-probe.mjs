import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 仅在本次创建的 repo 中启动测试 daemon；不使用用户的 IPFS_PATH 或已有 daemon。
const directory = resolve(".cache", `kubo-ownership-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const env = { ...process.env, IPFS_PATH: directory };
const executable = process.env.KUBO_PROBE_EXECUTABLE || "ipfs";
const cli = (...args) =>
  execFileSync(executable, args, {
    env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let daemon;
let exited;
let daemonLog = "";
let api;

async function rpc(command, args = {}, body) {
  const url = new URL(`/api/v0/${command}`, api);
  for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.ok(text.length <= 16_384, "小型测试响应不得超出证明脚本的预期边界");
  assert.ok(response.ok, `${command}: ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function pins(cid) {
  return rpc("pin/ls", { arg: cid, type: "recursive", names: true });
}

try {
  const version = cli("version");
  cli("init", "--profile=test", "--empty-repo");
  cli("config", "Addresses.API", "/ip4/127.0.0.1/tcp/0");
  cli("config", "Addresses.Gateway", "/ip4/127.0.0.1/tcp/0");
  cli("config", "--json", "Bootstrap", "[]");
  daemon = spawn(executable, ["--offline", "daemon", "--routing=none"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = once(daemon, "exit");
  daemon.stdout.on("data", (chunk) => {
    daemonLog = (daemonLog + chunk).slice(-16_384);
  });
  daemon.stderr.on("data", (chunk) => {
    daemonLog = (daemonLog + chunk).slice(-16_384);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.equal(daemon.exitCode, null, daemonLog);
    try {
      const address = (await readFile(join(directory, "api"), "utf8")).trim();
      const match = /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)$/.exec(address);
      assert.ok(match, "测试 RPC 必须只监听 loopback");
      api = `http://127.0.0.1:${match[1]}`;
      await rpc("version");
      break;
    } catch {
      await sleep(100);
    }
  }
  assert.ok(api, `测试 daemon 未启动：${daemonLog}`);
  const online = await rpc("id");
  assert.deepEqual(online.Addresses ?? [], [], "测试 daemon 不得监听 swarm");
  const body = new FormData();
  body.append("file", new Blob(["task-engine pin ownership counterexample"]), "block");
  const { Key: cid } = await rpc(
    "block/put",
    { format: "raw", mhtype: "sha2-256", pin: false },
    body,
  );
  assert.equal(typeof cid, "string");

  await rpc("pin/add", { arg: cid, recursive: true });
  const systemOnly = await pins(cid);
  await rpc("pin/add", { arg: cid, recursive: true });
  const systemAndExternal = await pins(cid);
  assert.deepEqual(
    systemAndExternal,
    systemOnly,
    "系统 pin 后外部再次 pin，不产生可区分的所有者或引用计数",
  );
  await rpc("pin/rm", { arg: cid, recursive: true });
  const afterRemove = await rpc("pin/ls", { type: "recursive", names: true });
  assert.equal(Object.hasOwn(afterRemove.Keys, cid), false);

  await rpc("pin/add", { arg: cid, recursive: true, name: "task-engine/owner-a" });
  const namedSystemOnly = await pins(cid);
  await rpc("pin/add", { arg: cid, recursive: true, name: "task-engine/owner-a" });
  const namedSystemAndExternal = await pins(cid);
  assert.deepEqual(
    namedSystemAndExternal,
    namedSystemOnly,
    "可见的 pin name 是可覆盖标签，不是所有者身份或独占能力",
  );

  await rpc("pin/add", { arg: cid, recursive: true, name: "external/manual" });
  const renamedByExternal = await pins(cid);
  assert.equal(renamedByExternal.Keys[cid].Name, "external/manual");
  await rpc("pin/rm", { arg: cid, recursive: true });
  const afterRace = await rpc("pin/ls", { type: "recursive", names: true });
  assert.equal(
    Object.hasOwn(afterRace.Keys, cid),
    false,
    "pin/rm 不能按旧 name 条件删除；标记后发生的外部 pin 也会被移除",
  );

  console.log(
    JSON.stringify(
      {
        version,
        daemonMode: "offline",
        isolatedRepo: true,
        swarmAddresses: online.Addresses ?? [],
        cid,
        systemOnly,
        systemAndExternal,
        afterRemove,
        namedSystemOnly,
        namedSystemAndExternal,
        renamedByExternal,
        afterRace,
        conclusion: "已复现：原生 Kubo pin 不提供外部所有权识别或条件 unpin。",
      },
      null,
      2,
    ),
  );
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill();
    await Promise.race([
      exited,
      sleep(10_000).then(() => {
        if (daemon.exitCode === null) daemon.kill("SIGKILL");
      }),
    ]);
    await exited;
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
