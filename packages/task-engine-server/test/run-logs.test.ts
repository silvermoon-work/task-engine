import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { newId } from "@silvermoon-work/task-engine";
import { MemoryIpfsClient, MemoryStore } from "@silvermoon-work/task-engine/testing";
import { TaskClient } from "@silvermoon-work/task-engine-http";
import { openSqliteStore } from "@silvermoon-work/task-engine-storage";
import {
  type RunLogPage,
  type SubmissionResult,
  TaskError,
  taskSchemaUri,
} from "@silvermoon-work/task-protocol";
import { type ServerOptions, startTaskServer } from "../src/index.js";

const ipfsClient = new MemoryIpfsClient();

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() > deadline)
      throw new Error(`Log observation stalled: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(
  run: (value: { directory: string; bundle: string; receipts: string }) => Promise<void>,
  version = taskSchemaUri,
) {
  const directory = resolve(".cache", `run-logs-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    const declaration = join(directory, "task.yaml");
    const entry = join(directory, "callback.ts");
    const receipts = join(directory, "receipts.jsonl");
    await writeFile(
      declaration,
      JSON.stringify({
        $schema: version,
        name: "Diagnostic test",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: { type: "object" },
        resultSchema: {
          type: "object",
          properties: { ok: { const: true } },
          required: ["ok"],
          additionalProperties: false,
        },
        messageSchema: false,
      }),
    );
    await writeFile(
      entry,
      `
import {appendFileSync} from "node:fs";
import {parentPort,workerData} from "node:worker_threads";
export default async (input, context) => {
  if(input.mode==="generation") {
    parentPort.postMessage({generation:"retired-generation",runId:context.runId,kind:"log",logId:1,value:{level:"error",message:"foreign generation"}});
    parentPort.postMessage({generation:workerData.generation,runId:"foreign-run",kind:"log",logId:1,value:{level:"error",message:"foreign Run"}});
  }
  const receipt = await context.log({level:"info",message:"begin:"+input.label,fields:{label:input.label}});
  appendFileSync(${JSON.stringify(receipts)},JSON.stringify({label:input.label,receipt})+"\\n");
  if(input.mode==="cumulative") {
    parentPort.postMessage({generation:workerData.generation,runId:context.runId,kind:"log-drop",logId:2,count:5});
    parentPort.postMessage({generation:workerData.generation,runId:context.runId,kind:"log-drop",logId:3,count:10,final:true});
    await context.progress({stage:"execution",message:"Cumulative snapshots sent."});
    return {ok:true};
  }
  if(input.mode==="invalid") {
    for(const value of [{level:"fatal",message:"bad"},{level:"info",message:"bad",fields:{n:NaN}},{level:"info",message:"bad",runId:"foreign-run"}]) {
      try { await context.log(value); throw Error("invalid log accepted"); }
      catch(error) { if(error.code!=="invalid_log") throw error; }
    }
  }
  if(input.mode==="overflow") await Promise.all(Array.from({length:250},(_,i)=>context.log({level:"debug",message:"detail:"+i})));
  if(input.mode==="large") {
    const large=await context.log({level:"debug",message:"x".repeat(20000)});
    appendFileSync(${JSON.stringify(receipts)},JSON.stringify({label:input.label,receipt:large})+"\\n");
  }
  if(input.mode==="fail") throw Error("business failure");
  if(input.mode==="cancel") {
    if(!context.signal.aborted) await new Promise(resolve=>context.signal.addEventListener("abort",resolve,{once:true}));
    const error=new Error("cancelled");error.name="AbortError";throw error;
  }
  if(input.mode==="forced") await new Promise(()=>{});
  if(input.mode==="delay") await new Promise(resolve=>setTimeout(resolve,100));
  await context.log({level:"warn",message:"end:"+input.label,fields:{nested:{text:"<script>untrusted</script>"}}});
  return {ok:true};
}`,
    );
    const built = await buildBundleFixture({
      declaration,
      entry,
      outDirectory: join(directory, "bundle"),
    });
    await ipfsClient.import(built.files);
    await rm(entry);
    await run({
      directory,
      receipts,
      bundle: built.cid,
    });
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    );
  }
}
function options(directory: string): ServerOptions {
  return {
    database: join(directory, "tasks.sqlite"),
    ipfsClient,
    port: 0,
    limits: { tickMs: 5, stopGraceMs: 100, forceExitWaitMs: 1000, healthTimeoutMs: 10_000 },
    resolveCaller: (request) => {
      const token = request.headers.get("authorization");
      if (token !== "Bearer a" && token !== "Bearer b")
        throw new TaskError("unauthenticated", "Unauthorized");
      return { scope: token.slice(-1), subject: "tester" };
    },
    authorize: (caller, _operation, scope) => caller.scope === scope,
  };
}
function client(url: string, token = "a"): TaskClient {
  return new TaskClient({ url, headers: { authorization: `Bearer ${token}` } });
}
async function submit(api: TaskClient, bundle: string, label: string, mode = "success") {
  let decision: SubmissionResult = await api.submit({
    requestId: newId(),
    bundle,
    label,
    mode,
    timeoutMs: 30_000,
  });
  if (decision.status === "preparing")
    decision = await api.getRequestStatus(decision.requestId, { waitMs: 10_000 });
  assert.equal(decision.status, "accepted");
  if (decision.status !== "accepted") throw Error("Admission rejected.");
  const taskId = decision.taskId;
  return until(
    () => api.getTask(taskId),
    (task) => !!task.run,
  );
}
async function ended(api: TaskClient, id: string) {
  return until(
    () => api.getRun(id),
    (run) => !!run.reclaimedAt,
  );
}
test("v1 real SDK -> SQLite -> authenticated HTTP history/realtime, concurrent isolation and restart; Result stays concise", async () => {
  await fixture(async ({ directory, bundle }) => {
    const config = options(directory);
    let server = await startTaskServer(config);
    try {
      const api = client(server.url);
      const [a, b] = await Promise.all([
        submit(api, bundle, "A", "delay"),
        submit(api, bundle, "B", "delay"),
      ]);
      const ids = [a.run!.runId, b.run!.runId];
      const first = await api.getRunLogs(ids[0]!, { limit: 1 });
      assert.equal(first.entries[0]?.message, "begin:A");
      const pages: RunLogPage[] = [];
      for await (const page of api.subscribeRunLogs(ids[0]!, {
        afterSequence: first.nextSequence,
        limit: 1,
      }))
        pages.push(page);
      await Promise.all(ids.map((id) => ended(api, id)));
      assert.deepEqual(
        pages.flatMap((page) => page.entries).map((entry) => entry.message),
        ["end:A"],
      );
      assert.equal(pages.at(-1)?.state.completeness, "complete");
      for (const [index, id] of ids.entries()) {
        const page = await api.getRunLogs(id);
        assert.deepEqual(
          page.entries.map((entry) => entry.sequence),
          [1, 2],
        );
        assert.ok(
          page.entries.every(
            (entry) => entry.runId === id && entry.message.endsWith(index === 0 ? "A" : "B"),
          ),
        );
        assert.deepEqual((await api.getRun(id)).output?.result, { data: { ok: true }, cidPaths: [] });
        assert.equal(
          (await api.getRunHistory(id)).events.some((event) => event.type.includes("log")),
          false,
        );
        await assert.rejects(client(server.url, "b").getRunLogs(id), { code: "forbidden" });
        await assert.rejects(
          async () => {
            for await (const _page of client(server.url, "b").subscribeRunLogs(id)) {
            }
          },
          { code: "forbidden" },
        );
      }
      const missing = await fetch(`${server.url}/runs/${ids[0]}/logs`);
      assert.equal(missing.status, 401);
      await assert.rejects(api.getRunLogs(newId()), { code: "not_found" });
      await assert.rejects(api.getRunLogs(ids[0]!, { afterSequence: -1 }), {
        code: "invalid_log_cursor",
      });
      const before = await api.getRunLogs(ids[0]!);
      await server.close();
      server = await startTaskServer(config);
      assert.deepEqual(await client(server.url).getRunLogs(ids[0]!), before);
    } finally {
      await server.close();
    }
  });
});
test("failure, cooperative cancel, forced stop, invalid inputs, output overflow and large entries preserve lifecycle/reclamation", async () => {
  await fixture(async ({ directory, bundle, receipts }) => {
    const server = await startTaskServer({ ...options(directory), logs: { runEntries: 4 } });
    try {
      const api = client(server.url);
      for (const mode of [
        "fail",
        "cancel",
        "invalid",
        "generation",
        "cumulative",
        "overflow",
        "large",
      ]) {
        const task = await submit(api, bundle, mode, mode);
        const id = task.run!.runId;
        if (mode === "cancel") await api.cancelTask(task.taskId);
        const run = await ended(api, id);
        const logs = await api.getRunLogs(id);
        assert.equal(logs.entries[0]?.message, `begin:${mode}`);
        if (mode === "fail") assert.equal(run.stage, "failed");
        else if (mode === "cancel") {
          assert.equal(logs.state.completeness, "unknown");
        } else assert.deepEqual(run.output?.result, { data: { ok: true }, cidPaths: [] });
        if (mode === "generation")
          assert.deepEqual(
            logs.entries.map((entry) => entry.message),
            ["begin:generation", "end:generation"],
          );
        if (mode === "cumulative") {
          assert.equal(
            logs.state.dropped,
            10,
            "Terminal cumulative snapshots must not double count the ordinary report.",
          );
          assert.equal(logs.entries.length, 1);
          assert.equal(logs.state.availability, "truncated");
        }
        if (mode === "overflow" || mode === "large") {
          assert.equal(logs.state.availability, "truncated");
          assert.ok(logs.state.dropped > 0);
          assert.ok(logs.entries.length <= 4);
          if (mode === "overflow") assert.equal(logs.state.dropped, 248);
        }
      }
      const written = (await readFile(receipts, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(written.some((value) => value.receipt.state === "stored"));
      assert.ok(written.some((value) => value.receipt.reason === "entry_too_large"));
    } finally {
      await server.close();
    }
  });
});
test("forced stop keeps physical-exit and unknown-cleanup policy independent from log tail; no diagnostic drain is required", async () => {
  await fixture(async ({ directory, bundle }) => {
    const { database: _database, ...base } = options(directory);
    const server = await startTaskServer({ ...base, store: new MemoryStore() });
    const api = client(server.url);
    try {
      const task = await submit(api, bundle, "forced", "forced");
      const id = task.run!.runId;
      await until(
        () => api.getRunLogs(id),
        (page) => page.entries.length > 0,
      );
      await api.cancelTask(task.taskId);
      const run = await until(
        () => api.getRun(id),
        (value) => !!value.exit && !!value.cleanupUnknown,
      );
      assert.equal(run.exit?.forced, true);
      assert.equal(run.stage, "stopped");
      assert.equal(
        run.reclaimedAt,
        undefined,
        "Logs cannot manufacture an independent cleanup proof.",
      );
      assert.equal((await api.getRunLogs(id)).state.completeness, "unknown");
    } finally {
      await assert.rejects(server.close(), { code: "reclamation_failed" });
    }
  });
});
test("write/storage fault gives unavailable receipts and durable missing status, without blocking final outputs", async () => {
  await fixture(async ({ directory, bundle, receipts }) => {
    let fault = true;
    const store = openSqliteStore(join(directory, "fault.sqlite"), {
      logFault: () => {
        if (fault) throw Error("diagnostic disk fault");
      },
    });
    const { database: _database, ...base } = options(directory);
    const config = { ...base, store };
    let server = await startTaskServer(config);
    try {
      const api = client(server.url);
      const task = await submit(api, bundle, "storage");
      const id = task.run!.runId;
      assert.deepEqual((await ended(api, id)).output?.result, { data: { ok: true }, cidPaths: [] });
      assert.equal((await api.getRunLogs(id)).state.availability, "unavailable");
      assert.match(await readFile(receipts, "utf8"), /"reason":"storage"/);
      await server.close();
      fault = false;
      server = await startTaskServer(config);
      assert.equal((await client(server.url).getRunLogs(id)).state.availability, "unavailable");
    } finally {
      await server.close();
      store.close();
    }
  });
});
test("slow consumers replay pages, retention reports explicit gaps, and subscriptions have a hard capacity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await fixture(async ({ directory, bundle }) => {
    const server = await startTaskServer({
      ...options(directory),
      logs: { retentionMs: 200, maxSubscriptions: 1 },
    });
    try {
      const api = client(server.url);
      const task = await submit(api, bundle, "slow");
      const id = task.run!.runId;
      await ended(api, id);
      const caller = { scope: "a", subject: "tester" };
      const subscription = server.engine.subscribeRunLogs(id, { limit: 1 }, caller);
      assert.equal(subscription.initial.entries.length, 1);
      assert.throws(() => server.engine.subscribeRunLogs(id, {}, caller), {
        code: "capacity_exceeded",
      });
      assert.equal(subscription.pull().entries[0]?.sequence, 2);
      t.mock.timers.tick(250);
      const expired = subscription.pull();
      assert.equal(expired.state.availability, "expired");
      const gap = await api.getRunLogs(id, { afterSequence: 0 });
      assert.equal(gap.gap, true);
      assert.equal(gap.entries.length, 0);
      subscription.close();
      server.engine.subscribeRunLogs(id, {}, caller).close();
    } finally {
      await server.close();
    }
  });
});
test("v1 bundles support diagnostic logs; disabled logging is distinct", async () => {
  await fixture(async ({ directory, bundle, receipts }) => {
    const server = await startTaskServer(options(directory));
    try {
      const api = client(server.url);
      const task = await submit(api, bundle, "v1");
      await ended(api, task.run!.runId);
      const logs = await api.getRunLogs(task.run!.runId);
      assert.equal(logs.state.availability, "available");
      assert.deepEqual(
        logs.entries.map((entry) => entry.message),
        ["begin:v1", "end:v1"],
      );
      assert.match(await readFile(receipts, "utf8"), /"state":"stored"/);
    } finally {
      await server.close();
    }
  }, taskSchemaUri);
  await fixture(async ({ directory, bundle, receipts }) => {
    const server = await startTaskServer({ ...options(directory), logs: { enabled: false } });
    try {
      const api = client(server.url);
      const task = await submit(api, bundle, "disabled");
      await ended(api, task.run!.runId);
      assert.equal((await api.getRunLogs(task.run!.runId)).state.availability, "disabled");
      assert.match(await readFile(receipts, "utf8"), /"reason":"disabled"/);
    } finally {
      await server.close();
    }
  });
});
