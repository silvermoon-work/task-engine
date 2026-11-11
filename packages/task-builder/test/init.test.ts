import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createTaskProject } from "../src/init.js";
import { memoryTree, readBytes } from "../src/tree.js";

test("init returns a deterministic owned task template without CLI or package-manager configuration", async () => {
  const tree = createTaskProject({ name: "@example/echo" });
  assert.deepEqual(
    (await tree.list("")).map(({ name }) => name),
    [".gitignore", "assets", "package.json", "src", "task.build.yaml", "tsconfig.json"],
  );
  const bytes = await readBytes(tree, "package.json", 65_536);
  const manifest = JSON.parse(Buffer.from(bytes).toString());
  assert.equal(manifest.name, "@example/echo");
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.devDependencies, {
    "@types/node": "22.20.5",
    typescript: "5.9.3",
  });
  const sdkManifest = JSON.parse(
    await readFile(new URL("../../task-sdk/package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.dependencies, {
    "@silvermoon-work/task-sdk": "0.2.0-rc.0",
    "@sinclair/typebox": "0.34.52",
  });
  const candidate = createTaskProject({ name: "@example/echo", sdkVersion: sdkManifest.version });
  const candidateManifest = JSON.parse(
    Buffer.from(await readBytes(candidate, "package.json", 65_536)).toString(),
  );
  assert.deepEqual(candidateManifest.dependencies, {
    "@silvermoon-work/task-sdk": sdkManifest.version,
    "@sinclair/typebox": "0.34.52",
  });
  assert.match(
    Buffer.from(await readBytes(tree, "src/main.ts", 65_536)).toString(),
    /import \{ runTask \} from "@silvermoon-work\/task-sdk"/,
  );
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

test("generated TypeBox contract derives usable Input/Result types and typechecks the Worker", async () => {
  const root = resolve(".cache", `init-types-${randomUUID()}`);
  const tree = createTaskProject();
  try {
    for (const path of [
      "package.json",
      "tsconfig.json",
      "src/contract.ts",
      "src/helper.ts",
      "src/main.ts",
    ]) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readBytes(tree, path, 65_536));
    }
    await writeFile(
      join(root, "src/types.test.ts"),
      `import type { Input, Result } from "./contract.js";
const input: Input = { text: "hello" };
const result: Result = { text: input.text, bytes: 6, chunks: 1 };
const text: string = result.text;
const bytes: number = result.bytes;
const chunks: number = result.chunks;
// @ts-expect-error shared text must not infer as unknown or any
const badInput: Input = { text: 123 };
// @ts-expect-error shared result text must be a string
const badText: Result = { text: 123, bytes: 6, chunks: 1 };
// @ts-expect-error result byte count must be numeric
const badBytes: Result = { text: "hello", bytes: "6", chunks: 1 };
// @ts-expect-error result chunk count is required
const missingChunks: Result = { text: "hello", bytes: 6 };
// @ts-expect-error input properties are explicit
const extraInput: Input = { text: "hello", extra: true };
`,
    );
    const typecheck = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
          "--project",
          "tsconfig.json",
          "--pretty",
          "false",
        ],
        { cwd: root, encoding: "utf8" },
      );
    const valid = typecheck();
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    const contract = await readFile(join(root, "src/contract.ts"), "utf8");
    await writeFile(
      join(root, "src/contract.ts"),
      `${contract}\nconst invalidInput: Input = { text: 123 };
const invalidResult: Result = { text: "hello", bytes: "6", chunks: 1 };
`,
    );
    const invalidContract = typecheck();
    assert.equal(invalidContract.status, 2, invalidContract.stderr);
    assert.match(invalidContract.stdout, /src[/\\]contract\.ts.*TS2322.*number.*string/);
    assert.match(invalidContract.stdout, /src[/\\]contract\.ts.*TS2322.*string.*number/);
    await writeFile(join(root, "src/contract.ts"), contract);
    const main = await readFile(join(root, "src/main.ts"), "utf8");
    await writeFile(
      join(root, "src/main.ts"),
      main.replace("bytes, chunks };", 'bytes: "wrong", chunks };'),
    );
    const invalidWorker = typecheck();
    assert.equal(invalidWorker.status, 2, invalidWorker.stderr);
    assert.match(invalidWorker.stdout, /src[/\\]main\.ts.*TS2345/);
    assert.match(invalidWorker.stdout, /Type 'string' is not assignable to type 'number'/);
    await assert.rejects(tree.read("src/contract.json"), /File not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init fixes the module directory from the package name, independently of Task identity", async () => {
  for (const [name, derived] of [
    [undefined, "task-project"],
    ["echo-task", "echo-task"],
    ["@acme/echo-task", "acme-echo-task"],
    ["@con/echo-task", "con-echo-task"],
    ["a".repeat(214), "a".repeat(214)],
  ] as const) {
    const tree = createTaskProject({
      ...(name !== undefined ? { name } : {}),
      taskName: "Different Task",
    });
    const definition = parse(
      Buffer.from(await readBytes(tree, "task.build.yaml", 65_536)).toString(),
    );
    assert.equal(definition.outDirectory, `dist/${derived}`);
    assert.equal(definition.name, "Different Task");
  }
});

test("init rejects package names whose derived output paths are not portable", () => {
  for (const name of [
    "con",
    "aux.txt",
    "com1",
    "lpt9.log",
    "echo.",
    "@acme/echo.",
    "@con.txt/echo",
  ])
    assert.throws(() => createTaskProject({ name }), /unsafe output path.*Choose a package name/);
});

test("init accepts explicit dependency specs and rejects unsafe configuration", async () => {
  const tree = createTaskProject({
    sdkVersion: "file:task-sdk.tgz",
    taskName: "Custom task",
  });
  const manifest = JSON.parse(
    Buffer.from(await readBytes(tree, "package.json", 65_536)).toString(),
  );
  assert.deepEqual(manifest.dependencies, {
    "@silvermoon-work/task-sdk": "file:task-sdk.tgz",
    "@sinclair/typebox": "0.34.52",
  });
  for (const name of [
    "",
    "Uppercase",
    "../escape",
    "@scope",
    "name with spaces",
    "node_modules",
    "favicon.ico",
    "a".repeat(215),
    "@scope/../escape",
    "echo;clean",
    "echo\\task",
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
