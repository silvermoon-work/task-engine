import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { newId } from "@silvermoon-work/task-engine";
import { MemoryIpfsClient, MemoryStore } from "@silvermoon-work/task-engine/testing";
import { TaskClient } from "@silvermoon-work/task-engine-http";
import { openSqliteStore } from "@silvermoon-work/task-engine-storage";
import {
  type BundleReference,
  type SubmissionResult,
  TaskError,
  type TaskPage,
  taskSchemaUri,
} from "@silvermoon-work/task-protocol";
import { type ServerOptions, startTaskServer } from "../src/index.js";

const authoredRoot = resolve(".cache", `server-author-${randomUUID()}`);
let reference: BundleReference;
const ipfsClient = new MemoryIpfsClient();
let authoring: Promise<void> | undefined;
test.after(() => rm(authoredRoot, { recursive: true, force: true }));
async function config(): Promise<ServerOptions> {
  authoring ??= (async () => {
    await mkdir(authoredRoot, { recursive: true });
    const yaml = join(authoredRoot, "task.yaml"),
      entry = join(authoredRoot, "callback.ts");
    await writeFile(
      yaml,
      JSON.stringify({
        $schema: taskSchemaUri,
        name: "Server Echo",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      }),
    );
    await writeFile(
      entry,
      `import {createEcho} from ${JSON.stringify(
        relative(dirname(entry), fileURLToPath(new URL("./echo-worker.mjs", import.meta.url)))
          .split(sep)
          .join("/"),
      )};
const type=createEcho({});export default(input,context)=>type.run(input,context);`,
    );
    const built = await buildBundleFixture({
      declaration: yaml,
      entry,
      outDirectory: join(authoredRoot, "bundle"),
    });
    reference = await ipfsClient.import(built.files);
  })();
  await authoring;
  return {
    store: new MemoryStore(),
    port: 0,
    ipfsClient,
    authorize: (caller, _operation, scope) =>
      caller.scope === scope && caller.subject === "allowed",
    resolveCaller(request) {
      const token = request.headers.get("authorization");
      if (!token?.startsWith("Bearer "))
        throw new TaskError("unauthenticated", "Authentication required.");
      return {
        scope: token === "Bearer other" ? "other" : "one",
        subject: token === "Bearer bad" ? "denied" : "allowed",
      };
    },
    http: { pollMs: 5, maxBodyBytes: 1024 },
  };
}
const headers = { authorization: "Bearer good", "content-type": "application/json" };
test("shutdown owns cancellation of a quiet SSE body even when request abort propagation is blocked", async () => {
  const options = await config();
  const resolveCaller = options.resolveCaller;
  options.resolveCaller = (request) => {
    // Fault-inject a lost downstream abort; the HTTP bridge still owns its body reader.
    request.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    return resolveCaller(request);
  };
  const server = await startTaskServer(options);
  const baseline = server.engine.listTasks({}, {}, { scope: "one", subject: "allowed" });
  const response = await fetch(
    `${server.url}/tasks/events?fromRevision=${encodeURIComponent(baseline.revision)}`,
    { headers },
  );
  const reader = response.body?.getReader();
  assert.ok(reader);
  try {
    const connected = await reader.read();
    assert.match(new TextDecoder().decode(connected.value), /connected/);
    await server.close();
    assert.equal(server.engine.errors.length, 0);
    assert.equal((await reader.read()).done, true);
  } finally {
    await reader.cancel().catch(() => {});
    await server.engine.close();
    await server.close().catch(() => {});
    options.store?.close();
  }
});
test("independent programmatic import cannot listen, open a database or install global signals", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createRequire,syncBuiltinESMExports} from "node:module";
    const require=createRequire(import.meta.url);
    const denied=()=>{throw Error("unexpected import side effect")};
    require("node:http").createServer=denied;
    require("node:sqlite").DatabaseSync=denied;
    const on=process.on.bind(process);
    process.on=(name,...args)=>{if(name==="SIGINT"||name==="SIGTERM")denied();return on(name,...args)};
    syncBuiltinESMExports();
    const api=await import("@silvermoon-work/task-engine-server");
    if(typeof api.startTaskServer!=="function")throw Error("missing public API");
    console.log("inert");
  `,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(output.trim(), "inert");
});
test("import has no signals; real HTTP auth, permission, bounded body, history and SSE reconnect", async () => {
  const signals = process.listenerCount("SIGINT");
  const options = await config();
  const server = await startTaskServer(options);
  try {
    assert.equal(process.listenerCount("SIGINT"), signals);
    assert.equal((await fetch(`${server.url}/tasks/${newId()}`)).status, 401);
    assert.equal(
      (
        await fetch(`${server.url}/tasks`, {
          method: "POST",
          headers: { ...headers, authorization: "Bearer bad", "Idempotency-Key": newId() },
          body: JSON.stringify({ bundle: reference, text: "hello", timeoutMs: 10000 }),
        })
      ).status,
      403,
    );
    const requestId = newId();
    const submitted = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": requestId },
      body: JSON.stringify({ bundle: reference, text: "hello", timeoutMs: 10000 }),
    });
    assert.ok(submitted.ok);
    const client = new TaskClient({ url: server.url, headers });
    let decision = (await submitted.json()) as SubmissionResult;
    while (decision.status === "preparing")
      decision = await client.getRequestStatus(requestId, { waitMs: 1000 });
    assert.equal(decision.status, "accepted");
    if (decision.status !== "accepted") throw Error("Expected accepted.");
    const task = await client.getTask(decision.taskId);
    const directory = await fetch(
      `${server.url}/tasks?bundleCid=${encodeURIComponent(String(reference))}`,
      { headers },
    );
    assert.equal(directory.status, 200);
    assert.equal(((await directory.json()) as TaskPage).tasks[0]?.taskId, task.taskId);
    assert.equal((await fetch(`${server.url}/tasks`)).status, 401);
    assert.equal((await fetch(`${server.url}/events?taskId=${task.taskId}`)).status, 401);
    assert.equal(
      (
        await fetch(
          `${server.url}/events?taskId=${task.taskId}&fromRevision=${encodeURIComponent(task.revision)}`,
          {
            headers: { authorization: "Bearer other" },
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${server.url}/tasks/${task.taskId}`, {
          headers: { authorization: "Bearer other" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${server.url}/tasks`, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": newId() },
          body: JSON.stringify({ type: "echo", text: "x".repeat(2000), timeoutMs: 10000 }),
        })
      ).status,
      413,
    );
    const stream = await fetch(`${server.url}/events?taskId=${task.taskId}`, {
      headers: { ...headers, "Last-Event-ID": task.revision },
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const cursor = /^id: (.+)$/m.exec(first)?.[1];
    assert.ok(cursor);
    await reader.cancel();
    const reconnect = await fetch(`${server.url}/events?taskId=${task.taskId}`, {
      headers: { ...headers, "Last-Event-ID": cursor },
    });
    assert.equal(reconnect.status, 200);
    const active = reconnect.body!.getReader();
    await active.read();
    let next: string | undefined;
    const sequences = new Set<number>();
    do {
      const url = new URL(`${server.url}/event-history?taskId=${task.taskId}&limit=1`);
      if (next) url.searchParams.set("cursor", next);
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      const page = (await response.json()) as { events: { sequence: number }[]; next?: string };
      for (const event of page.events) {
        assert.ok(!sequences.has(event.sequence));
        sequences.add(event.sequence);
      }
      next = page.next;
    } while (next);
    assert.ok(sequences.size >= 1);
    await server.close();
    while (!(await active.read()).done) {}
    await assert.rejects(fetch(server.url));
    // Borrowed Store remains usable after the Server releases its lease.
    options.store!.claim("borrower");
    options.store!.release("borrower");
  } finally {
    await server.close();
    options.store!.close();
  }
});
test("occupied port and invalid config roll back resources and release the Store", async () => {
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, "127.0.0.1", done));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  let closed = 0;
  const options = {
    ...(await config()),
    port: address.port,
    closeResources() {
      closed++;
    },
  };
  try {
    await assert.rejects(startTaskServer(options), /EADDRINUSE/);
    assert.equal(closed, 1);
    options.store!.claim("next");
    options.store!.release("next");
    await assert.rejects(startTaskServer({ ...options, port: -1 }), /configuration/);
    assert.equal(closed, 2);
    await assert.rejects(
      startTaskServer({ ...options, currentVersions: { missing: "1" } } as ServerOptions),
      { code: "invalid_config" },
    );
    await assert.rejects(
      startTaskServer({
        ...options,
        types: [{}],
      } as ServerOptions),
      { code: "invalid_config" },
    );
  } finally {
    options.store!.close();
    await new Promise<void>((done) => occupied.close(() => done()));
  }
});
test("startup failure after acquiring resources and bounded shutdown never report false success", async () => {
  const options = await config();
  let cleaned = 0;
  await assert.rejects(
    startTaskServer({
      ...options,
      http: { prefix: "/" },
      closeResources() {
        cleaned++;
      },
    }),
    /mount prefix/,
  );
  assert.equal(cleaned, 1);
  options.store!.claim("after-rollback");
  options.store!.release("after-rollback");
  options.store!.close();
  const store = new MemoryStore();
  let owner = "";
  const claim = store.claim.bind(store);
  store.claim = (id) => {
    claim(id);
    owner = id;
  };
  let finish!: () => void;
  const physical = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = await startTaskServer({
    ...(await config()),
    store,
    shutdownMs: 20,
    limits: { stopGraceMs: 5, forceExitWaitMs: 5 },
    closeResources: () => physical,
  });
  await assert.rejects(server.close(), /not confirmed/);
  assert.throws(() => store.claim("other"), /owned/);
  finish();
  for (let index = 0; index < 30; index++) await Promise.resolve();
  // The actual cleanup subsequently completed, even though close remains a failure.
  store.claim("confirmed");
  store.release("confirmed");
  store.close();
  assert.ok(owner);
});
test("SQLite duplicate owner fails without disturbing the live Server", async () => {
  const root = resolve(".cache", `server-owner-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const base = await config();
  const { store: _unused, ...rest } = base;
  const options = { ...rest, database: resolve(root, "tasks.sqlite") };
  const server = await startTaskServer(options);
  try {
    await assert.rejects(startTaskServer(options), /owns/);
    assert.equal((await fetch(`${server.url}/tasks/${newId()}`, { headers })).status, 404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("physical resource cleanup failure is not successful shutdown; lease remains held", async () => {
  const root = resolve(".cache", `server-cleanup-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const store = openSqliteStore(resolve(root, "tasks.sqlite"));
  let retainedOwner = "";
  const claim = store.claim.bind(store);
  store.claim = (owner) => {
    claim(owner);
    retainedOwner = owner;
  };
  const server = await startTaskServer({
    ...(await config()),
    store,
    closeResources() {
      throw new Error("physical cleanup failed");
    },
  });
  try {
    await assert.rejects(server.close(), /physical cleanup failed/);
    assert.throws(() => store.claim("other"), /owned/);
    await assert.rejects(server.close(), /physical cleanup failed/);
    await assert.rejects(fetch(server.url));
  } finally {
    // Fault-injection owns no real resources; explicitly dispose its retained test lease.
    store.release(retainedOwner);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
