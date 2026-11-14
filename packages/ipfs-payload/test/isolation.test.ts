import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as payload from "../src/index.js";

test("payload codecs do not depend on or re-export ipfs-tree or a Store", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(Object.hasOwn(manifest.dependencies, "@silvermoon-work/ipfs-tree"), false);
  assert.equal(Object.hasOwn(manifest.dependencies, "@silvermoon-work/ipfs-store"), false);
  assert.equal(Object.hasOwn(payload, "ReadonlyIpfsTree"), false);
});
