import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [directory, gateway, cid, mode, foreignCID] = process.argv.slice(2);
const work = resolve(directory);
assert.match(basename(work), /^task-engine-ipfs-rc-smoke-/);
assert.ok(["isolation", "reject", "startup", "missing", "corrupt", "cancel", "force"].includes(mode));
assert.equal(new URL(gateway).hostname, "127.0.0.1");
const root = join(work, "consumer", "node_modules", "@silvermoon-work", "task-engine");
const manifest = JSON.parse(await readFile(join(root, "package.json")));
assert.equal(manifest.version, "0.2.0-rc.1");
assert.ok(!Object.keys(manifest.dependencies).some((name) => name.includes("task-builder")));
const { createTaskEngine, createIpfsGatewayClient, MemoryStore, newId } =
  await import(pathToFileURL(join(root, manifest.exports["."].import)).href);
const caller = { scope: "registry-ipfs-smoke", subject: "deployment" };
const timeout = 30_000;
async function until(read) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`部署观察超时: ${mode}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}
let badServer;
let badRequests = 0;
let selectedGateway = gateway;
if (["missing", "corrupt"].includes(mode)) {
  badServer = createServer((_request, response) => {
    badRequests++;
    response.writeHead(mode === "missing" ? 404 : 200, {
      "content-type": "application/vnd.ipld.raw",
    });
    response.end(mode === "missing" ? "missing" : "corrupt CID bytes");
  });
  await new Promise((done) => badServer.listen(0, "127.0.0.1", done));
  selectedGateway = `http://127.0.0.1:${badServer.address().port}`;
}
const content = createIpfsGatewayClient(selectedGateway, {
  timeoutMs: 2000,
  attemptTimeoutMs: 1000,
});
const store = new MemoryStore();
const engine = createTaskEngine({
  store,
  ipfsClient: content,
  authorize: () => true,
  requestInputEnvelope: true,
  executionBudgetFromWorker: true,
  durableLogs: true,
  limits: { maxConcurrent: 4, stopGraceMs: 200, forceExitWaitMs: 2000 },
});
let closed = false;
let closeError;
const facts = { mode, cid, node: process.version, engine: manifest.version };
function snapshot(run) {
  return {
    runId: run.runId,
    stage: run.stage,
    exit: run.exit ?? null,
    reclaimedAt: run.reclaimedAt ?? null,
    cleanupUnknown: run.cleanupUnknown ?? null,
    error: run.error ?? null,
    output: run.output ?? null,
  };
}
async function submit(input) {
  const requestId = newId();
  let decision = await engine.submit(
    { requestId, bundle: cid, timeoutMs: 20_000, input },
    caller,
  );
  while (decision.status === "preparing")
    decision = await engine.getRequestStatus(requestId, { waitMs: 1000 }, caller);
  return decision;
}
async function runFor(decision) {
  assert.equal(decision.status, "accepted", JSON.stringify(decision));
  const runId = await until(() => engine.getTask(decision.taskId, caller).run?.runId);
  return runId;
}
function checkResult(result) {
  const entry = `ipfs://${cid}/worker.cjs`;
  assert.equal(result.moduleURL, entry);
  assert.equal(result.filename, entry);
  assert.equal(result.dirname, `ipfs://${cid}`);
  assert.equal(result.evaluations, 1);
  assert.equal(result.sameSelf, true);
  assert.equal(result.cached, true);
  assert.equal(result.requireType, "function");
  assert.equal(result.cacheType, "object");
  assert.equal(result.resolveType, "function");
  assert.equal(result.pathsType, "function");
  assert.equal(result.resolvedBuiltin, "node:path");
  assert.equal(result.builtinType, "function");
  assert.equal(result.sourceVisible, false);
}
await engine.start();
try {
  if (badServer) {
    const decision = await submit({ mode: "echo" });
    assert.equal(decision.status, "rejected");
    assert.equal(decision.error.code, "bundle_fetch_failed");
    assert.ok(badRequests > 0);
    facts.decision = decision;
    facts.gatewayRequests = badRequests;
  } else if (mode === "startup") {
    const decision = await submit({ mode: "echo" });
    assert.equal(decision.status, "accepted");
    const task = await until(() => {
      const task = engine.getTask(decision.taskId, caller);
      return task.stage === "failed" && task;
    });
    assert.ok(task.error.message.includes(`ipfs://${cid}/worker.cjs`));
    facts.error = task.error;
    facts.runs = Object.keys(store.read().facts.runs)
      .map((id) => snapshot(engine.getRun(id, caller)));
  } else if (mode === "isolation") {
    const decisions = await Promise.all([
      submit({ mode: "echo", nonce: "first" }),
      submit({ mode: "echo", nonce: "second" }),
    ]);
    const ids = await Promise.all(decisions.map(runFor));
    assert.notEqual(ids[0], ids[1]);
    facts.runs = [];
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      await until(() => engine.getRun(id, caller).reclaimedAt);
      const run = engine.getRun(id, caller);
      const result = engine.getTask(decisions[index].taskId, caller).output.result;
      checkResult(result);
      assert.equal(result.bytes, 600_000);
      const logs = engine.getRunLogs(id, {}, caller);
      assert.ok(logs.entries.some((entry) => entry.message === "ipfs-entry:echo"));
      facts.runs.push({ ...snapshot(run), result, logs: logs.state });
    }
  } else {
    const selectedMode = mode === "cancel" ? "wait" : mode === "force" ? "block" : "reject";
    const decision = await submit({ mode: selectedMode, foreignCID });
    const id = await runFor(decision);
    if (mode === "reject") {
      await until(() => engine.getRun(id, caller).reclaimedAt);
      const result = engine.getTask(decision.taskId, caller).output.result;
      checkResult(result);
      assert.equal(result.denials.length, 16);
      for (const denial of result.denials) {
        assert.equal(denial.code, "unsupported_module");
        assert.ok(denial.message.includes(`ipfs://${cid}/worker.cjs`));
        assert.doesNotMatch(denial.message, /secret|user:/);
      }
      facts.result = result;
    } else {
      await until(() => engine.getRun(id, caller).progress?.message === `ipfs-entry:${selectedMode}`);
      engine.cancelTask(decision.taskId, caller);
      await until(() => engine.getRun(id, caller).exit);
      if (mode === "cancel") {
        await until(() => engine.getRun(id, caller).reclaimedAt);
        assert.equal(engine.getRun(id, caller).exit.forced, false);
      } else {
        await until(() => engine.getRun(id, caller).cleanupUnknown);
        assert.equal(engine.getRun(id, caller).exit.forced, true);
        assert.equal(engine.getRun(id, caller).reclaimedAt, undefined);
      }
    }
    facts.run = snapshot(engine.getRun(id, caller));
  }
  const hostFile = join(work, "consumer", `host-${mode}.mjs`);
  await writeFile(hostFile, 'export const marker = "host-local-loading";\n');
  assert.equal((await import(pathToFileURL(hostFile).href)).marker, "host-local-loading");
  facts.hostLocalLoading = true;
} finally {
  try {
    await engine.close();
    closed = true;
  } catch (error) {
    if (mode !== "force") throw error;
    assert.match(error.code, /^reclamation_/);
    closeError = { code: error.code, message: error.message };
  }
  await content.close();
  if (closed) store.close();
  if (badServer) await new Promise((done) => badServer.close(done));
}
console.log(JSON.stringify({
  ok: true,
  ...facts,
  engineClosed: closed,
  closeError: closeError ?? null,
  contentClientClosed: true,
}));
