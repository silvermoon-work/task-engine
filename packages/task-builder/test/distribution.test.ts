import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("core package distribution has no CLI binary, host adapter or CLI dependency", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.exports["./node"], undefined);
  assert.ok(manifest.exports["./tree"]);
  assert.equal(manifest.dependencies["@silvermoon-work/task-builder-cli"], undefined);
  assert.equal(manifest.dependencies.commander, undefined);
  const files = await readdir("dist");
  assert.ok(!files.some((name) => /^(?:cli|node)\./.test(name)));
});
