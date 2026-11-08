import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTaskBundle } from "../src/bundle-files.js";
import { isTaskBundlePath, taskBundleLimits } from "../src/bundle-paths.js";
import { parseTaskBundleYaml, taskSchemaUri, validateTaskBundle } from "../src/bundle.js";

const encode = (value: string) => new TextEncoder().encode(value);
function bundle(extra = new Map<string, Uint8Array>(), runtime = "22.13.0") {
  return new Map([
    [
      "task.yaml",
      encode(
        JSON.stringify({
          $schema: taskSchemaUri,
          name: "Protocol file inspection",
          runtime: { type: "node", minVersion: runtime },
          entry: "worker.cjs",
          binary: [...extra.keys()].filter((path) => path.startsWith("resources/")).sort(),
          include: ["task.yaml", "worker.cjs", ...extra.keys()],
          inputSchema: { type: "object" },
          resultSchema: true,
          messageSchema: false,
        }),
      ),
    ],
    ["worker.cjs", encode("throw new Error('must not evaluate Worker');")],
    ...extra,
  ]);
}

test("Bundle limits preserve file and CAR budgets without adopting Engine retention policy", () => {
  assert.deepEqual(taskBundleLimits, {
    bytes: 64 * 1024 * 1024,
    fileBytes: 64 * 1024 * 1024,
    files: 256,
    paths: 512,
    archiveBytes: 72 * 1024 * 1024,
  });
  assert.ok(Object.isFrozen(taskBundleLimits));
});

test("Bundle paths preserve portable naming and declaration/file validation use the same rule", () => {
  assert.ok(isTaskBundlePath("resources/nested/data.bin"));
  for (const path of [
    "",
    "../outside",
    "/absolute",
    "a//b",
    "resources/CON.txt",
    "a/Node_Modules/b",
    "a\\b",
    "a:b",
    "a ",
    "a.",
    "e\u0301",
    "a\u007f",
    "a?".repeat(2),
    "x".repeat(256),
    Array(5).fill("x".repeat(255)).join("/"),
  ]) {
    assert.equal(isTaskBundlePath(path), false, path);
    const files = bundle(new Map([[`resources/${path}`, encode("data")]]));
    const yaml = files.get("task.yaml");
    assert.ok(yaml);
    const declaration = parseTaskBundleYaml(yaml);
    assert.throws(() => validateTaskBundle(declaration), { code: "invalid_bundle" });
  }
  for (const extra of [
    new Map([
      ["resources/A", encode("a")],
      ["resources/a", encode("b")],
    ]),
    new Map([
      ["resources/A/one", encode("a")],
      ["resources/a/two", encode("b")],
    ]),
    new Map([
      ["resources/a", encode("a")],
      ["resources/a/b", encode("b")],
    ]),
  ])
    assert.throws(() => readTaskBundle(bundle(extra)), { code: "invalid_bundle" });
});

test("Task declaration YAML retains strict finite JSON-subset syntax and bounds", () => {
  assert.deepEqual(parseTaskBundleYaml(encode("name: example\nitems: [1, true, null]")), {
    name: "example",
    items: [1, true, null],
  });
  assert.equal(parseTaskBundleYaml(encode("null".padEnd(65_536))), null);
  for (const bytes of [
    encode("a: &a [1]\nb: *a"),
    encode("a: !!str value"),
    encode("!custom value"),
    encode("%YAML 1.2\n---\na: 1"),
    encode("a: 1\na: 2"),
    encode("1: value"),
    encode("a: .inf"),
    encode("a: .nan"),
    encode("---\na: 1\n---\na: 2"),
    encode(`${"[".repeat(34)}0${"]".repeat(34)}`),
    new Uint8Array([0xff]),
    new Uint8Array(65_537),
  ])
    assert.throws(() => parseTaskBundleYaml(bytes), { code: "invalid_bundle" });
});

test("supplied Bundle bytes produce exact structure statistics without file IO or runtime execution", () => {
  const files = bundle(new Map([["resources/data.bin", new Uint8Array([0, 255, 17])]]), "999.0.0");
  const result = readTaskBundle(files);
  assert.equal(result.files, 3);
  assert.equal(
    result.bytes,
    [...files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
  );
  assert.equal(result.declaration.runtime.minVersion, "999.0.0");
  assert.equal(result.resolved.inputSchema.type, "object");
  assert.deepEqual(result.declaration.include, [...files.keys()]);
});

test("file, path and byte capacities enforce exact boundaries and reject invalid limits", () => {
  const files = bundle(new Map([["resources/data.bin", encode("data")]]));
  const bytes = [...files.values()].reduce((sum, value) => sum + value.byteLength, 0);
  const fileBytes = Math.max(...[...files.values()].map((value) => value.byteLength));
  assert.equal(readTaskBundle(files, { bytes, fileBytes, files: 3, paths: 4 }).bytes, bytes);
  for (const limits of [
    { bytes: bytes - 1 },
    { fileBytes: fileBytes - 1 },
    { files: 2 },
    { paths: 3 },
  ])
    assert.throws(() => readTaskBundle(files, limits), { code: "capacity_exceeded" });
  for (const limits of [{ bytes: 0 }, { files: 1.5 }, { paths: NaN }, { fileBytes: Infinity }])
    assert.throws(() => readTaskBundle(files, limits), { code: "invalid_config" });
});

test("missing, undeclared, malformed Worker and Schema files fail explicitly", () => {
  const missing = bundle();
  missing.delete("worker.cjs");
  assert.throws(() => readTaskBundle(missing), { code: "invalid_bundle" });
  const undeclared = bundle();
  undeclared.set("resources/extra", encode("extra"));
  assert.throws(() => readTaskBundle(undeclared), { code: "invalid_bundle" });
  const invalidWorker = bundle();
  invalidWorker.set("worker.cjs", new Uint8Array([0xff]));
  assert.throws(() => readTaskBundle(invalidWorker), { code: "invalid_bundle" });
  const invalidSchema = bundle(new Map([["schemas/input.json", encode("{broken")]]));
  assert.throws(() => readTaskBundle(invalidSchema), { code: "invalid_bundle" });
  const primitiveSchema = bundle(new Map([["schemas/input.json", encode("null")]]));
  assert.throws(() => readTaskBundle(primitiveSchema), { code: "invalid_schema" });
  const schemaWithoutId = bundle(new Map([["schemas/input.json", encode("{}")]]));
  assert.throws(() => readTaskBundle(schemaWithoutId), { code: "invalid_schema" });
  const tooManyFiles = bundle(
    new Map(
      Array.from({ length: 255 }, (_, index): [string, Uint8Array] => [
        `resources/${index}`,
        encode("x"),
      ]),
    ),
  );
  assert.throws(() => readTaskBundle(tooManyFiles), { code: "capacity_exceeded" });
});

test("safe sidecars are undeclared files, distinct from declared unsupported and unsafe paths", () => {
  const sidecar = bundle();
  sidecar.set("unknown.txt", encode("preserve"));
  assert.throws(() => readTaskBundle(sidecar), {
    code: "invalid_bundle",
    message: "Undeclared Bundle file: unknown.txt.",
  });
  const declaredUnsupported = bundle(new Map([["unknown.txt", encode("preserve")]]));
  assert.throws(() => readTaskBundle(declaredUnsupported), {
    code: "invalid_bundle",
    message: "Unsupported Bundle path: unknown.txt.",
  });
  const unsafe = bundle();
  unsafe.set("../unknown.txt", encode("preserve"));
  assert.throws(() => readTaskBundle(unsafe), {
    code: "invalid_bundle",
    message: "Unsafe or duplicate Bundle path.",
  });
  const resource = bundle();
  resource.set("resources/unknown.txt", encode("preserve"));
  assert.throws(() => readTaskBundle(resource), {
    code: "invalid_bundle",
    message: "Task Bundle has missing or undeclared files; rebuild the complete artifact.",
  });
  const sidecarAtCapacity = bundle();
  sidecarAtCapacity.set("unknown.txt", encode("preserve"));
  assert.throws(() => readTaskBundle(sidecarAtCapacity, { files: 2 }), {
    code: "capacity_exceeded",
  });
});

test("Bundle Schema structure resolves only the supplied exact Schema resources", () => {
  const files = bundle(
    new Map([
      [
        "schemas/input.json",
        encode(
          JSON.stringify({
            $id: "https://example.test/input",
            type: "object",
            properties: { text: { type: "string" } },
          }),
        ),
      ],
    ]),
  );
  const declaration = {
    $schema: taskSchemaUri,
    name: "Offline Schema",
    runtime: { type: "node", minVersion: "22.13.0" },
    entry: "worker.cjs",
    binary: [],
    include: [...files.keys()],
    inputSchema: { $ref: "https://example.test/input" },
    resultSchema: true,
    messageSchema: false,
  };
  files.set("task.yaml", encode(JSON.stringify(declaration)));
  assert.deepEqual(readTaskBundle(files).resolved.inputSchema, {
    type: "object",
    properties: { text: { type: "string" } },
  });
  files.set(
    "schemas/input.json",
    encode(JSON.stringify({ $id: "https://example.test/other", type: "object" })),
  );
  assert.throws(() => readTaskBundle(files), { code: "invalid_schema" });
});

test("Bundle readers and paths are independent of artifact-files and Node file IO", async () => {
  for (const name of ["bundle-files", "bundle-paths", "bundle"]) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    assert.ok(!source.includes("@potential-guide/artifact-files"));
    assert.ok(!/from ["'](?:node:)?fs(?:\/promises)?["']/.test(source));
  }
  for (const name of ["bundle-reference", "presentation"]) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    assert.ok(!source.includes("bundle-files.js"));
    assert.ok(!source.includes('from "yaml"'));
  }
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  const runtimeWorker = worker.replace(/^export type .+$/gm, "");
  assert.ok(!runtimeWorker.includes('from "./bundle.js"'));
  assert.ok(!runtimeWorker.includes("bundle-files.js"));
  assert.ok(!runtimeWorker.includes('from "yaml"'));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies.yaml, "catalog:");
  assert.equal(manifest.dependencies["@potential-guide/artifact-files"], undefined);
  const engine = await readFile(
    new URL("../../task-engine/src/bundle.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!engine.includes("@potential-guide/artifact-files"));
  assert.ok(engine.includes('from "semver"'));
  assert.ok(!engine.includes("ArtifactTreeLimits"));
  assert.ok(!engine.includes("parseArtifactYaml"));
});
