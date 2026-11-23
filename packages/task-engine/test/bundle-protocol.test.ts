import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskBundleYaml,
  readTaskBundle,
  taskBundleLimits,
  taskSchemaUri,
} from "@silvermoon-work/task-protocol";
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
          parametersSchema: { type: "object" },
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
  const { runtime } = readTaskBundle(future).declaration;
  assert.ok(runtime.type === "node");
  assert.equal(runtime.minVersion, "999.0.0");
  assert.throws(() => inspectTaskBundle(future), { code: "unsupported_runtime" });
  const invalid = files();
  invalid.set("worker.cjs", Buffer.from([0xff]));
  assert.throws(() => inspectTaskBundle(invalid), { code: "invalid_bundle" });
});

test("Node Engine rejects non-Node runtimes during inspection before executing their entry", () => {
  const bundle = files();
  const declaration = parseTaskBundleYaml(bundle.get("task.yaml")!);
  assert.ok(declaration && typeof declaration === "object" && !Array.isArray(declaration));
  for (const type of ["browser", "browser-worker", "cloudflare-worker"]) {
    bundle.set("task.yaml", Buffer.from(JSON.stringify({ ...declaration, runtime: { type } })));
    assert.equal(readTaskBundle(bundle).declaration.runtime.type, type);
    assert.throws(() => inspectTaskBundle(bundle), {
      code: "unsupported_runtime",
      message: `Bundle runtime ${type} is unsupported by the Node Engine.`,
    });
  }
});
