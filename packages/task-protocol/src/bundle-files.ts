import {
  resolveBundleSchemas,
  validateTaskBundleFiles,
  parseTaskBundleYaml,
  validateTaskBundle,
} from "./bundle.js";
import { isTaskBundlePath, type TaskBundleFileLimits, taskBundleLimits } from "./bundle-paths.js";
import { fail, type Json, type JsonObject, TaskError } from "./json.js";
import { validateTaskText } from "./bundle-content.js";

/** Inspect supplied bytes only; filesystem, transport and runtime eligibility belong to callers. */
export function readTaskBundle(
  files: ReadonlyMap<string, Uint8Array>,
  configuration: Partial<TaskBundleFileLimits> = {},
) {
  const limits: TaskBundleFileLimits = {
    bytes: taskBundleLimits.bytes,
    fileBytes: taskBundleLimits.fileBytes,
    files: taskBundleLimits.files,
    paths: taskBundleLimits.paths,
    ...configuration,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
    fail("invalid_config", "Invalid Bundle file capacity.");
  if (files.size > limits.files) fail("capacity_exceeded", "Bundle file capacity exceeded.");
  const seen = new Set<string>();
  const spellings = new Map<string, string>();
  const unsupportedPaths: string[] = [];
  let bytes = 0;
  for (const [path, content] of files) {
    if (!isTaskBundlePath(path) || seen.has(path.toLowerCase()))
      fail("invalid_bundle", "Unsafe or duplicate Bundle path.");
    if (
      !["task.yaml", "worker.cjs"].includes(path) &&
      !path.startsWith("schemas/") &&
      !path.startsWith("resources/")
    )
      unsupportedPaths.push(path);
    seen.add(path.toLowerCase());
    let prefix = "";
    for (const part of path.split("/")) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const folded = prefix.toLowerCase();
      if (spellings.has(folded) && spellings.get(folded) !== prefix)
        fail("invalid_bundle", "Ambiguous Bundle path casing.");
      spellings.set(folded, prefix);
    }
    bytes += content.byteLength;
    if (
      content.byteLength > limits.fileBytes ||
      bytes > limits.bytes ||
      spellings.size > limits.paths
    )
      fail("capacity_exceeded", "Bundle tree capacity exceeded.");
  }
  for (const path of files.keys()) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (files.has(parts.join("/"))) fail("invalid_bundle", "Bundle file is also a parent.");
      parts.pop();
    }
  }
  const yaml = files.get("task.yaml");
  const worker = files.get("worker.cjs");
  if (!yaml || !worker?.byteLength)
    fail("invalid_bundle", "Bundle requires task.yaml and nonempty worker.cjs.");
  validateTaskText(yaml, "task.yaml");
  const parsed = parseTaskBundleYaml(yaml);
  if (
    unsupportedPaths.length &&
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.include)
  ) {
    const include = parsed.include;
    const undeclared = unsupportedPaths.find((path) => !include.includes(path));
    if (undeclared !== undefined) fail("invalid_bundle", `Undeclared Bundle file: ${undeclared}.`);
    fail("invalid_bundle", `Unsupported Bundle path: ${unsupportedPaths[0]}.`);
  }
  const declaration = validateTaskBundle(parsed);
  validateTaskBundleFiles(declaration, files.keys());
  const binary = new Set(declaration.binary);
  for (const [path, content] of files) if (!binary.has(path)) validateTaskText(content, path);
  const schemaFiles = [...files].filter(([path]) => path.startsWith("schemas/"));
  let schemas: JsonObject[];
  try {
    schemas = schemaFiles.map(([, content]) => {
      const value: Json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail("invalid_schema", "Shared Schema requires an absolute $id.");
      return value;
    });
    new TextDecoder("utf-8", { fatal: true }).decode(worker);
  } catch (error) {
    if (error instanceof TaskError) throw error;
    fail("invalid_bundle", "Invalid Bundle Worker or Schema JSON.");
  }
  return {
    declaration,
    resolved: resolveBundleSchemas(
      declaration,
      schemas,
      schemaFiles.map(([path]) => path),
    ),
    bytes,
    files: files.size,
  };
}
