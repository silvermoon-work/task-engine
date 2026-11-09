import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as runtime from "../src/index.js";
import { RunFailure } from "@silvermoon-work/task-protocol/worker";

test("SDK exposes only the Worker runtime and depends only on the workspace protocol", async () => {
  assert.deepEqual(Object.keys(runtime).sort(), ["RunFailure", "runTask"]);
  assert.equal(runtime.RunFailure, RunFailure);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(manifest.dependencies, { "@silvermoon-work/task-protocol": "workspace:*" });
});

test("SDK refuses to run without a build-locked Bundle binding", () => {
  const callback: runtime.TaskCallback = (input, context) =>
    context.invokeTask({
      key: "child",
      cid: "host-verified-child",
      path: "resources/child",
      input,
      timeoutMs: 1000,
    });
  assert.throws(() => runtime.runTask(callback), /build-locked Bundle binding/);
});
