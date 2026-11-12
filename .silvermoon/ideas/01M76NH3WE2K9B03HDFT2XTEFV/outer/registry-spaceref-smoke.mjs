import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const work = resolve(process.cwd());
const marker = JSON.parse(await readFile(join(work, "ownership.json"), "utf8"));
assert.equal(marker.idea, "01M76NH3WE2K9B03HDFT2XTEFV");
assert.match(marker.versionCommit, /^[a-f0-9]{40}$/);
assert.match(basename(work), new RegExp(`^${marker.versionCommit.slice(0, 12)}-[a-zA-Z0-9-]+$`));
assert.equal(process.platform, "linux");
const consumer = join(work, "consumer");
const expected = {
  "ipfs-store": "0.1.0-rc.1",
  "task-protocol": "0.2.0-rc.1",
  "task-sdk": "0.2.0-rc.1",
  "task-builder": "0.2.0-rc.2",
  "task-builder-cli": "0.2.0-rc.2",
  "task-engine": "0.2.0-rc.2",
  "task-engine-cli": "0.2.0-rc.10",
};
const report = { startedAt: new Date().toISOString(), versionCommit: marker.versionCommit, node: process.version, packages: [], cases: [] };
const redact = value => String(value).replaceAll(work, "<owned-work>");
async function command(binary, args, options = {}) {
  const { expectedCode = 0, ...selected } = options;
  const began = Date.now();
  let result, code = 0;
  try { result = await execute(binary, args, { cwd: work, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...selected }); }
  catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    code = error.code;
    result = { stdout: error.stdout, stderr: error.stderr };
  }
  await appendFile(join(work, "commands.jsonl"), JSON.stringify({ at: new Date().toISOString(), binary: basename(binary), args: args.map(redact), code, durationMs: Date.now() - began, stdout: redact(result.stdout), stderr: redact(result.stderr) }) + "\n");
  assert.equal(code, expectedCode, redact(result.stdout + result.stderr));
  return { ...result, code };
}
async function until(read, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await read();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Smoke observation timed out: ${label}`);
    await new Promise(done => setTimeout(done, 20));
  }
}
async function ownedProcessExited(identity) {
  try {
    const text = await readFile(`/proc/${identity.pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return fields[0] === "Z" || `${boot}:${fields[19]}` !== identity.birth;
  } catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
async function save() { await writeFile(join(work, "result.json"), JSON.stringify(report, null, 2) + "\n"); }
async function checkCase(name, action) {
  const start = Date.now();
  const record = { name, passed: false };
  report.cases.push(record);
  try { record.evidence = await action(); record.passed = true; }
  catch (error) { record.error = { name: error.name, code: error.code, message: redact(error.message) }; throw error; }
  finally { record.durationMs = Date.now() - start; await save(); }
}
const packages = {};
const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
for (const [id, version] of Object.entries(expected)) {
  const root = join(consumer, "node_modules", "@silvermoon-work", id);
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  assert.ok((await realpath(root)).startsWith(consumer + sep));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const entry = lock.packages[`node_modules/@silvermoon-work/${id}`];
  assert.equal(manifest.version, version);
  assert.equal(entry.version, version);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.ok(entry.integrity);
  packages[id] = { root, manifest };
  report.packages.push({ name: manifest.name, version, path: relative(work, root), tarball: entry.resolved, integrity: entry.integrity });
}
const load = async (id, subpath = ".") => {
  const pkg = packages[id];
  return import(new URL(`file://${join(pkg.root, pkg.manifest.exports[subpath].import)}`).href);
};
const { IpfsStore } = await load("ipfs-store");
const { ContentBlocks } = await load("ipfs-store", "./dag");
const { buildTaskBundle, readTaskBuild } = await load("task-builder");
const { encodeTaskBundleCar, readTaskBundleCar } = await load("task-builder", "./car");
const { memoryFile } = await load("task-builder", "./tree");
const { directoryTree, writeDirectory } = await load("task-builder-cli", "./node");
const { createTaskEngine, MemoryStore, newId } = await load("task-engine");
const builderBin = join(packages["task-builder-cli"].root, packages["task-builder-cli"].manifest.bin["task-builder"]);
const engineBin = join(packages["task-engine-cli"].root, packages["task-engine-cli"].manifest.bin["task-engine"]);
const fixtureModule = join(consumer, "fixture-libraries.mjs");
await writeFile(fixtureModule, 'export {importer} from "ipfs-unixfs-importer"; export {fixedSize} from "ipfs-unixfs-importer/chunker"; export {exporter} from "ipfs-unixfs-exporter"; export {CID} from "multiformats/cid"; export {sha256} from "multiformats/hashes/sha2"; export {CarReader} from "@ipld/car/reader";\n');
const { importer, fixedSize, exporter, CID, sha256, CarReader } = await import(new URL(`file://${fixtureModule}`).href);
const blocks = new Map();
const counts = new Map(), unavailable = new Set();
let requests = 0, sourceEnabled = true;
const source = createServer((request, response) => {
  requests++;
  let bytes;
  try {
    const key = CID.parse(new URL(request.url, "http://127.0.0.1").pathname.split("/").at(-1)).toV1().toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (sourceEnabled && !unavailable.has(key)) bytes = blocks.get(key);
  } catch {}
  response.writeHead(bytes ? 200 : 404, { "content-type": "application/vnd.ipld.raw" }).end(bytes);
});
await new Promise(done => source.listen(0, "127.0.0.1", done));
const gateway = `http://127.0.0.1:${source.address().port}/source`;
const shared = new IpfsStore({ dataDir: join(work, "shared-content"), gateway });
const caller = { scope: "registry-spaceref", subject: "owned-smoke" };
const active = new Set();
const outputs = {};
let ownedCli;
let prepared;
let buildIndex = 0;
async function build(code, imports = {}, content = shared) {
  const name = `task-${buildIndex++}`;
  const entry = `author/${name}/main.ts`;
  await mkdir(join(consumer, dirname(entry)), { recursive: true });
  await writeFile(join(consumer, entry), code);
  const tree = await buildTaskBundle(await directoryTree(consumer), {
    name,
    runtime: { minVersion: "22.15.0" },
    source: { entry, mode: "callback", contract: { input: { type: "object" }, result: true, message: true } },
    imports, content,
  });
  const directory = join(work, "bundles", name);
  await writeDirectory(tree, directory);
  const car = await encodeTaskBundleCar(await directoryTree(directory));
  try {
    const bytes = Buffer.from(await new Response(car.stream).arrayBuffer());
    const archive = await CarReader.fromBytes(bytes);
    for await (const block of archive.blocks()) blocks.set(block.cid.toV1().toString(), block.bytes);
    await writeFile(`${directory}.car`, bytes);
    return { cid: car.cid, directory, bytes };
  } finally { await car.close(); }
}
function engineOptions(content, db, limits = {}) {
  return { store: db, ipfsStore: content, authorize: () => true, requestInputEnvelope: true, limits: { maxConcurrent: 4, maxChildConcurrent: 2, maxChildDepth: 8, maxChildTotal: 64, stopGraceMs: 200, forceExitWaitMs: 2000, ...limits } };
}
async function scenario(cid, input, { content = shared, limits = {}, beforeDrain, afterDrain } = {}) {
  const db = new MemoryStore();
  const engine = createTaskEngine(engineOptions(content, db, limits));
  active.add(engine);
  const request = { requestId: newId(), bundle: cid, timeoutMs: 60_000, input };
  try {
    await engine.start();
    let decision = await engine.submit(request, caller);
    while (decision.status === "preparing") decision = await engine.getRequestStatus(request.requestId, { waitMs: 1000 }, caller);
    assert.equal(decision.status, "accepted", JSON.stringify(decision));
    if (beforeDrain) await beforeDrain(engine, db, decision);
    const result = await engine.drain();
    const children = Object.values(db.read().facts.submissions).filter(record => record.composition).map(record => ({ requestId: record.request.requestId, ...record.composition }));
    const root = result.tasks.find(task => task.requestId === request.requestId);
    for (const child of children) assert.ok(Date.parse(child.deadlineAt) <= Date.parse(root.deadlineAt));
    if (afterDrain) await afterDrain(engine, db, request, result, children);
    return { root, tasks: result.tasks, runs: result.runs.map(run => ({ runId: run.runId, stage: run.stage, exit: run.exit, reclaimedAt: run.reclaimedAt, cleanupUnknown: run.cleanupUnknown })), children };
  } finally {
    await engine.close();
    active.delete(engine);
    db.close();
  }
}
const successful = result => {
  assert.ok(result.tasks.every(task => task.stage === "completed" && !task.canceled), JSON.stringify(result.tasks));
  assert.ok(result.runs.every(run => run.reclaimedAt && !run.cleanupUnknown), JSON.stringify(result.runs));
};
try {
  await checkCase("independent reader cancellation does not own shared acquisition or source close", async () => {
    const bytes = Buffer.from("shared published reader");
    const cid = CID.createV1(0x55, await sha256.digest(bytes));
    let release, began, reads = 0, closed = 0;
    const started = new Promise(done => { began = done; });
    const port = { block: { get: async () => { reads++; began(); await new Promise(done => { release = done; }); return bytes; } }, async close() { closed++; } };
    const store = IpfsStore.fromClient(port), first = store.scope(), second = store.scope();
    const cancellation = new AbortController();
    const rejected = assert.rejects(first.read(cid, { signal: cancellation.signal }), /one reader cancelled/);
    const survivor = second.read(cid);
    try {
      await started;
      cancellation.abort(new Error("one reader cancelled"));
      await rejected;
      await first.close();
      release();
      const node = await survivor, parts = [];
      for await (const part of node.content()) parts.push(part);
      assert.deepEqual(Buffer.concat(parts), bytes);
      assert.equal(reads, 1);
      await Promise.all([store.close(), store.close(), second.close()]);
      assert.equal(closed, 0);
      return { acquiredOnce: reads, callerSourceClosed: closed, otherReaderCompleted: true };
    } finally { release?.(); await Promise.all([first.close(), second.close(), store.close()]); }
  });
  await checkCase("original UnixFS resources, streaming and verified cache", async () => {
    const graph = new ContentBlocks();
    const payload = Buffer.from(Array.from({ length: 10_001 }, (_, index) => index % 251));
    let root;
    for await (const entry of importer([{ path: "data.bin", content: payload, mode: 0o640, mtime: { secs: 123n, nsecs: 456 } }, { path: "notes.txt", content: Buffer.from("keep\r\nbytes\r\n") }], graph, { cidVersion: 1, rawLeaves: false, wrapWithDirectory: true, chunker: fixedSize({ chunkSize: 777 }) })) root = entry.cid;
    for (const [cid, bytes] of graph.blocks) blocks.set(cid, bytes);
    outputs.resource = root.toString();
    const directory = await shared.read(root);
    assert.equal(directory.type, "directory");
    const names = [];
    for await (const entry of directory.entries()) names.push(entry.name);
    assert.deepEqual(names.sort(), ["data.bin", "notes.txt"]);
    const file = await shared.read(`${root}/data.bin`);
    const parts = [];
    for await (const part of file.content()) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), payload);
    await shared.prepare(root);
    const before = requests;
    const independent = new IpfsStore({ dataDir: join(work, "shared-content"), gateway });
    try { await independent.prepare(root); assert.equal(requests, before); }
    finally { await independent.close(); }
    const local = new IpfsStore({ dataDir: join(work, "empty-local") });
    try { await assert.rejects(local.read(root), /Missing local content/); }
    finally { await local.close(); }
    return { cid: outputs.resource, uniqueBlocks: graph.blocks.size, logicalBytes: payload.length, originalChunkBytes: 777, localHitNetworkRequests: requests - before };
  });
  const leaf = await build('import {setTimeout as delay} from "node:timers/promises"; export default async (input,context)=>{if(input.mode==="slow"){await context.progress({stage:"execution",message:"leaf-slow"});await delay(60000,undefined,{signal:context.signal});}return {value:input.value,runId:context.runId};};');
  const external = await build("export default async (input,context)=>({value:input.value+100,runId:context.runId});");
  const branch = await build('export default async (input,context)=>await context.invokeTask({key:"branch-leaf",bundle:context.bundle.root.resolve("resources/leaf"),input:{value:input.value},timeoutMs:10000});', { "resources/leaf": leaf.cid });
  const parentCode = `
import {parentPort} from "node:worker_threads";import {getEventListeners} from "node:events";import {setTimeout as delay} from "node:timers/promises";
export default async(input,context)=>{
 if(input.mode==="gate"){await context.progress({stage:"execution",message:"parent-ready"});for await(const message of context.messages){await message.accept();break;}}
 const request={key:"one",bundle:context.bundle.root.resolve("resources/leaf"),input:{value:7},timeoutMs:10000};
 if(input.mode==="external")request.bundle=context.space(${JSON.stringify(external.cid)}).root;
 if(input.mode==="output")request.bundle=context.output.root;
 if(input.mode==="legacy")return await context.invokeTask({key:"old",cid:${JSON.stringify(leaf.cid)},path:"resources/leaf",input:{value:7},timeoutMs:10000});
 if(input.mode==="cancel"||input.mode==="timeout"){request.input.mode="slow";if(input.mode==="timeout")request.timeoutMs=100;}
 if(input.mode==="lost-ack"){
  const handlers=getEventListeners(parentPort,"message");let dropped=false;parentPort.removeAllListeners("message");
  parentPort.on("message",message=>{if(message.kind==="ack"&&message.value?.value===7&&!dropped){dropped=true;return;}for(const handler of handlers)handler.call(parentPort,message);});
  void context.invokeTask(request).catch(()=>{});await delay(250);const value=await context.invokeTask(request);if(!dropped)throw Error("No acknowledgement dropped");return value;
 }
 const first=await context.invokeTask(request);
 if(["external","cancel","timeout","output"].includes(input.mode))return first;
 const second=await context.invokeTask({key:"two",bundle:context.bundle.root.resolve("resources/branch"),input:{value:8},timeoutMs:10000});
 return {sum:first.value+second.value,parentRun:context.runId,firstRun:first.runId,secondRun:second.runId,moduleURL:import.meta.url};
};`;
  const parent = await build(parentCode, { "resources/leaf": leaf.cid, "resources/branch": branch.cid, "resources/model": outputs.resource });
  Object.assign(outputs, { leaf: leaf.cid, branch: branch.cid, parent: parent.cid, external: external.cid });
  await checkCase("cold gateway hints remain denied without the host resource policy", async () => {
    const local = new IpfsStore({ dataDir: join(work, "denied-hint") }), db = new MemoryStore();
    const engine = createTaskEngine(engineOptions(local, db));
    active.add(engine);
    const before = requests;
    try {
      await engine.start();
      const requestId = newId();
      let decision = await engine.submit({ requestId, bundle: { cid: parent.cid, hint: new URL(gateway).origin }, input: {}, timeoutMs: 10000 }, caller);
      while (decision.status === "preparing") decision = await engine.getRequestStatus(requestId, { waitMs: 1000 }, caller);
      assert.equal(decision.status, "rejected");
      assert.equal(decision.error.code, "bundle_fetch_failed");
      assert.equal(requests, before);
      return { error: decision.error, unauthorizedRequests: requests - before };
    } finally { await engine.close(); active.delete(engine); await local.close(); db.close(); }
  });
  await checkCase("published init, default shared config and independent Builder/Engine overrides", async () => {
    const project = join(consumer, "initialized-author");
    await command(process.execPath, [builderBin, "init", project, "--name", "registry-spaceref-author"]);
    const generated = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    await command("npm", ["--cache", join(work, "npm-cache"), "--prefix", project, "install", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund", "--save-exact", "@silvermoon-work/task-sdk@0.2.0-rc.1", "@silvermoon-work/task-builder@0.2.0-rc.2", "@silvermoon-work/task-builder-cli@0.2.0-rc.2"], { timeout: 600_000 });
    const authorManifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    assert.equal(authorManifest.dependencies["@silvermoon-work/task-sdk"], expected["task-sdk"]);
    await writeFile(join(project, "src", "main.ts"), 'export default async(input,context)=>await context.invokeTask({key:"cli-child",bundle:context.bundle.root.resolve("resources/leaf"),input:{value:7},timeoutMs:10000});');
    await writeFile(join(project, "contract.json"), JSON.stringify({ input: { type: "object" }, result: true, message: false }));
    await writeFile(join(project, "task.build.yaml"), JSON.stringify({ name: "Published CLI shared defaults", runtime: { minVersion: "22.15.0" }, source: { entry: "src/main.ts", contract: "contract.json", mode: "callback" }, imports: { "resources/leaf": leaf.cid }, outDirectory: "dist/cli" }));
    const home = join(work, "default-cli-home"), contentDir = join(work, "default-cli-content");
    await mkdir(join(home, ".config", "task-content"), { recursive: true });
    await writeFile(join(home, ".config", "task-content", "config.json"), JSON.stringify({ dataDir: contentDir, gateway }));
    const env = { ...process.env, HOME: home, LOCALAPPDATA: join(home, "local") };
    delete env.TASK_CONTENT_CONFIG;
    const built = JSON.parse((await command(process.execPath, [builderBin, "build", join(project, "task.build.yaml")], { env })).stdout);
    assert.equal(built.ok, true);
    const archive = await CarReader.fromBytes(new Uint8Array(await readFile(built.data.car.path)));
    for await (const block of archive.blocks()) blocks.set(block.cid.toV1().toString(), block.bytes);
    const leafCar = await CarReader.fromBytes(leaf.bytes), leafBlocks = [];
    for await (const block of leafCar.blocks()) leafBlocks.push(block.cid.toV1().toString());
    const beforeLeaf = leafBlocks.reduce((sum, cid) => sum + (counts.get(cid) ?? 0), 0);
    for (const cid of leafBlocks) unavailable.add(cid);
    const beforeDefaultFiles = (await readdir(join(contentDir, "blocks"))).sort();
    const input = join(work, "default-input.json");
    await writeFile(input, "{}");
    const runCli = async (label, overrides = []) => {
      const portSource = createServer();
      await new Promise(done => portSource.listen(0, "127.0.0.1", done));
      const port = portSource.address().port;
      await new Promise(done => portSource.close(done));
      const data = join(work, `${label}-data`);
      ownedCli = { data, env };
      await command(process.execPath, [engineBin, "server", "start", "--data-dir", data, "--host", "127.0.0.1", "--port", String(port), ...overrides], { env });
      const identity = JSON.parse(await readFile(join(data, "instance.json"), "utf8"));
      ownedCli.identity = { pid: identity.pid, birth: identity.birth, instanceId: identity.instanceId };
      assert.equal(identity.contentDataDir, overrides.length ? join(work, "engine-override-content") : contentDir);
      const result = JSON.parse((await command(process.execPath, [engineBin, "run", "--cid", built.data.cid, "--input", input, "--engine", `http://127.0.0.1:${port}`], { env })).stdout);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.output.result.value, 7);
      const disabled = await fetch(`http://127.0.0.1:${port}/ipfs/${built.data.cid}?format=raw`);
      assert.notEqual(disabled.status, 200);
      await command(process.execPath, [engineBin, "server", "stop", "--data-dir", data, "--cancel-running"], { env });
      await until(() => ownedProcessExited(identity), "owned default/override daemon exit");
      assert.equal(JSON.parse(await readFile(join(data, "instance.json"), "utf8")).released, true);
      ownedCli.stopped = true;
      return { taskId: result.data.taskId, contentDataDir: identity.contentDataDir, disabledRawGatewayStatus: disabled.status };
    };
    try {
      const defaults = await runCli("default");
      const afterLeaf = leafBlocks.reduce((sum, cid) => sum + (counts.get(cid) ?? 0), 0);
      assert.equal(afterLeaf, beforeLeaf, "Engine must reuse Builder's local imported blocks.");
      unavailable.clear();
      const defaultAfterRun = (await readdir(join(contentDir, "blocks"))).sort();
      const independent = join(work, "builder-override-content");
      await command(process.execPath, [builderBin, "build", join(project, "task.build.yaml"), "--content-gateway", gateway, "--content-data-dir", independent], { env });
      assert.deepEqual((await readdir(join(contentDir, "blocks"))).sort(), defaultAfterRun);
      const overrides = await runCli("override", ["--ipfs-gateway", gateway, "--content-data-dir", join(work, "engine-override-content")]);
      assert.deepEqual((await readdir(join(contentDir, "blocks"))).sort(), defaultAfterRun);
      assert.ok((await readdir(join(independent, "blocks"))).length > 0);
      return { generatedTemplateSdk: generated.dependencies["@silvermoon-work/task-sdk"], explicitlyInstalledMigrationSdk: expected["task-sdk"], defaultImportedBlocks: beforeDefaultFiles.length, defaultImportedNetworkRequests: afterLeaf - beforeLeaf, defaults, overrides };
    } finally { unavailable.clear(); }
  });
  await checkCase("complete static closure before first nested invocation, then source disconnected", async () => {
    const dataDir = join(work, "cold-engine-prepared");
    await assert.rejects(lstat(dataDir), { code: "ENOENT" });
    prepared = new IpfsStore({ dataDir, gateway });
    const before = requests;
    const result = await scenario(parent.cid, { mode: "gate" }, { content: prepared, beforeDrain: async (engine, db, decision) => {
      await until(() => Object.keys(db.read().facts.runs).some(id => engine.getRun(id, caller).progress?.message === "parent-ready"), "parent gate");
      assert.equal(Object.values(db.read().facts.submissions).filter(row => row.composition).length, 0);
      outputs.requestsBeforeDisconnect = requests;
      sourceEnabled = false;
      engine.sendTaskMessage(decision.taskId, newId(), { go: true }, caller);
    } });
    successful(result);
    assert.equal(result.root.output.result.sum, 15);
    assert.equal(result.root.output.result.moduleURL, `ipfs://${parent.cid}/worker.cjs`);
    assert.equal(result.tasks.length, 4);
    assert.equal(new Set(result.runs.map(run => run.runId)).size, 4);
    assert.equal(requests, outputs.requestsBeforeDisconnect);
    const sameLeaf = result.children.filter(child => child.targetCid === leaf.cid);
    assert.equal(sameLeaf.length, 2);
    assert.ok(outputs.requestsBeforeDisconnect > before);
    return { initiallyCold: true, acquiredBeforeFirstChild: outputs.requestsBeforeDisconnect - before, tasks: result.tasks.length, runs: result.runs, children: result.children, sourceRequestsAfterDisconnect: requests - outputs.requestsBeforeDisconnect };
  });
  await checkCase("external target missing while offline fails instead of lazy dispatch", async () => {
    const result = await scenario(parent.cid, { mode: "external" }, { content: prepared });
    assert.equal(result.root.stage, "failed");
    assert.ok(result.root.error?.code);
    return { error: result.root.error, children: result.children };
  });
  await prepared.close();
  sourceEnabled = true;
  await checkCase("external SpaceRef fully prepares an independent Run", async () => {
    const before = requests;
    const beforeExternal = counts.get(external.cid) ?? 0;
    const result = await scenario(parent.cid, { mode: "external" });
    successful(result);
    assert.equal(result.root.output.result.value, 107);
    assert.equal(result.children[0].targetCid, external.cid);
    assert.equal(result.tasks.length, 2);
    assert.ok(requests > before);
    assert.ok((counts.get(external.cid) ?? 0) > beforeExternal);
    return { children: result.children, runs: result.runs, acquiredRequests: requests - before, externalRootRequests: (counts.get(external.cid) ?? 0) - beforeExternal };
  });
  await checkCase("lost acknowledgement and completed-domain recovery keep fixed child identity", async () => {
    const result = await scenario(parent.cid, { mode: "lost-ack" }, { afterDrain: async (_engine, db, request, _result, children) => {
      assert.equal(children.length, 1);
      assert.equal(children[0].targetCid, leaf.cid);
      assert.ok(children[0].requestId && children[0].deadlineAt);
      const before = JSON.stringify(Object.values(db.read().facts.submissions));
      const recovered = createTaskEngine(engineOptions(shared, db));
      active.add(recovered);
      try {
        await recovered.start();
        await recovered.submit(request, caller);
        const replay = await recovered.drain();
        assert.ok(replay.tasks.every(task => task.stage === "completed"));
        assert.equal(JSON.stringify(Object.values(db.read().facts.submissions)), before);
      } finally { await recovered.close(); active.delete(recovered); }
    } });
    successful(result);
    assert.equal(result.root.output.result.value, 7);
    return { children: result.children, tasks: result.tasks.length, runs: result.runs };
  });
  for (const mode of ["output", "legacy", "timeout"]) {
    await checkCase(`explicit ${mode} rejection`, async () => {
      const result = await scenario(parent.cid, { mode });
      assert.equal(result.root.stage, "failed");
      assert.ok(result.root.error?.code);
      return { error: result.root.error, children: result.children };
    });
  }
  await checkCase("child depth budget is explicit", async () => {
    const result = await scenario(parent.cid, { mode: "normal" }, { limits: { maxChildDepth: 1 } });
    assert.equal(result.root.stage, "failed");
    assert.ok(result.root.error?.code);
    return { error: result.root.error, children: result.children };
  });
  await checkCase("unique-block and logical import budgets fail independently without lazy fallback", async () => {
    const limited = new IpfsStore({ dataDir: join(work, "one-block"), gateway, limits: { blocks: 1 } });
    const errors = [];
    try { await assert.rejects(limited.prepare(parent.cid), error => { errors.push(error.message); return /capacity/.test(error.message); }); }
    finally { await limited.close(); }
    const input = await directoryTree(consumer);
    const options = { name: "logical-budget", runtime: { minVersion: "22.15.0" }, source: { entry: "author/task-0/main.ts", mode: "callback", contract: { input: { type: "object" }, result: true, message: false } }, content: shared };
    await assert.rejects(buildTaskBundle(input, { ...options, imports: { "resources/model": outputs.resource }, limits: { bytes: 1000 } }), error => { errors.push(error.message); return /logical byte capacity/.test(error.message); });
    await assert.rejects(buildTaskBundle(input, { ...options, imports: { "resources/CON": leaf.cid } }));
    await assert.rejects(buildTaskBundle(input, { ...options, include: [{ from: "author/task-0/main.ts", to: "resources/" }], imports: { "resources/main.ts": leaf.cid } }), /collision/);
    return { uniqueBlockBudget: 1, logicalByteBudget: 1000, errors, unsafePathAndCollisionRejected: true };
  });
  await checkCase("old imports format is rejected and rebuilt references use the unchanged schema identity", async () => {
    const path = "old-task.build.json";
    await writeFile(join(consumer, path), JSON.stringify({ name: "old-format", runtime: { minVersion: "22.15.0" }, source: { entry: "old-main.ts", contract: "old-contract.json" }, imports: [{ cid: leaf.cid, path: "resources/leaf" }] }));
    await assert.rejects(readTaskBuild(await directoryTree(consumer), path));
    const archive = await readTaskBundleCar(memoryFile(parent.bytes));
    try {
      assert.equal(archive.declaration.$schema, "https://shazhou-ww.github.io/potential-guide/schemas/artifacts/task/v1.json");
      assert.equal(archive.declaration.imports["resources/leaf"], leaf.cid);
      return { rejectedOldImports: true, rebuiltParent: parent.cid, schema: archive.declaration.$schema, rebuiltImports: archive.declaration.imports };
    } finally { await archive.close(); }
  });
  await checkCase("parent cancellation releases already dispatched child", async () => {
    const result = await scenario(parent.cid, { mode: "cancel" }, { beforeDrain: async (engine, db, decision) => {
      await until(() => Object.keys(db.read().facts.runs).some(id => engine.getRun(id, caller).progress?.message === "leaf-slow"), "slow child dispatched");
      assert.equal(engine.cancelTask(decision.taskId, caller).changed, true);
    } });
    assert.equal(result.root.canceled, true);
    assert.ok(result.runs.every(run => run.reclaimedAt && !run.cleanupUnknown));
    return { tasks: result.tasks.map(task => ({ id: task.taskId, stage: task.stage, canceled: task.canceled })), runs: result.runs };
  });
  await checkCase("moved self-contained folder encodes CAR without project, source or cache", async () => {
    const moved = join(work, "moved-task");
    await cp(parent.directory, moved, { recursive: true, errorOnExist: true });
    await shared.close();
    await prepared?.close();
    for (const name of ["shared-content", "cold-engine-prepared", "default-cli-content", "builder-override-content", "engine-override-content", "one-block", "denied-hint", "empty-local"])
      await rm(join(work, name), { recursive: true, force: true });
    await rm(join(consumer, "author"), { recursive: true, force: true });
    sourceEnabled = false;
    const before = requests;
    const encoded = await encodeTaskBundleCar(await directoryTree(moved));
    let bytes;
    try { assert.equal(encoded.cid, parent.cid); bytes = Buffer.from(await new Response(encoded.stream).arrayBuffer()); }
    finally { await encoded.close(); }
    assert.equal(requests, before);
    const archive = await CarReader.fromBytes(bytes), seen = new Set();
    for await (const block of archive.blocks()) { assert.equal(seen.has(block.cid.toV1().toString()), false); seen.add(block.cid.toV1().toString()); }
    const decoded = await readTaskBundleCar(memoryFile(bytes), { expectedCid: parent.cid });
    const local = IpfsStore.fromClient(decoded);
    try {
      const result = await scenario(parent.cid, { mode: "normal" }, { content: local });
      successful(result);
      assert.equal(result.root.output.result.sum, 15);
      const tree = { async *get(cid) { yield await local.block.get(cid.toString()); } };
      assert.ok((await exporter(`${parent.cid}/resources/leaf`, tree)).cid.equals(CID.parse(leaf.cid)));
      assert.ok((await exporter(`${parent.cid}/resources/model`, tree)).cid.equals(CID.parse(outputs.resource)));
      const original = await exporter(`${parent.cid}/resources/model/data.bin`, tree);
      assert.equal(original.unixfs.mode, 0o640);
      assert.deepEqual(original.unixfs.mtime, { secs: 123n, nsecs: 456 });
      assert.equal(requests, before);
    } finally { await local.close(); await decoded.close(); }
    await writeFile(join(work, "offline-parent.car"), bytes);
    const home = join(work, "offline-builder-home");
    await mkdir(home, { recursive: true });
    const badConfig = join(home, "content-config.json");
    await writeFile(badConfig, "{invalid configuration");
    const cliCar = join(work, "cli-offline-parent.car");
    await command(process.execPath, [builderBin, "car", join(moved, "task.yaml"), "--output", cliCar], { env: { ...process.env, HOME: home, TASK_CONTENT_CONFIG: badConfig } });
    assert.deepEqual(await readFile(cliCar), bytes);
    await writeFile(join(moved, "resources", "model", "notes.txt"), "changed\n");
    await assert.rejects(encodeTaskBundleCar(await directoryTree(moved)), /Immutable import changed/);
    await rm(join(moved, ".task-imports.car"));
    await assert.rejects(encodeTaskBundleCar(await directoryTree(moved)), /missing|not.found/i);
    return { cid: parent.cid, uniqueBlocks: seen.size, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), networkRequests: requests - before };
  });
  await checkCase("published offline CLI consumes the moved CAR in a fresh data domain", async () => {
    const home = join(work, "offline-cli-home");
    await mkdir(home, { recursive: true });
    const config = join(home, "content-config.json");
    await writeFile(config, JSON.stringify({ dataDir: join(work, "offline-cli-content") }));
    const env = { ...process.env, HOME: home, LOCALAPPDATA: join(home, "config"), TASK_CONTENT_CONFIG: config };
    const portSource = createServer();
    await new Promise(done => portSource.listen(0, "127.0.0.1", done));
    const port = portSource.address().port;
    await new Promise(done => portSource.close(done));
    const data = join(work, "offline-cli-data");
    ownedCli = { data, env };
    await command(process.execPath, [engineBin, "server", "start", "--data-dir", data, "--host", "127.0.0.1", "--port", String(port)], { env });
    const identity = JSON.parse(await readFile(join(data, "instance.json"), "utf8"));
    assert.equal(identity.dataDir, data);
    ownedCli.identity = { pid: identity.pid, birth: identity.birth, instanceId: identity.instanceId };
    const input = join(work, "normal-input.json");
    await writeFile(input, JSON.stringify({ mode: "normal" }));
    const before = requests;
    const result = await command(process.execPath, [engineBin, "run", "--car", join(work, "offline-parent.car"), "--input", input, "--engine", `http://127.0.0.1:${port}`], { env });
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, true, result.stdout);
    assert.equal(value.data.status, "succeeded");
    assert.equal(value.data.output.result.sum, 15);
    assert.equal(requests, before);
    await command(process.execPath, [engineBin, "server", "stop", "--data-dir", data, "--cancel-running"], { env });
    await until(() => ownedProcessExited(identity), "owned offline daemon exit");
    assert.equal(JSON.parse(await readFile(join(data, "instance.json"), "utf8")).released, true);
    ownedCli.stopped = true;
    return { code: result.code, taskId: value.data.taskId, output: value.data.output, networkRequests: requests - before, identity: ownedCli.identity, stopped: true };
  });
  report.binaries = { builder: relative(work, builderBin), engine: relative(work, engineBin) };
  report.outputs = outputs;
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = { name: error.name, code: error.code, message: redact(error.message), stack: redact(error.stack) };
  throw error;
} finally {
  const cleanup = await Promise.allSettled([...active].map(engine => engine.close()));
  let cliCleanup;
  if (ownedCli && !ownedCli.stopped) {
    try {
      await command(process.execPath, [engineBin, "server", "stop", "--data-dir", ownedCli.data, "--cancel-running"], { env: ownedCli.env });
      ownedCli.stopped = true;
    } catch (error) { cliCleanup = { code: error.code, message: redact(error.message) }; report.ok = false; }
  }
  await shared.close();
  await prepared?.close();
  source.closeAllConnections();
  await new Promise(done => source.close(done));
  report.cleanup = { allOwnedEnginesClosed: cleanup.every(row => row.status === "fulfilled"), sourceClosed: !source.listening, ownedCliStopped: ownedCli ? ownedCli.stopped === true : null, cliCleanup };
  report.finishedAt = new Date().toISOString();
  await save();
}
console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(row => ({ name: row.name, passed: row.passed })), outputs: report.outputs, cleanup: report.cleanup }));
