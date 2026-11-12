import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { buildTaskBundle } from "@silvermoon-work/task-builder";
import { readBytes } from "@silvermoon-work/task-builder/tree";
import { directoryTree } from "@silvermoon-work/task-builder-cli/node";
import { type Json, readTaskBundle, taskSchemaUri } from "@silvermoon-work/task-protocol";
import { precompileCases } from "../../task-protocol/test/precompile-fixtures.js";
import { createTaskEngine, newId } from "../src/index.js";
import { MemoryIpfsClient, MemoryStore } from "../src/testing.js";
import { TypeSupervisor, type RunOutcomeReport, type TypeChannel } from "../src/type-supervisor.js";

const object = { type: "object" };
const text = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const declaration = {
  $schema: taskSchemaUri,
  name: "Engine contracts",
  runtime: { type: "node", minVersion: "22.13.0" },
  entry: "worker.cjs",
  binary: [],
  inputSchema: object,
  resultSchema: text,
  messageSchema: false,
};
async function fixture(action: (directory: string) => Promise<void>) {
  const directory = resolve(".cache", `host-contract-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function until(check: () => boolean) {
  const end = performance.now() + 15000;
  while (!check()) {
    if (performance.now() > end) throw new Error("Host contract outcome/reclamation timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function compile(directory: string, source: string, schemas: Record<string, unknown> = {}) {
  const entry = join(directory, "main.ts");
  await writeFile(entry, source);
  const repository = resolve("..", "..");
  const contract = { ...declaration, ...schemas };
  const tree = await buildTaskBundle(await directoryTree(repository), {
    name: declaration.name,
    runtime: { minVersion: declaration.runtime.minVersion },
    source: {
      entry: relative(repository, entry).split(sep).join("/"),
      mode: "explicit",
      contract: {
        input: contract.inputSchema,
        result: contract.resultSchema,
        message: contract.messageSchema,
      },
    },
  });
  const contents = new Map<string, Buffer>();
  const collect = async (directory: string): Promise<void> => {
    for (const file of await tree.list(directory)) {
      const path = directory ? `${directory}/${file.name}` : file.name;
      if (file.kind === "directory") await collect(path);
      else contents.set(path, Buffer.from(await readBytes(tree, path, 1_048_576)));
    }
  };
  await collect("");
  const { resolved } = readTaskBundle(contents);
  const cid = await new MemoryIpfsClient().import(contents);
  return { contents, resolved, cid };
}
type Built = Awaited<ReturnType<typeof compile>>;

test("IPFS module entry preserves Builder URLs, CJS APIs, cache and per-Run isolation", async () => {
  await fixture(async (directory) => {
    const built = await compile(
      directory,
      `import {runTask} from "@silvermoon-work/task-sdk";
const state = globalThis;
state.moduleEvaluations = (state.moduleEvaluations ?? 0) + 1;
runTask(async () => {
  const cached = require.cache[__filename];
  const first = module.require(__filename);
  const second = module.require(__filename);
  let ipfsResolve;
  try { require.resolve(__filename); } catch (error) { ipfsResolve = error.code; }
  return {
    url: import.meta.url, filename: __filename, dirname: __dirname,
    require: typeof require, cache: typeof require.cache,
    resolve: require.resolve("node:path"), paths: typeof require.resolve.paths,
    cached: Boolean(cached), same: first === second && cached.exports === first,
    evaluations: state.moduleEvaluations, ipfsResolve,
    builtin: typeof module.require("node:crypto").createHash,
    options: process.env.NODE_OPTIONS, sourceVisible: "bundleSource" in module.require("node:worker_threads").workerData
  };
});`,
      { resultSchema: true },
    );
    const expected = {
      url: `ipfs://${built.cid}/worker.cjs`,
      filename: `ipfs://${built.cid}/worker.cjs`,
      dirname: `ipfs://${built.cid}`,
      require: "function",
      cache: "object",
      resolve: "node:path",
      paths: "function",
      cached: true,
      same: true,
      evaluations: 1,
      ipfsResolve: "MODULE_NOT_FOUND",
      builtin: "function",
      options: "",
      sourceVisible: false,
    };
    const runs = await Promise.all([supervise(built, {}), supervise(built, {})]);
    for (const observed of runs)
      assert.deepEqual(observed?.outcomes, [{ kind: "completed", result: expected }]);
  });
});

test("IPFS module hook rejects non-entry addresses without disclosing credentials", async () => {
  await fixture(async (directory) => {
    const built = await compile(
      directory,
      `import {runTask} from "@silvermoon-work/task-sdk";
runTask(async () => {
  const cid = __filename.slice(7, -11);
  const requests = [
    "ipfs://" + cid + "/resources/data.js",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76u7cnngv7cbd3gbta6ipjcnpf7bh6zyvle/worker.cjs",
    "ipfs://invalid/worker.cjs", "ipfs://user:secret@" + cid + "/worker.cjs",
    "ipfs://" + cid + "/other/../worker.cjs",
    "ipfs://" + cid + "/%77orker.cjs",
    "ipfs://" + cid + "/%2e%2e/worker.cjs",
    "ipfs://" + cid + "/worker.cjs?query",
    "ipfs://" + cid + "/worker.cjs#fragment",
    "ipfs://" + cid + "/worker.cjs?", "ipfs://" + cid + "/worker.cjs#",
    "ipfs://" + cid + "/worker.cjs/extra",
    "./resources/data.js", "file:///host-secret.cjs", "https://user:secret@host/code.js",
    "unbundled-package"
  ];
  return requests.map(request => {
    try { Reflect.apply(module.require, module, [request]); return {loaded: true}; }
    catch (error) { return {code: error.code, message: error.message}; }
  });
});`,
      { resultSchema: true },
    );
    const observed = await supervise(built, {});
    const outcome = observed?.outcomes[0];
    assert.ok(outcome?.kind === "completed" && Array.isArray(outcome.result));
    const result = outcome.result;
    assert.equal(result.length, 16);
    for (const error of result) {
      assert.ok(error && typeof error === "object" && !Array.isArray(error));
      assert.equal(error.code, "unsupported_module");
      assert.ok(typeof error.message === "string");
      assert.match(error.message, new RegExp(`ipfs://${built.cid}/worker.cjs`));
      assert.doesNotMatch(error.message, /secret|host-secret|user:/);
    }
    const local = new URL("./isolated-type.mjs", import.meta.url).href;
    assert.equal(
      typeof (await import(local)).createType,
      "function",
      "host local loading is unchanged",
    );
  });
});

test("IPFS module lifecycle logs, cancels and confirms physical exit without inventing cleanup proof", async () => {
  await fixture(async (directory) => {
    const built = await compile(
      directory,
      `import {runTask} from "@silvermoon-work/task-sdk";
runTask(async (input, context) => {
  await context.log({level: "info", message: "IPFS entry loaded"});
  await context.progress({stage: "execution", message: "ready"});
  if (input.blocked) { for (;;) {} }
  await new Promise(resolve => context.signal.addEventListener("abort", resolve, {once: true}));
  return {cancelled: context.signal.aborted};
});`,
      { resultSchema: true },
    );
    for (const blocked of [false, true]) {
      const progress: Json[] = [],
        logs: string[] = [],
        outcomes: RunOutcomeReport[] = [];
      let exited = false,
        released = false;
      let loss: string | undefined;
      const supervisor = new TypeSupervisor(
        {
          type: built.cid,
          version: "1",
          environment: "ipfs-lifecycle",
          ...built.resolved,
          bundle: { cid: built.cid, declaration: built.resolved },
          module: `ipfs://${built.cid}/worker.cjs`,
          exportName: "",
          configuration: null,
          getBundleSource: () => built.contents.get("worker.cjs")!.toString(),
        },
        {
          async progress(_run, value) {
            progress.push(value);
          },
          log(_run, _generation, _scope, value) {
            logs.push(value.message);
            return { state: "unavailable", reason: "disabled" };
          },
          async complete() {},
          async failed() {},
          async confirm() {},
          async outcome(_run, value) {
            outcomes.push(value);
          },
          async exited() {
            exited = true;
          },
          released() {
            assert.equal(exited, true);
            released = true;
          },
          lost(_runs, error) {
            loss = error.code;
          },
        },
        {
          heartbeatMs: 20,
          healthMs: 5000,
          maxInFlight: 8,
          maxPayloadBytes: 65536,
          stopGraceMs: 1000,
          forceExitWaitMs: 1000,
        },
      );
      try {
        await supervisor.run("run", { blocked }, "scope");
        await until(() => progress.length === 1);
        assert.deepEqual(logs, ["IPFS entry loaded"]);
        if (blocked) {
          const exit = await supervisor.forceTerminate("run");
          assert.equal(exit.forced, true);
        } else supervisor.cancel("run");
        await until(() => released || loss !== undefined);
        assert.equal(exited, true);
        assert.equal(loss, blocked ? "reclamation_unknown" : undefined);
        assert.equal(released, !blocked);
        assert.equal(supervisor.canRoute("run"), false);
        if (!blocked)
          assert.deepEqual(outcomes, [{ kind: "completed", result: { cancelled: true } }]);
      } finally {
        await supervisor.close();
      }
    }
  });
});

async function supervise(
  built: Built,
  input: Json,
  message?: Json,
  rejectInput = false,
  rejectMessage = false,
) {
  const outcomes: RunOutcomeReport[] = [],
    checkpoints: Json[] = [],
    confirmations: string[] = [];
  let exited = false,
    released = false,
    dispatched = false,
    lost = false;
  const channel: TypeChannel = {
    async progress() {},
    async complete() {},
    async failed() {},
    async checkpoint(_id, value) {
      checkpoints.push(value);
    },
    async outcome(_id, value) {
      outcomes.push(value);
    },
    async dispatch() {
      dispatched = true;
    },
    async confirm(_run, _task, id) {
      confirmations.push(id);
    },
    async exited() {
      exited = true;
    },
    released() {
      released = true;
    },
    lost() {
      lost = true;
    },
  };
  const supervisor = new TypeSupervisor(
    {
      type: built.cid,
      version: "1",
      environment: "host-contract",
      ...built.resolved,
      bundle: { cid: built.cid, declaration: built.resolved },
      module: "",
      exportName: "",
      configuration: {},
      getBundleSource: () => built.contents.get("worker.cjs")!.toString(),
    },
    channel,
    { heartbeatMs: 20, healthMs: 5000, maxInFlight: 8, maxPayloadBytes: 65536 },
  );
  try {
    if (rejectInput) {
      await assert.rejects(supervisor.run("run", input, "scope"), { code: "invalid_input" });
      assert.equal(dispatched, false);
      assert.equal(outcomes.length, 0);
      return;
    }
    await supervisor.run("run", input, "scope");
    if (message !== undefined || rejectMessage) {
      const value = {
        messageId: "message",
        taskId: "task",
        caller: { scope: "scope", subject: "actor" },
        payload: message!,
      };
      if (rejectMessage) {
        assert.throws(() => supervisor.message("run", value), { code: "invalid_input" });
        supervisor.cancel("run");
      } else supervisor.message("run", value);
    }
    await until(() => released || lost);
    assert.equal(lost, false);
    assert.equal(exited, true, "release must follow physical exit");
    assert.equal(released, true);
    if (!rejectMessage) assert.equal(outcomes.length, 1);
    if (rejectMessage) assert.equal(confirmations.length, 0);
    return { outcomes, checkpoints };
  } finally {
    await supervisor.close();
  }
}

for (const scenario of precompileCases)
  test(`Engine alone enforces shared schema data at every boundary: ${scenario.name}`, async () => {
    await fixture(async (directory) => {
      const boxed = {
        type: "object",
        properties: { value: scenario.schema },
        required: ["value"],
        additionalProperties: false,
        ...(scenario.schema && typeof scenario.schema === "object" && "$defs" in scenario.schema
          ? { $defs: scenario.schema.$defs }
          : {}),
      };
      for (const role of ["input", "result", "message"]) {
        const built = await compile(
          directory,
          role === "message"
            ? 'import {runTask} from "@silvermoon-work/task-sdk"; runTask(async (_input, context) => {for await(const message of context.messages){await message.accept();return message.payload;}return null;});'
            : 'import {runTask} from "@silvermoon-work/task-sdk"; runTask(async input => input.value);',
          {
            inputSchema: role === "input" ? boxed : object,
            resultSchema: role === "result" ? scenario.schema : true,
            messageSchema: role === "message" ? scenario.schema : false,
          },
        );
        for (const value of scenario.good) {
          const observed = await supervise(
            built,
            { value: value as Json },
            role === "message" ? (value as Json) : undefined,
          );
          assert.deepEqual(observed?.outcomes, [{ kind: "completed", result: value }]);
        }
        for (const value of scenario.bad) {
          const observed = await supervise(
            built,
            { value: value as Json },
            role === "message" ? (value as Json) : undefined,
            role === "input",
            role === "message",
          );
          if (role === "result")
            assert.deepEqual(observed?.outcomes, [
              {
                kind: "failed",
                error: { code: "invalid_input", message: "Input does not satisfy inputSchema." },
              },
            ]);
        }
      }
    });
  });

for (const mode of [
  "result",
  "failure-evidence",
  "valid-evidence",
  "malformed-json",
  "cyclic-result",
  "date-result",
  "bigint-result",
  "oversized-result",
  "deep-result",
  "uncloneable-result",
  "uncloneable-evidence",
])
  test(`real Engine persists only validated output and reclaims the Worker: ${mode}`, async () => {
    await fixture(async (directory) => {
      const code = {
        result: "return {text: 1};",
        "failure-evidence": 'throw new RunFailure("business", "business failure", {text: 1});',
        "valid-evidence":
          'throw new RunFailure("business", "business failure", {text: "evidence"});',
        "malformed-json": "return undefined;",
        "cyclic-result": "const value={text:'cycle'}; value.self=value; return value;",
        "date-result": "return new Date();",
        "bigint-result": "return {text:1n};",
        "oversized-result": "return {text:'x'.repeat(65536)};",
        "deep-result":
          "let value={text:'nested'}; for(let i=0;i<70;i++) value={child:value}; return value;",
        "uncloneable-result": "return {text:()=>{}};",
        "uncloneable-evidence":
          'throw new RunFailure("business", "business failure", {text:()=>{}});',
      }[mode]!;
      const built = await compile(
        directory,
        `import {runTask,RunFailure} from "@silvermoon-work/task-sdk"; runTask(async(input,context)=>{${code}});`,
      );
      const client = new MemoryIpfsClient();
      const cid = await client.import(built.contents);
      const store = new MemoryStore();
      const engine = createTaskEngine({
        store,
        ipfsClient: client,
        authorize: () => true,
        limits: { maxConcurrent: 1 },
      });
      const caller = { scope: "scope", subject: "actor" };
      await engine.start();
      try {
        const requestId = newId();
        let decision = await engine.submit({ requestId, bundle: cid, timeoutMs: 15000 }, caller);
        while (decision.status === "preparing")
          decision = await engine.getRequestStatus(requestId, { waitMs: 1000 }, caller);
        assert.equal(decision.status, "accepted", JSON.stringify(decision));
        if (decision.status !== "accepted") throw new Error("Expected accepted request.");
        const taskId = decision.taskId;
        await until(() => engine.getTask(taskId, caller).stage === "failed");
        const task = engine.getTask(taskId, caller);
        const runId = task.run!.runId;
        await until(() => !!engine.getRun(runId, caller).reclaimedAt);
        const run = engine.getRun(runId, caller);
        assert.equal(
          task.error?.code,
          mode === "valid-evidence"
            ? "business"
            : mode === "oversized-result"
              ? "payload_too_large"
              : [
                    "malformed-json",
                    "cyclic-result",
                    "date-result",
                    "bigint-result",
                    "deep-result",
                    "uncloneable-result",
                    "uncloneable-evidence",
                    "swallowed-uncloneable-checkpoint",
                  ].includes(mode)
                ? "invalid_payload"
                : "invalid_input",
        );
        assert.equal(run.stage, "failed");
        assert.ok(run.exit);
        assert.equal(run.cleanupUnknown, undefined);
        assert.ok(run.reclaimedAt);
        if (mode === "valid-evidence") assert.deepEqual(task.output?.result, { text: "evidence" });
        else assert.equal(task.output?.result, undefined);
        const persisted = store.read().facts.runs[runId]!;
        assert.notDeepEqual(persisted.output?.result, { text: 1 });
        assert.ok(
          !persisted.evidence?.some((entry) => JSON.stringify(entry.value) === '{"text":1}'),
        );
        if (mode === "result") {
          const nextRequest = newId();
          let next = await engine.submit(
            { requestId: nextRequest, bundle: cid, attempt: 2, timeoutMs: 15000 },
            caller,
          );
          while (next.status === "preparing")
            next = await engine.getRequestStatus(nextRequest, { waitMs: 1000 }, caller);
          assert.equal(next.status, "accepted");
          if (next.status !== "accepted") throw new Error("Expected reusable capacity.");
          const nextTask = next.taskId;
          await until(() => engine.getTask(nextTask, caller).stage === "failed");
          const nextRun = engine.getTask(nextTask, caller).run!.runId;
          assert.notEqual(nextRun, runId);
          await until(() => !!engine.getRun(nextRun, caller).reclaimedAt);
        }
      } finally {
        await engine.close();
        store.close();
      }
    });
  });

test("real Engine rejects input and message before dispatch or persistence", async () => {
  await fixture(async (directory) => {
    const marker = join(directory, "callback.txt");
    const built = await compile(
      directory,
      `
import {runTask} from "@silvermoon-work/task-sdk";
import {appendFileSync} from "node:fs";
runTask(async(input,context)=>{
 appendFileSync(${JSON.stringify(marker)},"callback\\n");
 for await(const message of context.messages){
    appendFileSync(${JSON.stringify(marker)},"message\\n");
    await message.accept();return message.payload;
 }
 return input;
});`,
      { inputSchema: text, messageSchema: text },
    );
    const client = new MemoryIpfsClient(),
      store = new MemoryStore();
    const cid = await client.import(built.contents);
    const engine = createTaskEngine({ store, ipfsClient: client, authorize: () => true });
    const caller = { scope: "scope", subject: "actor" };
    await engine.start();
    const submit = async (value: unknown) => {
      const requestId = newId();
      let decision = await engine.submit(
        { requestId, bundle: cid, text: value, timeoutMs: 15000 },
        caller,
      );
      while (decision.status === "preparing")
        decision = await engine.getRequestStatus(requestId, { waitMs: 1000 }, caller);
      return decision;
    };
    try {
      assert.equal((await submit(1)).status, "rejected");
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const accepted = await submit("valid");
      assert.equal(accepted.status, "accepted");
      if (accepted.status !== "accepted") throw new Error("Expected accepted request.");
      const id = accepted.taskId;
      await until(() => engine.getTask(id, caller).stage === "running");
      const badMessage = newId();
      assert.throws(() => engine.sendTaskMessage(id, badMessage, { text: 1 }, caller), {
        code: "invalid_input",
      });
      assert.equal(Object.keys(store.read().facts.messages).length, 0);
      engine.sendTaskMessage(id, newId(), { text: "message" }, caller);
      await until(() => engine.getTask(id, caller).stage === "completed");
      const task = engine.getTask(id, caller);
      await until(() => !!engine.getRun(task.run!.runId, caller).reclaimedAt);
      assert.deepEqual(task.output?.result, { text: "message" });
      assert.equal(await readFile(marker, "utf8"), "callback\nmessage\n");
    } finally {
      await engine.close();
      store.close();
    }
  });
});

test("Bundle host explicitly rejects a Worker without the Space protocol handshake", async () => {
  await fixture(async (directory) => {
    const built = await compile(
      directory,
      `
import {parentPort,workerData} from "node:worker_threads";
const {generation,bundle}=workerData;
parentPort.postMessage({generation,kind:"ready",value:{$schema:bundle.declaration.$schema,cid:bundle.cid,inputSchema:bundle.declaration.inputSchema,resultSchema:bundle.declaration.resultSchema,messageSchema:bundle.declaration.messageSchema}});
parentPort.on("message",m=>{
 if(m.kind==="run")throw Error("Legacy Worker must not be dispatched");
});
`,
    );
    await assert.rejects(supervise(built, {}), { code: "unsupported_contract" });
  });
});

test("Engine rejects diagnostic and progress payloads through ACK without poisoning later log IDs", async () => {
  await fixture(async (directory) => {
    const built = await compile(
      directory,
      `
  import {runTask} from "@silvermoon-work/task-sdk";
  runTask(async(_input,context)=>{
   const codes=[];
   for(const value of [
     {level:"info",message:"bad",fields:{fn:()=>{}}},
     {level:"invalid",message:"bad"},
     {level:"info",message:"large",fields:{text:"x".repeat(1048576)}},
   ]) {
     try {await context.log(value);throw Error("Invalid log accepted");}
     catch(error) {if(!error.code)throw error;codes.push(error.code);}
   }
   const receipt=await context.log({level:"info",message:"valid"});
   return {codes,receipt};
  });`,
      { resultSchema: true },
    );
    const result = await supervise(built, {});
    assert.deepEqual(result?.outcomes, [
      {
        kind: "completed",
        result: {
          codes: ["invalid_payload", "invalid_log", "invalid_log"],
          receipt: { state: "unavailable", reason: "disabled" },
        },
      },
    ]);
    const progress = await compile(
      directory,
      `
  import {runTask} from "@silvermoon-work/task-sdk";
  runTask(async(_input,context)=>{
   try {await context.progress({stage:"not-a-stage"});}catch{}
   return {text:"valid"};
  });`,
    );
    const rejected = await supervise(progress, {});
    assert.equal(rejected?.outcomes[0]?.kind, "failed");
    const outcome = rejected?.outcomes[0];
    if (outcome?.kind !== "failed") assert.fail("Invalid progress must fail after its NACK.");
    assert.equal(outcome.error.code, "invalid_progress");
  });
});
