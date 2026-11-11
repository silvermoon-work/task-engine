import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { MemoryIpfsClient } from "@silvermoon-work/task-engine/testing";
import { processBirth, stopManaged } from "../src/managed.js";
import { encodeTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { memoryTree } from "@silvermoon-work/task-builder/tree";

const bin = resolve("dist", "bin.js");
interface Result {
  ok: boolean;
  data: Record<string, unknown>;
  error?: { code: string; message: string };
}
async function execute(
  args: string[],
  directory: string,
  input?: string,
  interruptMs?: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const began = performance.now();
  const script =
    interruptMs === undefined
      ? undefined
      : `import {main} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const timer=setTimeout(()=>process.emit("SIGINT"),${interruptMs});process.exitCode=await main(process.argv.slice(1));clearTimeout(timer);`;
  const child = spawn(
    process.execPath,
    script ? ["--input-type=module", "-e", script, ...args] : [bin, ...args],
    {
      env: { ...process.env, LOCALAPPDATA: join(directory, "configuration"), HOME: directory },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part) => {
    stdout += part;
  });
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 45_000);
  const abort = () => {
    child.kill();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
  const evidence = {
    args,
    code,
    signal: child.signalCode,
    durationMs: performance.now() - began,
    timedOut,
    stdout,
    stderr,
  };
  await appendFile(join(directory, "commands.jsonl"), `${JSON.stringify(evidence)}\n`);
  assert.equal(timedOut, false, JSON.stringify(evidence));
  assert.notEqual(code, null, JSON.stringify(evidence));
  signal?.throwIfAborted();
  return { code, stdout, stderr, parse: () => JSON.parse(stdout) as Result };
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
test("managed installed entry: lifecycle, persistent execution, logs, configuration and offline cleanup", async (t) => {
  const directory = resolve(".cache", `managed-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const data = join(directory, "data");
  const cancelledData = join(directory, "cancelled-start");
  const port = await freePort();
  const engine = `http://127.0.0.1:${port}`;
  let phaseSignal: AbortSignal | undefined;
  const run = (args: string[], input?: string, interruptMs?: number) =>
    execute(args, directory, input, interruptMs, phaseSignal);
  const phase = async (name: string, operation: () => Promise<void>) => {
    let passed = false;
    await t.test(name, { timeout: 90_000 }, async (stage) => {
      phaseSignal = stage.signal;
      await operation();
      passed = true;
    });
    phaseSignal = undefined;
    assert.ok(passed, `${name} failed; see subtest and commands.jsonl.`);
  };
  let built!: Awaited<ReturnType<typeof buildBundleFixture>>;
  const start = ["server", "start", "--data-dir", data, "--port", String(port)];
  let args!: string[], taskId!: string, failure!: Awaited<ReturnType<typeof execute>>;
  let outputCid: unknown;
  let completed = false;
  t.after(async () => {
    if (!completed)
      t.diagnostic(
        `Failed lifecycle command evidence retained in ${join(directory, "commands.jsonl")}`,
      );
    const cleanup = await Promise.allSettled([
      stopManaged(data, true),
      stopManaged(cancelledData, true),
    ]);
    for (const result of cleanup) {
      assert.equal(
        result.status,
        "fulfilled",
        result.status === "rejected" ? String(result.reason) : undefined,
      );
      if (result.status === "fulfilled") assert.equal(result.value.ok, true);
    }
    if (completed) await rm(directory, { recursive: true, force: true });
  });
  await phase("startup cancellation, concurrent ownership and authenticated status", async () => {
    const interruptedStart = await run(
      ["server", "start", "--data-dir", cancelledData, "--port", String(await freePort())],
      undefined,
      100,
    );
    assert.equal(interruptedStart.code, 130, interruptedStart.stdout);
    const entry = join(directory, "main.ts");
    await writeFile(
      entry,
      `
import {setTimeout as delay} from "node:timers/promises";
export default async (input,context)=>{
 for(let i=0;i<30;i++) context.log({level:"info",message:"entry-"+i});
 if(input.mode==="failure") throw Error("business failure");
 if(input.mode==="echo") return input;
 if(input.mode==="null") return null;
 if(input.mode==="slow") await delay(60000,undefined,{signal:context.signal});
 await context.output.write("/value.txt",new ReadableStream({
   start(controller){controller.enqueue(new TextEncoder().encode(String(input.value??"")));controller.close();}
 }));
 return {value:input.value??null};
}`,
    );
    built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "managed test",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        inputSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      entry,
      outDirectory: join(directory, "bundle"),
      resources: {},
    });
    const starts = await Promise.all([run(start), run(start)]);
    assert.deepEqual(
      starts.map((item) => item.code).sort(),
      [0, 1],
      starts.map((item) => item.stdout + item.stderr).join("\n"),
    );
    assert.equal(starts.find((item) => item.code === 0)!.parse().data.state, "ready");
    const alias = join(directory, "alias");
    await symlink(data, alias, process.platform === "win32" ? "junction" : "dir");
    const duplicate = await run([
      "server",
      "start",
      "--data-dir",
      alias,
      "--port",
      String(await freePort()),
    ]);
    assert.equal(duplicate.code, 1);
    const status = await run(["server", "status", "--data-dir", alias]);
    assert.equal(status.parse().data.state, "ready");
    const initialIdentityPath = join(data, "instance.json"),
      initialIdentityText = await readFile(initialIdentityPath, "utf8");
    const fake = createServer((incoming, outgoing) => {
      assert.equal(incoming.headers.authorization, undefined);
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ ok: true, data: status.parse().data }));
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    try {
      await writeFile(
        initialIdentityPath,
        JSON.stringify({
          ...JSON.parse(initialIdentityText),
          engineUrl: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
        }),
      );
      assert.equal(
        (await run(["server", "status", "--data-dir", data])).parse().error?.code,
        "LOCAL_SERVER_UNKNOWN",
      );
    } finally {
      await writeFile(initialIdentityPath, initialIdentityText);
      fake.closeAllConnections();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
  await phase("persistent execution, child invocation and paginated logs", async () => {
    args = ["run", "--car", built.car, "--input", "-", "--engine", engine];
    const success = await run(args, '{"value":7}');
    assert.equal(success.code, 0, success.stdout + success.stderr);
    taskId = String(success.parse().data.taskId);
    assert.deepEqual((success.parse().data.output as { result: unknown }).result, { value: 7 });
    outputCid = (success.parse().data.output as { cid: string }).cid;
    assert.equal(typeof outputCid, "string");
    assert.equal(Object.hasOwn(success.parse().data, "result"), false);
    assert.equal(Object.hasOwn(success.parse().data, "outputCid"), false);
    assert.deepEqual(Object.keys(success.parse()), ["ok", "data"]);
    const business = {
      mode: "echo",
      requestId: "business-id",
      bundle: "business-bundle",
      type: "business-type",
      timeoutMs: -1,
    };
    const echoed = await run(args, JSON.stringify(business));
    assert.equal(echoed.code, 0, echoed.stdout);
    assert.deepEqual((echoed.parse().data.output as { result: unknown }).result, business);
    const nullResult = await run(args, '{"mode":"null"}');
    assert.equal(nullResult.code, 0, nullResult.stdout);
    assert.equal((nullResult.parse().data.output as { result: unknown }).result, null);
    const parentEntry = join(directory, "parent.ts");
    await writeFile(
      parentEntry,
      `export default async(input,context)=>context.invokeTask({
key:"child",cid:${JSON.stringify(built.cid)},path:"resources/child",input,timeoutMs:15000});`,
    );
    const parent = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "managed parent",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        inputSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      entry: parentEntry,
      outDirectory: join(directory, "parent"),
      resources: Object.fromEntries(
        [...built.files.keys()].map((path) => [
          `resources/child/${path}`,
          join(built.directory, ...path.split("/")),
        ]),
      ),
    });
    const childRun = await run(
      ["run", "--car", parent.car, "--input", "-", "--engine", engine],
      '{"value":9}',
    );
    assert.equal(childRun.code, 0, childRun.stdout);
    assert.deepEqual((childRun.parse().data.output as { result: unknown }).result, { value: 9 });
    const query = await run(["task", "query", "--id", taskId, "--engine", engine]);
    assert.equal((query.parse().data.items as unknown[]).length, 1);
    const logs = await run(["task", "logs", taskId, "--limit", "17", "--engine", engine]);
    assert.equal((logs.parse().data.logs as unknown[]).length, 17, logs.stdout);
    const cursor = String(logs.parse().data.nextCursor);
    assert.equal((logs.parse().data.logs as { message: string }[])[0]!.message, "entry-0");
    const tail = await run([
      "task",
      "logs",
      taskId,
      "--limit",
      "17",
      "--cursor",
      cursor,
      "--engine",
      engine,
    ]);
    assert.equal((tail.parse().data.logs as unknown[]).length, 13);
    assert.equal((tail.parse().data.logs as { message: string }[])[0]!.message, "entry-17");
    failure = await run(args, '{"mode":"failure"}');
    assert.equal(failure.code, 1, failure.stdout);
    assert.equal(failure.parse().data.status, "failed");
  });
  await phase("query filters, cursors and invalid input", async () => {
    const query = await run(["task", "query", "--id", taskId, "--engine", engine]);
    const cursor = String(
      (await run(["task", "logs", taskId, "--limit", "17", "--engine", engine])).parse().data
        .nextCursor,
    );
    const union = await run([
      "task",
      "query",
      "--status",
      "failed",
      "--status",
      "succeeded",
      "--engine",
      engine,
    ]);
    const unionIds = (union.parse().data.items as { taskId: string }[]).map((item) => item.taskId);
    assert.ok(unionIds.includes(taskId) && unionIds.includes(String(failure.parse().data.taskId)));
    const firstPage = await run(["task", "query", "--limit", "1", "--engine", engine]);
    const nextPage = await run([
      "task",
      "query",
      "--limit",
      "1",
      "--cursor",
      String(firstPage.parse().data.nextCursor),
      "--engine",
      engine,
    ]);
    assert.notDeepEqual(firstPage.parse().data.items, nextPage.parse().data.items);
    const createdAt = String((query.parse().data.items as { createdAt: string }[])[0]!.createdAt);
    const bounded = await run([
      "task",
      "query",
      "--since",
      createdAt,
      "--until",
      new Date(Date.parse(createdAt) + 1).toISOString(),
      "--engine",
      engine,
    ]);
    assert.equal((bounded.parse().data.items as { taskId: string }[])[0]!.taskId, taskId);
    const upper = await run(["task", "query", "--until", createdAt, "--engine", engine]);
    assert.equal(
      (upper.parse().data.items as { taskId: string }[]).some((item) => item.taskId === taskId),
      false,
    );
    assert.equal(
      (await run(["task", "query", "--id", taskId, "--limit", "1", "--engine", engine])).code,
      1,
    );
    assert.equal(
      (await run(["task", "query", "--since", "2026-02-30T00:00:00Z", "--engine", engine])).code,
      1,
    );
    assert.equal(
      (
        await run([
          "task",
          "logs",
          String(failure.parse().data.taskId),
          "--cursor",
          cursor,
          "--engine",
          engine,
        ])
      ).code,
      1,
    );
    const invalid = await run(args, "[]");
    assert.equal(invalid.code, 1);
    assert.deepEqual(Object.keys(invalid.parse().error!).sort(), ["code", "message"]);
    assert.equal((await run([...args, "--json"], "{}")).code, 1);
    const absent = await run(["task", "query", "--id", "absent", "--engine", engine]);
    assert.deepEqual(absent.parse().data.items, []);
    assert.equal((await run(["task", "logs", "absent", "--engine", engine])).code, 1);
  });
  await phase("execution budgets, interruption and confirmed shutdown", async () => {
    const timeout = await run([...args, "--timeout-ms", "150"], '{"mode":"slow"}');
    assert.equal(timeout.code, 1, timeout.stdout);
    assert.equal(timeout.parse().data.status, "timed_out");
    const bootEntry = join(directory, "boot.ts");
    await writeFile(
      bootEntry,
      "const until=Date.now()+500;while(Date.now()<until){};export default async()=>({mustNotRun:true});",
    );
    const boot = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "bootstrap budget",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        inputSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      entry: bootEntry,
      outDirectory: join(directory, "boot"),
      resources: {},
    });
    const delayedFiles = new Map(boot.files);
    delayedFiles.set(
      "worker.cjs",
      Buffer.concat([
        Buffer.from("const bootstrapUntil=Date.now()+500;while(Date.now()<bootstrapUntil){};"),
        delayedFiles.get("worker.cjs")!,
      ]),
    );
    const delayedCar = await encodeTaskBundleCar(memoryTree(delayedFiles));
    try {
      await writeFile(boot.car, Buffer.from(await new Response(delayedCar.stream).arrayBuffer()));
    } finally {
      await delayedCar.close();
    }
    const bootTimeout = await run(
      ["run", "--car", boot.car, "--input", "-", "--timeout-ms", "50", "--engine", engine],
      "{}",
    );
    assert.equal(bootTimeout.parse().data.status, "timed_out", bootTimeout.stdout);
    assert.equal(bootTimeout.parse().error?.code, "TASK_TIMED_OUT");
    assert.equal(
      Object.hasOwn(bootTimeout.parse().data, "result"),
      false,
      "Expired bootstrap must not enter task code.",
    );
    const cancelled = await run(args, '{"mode":"slow"}', 400);
    assert.equal(cancelled.code, 130, cancelled.stdout);
    assert.equal(cancelled.parse().data.status, "cancelled");
    const asyncResult = await run([...args, "--async"], '{"mode":"slow"}');
    assert.equal(asyncResult.code, 0);
    const asyncId = String(asyncResult.parse().data.taskId);
    const waiting = await run(["task", "await", asyncId, "--engine", engine], undefined, 200);
    assert.equal(waiting.code, 130, waiting.stdout);
    const activeStop = await run(["server", "stop", "--data-dir", data]);
    assert.equal(activeStop.parse().error?.code, "ACTIVE_TASKS");
    const stopped = await run(["server", "stop", "--data-dir", data, "--cancel-running"]);
    assert.equal(stopped.code, 0, stopped.stdout);
  });
  await phase("stale identity, restart recovery and offline cleanup", async () => {
    const identityPath = join(data, "instance.json");
    const identityText = await readFile(identityPath, "utf8");
    const identity = JSON.parse(identityText) as { pid: number; birth: string };
    await writeFile(
      identityPath,
      JSON.stringify({ ...JSON.parse(identityText), pid: process.pid, birth: "unrelated" }),
    );
    assert.equal(
      (await run(["server", "status", "--data-dir", data])).parse().error?.code,
      "LOCAL_SERVER_UNKNOWN",
    );
    assert.equal((await run(["server", "stop", "--data-dir", data])).code, 1);
    await writeFile(identityPath, identityText);
    const liveBirth = (await processBirth(process.pid))!;
    const previousBirth =
      process.platform === "win32"
        ? "000000000000000001"
        : process.platform === "linux"
          ? `${liveBirth.split(":")[0]}:0`
          : "Thu Jan 1 00:00:00 1970";
    await writeFile(
      identityPath,
      JSON.stringify({ ...JSON.parse(identityText), pid: process.pid, birth: previousBirth }),
    );
    assert.equal(
      (await run(["server", "status", "--data-dir", data])).parse().data.state,
      "stopped",
    );
    assert.equal((await run(["server", "stop", "--data-dir", data])).parse().data.changed, false);
    process.kill(process.pid, 0);
    await writeFile(identityPath, identityText);
    assert.equal((await run([...start, "--max-payload-bytes", "131072"])).code, 0);
    const largeBusiness = { mode: "echo", text: "x".repeat(70000) };
    const large = await run(args, JSON.stringify(largeBusiness));
    assert.equal(large.code, 0, large.stdout.slice(0, 512));
    assert.deepEqual((large.parse().data.output as { result: unknown }).result, largeBusiness);
    const retained = await run(["task", "await", taskId, "--engine", engine]);
    assert.equal(retained.code, 0, retained.stdout);
    assert.deepEqual((retained.parse().data.output as { result: unknown }).result, { value: 7 });
    assert.equal((retained.parse().data.output as { cid: string }).cid, outputCid);
    const crashTask = await run([...args, "--async"], '{"mode":"slow"}');
    const crashIdentity = JSON.parse(await readFile(identityPath, "utf8")) as { pid: number };
    assert.notEqual(crashIdentity.pid, identity.pid);
    process.kill(crashIdentity.pid, "SIGKILL");
    assert.equal((await run(start)).code, 0);
    const interrupted = await run([
      "task",
      "await",
      String(crashTask.parse().data.taskId),
      "--engine",
      engine,
    ]);
    assert.equal(
      interrupted.parse().error?.code,
      "TASK_INTERRUPTED_BY_RESTART",
      interrupted.stdout,
    );
    assert.equal(interrupted.parse().data.status, "failed");
    const restartedStop = await run(["server", "stop", "--data-dir", data]);
    assert.equal(restartedStop.code, 0, restartedStop.stdout + restartedStop.stderr);
    const prune = await run([
      "data",
      "prune",
      "--task",
      String(failure.parse().data.taskId),
      "--cache",
      "--data-dir",
      data,
    ]);
    assert.equal(prune.code, 0, prune.stdout);
    assert.equal(prune.parse().data.deletedTasks, 1);
    assert.equal(prune.parse().data.deletedLogs, 30);
    assert.equal(prune.parse().data.deletedCacheBlocks, 0);
  });
  await phase("configuration and installed help", async () => {
    const listed = await run(["config", "list"]);
    const items = listed.parse().data.items as {
      key: string;
      effectiveValue: unknown;
      source: string;
    }[];
    assert.equal(items.length, 15);
    assert.deepEqual(
      items.map((item) => item.key),
      items.map((item) => item.key).sort(),
    );
    const expectedLimits: Record<string, number> = {
      "server.maxConcurrent": 64,
      "server.maxPreparing": 1000,
      "server.maxChildDepth": 4,
      "server.maxChildConcurrent": 4,
      "server.maxChildTotal": 64,
      "server.maxPayloadBytes": 65536,
      "server.bundleConcurrency": 4,
      "server.bundleMaxBytes": 67108864,
      "server.maxConnections": 256,
    };
    for (const [key, value] of Object.entries(expectedLimits))
      assert.equal(items.find((item) => item.key === key)?.effectiveValue, value);
    assert.equal(items.find((item) => item.key === "server.ipfsGateway")?.source, "unset");
    assert.equal((await run(["config", "get", "not-a-key"])).code, 1);
    assert.equal((await run(["config", "set", "server.port", "9999"])).code, 0);
    assert.equal(
      (await run(["config", "get", "client.engine"])).parse().data.effectiveValue,
      "http://127.0.0.1:8787",
    );
    assert.equal((await run(["config", "get", "server.port"])).parse().data.effectiveValue, 9999);
    const writes = await Promise.all([
      run(["config", "set", "client.engine", engine]),
      run(["config", "set", "task.timeoutMs", "4567"]),
    ]);
    assert.deepEqual(
      writes.map((item) => item.code),
      [0, 0],
    );
    assert.equal(
      (await run(["config", "get", "task.timeoutMs"])).parse().data.effectiveValue,
      4567,
    );
    assert.equal((await run(["config", "reset", "task.timeoutMs"])).parse().data.changed, true);
    assert.equal((await run(["config", "reset", "task.timeoutMs"])).parse().data.changed, false);
    const configPath =
      process.platform === "win32"
        ? join(directory, "configuration", "TaskEngine", "config.json")
        : join(directory, ".task-engine", "config.json");
    const saved = await readFile(configPath, "utf8");
    assert.match(saved, /"server.port"/);
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(saved), "unknown.setting": true }));
    assert.equal((await run(["config", "list"])).code, 1);
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(saved), "server.port": 0 }));
    assert.equal((await run(["config", "list"])).code, 1);
    await writeFile(configPath, "broken");
    assert.equal((await run(["config", "list"])).code, 1);
    assert.equal((await run(["server", "--help"])).code, 0);
    assert.match((await run(["server"])).stdout, /Commands: start, status, stop/);
    assert.equal((await run(["--version"])).code, 0);
  });
  completed = true;
});

test("succeeded is not final until real Worker host cleanup is confirmed; cleanup failure never succeeds", {
  timeout: 90_000,
}, async (t) => {
  const directory = resolve(".cache", `release-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "main.ts");
  await writeFile(entry, "export default async()=>({done:true});");
  const built = await buildBundleFixture({
    declaration: {
      $schema: taskSchemaUri,
      name: "release test",
      runtime: { type: "node", minVersion: "22.13.0" },
      entry: "worker.cjs",
      binary: [],
      inputSchema: { type: "object" },
      resultSchema: true,
      messageSchema: false,
    },
    entry,
    outDirectory: join(directory, "bundle"),
    resources: {},
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const uncertain of [false, true]) {
    const data = join(directory, uncertain ? "uncertain" : "delayed");
    const marker = join(directory, `${uncertain}-entered`),
      release = join(directory, `${uncertain}-release`);
    const port = await freePort(),
      engine = `http://127.0.0.1:${port}`;
    const script = `import {serveManaged} from ${JSON.stringify(new URL("../dist/managed.js", import.meta.url).href)};
import {writeFile,access} from "node:fs/promises";
await serveManaged({"server.dataDir":${JSON.stringify(data)},"server.port":${port}},new AbortController().signal,
(message)=>{if(message.type==="result")console.log(JSON.stringify(message.result));},
{async confirmTaskRelease(){await writeFile(${JSON.stringify(marker)},"entered");
while(true){try{await access(${JSON.stringify(release)});break;}catch(error){if(error.code!=="ENOENT")throw error;}
await new Promise(resolve=>setTimeout(resolve,10));}
if(${uncertain})throw new Error("controlled missing release proof");}});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    try {
      const deadline = Date.now() + 20_000;
      while (!stdout.includes('"ready"')) {
        assert.ok(Date.now() < deadline, stderr);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const accepted = await execute(
        ["run", "--car", built.car, "--input", "-", "--async", "--engine", engine],
        directory,
        "{}",
      );
      assert.equal(accepted.code, 0, accepted.stdout);
      const id = String(accepted.parse().data.taskId);
      for (;;) {
        try {
          await readFile(marker);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        assert.ok(Date.now() < deadline, "Worker did not enter physical cleanup");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const query = await execute(["task", "query", "--id", id, "--engine", engine], directory);
      assert.equal((query.parse().data.items as { status: string }[])[0]!.status, "succeeded");
      let completed = false;
      const waiting = execute(["task", "await", id, "--engine", engine], directory).then(
        (value) => {
          completed = true;
          return value;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(completed, false);
      await writeFile(release, "release");
      const final = await waiting;
      assert.equal(final.code, uncertain ? 1 : 0, final.stdout);
      if (uncertain) assert.equal(final.parse().error?.code, "RESOURCE_RELEASE_UNCONFIRMED");
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  }
});

test("controlled cache ENOSPC makes a real Server fail-exit without filling the machine disk", {
  timeout: 90_000,
}, async (t) => {
  const directory = resolve(".cache", `fatal-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const data = join(directory, "data"),
    port = await freePort();
  const entry = join(directory, "main.ts");
  await writeFile(entry, "export default async()=>null;");
  const built = await buildBundleFixture({
    declaration: {
      $schema: taskSchemaUri,
      name: "fatal test",
      runtime: { type: "node", minVersion: "22.13.0" },
      entry: "worker.cjs",
      binary: [],
      inputSchema: { type: "object" },
      resultSchema: true,
      messageSchema: false,
    },
    entry,
    outDirectory: join(directory, "bundle"),
    resources: {},
  });
  const script = `import {serveManaged} from ${JSON.stringify(new URL("../dist/managed.js", import.meta.url).href)};
await serveManaged({"server.dataDir":${JSON.stringify(data)},"server.port":${port}},new AbortController().signal,
(message)=>{if(message.type==="result")console.log(JSON.stringify(message.result));},
{beforeCacheWrite(){throw Object.assign(new Error("controlled ENOSPC"),{code:"ENOSPC"});}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part) => {
    stdout += part;
  });
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 20_000;
  while (!stdout.includes('"ready"')) {
    assert.ok(Date.now() < deadline, `Server did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const accepted = await execute(
    ["run", "--car", built.car, "--input", "-", "--async", "--engine", `http://127.0.0.1:${port}`],
    directory,
    "{}",
  );
  assert.equal(accepted.code, 0, accepted.stdout);
  const timer = setTimeout(() => child.kill(), 20_000);
  const exit = await exited.finally(() => clearTimeout(timer));
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /"systemCode":"ENOSPC"/);
  assert.doesNotMatch(stderr, /controlled ENOSPC/);
  const diagnostic = JSON.parse(await readFile(join(data, "daemon-diagnostic.json"), "utf8"));
  assert.equal(diagnostic.event, "storage-failed");
  assert.equal(diagnostic.systemCode, "ENOSPC");
  const instance = JSON.parse(await readFile(join(data, "instance.json"), "utf8")) as {
    released: boolean;
  };
  assert.equal(
    instance.released,
    true,
    "Controlled write fault still allowed owned resource cleanup and durable proof.",
  );
});

test("detached managed daemon retains private diagnostics after a real SQLite write failure", {
  timeout: 90_000,
}, async (t) => {
  const directory = resolve(".cache", `diagnostic-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const data = join(directory, "data"),
    port = await freePort();
  const engine = `http://127.0.0.1:${port}`;
  let pid: number | undefined;
  let birth: string | undefined;
  t.after(async () => {
    if (pid && (await processBirth(pid)) === birth) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  const started = await execute(
    ["server", "start", "--data-dir", data, "--port", String(port)],
    directory,
  );
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const instance = JSON.parse(await readFile(join(data, "instance.json"), "utf8"));
  pid = instance.pid;
  birth = instance.birth;
  const db = new DatabaseSync(join(data, "tasks.sqlite"));
  try {
    db.exec(`CREATE TRIGGER diagnostic_failure BEFORE INSERT ON tasks
      BEGIN SELECT RAISE(FAIL, 'secret-token-and-user-payload'); END;`);
  } finally {
    db.close();
  }
  const bytes = Buffer.from("diagnostic input");
  const client = new MemoryIpfsClient();
  const cid = await client.import(new Map([["input", bytes]]));
  const failed = await execute(
    ["run", "--cid", cid, "--input", "-", "--async", "--engine", engine],
    directory,
    "{}",
  );
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  const deadline = Date.now() + 20_000;
  while (await processBirth(pid!)) {
    assert.ok(Date.now() < deadline, "Fatal daemon did not exit.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const text = await readFile(join(data, "daemon-diagnostic.json"), "utf8");
  const diagnostic = JSON.parse(text);
  assert.equal(diagnostic.event, "storage-failed");
  assert.equal(diagnostic.instanceId, instance.instanceId);
  assert.equal(diagnostic.pid, pid);
  assert.equal(diagnostic.systemCode, "ERR_SQLITE_ERROR");
  assert.equal(typeof diagnostic.sqliteCode, "number");
  assert.doesNotMatch(text, /secret-token-and-user-payload/);
  assert.equal(text.includes(instance.token), false);
  assert.equal(Buffer.byteLength(text), 4096);
});

test("Linux process identity treats an unreaped zombie as exited", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async (t) => {
  const script = `const {spawn}=require("node:child_process");
const child=spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),100)"],{stdio:"ignore"});
console.log(child.pid);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`;
  const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => parent.once("close", resolve));
  t.after(async () => {
    parent.kill("SIGKILL");
    await exited;
  });
  const pid = await new Promise<number>((resolve) =>
    parent.stdout.once("data", (part) => resolve(Number(String(part).trim()))),
  );
  const deadline = Date.now() + 5000;
  for (;;) {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    if (text.slice(text.lastIndexOf(")") + 2).startsWith("Z ")) break;
    assert.ok(Date.now() < deadline, "Expected the child to become an unreaped zombie.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.kill(pid, 0);
  assert.equal(await processBirth(pid), undefined);
});

test("CID async acceptance is durable before a blocked Gateway, prepare failure keeps identity and Worker budget excludes prepare", {
  timeout: 180_000,
}, async (t) => {
  const directory = resolve(".cache", `gateway-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const data = join(directory, "data");
  const port = await freePort();
  const engine = `http://127.0.0.1:${port}`;
  const run = (args: string[], input?: string) => execute(args, directory, input);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  let requests = 0;
  const client = new MemoryIpfsClient();
  const gateway = createServer((incoming, outgoing) => {
    requests++;
    assert.ok(incoming.url!.startsWith("/content/ipfs/"));
    void gate.then(async () => {
      if (fail) {
        outgoing.writeHead(404).end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const cid = new URL(incoming.url!, "http://localhost").pathname.split("/").at(-1)!;
      const bytes = client.blocks.get(cid);
      outgoing
        .writeHead(bytes ? 200 : 404, { "content-type": "application/vnd.ipld.raw" })
        .end(bytes);
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/content/`;
  t.after(async () => {
    release();
    await run(["server", "stop", "--data-dir", data, "--cancel-running"]);
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const entry = join(directory, "main.ts");
  await writeFile(entry, "export default async()=>({value:42});");
  const built = await buildBundleFixture({
    declaration: {
      $schema: taskSchemaUri,
      name: "gateway test",
      runtime: { type: "node", minVersion: "22.13.0" },
      entry: "worker.cjs",
      binary: [],
      inputSchema: { type: "object" },
      resultSchema: true,
      messageSchema: false,
    },
    entry,
    outDirectory: join(directory, "bundle"),
    resources: {},
  });
  const cid = await client.import(built.files);
  assert.equal(
    (
      await run([
        "server",
        "start",
        "--data-dir",
        data,
        "--port",
        String(port),
        "--ipfs-gateway",
        url,
      ])
    ).code,
    0,
  );
  const accepted = await run(
    ["run", "--cid", cid, "--input", "-", "--async", "--engine", engine],
    "{}",
  );
  assert.equal(accepted.code, 0);
  const id = String(accepted.parse().data.taskId);
  assert.equal(accepted.parse().data.status, "pending");
  const query = await run(["task", "query", "--id", id, "--engine", engine]);
  assert.equal((query.parse().data.items as { taskId: string }[])[0]!.taskId, id);
  assert.ok(requests > 0);
  release();
  const failure = await run(["task", "await", id, "--engine", engine]);
  assert.equal(failure.code, 1);
  assert.equal(failure.parse().data.taskId, id);
  assert.equal(failure.parse().data.status, "failed");
  fail = false;
  const began = performance.now();
  const success = await run(
    ["run", "--cid", cid, "--input", "-", "--timeout-ms", "3000", "--engine", engine],
    "{}",
  );
  assert.equal(success.code, 0, success.stdout);
  assert.ok(
    performance.now() - began > 3000,
    "Preparation must exceed the execution budget without consuming it.",
  );
  assert.deepEqual((success.parse().data.output as { result: unknown }).result, { value: 42 });
  assert.equal((await run(["server", "stop", "--data-dir", data])).code, 0);
  const before = requests;
  assert.equal(
    (await run(["server", "start", "--data-dir", data, "--port", String(port)])).code,
    0,
  );
  assert.equal(
    (await run(["run", "--cid", cid, "--input", "-", "--engine", engine], "{}")).code,
    0,
  );
  assert.equal(requests, before, "cache-only restart must not use a network source");
});
