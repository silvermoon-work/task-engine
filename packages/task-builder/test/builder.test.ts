import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { readTaskBundle, taskSchemaUri, TaskError } from "@silvermoon-work/task-protocol";
import {
  buildTaskBundle,
  readTaskBuild,
  type ReadonlyFileTree,
  type TaskBuildOptions,
  type TreeEntry,
} from "../src/index.js";

function tree(files: Readonly<Record<string, string | (() => ReadableStream<Uint8Array>)>>) {
  const opened: string[] = [];
  const directories = new Map<string, Map<string, TreeEntry>>([["", new Map()]]);
  for (const path of Object.keys(files)) {
    let parent = "";
    for (const [index, name] of path.split("/").entries()) {
      const directory = index < path.split("/").length - 1;
      directories.get(parent)!.set(name, { name, kind: directory ? "directory" : "file" });
      if (directory) {
        parent = parent ? `${parent}/${name}` : name;
        if (!directories.has(parent)) directories.set(parent, new Map());
      }
    }
  }
  const input: ReadonlyFileTree = {
    async list(path) {
      const result = directories.get(path);
      if (!result) throw Object.assign(new Error(`Missing directory: ${path}`), { code: "ENOENT" });
      return [...result.values()];
    },
    async read(path) {
      opened.push(path);
      const value = files[path];
      if (value === undefined)
        throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
      if (typeof value === "function") return value();
      let sent = false;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent) controller.close();
            else {
              sent = true;
              controller.enqueue(Buffer.from(value));
            }
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
  return { input, opened };
}

const options: TaskBuildOptions = {
  name: "Virtual task",
  runtime: { minVersion: "22.13.0" },
  source: {
    entry: "src/main.ts",
    contract: {
      input: Type.Object({ text: Type.String() }),
      result: Type.String(),
      message: Type.Never(),
    },
  },
};

async function bytes(tree: ReadonlyFileTree, path: string): Promise<Buffer> {
  const reader = (await tree.read(path)).getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return Buffer.concat(chunks);
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function collect(tree: ReadonlyFileTree) {
  const files = new Map<string, Uint8Array>();
  const walk = async (path: string): Promise<void> => {
    for (const entry of await tree.list(path)) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "directory") await walk(child);
      else files.set(child, await bytes(tree, child));
    }
  };
  await walk("");
  return files;
}

test("bundles virtual relative imports, TS extension aliases, package exports and require conditions", async () => {
  const { input, opened } = tree({
    "src/main.ts": `import {value} from "./nested/value.js";
import {suffix} from "virtual-dependency/feature";
const cjs = require("virtual-dependency/feature");
module.exports = value + suffix + cjs.suffix;`,
    "src/nested/value.ts": 'export const value: string = "virtual";',
    "node_modules/virtual-dependency/package.json": JSON.stringify({
      name: "virtual-dependency",
      exports: { "./feature": { import: "./esm.js", require: "./cjs.cjs" } },
    }),
    "node_modules/virtual-dependency/esm.js": 'export const suffix = "-import";',
    "node_modules/virtual-dependency/cjs.cjs": 'exports.suffix = "-require";',
  });
  const output = await buildTaskBundle(input, options);
  const files = await collect(output);
  const checked = readTaskBundle(files);
  assert.equal(checked.declaration.$schema, taskSchemaUri);
  assert.deepEqual(checked.declaration.inputSchema, { $ref: "schemas/input.json" });
  assert.deepEqual(checked.declaration.resultSchema, { $ref: "schemas/result.json" });
  assert.deepEqual(checked.declaration.messageSchema, { $ref: "schemas/message.json" });
  assert.deepEqual([...files.keys()].sort(), [
    "schemas/input.json",
    "schemas/message.json",
    "schemas/result.json",
    "task.yaml",
    "worker.cjs",
  ]);
  const module = { exports: {} };
  new Function("module", "exports", "require", "__filename", files.get("worker.cjs")!.toString())(
    module,
    module.exports,
    (specifier: string) => {
      assert.equal(specifier, "node:url");
      return { pathToFileURL: () => new URL("file:///worker.cjs") };
    },
    "worker.cjs",
  );
  assert.equal(module.exports, "virtual-import-require");
  assert.ok(opened.includes("src/nested/value.ts"));
  assert.ok(opened.includes("node_modules/virtual-dependency/esm.js"));
  assert.ok(opened.includes("node_modules/virtual-dependency/cjs.cjs"));
});

test("shared Schemas use a separate namespace and retain author IDs and offline references", async () => {
  const id = "https://example.test/shared-text";
  const { input } = tree({ "src/main.ts": "export const value = 1;" });
  const output = await buildTaskBundle(input, {
    ...options,
    source: {
      ...options.source,
      contract: {
        input: {
          type: "object",
          properties: { text: { $ref: id } },
          required: ["text"],
        },
        result: { $ref: id },
        message: false,
        schemas: { text: { $id: id, type: "string", minLength: 1 } },
      },
    },
  });
  const files = await collect(output);
  assert.deepEqual([...files.keys()].sort(), [
    "schemas/input.json",
    "schemas/message.json",
    "schemas/result.json",
    "schemas/shared/text.json",
    "task.yaml",
    "worker.cjs",
  ]);
  const shared = await bytes(output, "schemas/shared/text.json");
  assert.equal(JSON.parse(shared.toString()).$id, id);
  assert.equal(JSON.parse((await bytes(output, "schemas/result.json")).toString()).$ref, id);
  readTaskBundle(files);
});

test("JSON and trusted module contracts share named Schemas without changing the manifest structure", async () => {
  const contract = {
    input: { type: "object", properties: { user: { $ref: "https://example.test/user" } } },
    result: { $ref: "https://example.test/user" },
    message: false,
    schemas: { user: { $id: "https://example.test/user", type: "object" } },
  };
  const { input } = tree({
    "src/main.ts": "export const value = 1;",
    "src/contract.json": JSON.stringify(contract),
    "src/contract.ts": 'import contract from "./contract.json"; export default contract;',
  });
  for (const path of ["src/contract.json", "src/contract.ts"]) {
    const output = await buildTaskBundle(input, {
      ...options,
      source: { ...options.source, contract: path },
      allowContractExecution: true,
    });
    const files = await collect(output);
    const { declaration } = readTaskBundle(files);
    assert.ok(files.has("schemas/shared/user.json"));
    assert.deepEqual(Object.keys(declaration).sort(), [
      "$schema",
      "binary",
      "entry",
      "include",
      "inputSchema",
      "messageSchema",
      "name",
      "resultSchema",
      "runtime",
    ]);
    assert.deepEqual(declaration.inputSchema, { $ref: "schemas/input.json" });
    assert.equal(
      JSON.parse((await bytes(output, "schemas/result.json")).toString()).$ref,
      "https://example.test/user",
    );
  }
});

test("named shared Schemas reject conflicting identities and missing offline references", async () => {
  const id = "https://example.test/shared";
  const { input } = tree({ "src/main.ts": "export const value = 1;" });
  await assert.rejects(
    buildTaskBundle(input, {
      ...options,
      source: {
        ...options.source,
        contract: {
          input: { type: "object" },
          result: true,
          message: false,
          schemas: {
            first: { $id: id, type: "string" },
            second: { $id: id, type: "number" },
          },
        },
      },
    }),
    /Conflicting Schema resource identifier/,
  );
  await assert.rejects(
    buildTaskBundle(input, {
      ...options,
      source: {
        ...options.source,
        contract: {
          input: { type: "object" },
          result: { $ref: id },
          message: false,
          schemas: {},
        },
      },
    }),
    /Missing offline Schema resource/,
  );
});

test("resources are demand-only, repeatable, split-safe UTF-8/LF streams with preserved BOM", async () => {
  let pulls = 0;
  let cancellations = 0;
  const chunks = [
    Uint8Array.of(239),
    Uint8Array.of(187, 191, 65, 13),
    Uint8Array.of(10, 226),
    Uint8Array.of(130, 172, 13),
    Uint8Array.of(66),
  ];
  const { input, opened } = tree({
    "src/main.ts": "export const value = 1;",
    "assets/text.txt": () => {
      let index = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            if (index < chunks.length) controller.enqueue(chunks[index++]!);
            else controller.close();
          },
          cancel() {
            cancellations++;
          },
        },
        { highWaterMark: 0 },
      );
    },
  });
  const output = await buildTaskBundle(input, {
    ...options,
    include: [{ from: "assets/**", to: "resources/" }],
  });
  assert.ok(!opened.includes("assets/text.txt"));
  const stream = await output.read("resources/text.txt");
  assert.equal(pulls, 0);
  assert.ok(!opened.includes("assets/text.txt"));
  const reader = stream.getReader();
  assert.deepEqual((await reader.read()).value, chunks[0]);
  assert.equal(pulls, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pulls, 1);
  await reader.cancel();
  reader.releaseLock();
  assert.equal(cancellations, 1);
  const expected = Buffer.from("\uFEFFA\n€\nB");
  assert.deepEqual(await bytes(output, "resources/text.txt"), expected);
  assert.deepEqual(await bytes(output, "resources/text.txt"), expected);
  readTaskBundle(await collect(output));
});

test("binary resources preserve bytes and text errors are deferred and explicit", async () => {
  const { input } = tree({
    "src/main.ts": "export const value = 1;",
    "assets/data.bin": () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(255, 13, 10));
          controller.close();
        },
      }),
  });
  const include = [{ from: "assets/**", to: "resources/" }];
  const text = await buildTaskBundle(input, { ...options, include });
  await assert.rejects(
    bytes(text, "resources/data.bin"),
    (error: unknown) => error instanceof TaskError && error.code === "invalid_bundle",
  );
  const binary = await buildTaskBundle(input, { ...options, include, binary: ["resources/**"] });
  assert.deepEqual(await bytes(binary, "resources/data.bin"), Buffer.from([255, 13, 10]));
  assert.deepEqual(readTaskBundle(await collect(binary)).declaration.binary, [
    "resources/data.bin",
  ]);
});

test("truncated UTF-8 and midstream input errors fail the output stream", async () => {
  for (const truncated of [true, false]) {
    const { input } = tree({
      "src/main.ts": "export const value = 1;",
      "assets/text": () => {
        let sent = false;
        return new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(truncated ? Uint8Array.of(226) : Buffer.from("ok"));
              } else if (truncated) controller.close();
              else controller.error(new Error("source broke"));
            },
          },
          { highWaterMark: 0 },
        );
      },
    });
    const output = await buildTaskBundle(input, {
      ...options,
      include: [{ from: "assets/**", to: "resources/" }],
    });
    await assert.rejects(
      bytes(output, "resources/text"),
      truncated ? /Invalid UTF-8/ : /source broke/,
    );
  }
});

test("abort cancels a blocked resource reader; build signal does not own output lifetime", async () => {
  let cancelled = 0;
  const { input } = tree({
    "src/main.ts": "export const value = 1;",
    "assets/text": () =>
      new ReadableStream<Uint8Array>(
        {
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
  });
  const buildController = new AbortController();
  const output = await buildTaskBundle(input, {
    ...options,
    signal: buildController.signal,
    include: [{ from: "assets/**", to: "resources/" }],
  });
  buildController.abort();
  assert.ok((await bytes(output, "worker.cjs")).byteLength);
  const controller = new AbortController();
  const reader = (await output.read("resources/text", { signal: controller.signal })).getReader();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("stop reading"));
  await assert.rejects(pending, /stop reading/);
  assert.equal(cancelled, 1);
  reader.releaseLock();
});

test("resource limits are enforced lazily without counting repeated or concurrent reads twice", async () => {
  const { input } = tree({
    "src/main.ts": "export const value = 1;",
    "assets/a": "x".repeat(20_000),
    "assets/b": "y".repeat(20_000),
  });
  const include = [{ from: "assets/**", to: "resources/" }];
  const output = await buildTaskBundle(input, { ...options, include, limits: { bytes: 30_000 } });
  await Promise.all([bytes(output, "resources/a"), bytes(output, "resources/a")]);
  await assert.rejects(bytes(output, "resources/b"), /total byte limit/);
  const small = await buildTaskBundle(input, {
    ...options,
    include,
    limits: { fileBytes: 10_000 },
  });
  await assert.rejects(bytes(small, "resources/a"), /Resource exceeds byte limit/);
});

test("normalized resource bytes succeed at exact file/total limits and fail one byte below", async () => {
  const text = "x".repeat(20_000);
  const { input } = tree({
    "src/main.ts": "export const value = 1;",
    "assets/text": text,
  });
  const include = [{ from: "assets/**", to: "resources/" }];
  const baseline = await buildTaskBundle(input, { ...options, include });
  let generatedBytes = 0;
  for (const path of [
    "task.yaml",
    "worker.cjs",
    "schemas/input.json",
    "schemas/result.json",
    "schemas/message.json",
  ])
    generatedBytes += (await bytes(baseline, path)).byteLength;
  const exact = await buildTaskBundle(input, {
    ...options,
    include,
    limits: { fileBytes: text.length, bytes: generatedBytes + text.length },
  });
  assert.equal((await bytes(exact, "resources/text")).byteLength, text.length);
  for (const limits of [
    { fileBytes: text.length - 1 },
    { bytes: generatedBytes + text.length - 1 },
  ]) {
    const output = await buildTaskBundle(input, { ...options, include, limits });
    await assert.rejects(bytes(output, "resources/text"), /byte limit/);
  }
});

test("module graph byte limits interrupt streaming source aggregation before EOF", async () => {
  let pulls = 0;
  let cancelled = 0;
  const { input } = tree({
    "src/main.ts": () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            if (pulls < 50) controller.enqueue(Buffer.from(" ".repeat(1024)));
            else controller.close();
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
  });
  await assert.rejects(
    buildTaskBundle(input, { ...options, limits: { sourceBytes: 1024 } }),
    /Module graph exceeds byte limit/,
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, 1);
});

test("trusted code contracts compile exclusively from the tree; JSON contracts need no execution", async () => {
  const { input } = tree({
    "src/main.ts": "export const value = 1;",
    "src/contract.ts": 'import contract from "./contract.json"; export default contract;',
    "src/contract.json": JSON.stringify({
      input: { type: "object" },
      result: true,
      message: false,
    }),
  });
  const source = { ...options.source, contract: "src/contract.ts" };
  await assert.rejects(buildTaskBundle(input, { ...options, source }), /allowContractExecution/);
  const trusted = await buildTaskBundle(input, {
    ...options,
    source,
    allowContractExecution: true,
  });
  readTaskBundle(await collect(trusted));
  const json = await buildTaskBundle(input, {
    ...options,
    source: { ...source, contract: "src/contract.json" },
  });
  readTaskBundle(await collect(json));
});

test("callback wrapper injects the locked SDK binding and keeps callback evaluation lazy", async () => {
  const { input } = tree({
    "src/main.ts": 'throw new Error("author was evaluated"); export default () => "ok";',
    "node_modules/@silvermoon-work/task-sdk/package.json": JSON.stringify({
      name: "@silvermoon-work/task-sdk",
      exports: "./index.js",
    }),
    "node_modules/@silvermoon-work/task-sdk/index.js": `import {binding} from "./binding.js";
export function runTask(callback) { globalThis.fixture = {callback, binding}; }`,
    "node_modules/@silvermoon-work/task-sdk/binding.js": "export const binding = undefined;",
  });
  const output = await buildTaskBundle(input, {
    ...options,
    source: { ...options.source, mode: "callback" },
  });
  const source = (await bytes(output, "worker.cjs")).toString();
  const fixture: { fixture?: { binding: { declaration: { name: string } } } } = {};
  new Function("globalThis", "require", "__filename", source)(
    fixture,
    () => ({ pathToFileURL: () => new URL("file:///worker.cjs") }),
    "worker.cjs",
  );
  assert.equal(fixture.fixture?.binding.declaration.name, options.name);
});

test("missing imports never fall back to host node_modules; unsafe and colliding paths fail", async () => {
  const missing = tree({ "src/main.ts": 'import "esbuild";' });
  await assert.rejects(buildTaskBundle(missing.input, options), /resolve 'esbuild'/);
  const escaping = tree({ "src/main.ts": 'import "../../outside.js";' });
  await assert.rejects(buildTaskBundle(escaping.input, options), /resolve/);
  const collision = tree({
    "src/main.ts": "export const value = 1;",
    "assets/A": "a",
    "assets/a": "b",
  });
  await assert.rejects(
    buildTaskBundle(collision.input, {
      ...options,
      include: [{ from: "assets/**", to: "resources/" }],
    }),
    /portable exact file paths/,
  );
  await assert.rejects(
    buildTaskBundle(collision.input, {
      ...options,
      include: [{ from: "assets/missing*", to: "resources/" }],
    }),
    /matched no files/,
  );
});

test("build files use tree-relative paths, reject unknown fields, and protect author inputs", async () => {
  const definition = {
    name: "Nested",
    runtime: { minVersion: "22.13.0" },
    source: { entry: "main.ts", contract: "contract.json" },
    outDirectory: "dist",
    include: [{ from: "assets/**", to: "resources/" }],
  };
  const { input } = tree({ "project/task.build.yaml": JSON.stringify(definition) });
  const parsed = await readTaskBuild(input, "project/task.build.yaml");
  assert.equal(parsed.options.source.entry, "project/main.ts");
  assert.equal(parsed.outDirectory, "project/dist");
  assert.deepEqual(parsed.options.include, [{ from: "project/assets/**", to: "resources/" }]);
  for (const invalid of [
    { ...definition, unexpected: true },
    { ...definition, outDirectory: "../escape" },
  ]) {
    await assert.rejects(
      readTaskBuild(tree({ "task.build.yaml": JSON.stringify(invalid) }).input, "task.build.yaml"),
    );
  }
});
