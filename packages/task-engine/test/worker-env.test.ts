import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { createTaskEngine as createCoordinator } from "../src/engine.js";
import { createTaskEngine, IpfsStore, MemoryStore, newId } from "../src/index.js";
import { MemoryIpfsClient } from "../src/testing.js";
import { snapshotWorkerEnvironment } from "../src/worker-env.js";

test("environment snapshots are opt-in copies with explicit omission and override semantics", () => {
  const host = { SystemRoot: "system-before", WINDIR: "windows", PATH: "not-inherited" };
  assert.equal(snapshotWorkerEnvironment(undefined, host, "win32"), undefined);
  assert.deepEqual(snapshotWorkerEnvironment({}, host, "win32"), {
    SystemRoot: "system-before",
    WINDIR: "windows",
    NODE_OPTIONS: "",
  });
  const configured = { PATH: "approved-path", HOME: "", MISSING: undefined, systemroot: "chosen" };
  const snapshot = snapshotWorkerEnvironment(configured, host, "win32");
  configured.PATH = "mapping-after";
  host.SystemRoot = "host-after";
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(snapshot, {
    SystemRoot: "chosen",
    WINDIR: "windows",
    PATH: "approved-path",
    HOME: "",
    NODE_OPTIONS: "",
  });
});

test("Windows aliases are canonicalized or rejected, never silently selected by key order", () => {
  for (const mapping of [
    { Path: "one", PATH: "two" },
    { PATH: "two", Path: "one" },
    { home: "one", HOME: "two" },
  ])
    assert.throws(() => snapshotWorkerEnvironment(mapping, {}, "win32"), {
      code: "invalid_config",
      message: "workerEnv contains conflicting variable aliases.",
    });
  for (const mapping of [
    { Path: "same", PATH: "same" },
    { PATH: "same", Path: "same" },
  ])
    assert.deepEqual(snapshotWorkerEnvironment(mapping, {}, "win32"), {
      PATH: "same",
      NODE_OPTIONS: "",
    });
  assert.deepEqual(snapshotWorkerEnvironment({ Path: "one", PATH: "two" }, {}, "linux"), {
    Path: "one",
    PATH: "two",
    NODE_OPTIONS: "",
  });
  assert.throws(
    () => snapshotWorkerEnvironment({}, { SystemRoot: "one", SYSTEMROOT: "two" }, "win32"),
    { code: "invalid_config" },
  );
});

test("invalid and startup-sensitive mappings fail at the public constructor without echoing values", () => {
  const secret = "must-not-appear-in-errors";
  const store = new MemoryStore();
  const ipfsClient = new MemoryIpfsClient();
  try {
    for (const name of [
      "",
      "BAD=NAME",
      "BAD\0NAME",
      "NODE_OPTIONS",
      "node_options",
      "NODE_PATH",
      "NODE_EXTRA_CA_CERTS",
      "UV_THREADPOOL_SIZE",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "OPENSSL_CONF",
    ])
      assert.throws(
        () =>
          createTaskEngine({
            store,
            ipfsClient,
            authorize: () => true,
            workerEnv: { [name]: secret },
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "invalid_config" &&
          error.message.startsWith("workerEnv ") &&
          !error.message.includes(secret) &&
          !error.message.includes(name || secret),
      );
    assert.throws(
      () =>
        createTaskEngine({
          store,
          ipfsClient,
          authorize: () => true,
          workerEnv: { VALUE: "bad\0value" },
        }),
      { code: "invalid_config", message: "workerEnv values must be strings without NUL." },
    );
    if (process.platform === "win32")
      assert.throws(
        () =>
          createTaskEngine({
            store,
            ipfsClient,
            authorize: () => true,
            workerEnv: { Path: secret, PATH: "conflict" },
          }),
        { code: "invalid_config", message: "workerEnv contains conflicting variable aliases." },
      );
  } finally {
    store.close();
  }
});

const names = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "NVM_DIR",
  "NVM_HOME",
  "NVM_SYMLINK",
  "PNPM_HOME",
  "WORKER_CUSTOM",
];
const caller = { scope: "worker-env", subject: "host" };
const digest = (values: unknown) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
const observeSource = `
import {createHash} from "node:crypto";
import {workerData} from "node:worker_threads";
const names = ${JSON.stringify(names)};
function environment(name) {
  if (process.platform !== "win32") return process.env[name];
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1];
}
function observe() {
  return {
    digest: createHash("sha256").update(JSON.stringify(names.map(name => environment(name) ?? null))).digest("hex"),
    pathNames: Object.keys(process.env).filter(name => name.toUpperCase() === "PATH").sort(),
    unauthorizedPresent: process.env.WORKER_UNAPPROVED !== undefined,
    missing: process.env.WORKER_MISSING ?? null,
    options: process.env.NODE_OPTIONS,
    execArgv: process.execArgv,
    envInData: "workerEnv" in workerData || "env" in workerData,
    configuration: workerData.configuration
  };
}
`;
async function until(check: () => boolean) {
  const end = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Worker environment test timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real CAR Workers and children natively inherit by default or use an explicit host snapshot without persistence", {
  timeout: 60_000,
}, async (t) => {
  const directory = resolve(".cache", `worker-env-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new MemoryIpfsClient();
  async function build(name: string, code: string, child?: string) {
    const entry = join(directory, `${name}.ts`);
    await writeFile(entry, observeSource + code);
    const built = await buildBundleFixture({
      entry,
      outDirectory: join(directory, name),
      declaration: {
        $schema: taskSchemaUri,
        name: "Worker environment fixture",
        runtime: { type: "node", minVersion: "22.15.0" },
        entry: "worker.cjs",
        binary: [],
        parametersSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
      ...(child ? { imports: { "resources/child": child }, content: client } : {}),
    });
    for (const [cid, bytes] of built.blocks) client.blocks.set(cid, bytes);
    assert.ok((await readFile(built.car)).byteLength > 0);
    return built;
  }
  const leaf = await build("leaf", "export default async () => observe();");
  const parent = await build(
    "parent",
    `export default async (_input, context) => {
      const parent = observe();
      process.env.PATH = "task-local-mutation";
      const child = await context.invokeTask({
        key: "environment", bundle: context.bundle, path: "resources/child",
        parameters: {}, timeoutMs: 5000
      });
      return {parent, child};
    };`,
    leaf.cid,
  );
  const original = new Map(
    [...names, "WORKER_UNAPPROVED", "WORKER_MISSING", "NODE_OPTIONS"].map((name) => [
      name,
      process.env[name],
    ]),
  );
  t.after(() => {
    for (const [name, value] of original)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const name of names) process.env[name] = `host-unapproved-${name}`;
  process.env.WORKER_UNAPPROVED = "host-private-sentinel";
  delete process.env.WORKER_MISSING;
  process.env.NODE_OPTIONS = "--trace-warnings";

  for (const enabled of [false, true]) {
    const store = new MemoryStore();
    const archiveDirectory = join(directory, enabled ? "opt-in-archive" : "default-archive");
    const archiveStore = new IpfsStore({ dataDir: archiveDirectory });
    const configured: Record<string, string | undefined> = Object.fromEntries(
      names.map((name) => [name, `approved-sentinel-${name}`]),
    );
    configured.WORKER_MISSING = undefined;
    if (process.platform === "win32") {
      configured.Path = configured.PATH;
      configured.home = configured.HOME;
    }
    const configuredDigest = digest(names.map((name) => configured[name]));
    const engine = createTaskEngine({
      store,
      ipfsClient: client,
      archiveStore,
      authorize: () => true,
      durableLogs: true,
      ...(enabled ? { workerEnv: configured } : {}),
    });
    // Both the caller-owned mapping and process.env change before the first Worker exists.
    for (const name of names) configured[name] = `mapping-after-${name}`;
    process.env.WORKER_CUSTOM = "host-after-construction";
    const expected = {
      digest: enabled ? configuredDigest : digest(names.map((name) => process.env[name])),
      pathNames: enabled
        ? ["PATH"]
        : Object.keys(process.env)
            .filter((name) => name.toUpperCase() === "PATH")
            .sort(),
      unauthorizedPresent: !enabled,
      missing: null,
      options: enabled ? "" : "--trace-warnings",
      execArgv: [],
      envInData: false,
      configuration: null,
    };
    try {
      await engine.start();
      const requestId = newId();
      await engine.submit(
        {
          requestId,
          bundle: parent.cid,
          parameters: { data: {}, cidPaths: [] },
          timeoutMs: 10_000,
        },
        caller,
      );
      const decision = await engine.getRequestStatus(requestId, { waitMs: 5000 }, caller);
      assert.equal(decision.status, "accepted");
      if (decision.status !== "accepted") throw new Error("Expected admission.");
      await engine.waitForTaskRelease(decision.taskId, caller);
      const task = engine.getTask(decision.taskId, caller);
      assert.equal(task.stage, "completed", JSON.stringify(task));
      assert.deepEqual(task.result, { data: { parent: expected, child: expected }, cidPaths: [] });
      const runs = Object.values(store.read().facts.runs);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.exit && run.reclaimedAt));
      assert.notEqual(process.env.PATH, "task-local-mutation", "Worker does not share host env");
      await until(() =>
        runs.every((run) => store.runHistory.read(run.runId)?.archive.state === "archived"),
      );
      const details = await Promise.all(
        runs.map((run) => engine.readRunHistoryArchive(run.runId, caller)),
      );
      const persisted = JSON.stringify({
        state: store.read(),
        request: engine.getRequest(requestId, caller),
        task,
        details,
        logs: runs.map((run) => engine.getRunLogs(run.runId, {}, caller)),
        errors: engine.errors,
      });
      assert.doesNotMatch(persisted, /approved-sentinel-|host-private-sentinel|mapping-after-/);
      for (const file of await readdir(join(archiveDirectory, "blocks"))) {
        const bytes = await readFile(join(archiveDirectory, "blocks", file));
        assert.doesNotMatch(
          bytes.toString(),
          /approved-sentinel-|host-private-sentinel|mapping-after-/,
        );
      }
      for (const bytes of client.blocks.values())
        assert.doesNotMatch(bytes.toString(), /approved-sentinel-|host-private-sentinel/);
    } finally {
      await engine.close();
      await archiveStore.close();
      store.close();
    }
  }
});

test("ordinary type Workers use the Coordinator constructor snapshot, including verification", async (t) => {
  const directory = resolve(".cache", `type-env-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = join(directory, "type.mjs");
  await writeFile(
    module,
    observeSource +
      `
export function createType() {
  const startup = observe();
  return {
    type: "environment", version: "1", parametersSchema: {type:"object"},
    resultSchema: true, messageSchema: false,
    async run() { return {startup, current:observe()}; }
  };
}
export function verify(_configuration, result) {
  if (result.startup.digest !== observe().digest) throw new Error("Verifier environment differs.");
  return result;
}
`,
  );
  const configured = Object.fromEntries(names.map((name) => [name, `ordinary-${name}`]));
  const expectedDigest = digest(names.map((name) => configured[name]));
  const store = new MemoryStore();
  const engine = createCoordinator({
    store,
    authorize: () => true,
    workerEnv: configured,
    types: [
      {
        type: "environment",
        version: "1",
        environment: "trusted",
        module: pathToFileURL(module).href,
        exportName: "createType",
        verifyExportName: "verify",
        configuration: null,
        parametersSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      },
    ],
    currentVersions: { environment: "1" },
  });
  configured.PATH = "mutated-after-construction";
  try {
    await engine.start();
    const task = engine.submit(
      {
        requestId: newId(),
        type: "environment",
        parameters: { data: {}, cidPaths: [] },
        timeoutMs: 5000,
      },
      caller,
    );
    await engine.waitForTaskRelease(task.taskId, caller);
    const observed = engine.getTask(task.taskId, caller);
    assert.equal(observed.stage, "completed", JSON.stringify(observed));
    const expected = {
      digest: expectedDigest,
      pathNames: ["PATH"],
      unauthorizedPresent: false,
      missing: null,
      options: "",
      execArgv: [],
      envInData: false,
      configuration: null,
    };
    assert.deepEqual(observed.result, {
      data: { startup: expected, current: expected },
      cidPaths: [],
    });
  } finally {
    await engine.close();
    store.close();
  }
});
