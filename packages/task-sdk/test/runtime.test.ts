import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RunFailure } from "@silvermoon-work/task-protocol/worker";
import * as runtime from "../src/index.js";

test("SDK exposes only the Worker runtime with protocol and CID dependencies", async () => {
  assert.deepEqual(Object.keys(runtime).sort(), ["ContentRef", "RunFailure", "runTask"]);
  assert.equal(runtime.RunFailure, RunFailure);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(manifest.dependencies, {
    "@silvermoon-work/ipfs-access": "workspace:*",
    "@silvermoon-work/ipfs-payload": "workspace:*",
    "@silvermoon-work/task-protocol": "workspace:*",
    multiformats: "catalog:",
  });
  assert.equal(Object.hasOwn(manifest.dependencies, "@silvermoon-work/ipfs-tree"), false);
  assert.equal(Object.hasOwn(runtime, "ReadonlyIpfsTree"), false);
});

test("SDK refuses to run without a build-locked Bundle binding", () => {
  const callback: runtime.TaskCallback = (parameters, context) =>
    context.invokeTask({
      key: "child",
      bundle: context.bundle,
      path: "resources/child",
      parameters,
      timeoutMs: 1000,
    });
  assert.throws(() => runtime.runTask(callback), /build-locked Bundle binding/);
});
