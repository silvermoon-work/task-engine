import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

test("private application launcher displays CLI help and exits naturally", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    resolve("dist", "main.js"),
    "--help",
  ]);
  assert.match(stdout, /Usage: task-engine run/);
  assert.equal(stderr, "");
});
