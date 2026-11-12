import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const work = resolve(process.cwd());
const marker = JSON.parse(await readFile(join(work, "ownership.json"), "utf8"));
assert.equal(marker.idea, "01M76NH3WE2K9B03HDFT2XTEFV");
assert.equal(marker.versionCommit, "bbc504364514ef91edbd28e3a4a7f61d828cb58b");
assert.equal(marker.uid, process.getuid());
const consumer = join(work, "consumer");
const load = async (id, version, subpath = ".") => {
  const root = join(consumer, "node_modules", "@silvermoon-work", id);
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, version);
  return import(pathToFileURL(join(root, manifest.exports[subpath].import)).href);
};
const { IpfsStore } = await load("ipfs-store", "0.1.0-rc.1");
const { ContentBlocks } = await load("ipfs-store", "0.1.0-rc.1", "./dag");
const { buildTaskBundle } = await load("task-builder", "0.2.0-rc.2");
const { encodeTaskBundleCar, readTaskBundleCar } = await load("task-builder", "0.2.0-rc.2", "./car");
const { memoryFile } = await load("task-builder", "0.2.0-rc.2", "./tree");
const { directoryTree, writeDirectory } = await load("task-builder-cli", "0.2.0-rc.2", "./node");
const { createTaskEngine, MemoryStore, newId } = await load("task-engine", "0.2.0-rc.2");
const helper = join(consumer, "edge-libraries.mjs");
await writeFile(helper, 'export {importer} from "ipfs-unixfs-importer"; export {fixedSize} from "ipfs-unixfs-importer/chunker"; export {exporter} from "ipfs-unixfs-exporter"; export {CID} from "multiformats/cid"; export {sha256} from "multiformats/hashes/sha2"; export {CarReader} from "@ipld/car/reader"; export {CarWriter} from "@ipld/car/writer";\n', { flag: "wx" });
const { importer, fixedSize, exporter, CID, sha256, CarReader, CarWriter } = await import(pathToFileURL(helper).href);
const graph = new ContentBlocks(), sourceBlocks = new Map(), requests = [];
let mode = "normal";
const server = createServer((request, response) => {
  const cid = new URL(request.url, "http://127.0.0.1").pathname.split("/").at(-1);
  requests.push(cid);
  const bytes = mode === "corrupt" ? Buffer.from("wrong CID bytes") : mode === "offline" ? undefined : sourceBlocks.get(cid);
  response.writeHead(bytes ? 200 : 404, { "content-type": "application/vnd.ipld.raw" }).end(bytes);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const gateway = `http://127.0.0.1:${server.address().port}/source`;
const report = { startedAt: new Date().toISOString(), versionCommit: marker.versionCommit, cases: [], productCodeOrPackagesModified: false };
const stores = new Set(), engines = new Set();
const storeAt = name => { const store = new IpfsStore({ dataDir: join(work, name), gateway }); stores.add(store); return store; };
async function check(name, action) {
  const row = { name, passed: false };
  report.cases.push(row);
  row.evidence = await action();
  row.passed = true;
}
async function archive(roots, blocks) {
  const { writer, out } = CarWriter.create(roots);
  const parts = [];
  await Promise.all([
    (async () => { for (const block of blocks) await writer.put(block); await writer.close(); })(),
    (async () => { for await (const part of out) parts.push(part); })(),
  ]);
  return Buffer.concat(parts);
}
try {
  await check("wrong CID cannot become a verified cache hit", async () => {
    mode = "corrupt";
    const bytes = Buffer.from("expected content"), cid = CID.createV1(0x55, await sha256.digest(bytes));
    const store = storeAt("edge-corrupt");
    const before = requests.length;
    await assert.rejects(store.block.get(cid.toString()), /verification/i);
    await assert.rejects(lstat(join(work, "edge-corrupt", "blocks", cid.toString())), { code: "ENOENT" });
    await store.close();
    mode = "normal";
    return { rejectedCid: cid.toString(), corruptRequests: requests.length - before, cached: false };
  });
  let missingRoot;
  for await (const entry of importer([{ path: "absent.bin", content: Buffer.from("missing descendant") }], graph, { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true })) missingRoot = entry.cid;
  sourceBlocks.set(missingRoot.toString(), await graph.block.get(missingRoot.toString()));
  await check("full preparation rejects a missing descendant instead of returning a lazy graph", async () => {
    const store = storeAt("edge-missing");
    const before = requests.length;
    await assert.rejects(store.prepare(missingRoot), /acquisition failed|missing/i);
    assert.ok(requests.length - before >= 2);
    await store.close();
    return { root: missingRoot.toString(), attemptedRootAndDescendant: requests.slice(before) };
  });
  const payload = Buffer.from(Array.from({ length: 20_001 }, (_, index) => index % 251));
  let file, directory;
  for await (const entry of importer([{ content: payload, mode: 0o640, mtime: { secs: 321n, nsecs: 12 } }], graph, { cidVersion: 1, rawLeaves: false, chunker: fixedSize({ chunkSize: 777 }) })) file = entry.cid;
  for await (const entry of importer([{ path: "data.bin", content: payload }], graph, { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true, chunker: fixedSize({ chunkSize: 1024 }) })) directory = entry.cid;
  for (const [cid, bytes] of graph.blocks) sourceBlocks.set(cid, bytes);
  const source = storeAt("edge-content");
  await mkdir(join(consumer, "edge-author"));
  await writeFile(join(consumer, "edge-author", "main.ts"), "export default async()=>({ok:true});");
  const tree = await buildTaskBundle(await directoryTree(consumer), {
    name: "standalone-file-and-directory", runtime: { minVersion: "22.15.0" },
    source: { entry: "edge-author/main.ts", mode: "callback", contract: { input: { type: "object" }, result: true, message: false } },
    imports: { "resources/single.bin": file.toString(), "resources/tree": directory.toString() }, content: source,
  });
  await mkdir(join(work, "edge-bundles"));
  const folder = join(work, "edge-bundles", "task");
  await writeDirectory(tree, folder);
  const encoded = await encodeTaskBundleCar(await directoryTree(folder));
  let carBytes, root;
  try { root = encoded.cid; carBytes = Buffer.from(await new Response(encoded.stream).arrayBuffer()); }
  finally { await encoded.close(); }
  await check("standalone file CID and second directory chunk profile survive cache-free offline CAR", async () => {
    const moved = join(work, "edge-moved");
    await cp(folder, moved, { recursive: true, force: false, errorOnExist: true });
    await source.close();
    await rm(join(work, "edge-content"), { recursive: true, force: true });
    await rm(join(consumer, "edge-author"), { recursive: true, force: true });
    mode = "offline";
    const before = requests.length;
    const offline = await encodeTaskBundleCar(await directoryTree(moved));
    try { assert.equal(offline.cid, root); assert.deepEqual(Buffer.from(await new Response(offline.stream).arrayBuffer()), carBytes); }
    finally { await offline.close(); }
    const reader = await readTaskBundleCar(memoryFile(carBytes));
    const blockstore = { async *get(cid) { yield await reader.block.get(cid.toString()); } };
    try {
      const restored = await exporter(`${root}/resources/single.bin`, blockstore);
      assert.ok(restored.cid.equals(file));
      assert.equal(restored.unixfs.mode, 0o640);
      assert.deepEqual(restored.unixfs.mtime, { secs: 321n, nsecs: 12 });
      assert.ok((await exporter(`${root}/resources/tree`, blockstore)).cid.equals(directory));
    } finally { await reader.close(); }
    assert.equal(requests.length, before);
    return { root, standaloneFile: file.toString(), directory: directory.toString(), fileChunkBytes: 777, directoryChunkBytes: 1024, mode: "0640", mtime: "321s+12ns", networkRequests: 0, carSha256: createHash("sha256").update(carBytes).digest("hex") };
  });
  await check("sidecar missing one reachable original block and added imported files both fail offline", async () => {
    const moved = join(work, "edge-moved"), sidecar = join(moved, ".task-imports.car");
    const bytes = await readFile(sidecar), reader = await CarReader.fromBytes(bytes), roots = await reader.getRoots(), blocks = [];
    for await (const block of reader.blocks()) blocks.push(block);
    const dropped = blocks.find(block => roots.every(root => !root.equals(block.cid)));
    assert.ok(dropped);
    await writeFile(sidecar, await archive(roots, blocks.filter(block => !block.cid.equals(dropped.cid))));
    const before = requests.length;
    await assert.rejects(encodeTaskBundleCar(await directoryTree(moved)), /missing/i);
    await writeFile(sidecar, bytes);
    await writeFile(join(moved, "resources", "tree", "extra.bin"), "added");
    await assert.rejects(encodeTaskBundleCar(await directoryTree(moved)), /changed/i);
    assert.equal(requests.length, before);
    return { missingOriginalBlock: dropped.cid.toString(), addedImportFileRejected: true, networkRequests: 0 };
  });
  await check("Engine logical file capacity rejects an otherwise complete local DAG", async () => {
    const car = await readTaskBundleCar(memoryFile(carBytes)), content = IpfsStore.fromClient(car), db = new MemoryStore();
    stores.add(content);
    const engine = createTaskEngine({ store: db, ipfsStore: content, authorize: () => true, bundleLimits: { files: 1 } });
    engines.add(engine);
    try {
      await engine.start();
      const requestId = newId(), caller = { scope: "edge-probe", subject: "owned" };
      let decision = await engine.submit({ requestId, bundle: root, timeoutMs: 10000 }, caller);
      while (decision.status === "preparing") decision = await engine.getRequestStatus(requestId, { waitMs: 1000 }, caller);
      assert.equal(decision.status, "rejected");
      assert.equal(decision.error.code, "capacity_exceeded");
      assert.equal(Object.keys(db.read().facts.tasks).length, 0);
      return { fileLimit: 1, rejectedBeforeTask: true, error: decision.error };
    } finally { await engine.close(); engines.delete(engine); await content.close(); await car.close(); db.close(); }
  });
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = { name: error.name, code: error.code, message: error.message.replaceAll(work, "<owned-work>") };
  throw error;
} finally {
  const stoppedEngines = await Promise.allSettled([...engines].map(engine => engine.close()));
  const closedStores = await Promise.allSettled([...stores].map(store => store.close()));
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  report.cleanup = { allOwnedEnginesClosed: stoppedEngines.every(row => row.status === "fulfilled"), allOwnedStoresClosed: closedStores.every(row => row.status === "fulfilled"), sourceClosed: !server.listening };
  report.finishedAt = new Date().toISOString();
  await writeFile(join(work, "edge-result.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(row => ({ name: row.name, passed: row.passed })), cleanup: report.cleanup }));
