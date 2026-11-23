import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newId as rootNewId } from "@silvermoon-work/task-engine";
import { newId } from "@silvermoon-work/task-engine/identity";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const timestamp = (id: string) =>
  [...id.slice(0, 10)].reduce((value, character) => value * 32 + alphabet.indexOf(character), 0);

test("public identity and root exports retain the same ULID generator", () => {
  assert.equal(newId, rootNewId);
  const now = 1_700_000_000_123;
  const id = newId(now);
  assert.match(id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(timestamp(id), now);
  assert.equal(timestamp(newId(-1)), 0);
  assert.notEqual(newId(now), id);
});

test("public identity resolves in a fresh native process with only Node builtin imports", async () => {
  const loader = `export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("node:") && specifier !== "@silvermoon-work/task-engine/identity")
    throw new Error("Identity entry imported a non-builtin dependency: " + specifier);
  return nextResolve(specifier, context);
}`;
  const source = `import assert from "node:assert/strict";
import * as module from "node:module";
if (typeof module.registerHooks === "function") {
  module.registerHooks({resolve:${loader.replace("export ", "")}});
} else {
  module.register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
}
const identity = await import("@silvermoon-work/task-engine/identity");
assert.deepEqual(Object.keys(identity), ["newId"]);
const id = identity.newId(1700000000123);
assert.match(id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
console.log(JSON.stringify({id}));
`;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  assert.equal(stderr, "");
  const result = JSON.parse(stdout) as { id: string };
  assert.equal(timestamp(result.id), 1_700_000_000_123);
});
