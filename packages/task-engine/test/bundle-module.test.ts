import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { CID } from "multiformats/cid";
import { bundleModuleURL } from "../src/bundle-module.js";

const cid = "bafybeigdyrzt5sfp7udm7hu76u7cnngv7cbd3gbta6ipjcnpf7bh6zyvle";
const entry = bundleModuleURL(cid);

function worker(source: string) {
  return new Worker(new URL("../dist/bundle-worker.js", import.meta.url), {
    execArgv: [],
    workerData: { bundle: { cid }, bundleSource: source },
  });
}

test("IPFS bootstrap canonicalizes CID aliases to one CJS cache identity", async () => {
  const alias = CID.parse(cid).toV0().toString();
  assert.equal(bundleModuleURL(alias), entry);
  const run = worker(`
const {parentPort} = require("node:worker_threads");
const alias = ${JSON.stringify(`ipfs://${alias}/worker.cjs`)};
parentPort.postMessage({
  filename: __filename,
  same: require(alias) === require(__filename),
  cached: require.cache[__filename] === module
});`);
  const exited = new Promise<number>((resolve) => run.once("exit", resolve));
  try {
    const [message] = await once(run, "message");
    assert.deepEqual(message, { filename: entry, same: true, cached: true });
    assert.equal(await exited, 0);
  } finally {
    await run.terminate();
  }
});

test("IPFS bootstrap import of the CJS entry shares its existing module state", async () => {
  const run = worker(`
const {parentPort} = require("node:worker_threads");
globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;
module.exports = { marker: true };
if (globalThis.evaluations === 1) setImmediate(async () => {
  const imported = await import(__filename);
  parentPort.postMessage({
    evaluations: globalThis.evaluations,
    same: imported.default === module.exports
  });
});`);
  const exited = new Promise<number>((resolve) => run.once("exit", resolve));
  try {
    const [message] = await once(run, "message");
    assert.deepEqual(message, { evaluations: 1, same: true });
    assert.equal(await exited, 0);
  } finally {
    await run.terminate();
  }
});

test("IPFS bootstrap rejects dynamic non-entry imports and URL normalization tricks", async () => {
  const run = worker(`
const {parentPort} = require("node:worker_threads");
(async () => {
  const failures = [];
  for (const address of [
    ${JSON.stringify(entry.replace("/worker.cjs", "/%2e/worker.cjs"))},
    ${JSON.stringify(entry.replace("/worker.cjs", "/a/../worker.cjs"))},
    ${JSON.stringify(entry.replace("/worker.cjs", "/worker.cjs?"))},
    ${JSON.stringify(entry.replace("/worker.cjs", "/resources/worker.cjs"))},
    "file:///unverified.cjs",
    "https://user:secret@example.invalid/worker.cjs"
  ]) {
    try { await import(address); failures.push(null); }
    catch(error) { failures.push({code: error.code, message: error.message}); }
  }
  parentPort.postMessage(failures);
})();`);
  const exited = new Promise<number>((resolve) => run.once("exit", resolve));
  try {
    const [message] = await once(run, "message");
    assert.equal(message.length, 6);
    for (const failure of message) {
      assert.equal(failure.code, "unsupported_module");
      assert.ok(failure.message.includes(entry));
      assert.doesNotMatch(failure.message, /secret|unverified|user:/);
    }
    assert.equal(await exited, 0);
  } finally {
    await run.terminate();
  }
});

test("IPFS bootstrap startup errors retain their module address and exit", async () => {
  for (const source of ["throw new Error('module startup failed');", "invalid syntax {"]) {
    const run = worker(source);
    const exited = new Promise<number>((resolve) => run.once("exit", resolve));
    try {
      const [error] = await once(run, "error");
      assert.match(error.message, /Unable to load ipfs:\/\//);
      assert.ok(error.message.includes(entry));
      assert.equal(await exited, 1);
    } finally {
      await run.terminate();
    }
  }
});
