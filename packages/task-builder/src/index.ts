import { posix } from "node:path";
import {
  json,
  normalizeTaskText,
  parseTaskBundleYaml,
  readTaskBundle,
  selectTaskBinary,
  taskBundleLimits,
  taskBundlePattern,
  taskSchemaUri,
  validateTaskBundle,
} from "@silvermoon-work/task-protocol";
import { stringify } from "yaml";
import { contractSchemas } from "./contract.js";
import { compileTree, evaluateContract } from "./esbuild.js";
import { resourceStream } from "./streams.js";
import {
  checkTreePath,
  listTree,
  memoryFile,
  readBytes,
  treeError,
  type ReadonlyFileTree,
  type ReadOptions,
  type TreeEntry,
} from "./tree.js";

export type { ReadonlyFileTree, ReadOptions, TreeEntry } from "./tree.js";

export const taskBuildSchemaUri =
  "https://shazhou-ww.github.io/potential-guide/schemas/artifacts/task-build/v1.json";

export interface BuilderLimits {
  readonly fileBytes: number;
  readonly bytes: number;
  readonly sourceBytes: number;
  readonly sourceFiles: number;
  readonly traversalPaths: number;
}

export const defaultBuilderLimits: BuilderLimits = Object.freeze({
  fileBytes: taskBundleLimits.fileBytes,
  bytes: taskBundleLimits.bytes,
  sourceBytes: 128 * 1024 * 1024,
  sourceFiles: 4096,
  traversalPaths: 16_384,
});

export interface TaskContract {
  readonly input: unknown;
  readonly result: unknown;
  readonly message: unknown;
  readonly schemas?: Readonly<Record<string, unknown>>;
}

export interface TaskBuildOptions extends ReadOptions {
  readonly name: string;
  readonly runtime: { readonly minVersion: string };
  readonly source: {
    readonly entry: string;
    readonly contract: string | TaskContract;
    readonly mode?: "callback" | "explicit";
    readonly exportName?: string;
    readonly sdk?: string;
  };
  readonly include?: readonly { readonly from: string; readonly to: string }[];
  readonly binary?: readonly string[];
  readonly allowContractExecution?: boolean;
  readonly limits?: Partial<BuilderLimits>;
}

function limitsFor(options: TaskBuildOptions): BuilderLimits {
  const limits = { ...defaultBuilderLimits, ...options.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid builder byte/path limit.");
  if (limits.fileBytes > taskBundleLimits.fileBytes || limits.bytes > taskBundleLimits.bytes)
    throw new Error("Builder limits cannot exceed Bundle protocol limits.");
  return limits;
}

async function selectResources(
  input: ReadonlyFileTree,
  rules: NonNullable<TaskBuildOptions["include"]>,
  limits: BuilderLimits,
  options: ReadOptions,
) {
  const selected = new Map<string, string>();
  const sources = new Set<string>();
  for (const rule of rules) {
    const matcher = taskBundlePattern(rule.from);
    if (!rule.to.startsWith("resources/") || !rule.to.endsWith("/"))
      throw new Error("Include destinations must be resources/ directories ending in /.");
    checkTreePath(rule.to.slice(0, -1));
    const segments = rule.from.split("/");
    const wildcard = segments.findIndex((part) => /[*?]/.test(part));
    const base = (wildcard < 0 ? segments.slice(0, -1) : segments.slice(0, wildcard)).join("/");
    let visited = 0;
    let matches = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await listTree(input, directory, options)) {
        if (++visited > limits.traversalPaths)
          throw treeError("capacity_exceeded", directory, "Include traversal exceeds path limit");
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.kind === "directory") await walk(path);
        else if (matcher.test(path)) {
          const destination = `${rule.to}${base ? path.slice(base.length + 1) : path}`;
          if (sources.has(path) || selected.has(destination))
            throw new Error(`Overlapping include selections: ${destination}`);
          selected.set(destination, path);
          sources.add(path);
          matches++;
          if (selected.size > taskBundleLimits.files - 2)
            throw new Error("Bundle exceeds file capacity.");
        }
      }
    };
    await walk(base);
    if (!matches) throw new Error(`Include rule matched no files: ${rule.from}`);
  }
  return selected;
}

function outputTree(
  input: ReadonlyFileTree,
  generated: ReadonlyMap<string, Uint8Array>,
  resources: ReadonlyMap<string, string>,
  binary: ReadonlySet<string>,
  limits: BuilderLimits,
): ReadonlyFileTree {
  const directories = new Map<string, Map<string, TreeEntry>>([["", new Map()]]);
  const sizes = new Map([...generated].map(([path, bytes]) => [path, bytes.byteLength]));
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const observe = (path: string, bytes: number) => {
    const previous = sizes.get(path) ?? 0;
    if (bytes <= previous) return;
    if (total + bytes - previous > limits.bytes)
      throw treeError("capacity_exceeded", path, "Bundle exceeds total byte limit");
    total += bytes - previous;
    sizes.set(path, bytes);
  };
  for (const path of [...generated.keys(), ...resources.keys()]) {
    const segments = path.split("/");
    let parent = "";
    for (const [index, name] of segments.entries()) {
      const directory = index < segments.length - 1;
      directories.get(parent)!.set(name, { name, kind: directory ? "directory" : "file" });
      if (directory) {
        parent = parent ? `${parent}/${name}` : name;
        if (!directories.has(parent)) directories.set(parent, new Map());
      }
    }
  }
  return Object.freeze({
    async list(path: string, options: ReadOptions = {}) {
      checkTreePath(path);
      options.signal?.throwIfAborted();
      const entries = directories.get(path);
      if (!entries)
        throw treeError(
          generated.has(path) || resources.has(path) ? "ENOTDIR" : "ENOENT",
          path,
          "Output directory not found",
        );
      return [...entries.values()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((entry) => Object.freeze({ ...entry }));
    },
    async read(path: string, options: ReadOptions = {}) {
      checkTreePath(path);
      options.signal?.throwIfAborted();
      const bytes = generated.get(path);
      if (bytes) return memoryFile(bytes, options);
      const source = resources.get(path);
      if (source !== undefined)
        return resourceStream(
          input,
          source,
          path,
          binary.has(path),
          limits.fileBytes,
          observe,
          options,
        );
      throw treeError(directories.has(path) ? "EISDIR" : "ENOENT", path, "Output file not found");
    },
  });
}

/** Compile modules now; resources remain lazy streams owned by the caller's input tree. */
export async function buildTaskBundle(
  input: ReadonlyFileTree,
  options: TaskBuildOptions,
): Promise<ReadonlyFileTree> {
  options.signal?.throwIfAborted();
  checkTreePath(options.source.entry);
  if (!options.source.entry) throw new Error("Task entry must be a file.");
  if (options.source.mode !== undefined && !["callback", "explicit"].includes(options.source.mode))
    throw new Error("Invalid Task entry mode.");
  if (options.source.mode !== "callback" && options.source.exportName !== undefined)
    throw new Error("Only callback entries can select an export.");
  const limits = limitsFor(options);
  const resources = await selectResources(input, options.include ?? [], limits, options);
  let contract: unknown = options.source.contract;
  if (typeof contract === "string") {
    checkTreePath(contract);
    if (posix.extname(contract) === ".json")
      contract = parseTaskBundleYaml(await readBytes(input, contract, 65_536, options));
    else {
      if (!options.allowContractExecution)
        throw new Error(
          "Code contracts require allowContractExecution: true (CLI --trusted-contract).",
        );
      contract = evaluateContract(
        await compileTree(input, contract, {
          ...limits,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
    }
  }
  const schemas = contractSchemas(contract);
  const primarySchemaPaths = [
    "schemas/input.json",
    "schemas/result.json",
    "schemas/message.json",
  ] as const;
  const generated = new Map<string, Uint8Array>();
  for (const { path, document } of schemas)
    generated.set(path, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
  const include = ["task.yaml", "worker.cjs", ...generated.keys(), ...resources.keys()].sort();
  const declaration = validateTaskBundle({
    $schema: taskSchemaUri,
    name: options.name,
    runtime: { type: "node", minVersion: options.runtime.minVersion },
    entry: "worker.cjs",
    include,
    binary: selectTaskBinary(include, options.binary ?? []),
    inputSchema: { $ref: primarySchemaPaths[0] },
    resultSchema: { $ref: primarySchemaPaths[1] },
    messageSchema: { $ref: primarySchemaPaths[2] },
  });
  generated.set("task.yaml", Buffer.from(stringify(declaration)));
  // Empty resource placeholders check manifest and Schema closure, not deferred resource bytes.
  const structuralFiles = new Map(generated);
  structuralFiles.set("worker.cjs", Buffer.from("/* pending compilation */"));
  for (const path of resources.keys()) structuralFiles.set(path, new Uint8Array());
  const { resolved } = readTaskBundle(structuralFiles, limits);
  generated.set(
    "worker.cjs",
    normalizeTaskText(
      await compileTree(input, options.source.entry, {
        ...limits,
        ...(options.signal ? { signal: options.signal } : {}),
        binding: resolved,
        ...(options.source.mode === "callback"
          ? { callbackExport: options.source.exportName ?? "default" }
          : {}),
        ...(options.source.sdk ? { sdk: options.source.sdk } : {}),
      }),
      "worker.cjs",
    ),
  );
  structuralFiles.set("worker.cjs", generated.get("worker.cjs")!);
  readTaskBundle(structuralFiles, limits);
  options.signal?.throwIfAborted();
  return outputTree(input, generated, resources, new Set(declaration.binary), limits);
}

export interface TaskBuildFile {
  readonly options: TaskBuildOptions;
  readonly outDirectory: string;
}

export async function readTaskBuild(
  input: ReadonlyFileTree,
  path: string,
  options: ReadOptions & { readonly allowContractExecution?: boolean } = {},
): Promise<TaskBuildFile> {
  checkTreePath(path);
  const value = parseTaskBundleYaml(await readBytes(input, path, 65_536, options));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Task build file must contain an object.");
  if (
    (value.$schema !== undefined && value.$schema !== taskBuildSchemaUri) ||
    Object.keys(value).some(
      (key) =>
        !["$schema", "name", "runtime", "source", "include", "binary", "outDirectory"].includes(
          key,
        ),
    ) ||
    typeof value.name !== "string" ||
    typeof value.outDirectory !== "string"
  )
    throw new Error("Invalid Task build file fields.");
  const runtime = value.runtime;
  const source = value.source;
  if (
    !runtime ||
    typeof runtime !== "object" ||
    Array.isArray(runtime) ||
    Object.keys(runtime).some((key) => key !== "minVersion") ||
    typeof runtime.minVersion !== "string" ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    Object.keys(source).some(
      (key) => !["entry", "contract", "mode", "exportName", "sdk"].includes(key),
    ) ||
    typeof source.entry !== "string" ||
    typeof source.contract !== "string" ||
    (source.mode !== undefined && source.mode !== "explicit" && source.mode !== "callback") ||
    (source.exportName !== undefined && typeof source.exportName !== "string") ||
    (source.sdk !== undefined && typeof source.sdk !== "string")
  )
    throw new Error("Invalid Task runtime or source.");
  const base = posix.dirname(path);
  const relative = (name: string) => {
    checkTreePath(name);
    if (!name) throw new Error("Build file paths must not be empty.");
    return base === "." ? name : `${base}/${name}`;
  };
  const include: { from: string; to: string }[] = [];
  if (value.include !== undefined) {
    if (!Array.isArray(value.include)) throw new Error("Include must be an array.");
    for (const rule of value.include) {
      if (
        !rule ||
        typeof rule !== "object" ||
        Array.isArray(rule) ||
        Object.keys(rule).sort().join(",") !== "from,to" ||
        typeof rule.from !== "string" ||
        typeof rule.to !== "string"
      )
        throw new Error("Invalid include rule.");
      taskBundlePattern(rule.from);
      include.push({ from: base === "." ? rule.from : `${base}/${rule.from}`, to: rule.to });
    }
  }
  if (
    value.binary !== undefined &&
    (!Array.isArray(value.binary) || value.binary.some((pattern) => typeof pattern !== "string"))
  )
    throw new Error("Binary must be an array of patterns.");
  const binary: string[] = [];
  if (Array.isArray(value.binary))
    for (const pattern of value.binary) {
      if (typeof pattern !== "string") throw new Error("Invalid binary pattern.");
      binary.push(pattern);
    }
  const buildOptions: TaskBuildOptions = {
    name: value.name,
    runtime: { minVersion: runtime.minVersion },
    source: {
      entry: relative(source.entry),
      contract: relative(source.contract),
      ...(source.mode ? { mode: source.mode } : {}),
      ...(source.exportName !== undefined ? { exportName: source.exportName } : {}),
      ...(source.sdk !== undefined ? { sdk: source.sdk } : {}),
    },
    include,
    binary,
    ...options,
  };
  const outDirectory = relative(value.outDirectory);
  if (
    [path, buildOptions.source.entry, String(buildOptions.source.contract)].some(
      (inputPath) => inputPath === outDirectory || inputPath.startsWith(`${outDirectory}/`),
    )
  )
    throw new Error("Output must not contain build inputs.");
  for (const rule of include) {
    const parts = rule.from.split("/");
    const wildcard = parts.findIndex((part) => /[*?]/.test(part));
    const includeRoot = (wildcard < 0 ? parts.slice(0, -1) : parts.slice(0, wildcard)).join("/");
    if (
      !includeRoot ||
      includeRoot === outDirectory ||
      includeRoot.startsWith(`${outDirectory}/`) ||
      outDirectory.startsWith(`${includeRoot}/`)
    )
      throw new Error("Include selection must not traverse the output directory.");
  }
  // Validate JSON-only configuration before a caller can perform output I/O.
  json(value);
  return { options: buildOptions, outDirectory };
}
