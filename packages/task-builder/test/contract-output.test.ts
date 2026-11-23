import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskBundle } from "../src/index.js";
import { memoryTree } from "../src/tree.js";

const primary = '{parameters:{type:"object"},result:true,message:false}';
for (const statement of [
  'console.log("hidden")',
  'console.error("hidden")',
  'process.stdout.write("hidden")',
  'process.stderr.write("hidden")',
  'require("node:fs").writeSync(1, "hidden")',
  'require("node:fs").writeSync(2, "hidden")',
  'require("node:fs").write(1, "hidden", () => {})',
  'require("node:fs").createWriteStream("", {fd: 1, autoClose: false}).write("hidden")',
  'require("node:child_process").spawnSync(process.execPath, ["-e", "console.log(\'hidden\')"], {stdio:"inherit"})',
  'new (require("node:console").Console)(process.stdout).log("hidden")',
  'try { console.log("hidden"); } catch {}',
  'setTimeout(() => { try { process.stderr.write("hidden"); } catch {} }, 5)',
  'Promise.resolve().then(() => { try { console.log("hidden"); } catch {} })',
])
  test(`contract output attempts fail even when caught or deferred: ${statement}`, async () => {
    const tree = memoryTree(
      new Map([
        ["main.ts", Buffer.from('console.log("Task execution logging remains legal");')],
        ["contract.ts", Buffer.from(`import "./dependency.js"; export default ${primary};`)],
        ["dependency.ts", Buffer.from(statement)],
      ]),
    );
    await assert.rejects(
      buildTaskBundle(tree, {
        name: "Output test",
        runtime: { minVersion: "22.13.0" },
        source: { entry: "main.ts", contract: "contract.ts" },
        allowContractExecution: true,
      }),
      { code: "CONTRACT_OUTPUT_FORBIDDEN" },
    );
  });

test("silent JS/TS contracts execute normally and abort terminates pending evaluation", async () => {
  for (const extension of ["js", "ts"]) {
    const tree = memoryTree(
      new Map([
        ["main.ts", Buffer.from('console.log("runtime log");')],
        [`contract.${extension}`, Buffer.from(`export default ${primary};`)],
      ]),
    );
    const bundle = await buildTaskBundle(tree, {
      name: "Silent",
      runtime: { minVersion: "22.13.0" },
      source: { entry: "main.ts", contract: `contract.${extension}` },
      allowContractExecution: true,
    });
    assert.ok(await bundle.read("task.yaml"));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cancel evaluation")), 200);
  try {
    const tree = memoryTree(
      new Map([
        ["main.ts", Buffer.from("export {};")],
        ["contract.ts", Buffer.from(`setInterval(() => {}, 100); export default ${primary};`)],
      ]),
    );
    await assert.rejects(
      buildTaskBundle(tree, {
        name: "Canceled",
        runtime: { minVersion: "22.13.0" },
        allowContractExecution: true,
        source: { entry: "main.ts", contract: "contract.ts" },
        signal: controller.signal,
      }),
      /cancel evaluation/,
    );
  } finally {
    clearTimeout(timer);
  }
});
