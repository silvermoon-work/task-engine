import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createTaskProject } from "../src/init.js";
import { memoryTree, readBytes } from "../src/tree.js";

test("init returns a deterministic owned task template without CLI or package-manager configuration", async () => {
  const tree = createTaskProject({ name: "@example/echo" });
  assert.deepEqual(
    (await tree.list("")).map(({ name }) => name),
    [".gitignore", "assets", "package.json", "src", "task.build.yaml"],
  );
  const bytes = await readBytes(tree, "package.json", 65_536);
  const manifest = JSON.parse(Buffer.from(bytes).toString());
  assert.equal(manifest.name, "@example/echo");
  assert.equal(manifest.private, true);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.dependencies["@potential-guide/task-sdk"], "0.1.0-rc.2");
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.packageManager, undefined);
  const expected = Buffer.from(bytes);
  bytes.fill(0);
  assert.deepEqual(await readBytes(tree, "package.json", 65_536), expected);
  assert.deepEqual(
    await readBytes(createTaskProject({ name: "@example/echo" }), "package.json", 65_536),
    expected,
  );
  assert.deepEqual(await readBytes(tree, "assets/greeting.txt", 6), Buffer.from("Hello\n"));
});

test("init accepts explicit dependency specs and rejects unsafe configuration", async () => {
  const tree = createTaskProject({
    sdkVersion: "0.1.0-rc.2",
    taskName: "Custom task",
  });
  const manifest = JSON.parse(
    Buffer.from(await readBytes(tree, "package.json", 65_536)).toString(),
  );
  assert.equal(manifest.dependencies["@potential-guide/task-sdk"], "0.1.0-rc.2");
  for (const name of [
    "",
    "Uppercase",
    "../escape",
    "@scope",
    "name with spaces",
    "node_modules",
    "favicon.ico",
  ])
    assert.throws(() => createTaskProject({ name }), /npm package name/);
  assert.throws(() => createTaskProject({ taskName: "" }), /declaration/);
  assert.throws(() => createTaskProject({ minRuntimeVersion: "invalid" }), /declaration/);
  assert.throws(() => createTaskProject({ sdkVersion: "\n" }), /Dependency specifiers/);
});

test("published-style init and CAR subpaths import without loading esbuild", () => {
  const script = `
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const module = await import(process.argv[1]);
if (process.argv[1].endsWith("/init")) module.createTaskProject();
if (Object.keys(require.cache).some(path => path.includes("esbuild") || path.includes("enhanced-resolve")))
  throw new Error("Standalone entry loaded the JS compiler.");
`;
  for (const subpath of ["init", "car"])
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      `@silvermoon-work/task-builder/${subpath}`,
    ]);
});

test("memory template trees enforce file/directory kinds and never expose owned bytes", async () => {
  const bytes = Buffer.from("content");
  const tree = memoryTree(new Map([["directory/file", bytes]]));
  bytes.fill(0);
  assert.deepEqual(await readBytes(tree, "directory/file", 100), Buffer.from("content"));
  await assert.rejects(tree.read("directory"), /File not found/);
  await assert.rejects(tree.list("directory/file"), /Directory not found/);
  await assert.rejects(tree.read("../escape"), /relative file-tree path/);
  assert.throws(
    () =>
      memoryTree(
        new Map([
          ["file", Buffer.from("a")],
          ["file/child", Buffer.from("b")],
        ]),
      ),
    /collision/,
  );
});
