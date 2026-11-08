import assert from "node:assert/strict";
import test from "node:test";
import { readTaskBundle, taskBundleLimits, taskSchemaUri } from "@silvermoon-work/task-protocol";
import { defaultBundleLimits, inspectTaskBundle } from "../src/bundle.js";

function files(runtime = "22.13.0") {
  return new Map([
    [
      "task.yaml",
      Buffer.from(
        JSON.stringify({
          $schema: taskSchemaUri,
          name: "Engine Bundle protocol",
          runtime: { type: "node", minVersion: runtime },
          entry: "worker.cjs",
          binary: [],
          include: ["task.yaml", "worker.cjs"],
          inputSchema: { type: "object" },
          resultSchema: true,
          messageSchema: false,
        }),
      ),
    ],
    ["worker.cjs", Buffer.from("throw Error('Worker must not execute during inspection');")],
  ]);
}

test("Engine inspection reuses the Bundle reader while retaining host execution limits", () => {
  const bundle = files();
  assert.deepEqual(inspectTaskBundle(bundle), readTaskBundle(bundle));
  for (const key of ["bytes", "fileBytes", "files", "paths"] as const)
    assert.equal(defaultBundleLimits[key], taskBundleLimits[key]);
  assert.equal(defaultBundleLimits.hints, 16);
  assert.equal(defaultBundleLimits.retainedBytes, 256 * 1024 * 1024);
  assert.equal(defaultBundleLimits.blocks, 16_384);
  const limits = { ...defaultBundleLimits, files: 1 };
  assert.throws(() => inspectTaskBundle(bundle, limits), { code: "capacity_exceeded" });
});

test("runtime eligibility remains an Engine check, not a Bundle protocol parsing rule", () => {
  const future = files("999.0.0");
  assert.equal(readTaskBundle(future).declaration.runtime.minVersion, "999.0.0");
  assert.throws(() => inspectTaskBundle(future), { code: "unsupported_runtime" });
  const invalid = files();
  invalid.set("worker.cjs", Buffer.from([0xff]));
  assert.throws(() => inspectTaskBundle(invalid), { code: "invalid_bundle" });
});
