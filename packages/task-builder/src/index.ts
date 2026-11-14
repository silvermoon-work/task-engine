import { isAbsolute, posix } from "node:path";
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
  validateTaskImports,
} from "@silvermoon-work/task-protocol";
import type { IpfsStore } from "@silvermoon-work/ipfs-store";
import { ContentBlocks } from "@silvermoon-work/ipfs-store/dag";
import { expandContent } from "./content.js";
import { CID } from "multiformats/cid";
import { importSidecar, encodeImportBlocks } from "./imports.js";
import { stringify } from "yaml";
import { contractSchemas } from "./contract.js";
import { compileTree, evaluateContract } from "./esbuild.js";
import { resourceStream } from "./streams.js";
import {
  checkTreePath,
  fileTree,
  listTree,
  memoryFile,
  readBytes,
  treeError,
  type ReadonlyFileTree,
  type ReadOptions,
  type FileReader,
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
  readonly parameters: unknown;
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
  readonly imports?: Readonly<Record<string, string>>;
  readonly content?: IpfsStore;
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
  const sizes = new Map(
    [...generated]
      .filter(([path]) => path !== importSidecar)
      .map(([path, bytes]) => [path, bytes.byteLength]),
  );
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const observe = (path: string, bytes: number) => {
    const previous = sizes.get(path) ?? 0;
    if (bytes <= previous) return;
    if (total + bytes - previous > limits.bytes)
      throw treeError("capacity_exceeded", path, "Bundle exceeds total byte limit");
    total += bytes - previous;
    sizes.set(path, bytes);
  };
  const readers = new Map<string, FileReader>();
  for (const [path, bytes] of generated) readers.set(path, (options) => memoryFile(bytes, options));
  for (const [path, source] of resources)
    readers.set(path, (options) =>
      resourceStream(input, source, path, binary.has(path), limits.fileBytes, observe, options),
    );
  return fileTree(readers);
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
  const imports = validateTaskImports(options.imports ?? {});
  const imported = new Map<string, Uint8Array>();
  let importedBytes = 0;
  const blocks = new ContentBlocks(options.content);
  for (const [destination, cid] of Object.entries(imports)) {
    if (!options.content) throw new Error("Imports require an IpfsStore content object.");
    for (const local of resources.keys())
      if (
        local.toLowerCase() === destination.toLowerCase() ||
        local.toLowerCase().startsWith(`${destination.toLowerCase()}/`) ||
        destination.toLowerCase().startsWith(`${local.toLowerCase()}/`)
      )
        throw new Error(`Import/include collision: ${destination}`);
    const files = await expandContent(CID.parse(cid), options.content, {
      ...options,
      files: taskBundleLimits.files - imported.size,
      paths: limits.traversalPaths,
      bytes: limits.bytes - importedBytes,
      fileBytes: limits.fileBytes,
    });
    for (const file of files) {
      const path = file.path ? `${destination}/${file.path}` : destination;
      checkTreePath(path);
      imported.set(path, file.bytes);
      importedBytes += file.bytes.byteLength;
    }
  }
  let contract: unknown = options.source.contract;
  let evaluated: ReturnType<typeof contractSchemas> | undefined;
  if (typeof contract === "string") {
    checkTreePath(contract);
    if (posix.extname(contract) === ".json")
      contract = parseTaskBundleYaml(await readBytes(input, contract, 65_536, options));
    else {
      if (!options.allowContractExecution)
        throw new Error("Code contracts require allowContractExecution: true.");
      evaluated = await evaluateContract(
        await compileTree(input, contract, {
          ...limits,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        options,
      );
    }
  }
  const schemas = evaluated ?? contractSchemas(contract);
  const primarySchemaPaths = [
    "schemas/parameters.json",
    "schemas/result.json",
    "schemas/message.json",
  ] as const;
  const generated = new Map<string, Uint8Array>();
  for (const { path, document } of schemas)
    generated.set(path, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
  const include = [
    "task.yaml",
    "worker.cjs",
    ...generated.keys(),
    ...resources.keys(),
    ...imported.keys(),
  ].sort();
  const declaration = validateTaskBundle({
    $schema: taskSchemaUri,
    name: options.name,
    runtime: { type: "node", minVersion: options.runtime.minVersion },
    entry: "worker.cjs",
    include,
    binary: [
      ...new Set([...selectTaskBinary(include, options.binary ?? []), ...imported.keys()]),
    ].sort(),
    ...(Object.keys(imports).length ? { imports } : {}),
    parametersSchema: { $ref: primarySchemaPaths[0] },
    resultSchema: { $ref: primarySchemaPaths[1] },
    messageSchema: { $ref: primarySchemaPaths[2] },
  });
  generated.set("task.yaml", Buffer.from(stringify(declaration)));
  // Empty resource placeholders check manifest and Schema closure, not deferred resource bytes.
  const structuralFiles = new Map(generated);
  structuralFiles.set("worker.cjs", Buffer.from("/* pending compilation */"));
  for (const path of resources.keys()) structuralFiles.set(path, new Uint8Array());
  for (const path of imported.keys()) structuralFiles.set(path, new Uint8Array());
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
  for (const [path, bytes] of imported) structuralFiles.set(path, bytes);
  readTaskBundle(structuralFiles, limits);
  options.signal?.throwIfAborted();
  for (const [path, bytes] of imported) generated.set(path, bytes);
  if (Object.keys(imports).length)
    generated.set(importSidecar, await encodeImportBlocks(imports, blocks, options));
  return outputTree(input, generated, resources, new Set(declaration.binary), limits);
}

export interface TaskBuildFile {
  readonly options: TaskBuildOptions;
  readonly outDirectory: string;
}

export async function readTaskBuild(
  input: ReadonlyFileTree,
  path: string,
  options: ReadOptions & {
    readonly allowContractExecution?: boolean;
    readonly outDirectory?: string;
  } = {},
): Promise<TaskBuildFile> {
  checkTreePath(path);
  const value = parseTaskBundleYaml(await readBytes(input, path, 65_536, options));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Task build file must contain an object.");
  if (
    (value.$schema !== undefined && value.$schema !== taskBuildSchemaUri) ||
    Object.keys(value).some(
      (key) =>
        ![
          "$schema",
          "name",
          "runtime",
          "source",
          "include",
          "binary",
          "imports",
          "outDirectory",
        ].includes(key),
    ) ||
    typeof value.name !== "string" ||
    (value.outDirectory !== undefined && typeof value.outDirectory !== "string")
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
    imports: validateTaskImports(value.imports ?? {}),
    ...options,
  };
  const selectedOutput = options.outDirectory ?? value.outDirectory ?? "dist";
  if (typeof selectedOutput !== "string" || !selectedOutput.trim())
    throw new Error("Output directory must not be empty.");
  const outDirectory = isAbsolute(selectedOutput)
    ? selectedOutput
    : posix.normalize(posix.join(base, selectedOutput.replaceAll("\\", "/")));
  if (
    outDirectory === "." ||
    outDirectory.split("/").every((part) => part === "..") ||
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
