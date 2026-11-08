import { Ajv2020 } from "ajv/dist/2020.js";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { isTaskBundlePath, taskBundleLimits } from "./bundle-paths.js";
import { canonical, fail, type Json, type JsonObject, json, TaskError } from "./json.js";
import {
  compileInputSchema,
  compileJsonSchema,
  type InputSchema,
  type JsonSchema,
} from "./schema.js";

import { taskSchemaUri } from "./task-schema-uri.js";
export { taskSchemaUri } from "./task-schema-uri.js";
export const taskBundleSchema = {
  $id: taskSchemaUri,
  $comment:
    "IPFS UnixFS directory root CID identity. One CommonJS Worker per Run; generation-scoped business messages and independent log/log-ack, bounded cumulative log-drop/log-drop-ack diagnostics.",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "name",
    "runtime",
    "entry",
    "include",
    "binary",
    "inputSchema",
    "resultSchema",
    "messageSchema",
  ],
  properties: {
    $schema: { const: taskSchemaUri },
    name: {
      type: "string",
      minLength: 1,
      pattern:
        "^[^\\s\\u0000-\\u001f\\u007f-\\u009f](?:(?:[^\\s\\u0000-\\u001f\\u007f-\\u009f]| )*[^\\s\\u0000-\\u001f\\u007f-\\u009f])?$",
    },
    runtime: {
      type: "object",
      additionalProperties: false,
      required: ["type", "minVersion"],
      properties: {
        type: { const: "node" },
        minVersion: {
          type: "string",
          pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
        },
      },
    },
    entry: { const: "worker.cjs" },
    include: {
      type: "array",
      minItems: 2,
      maxItems: taskBundleLimits.files,
      uniqueItems: true,
      items: {
        type: "string",
        pattern:
          "^(?:task\\.yaml|worker\\.cjs|(?:schemas|resources)/[^\\\\:*?<>|\\u0000-\\u001f]+)$",
      },
    },
    inputSchema: { type: "object" },
    binary: {
      type: "array",
      maxItems: taskBundleLimits.files,
      uniqueItems: true,
      items: { type: "string", pattern: "^resources/[^\\\\:*?<>|\\u0000-\\u001f]+$" },
    },
    resultSchema: { type: ["object", "boolean"] },
    messageSchema: { type: ["object", "boolean"] },
  },
};
export * from "./bundle-reference.js";
export interface TaskBundleDeclaration {
  $schema: typeof taskSchemaUri;
  name: string;
  runtime: { type: "node"; minVersion: string };
  entry: "worker.cjs";
  include: string[];
  binary: string[];
  inputSchema: JsonObject;
  resultSchema: JsonSchema;
  messageSchema: JsonSchema;
}
export interface ResolvedTaskBundle extends Omit<TaskBundleDeclaration, "inputSchema"> {
  inputSchema: InputSchema;
}
const validator = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(taskBundleSchema);
export function parseTaskBundleYaml(bytes: Uint8Array): Json {
  if (bytes.byteLength > 64 * 1024) fail("invalid_bundle", "YAML exceeds bounds.");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const document = parseDocument(text, { schema: "core", uniqueKeys: true, strict: true });
    if (
      document.errors.length ||
      document.warnings.length ||
      document.directives?.yaml.explicit ||
      (document.directives?.tags &&
        Object.keys(document.directives.tags).some((key) => key !== "!!"))
    )
      fail("invalid_bundle", "Invalid JSON-subset YAML.");
    function inspect(node: unknown, depth: number): void {
      if (depth > 32 || isAlias(node)) fail("invalid_bundle", "YAML aliases or excessive depth.");
      if (isMap(node) || isSeq(node) || isScalar(node)) {
        if (node.tag) fail("invalid_bundle", "YAML tags are forbidden.");
        if (isMap(node))
          for (const pair of node.items) {
            if (!isScalar(pair.key) || typeof pair.key.value !== "string")
              fail("invalid_bundle", "YAML keys must be strings.");
            inspect(pair.value, depth + 1);
          }
        if (isSeq(node)) for (const child of node.items) inspect(child, depth + 1);
      }
    }
    inspect(document.contents, 0);
    return json(document.toJS({ maxAliasCount: 0 }), 1_048_576);
  } catch (error) {
    if (error instanceof TaskError && error.code === "invalid_bundle") throw error;
    fail("invalid_bundle", "YAML must contain valid UTF-8 finite JSON.");
  }
}
export function validateTaskBundle(value: unknown): TaskBundleDeclaration {
  const parsed = json(value, 1_048_576);
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    !Object.hasOwn(parsed, "include")
  )
    fail(
      "invalid_bundle",
      "Task Bundle has no exact include manifest. Rebuild with the current Task Bundle authoring tools and use the new CID.",
    );
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    !Object.hasOwn(parsed, "binary")
  )
    fail(
      "invalid_bundle",
      "Task Bundle has no exact binary manifest. Rebuild with the current Task Bundle authoring tools and use the new CID.",
    );
  if (!validator(parsed)) fail("invalid_bundle", "Invalid task.yaml declaration.");
  const declaration = parsed as unknown as TaskBundleDeclaration;
  const folded = new Set<string>();
  const spellings = new Map<string, string>();
  for (const path of declaration.include) {
    if (!isTaskBundlePath(path) || folded.has(path.toLowerCase()))
      fail("invalid_bundle", "Task Bundle include requires unique, portable exact file paths.");
    folded.add(path.toLowerCase());
    let prefix = "";
    for (const part of path.split("/")) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const previous = spellings.get(prefix.toLowerCase());
      if (previous !== undefined && previous !== prefix)
        fail("invalid_bundle", "Task Bundle include has ambiguous path casing.");
      spellings.set(prefix.toLowerCase(), prefix);
    }
  }
  for (const path of declaration.include)
    if (declaration.include.some((parent) => path.startsWith(`${parent}/`)))
      fail("invalid_bundle", "Task Bundle include has a file/directory collision.");
  if (!folded.has("task.yaml") || !folded.has("worker.cjs"))
    fail("invalid_bundle", "Task Bundle include must contain task.yaml and worker.cjs.");
  for (const [index, path] of declaration.binary.entries())
    if (
      !isTaskBundlePath(path) ||
      !declaration.include.includes(path) ||
      (index > 0 && declaration.binary[index - 1]! >= path)
    )
      fail(
        "invalid_bundle",
        "Task Bundle binary requires sorted, unique exact resource file paths from include.",
      );
  return declaration;
}
export function validateTaskBundleFiles(
  declaration: TaskBundleDeclaration,
  paths: Iterable<string>,
): void {
  const actual = new Set(paths);
  if (
    actual.size !== declaration.include.length ||
    declaration.include.some((path) => !actual.has(path))
  )
    fail(
      "invalid_bundle",
      "Task Bundle has missing or undeclared files; rebuild the complete artifact.",
    );
}
const objectSchema = (value: Json | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const schemaSingles = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "unevaluatedItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Resolve only supplied resources. No network loader or ambient Schema registry exists. */
export function resolveBundleSchemas(
  declaration: TaskBundleDeclaration,
  resources: readonly JsonObject[],
  resourcePaths?: readonly string[],
): ResolvedTaskBundle {
  if (
    resourcePaths &&
    (resourcePaths.length !== resources.length ||
      new Set(resourcePaths).size !== resourcePaths.length ||
      resourcePaths.some(
        (path) => !path.startsWith("schemas/") || !declaration.include.includes(path),
      ))
  )
    fail("invalid_schema", "Schema resource paths must match the exact Bundle manifest.");
  const registry = new Map<string, { node: JsonSchema; base: string }>();
  const locations = new WeakMap<JsonObject, string>();
  const rootBase = "https://task.invalid/declaration";
  let nodes = 0;
  function absolute(value: string, base: string): string {
    try {
      return new URL(value, base).href;
    } catch {
      return fail("invalid_schema", "Invalid Schema URI.");
    }
  }
  function add(id: string, node: JsonSchema, base: string): void {
    const existing = registry.get(id);
    if (existing && existing.node !== node) {
      if (canonical(existing.node) !== canonical(node))
        fail("invalid_schema", "Conflicting Schema resource identifier.");
      return;
    }
    registry.set(id, { node, base });
  }
  function children(node: JsonObject, visit: (child: JsonSchema) => void): void {
    for (const [key, value] of Object.entries(node)) {
      if (schemaMaps.has(key) && objectSchema(value))
        for (const child of Object.values(value)) {
          if (typeof child === "boolean" || objectSchema(child)) visit(child);
        }
      if (schemaSingles.has(key) && (typeof value === "boolean" || objectSchema(value)))
        visit(value);
      if (schemaArrays.has(key) && Array.isArray(value))
        for (const child of value)
          if (typeof child === "boolean" || objectSchema(child)) visit(child);
    }
  }
  function collect(node: JsonSchema, base: string): void {
    if (++nodes > 4096) fail("invalid_schema", "Schema resource budget exceeded.");
    if (typeof node === "boolean") return;
    if (
      node.$schema !== undefined &&
      node.$schema !== "https://json-schema.org/draft/2020-12/schema"
    )
      fail("invalid_schema", "Only JSON Schema Draft 2020-12 is supported.");
    if (node.$id !== undefined) {
      if (typeof node.$id !== "string") fail("invalid_schema", "Schema $id must be a URI.");
      base = absolute(node.$id, base);
      if (new URL(base).hash) fail("invalid_schema", "Schema $id must not contain a fragment.");
      add(base, node, base);
    }
    locations.set(node, base);
    if (node.$anchor !== undefined) {
      if (typeof node.$anchor !== "string" || !/^[A-Za-z_][-A-Za-z0-9._]*$/.test(node.$anchor))
        fail("invalid_schema", "Invalid Schema anchor.");
      add(`${base}#${node.$anchor}`, node, base);
    }
    children(node, (child) => collect(child, base));
  }
  for (const resource of resources) {
    if (!objectSchema(resource) || typeof resource.$id !== "string")
      fail("invalid_schema", "Shared Schema requires an absolute $id.");
    let id: string;
    try {
      id = new URL(resource.$id).href;
    } catch {
      return fail("invalid_schema", "Shared Schema requires an absolute $id.");
    }
    collect(resource, id);
  }
  resourcePaths?.forEach((path, index) => {
    const resource = resources[index]!;
    add(absolute(path, `${rootBase}/`), resource, locations.get(resource)!);
  });
  const roots = [declaration.inputSchema, declaration.resultSchema, declaration.messageSchema];
  roots.forEach((root, index) => {
    const base = `${rootBase}/${index}`;
    add(base, root, base);
    collect(root, base);
  });
  let expansions = 0;
  function expand(node: JsonSchema, base: string, ancestors: Set<JsonSchema>): JsonSchema {
    if (++expansions > 16_384 || ancestors.size > 64)
      fail("invalid_schema", "Schema reference expansion budget exceeded.");
    if (typeof node === "boolean") return node;
    if (ancestors.has(node)) fail("invalid_schema", "Cyclic Schema references are unsupported.");
    base = locations.get(node) ?? base;
    const path = new Set(ancestors).add(node);
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (["$id", "$anchor", "$ref"].includes(key)) continue;
      if (schemaMaps.has(key) && objectSchema(value)) {
        result[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [
            name,
            typeof child === "boolean" || objectSchema(child) ? expand(child, base, path) : child,
          ]),
        );
      } else if (schemaSingles.has(key) && (typeof value === "boolean" || objectSchema(value))) {
        result[key] = expand(value, base, path);
      } else if (schemaArrays.has(key) && Array.isArray(value)) {
        result[key] = value.map((child) =>
          typeof child === "boolean" || objectSchema(child) ? expand(child, base, path) : child,
        );
      } else result[key] = value;
    }
    if (node.$ref === undefined) return result;
    if (typeof node.$ref !== "string") fail("invalid_schema", "Schema $ref must be a URI.");
    const uri = absolute(node.$ref, base);
    let target = registry.get(uri);
    if (!target) {
      const url = new URL(uri);
      let fragment: string;
      try {
        fragment = decodeURIComponent(url.hash.slice(1));
      } catch {
        return fail("invalid_schema", "Invalid Schema URI fragment encoding.");
      }
      url.hash = "";
      const resource = registry.get(url.href);
      if (!resource) fail("invalid_schema", "Missing offline Schema resource.");
      if (fragment && !fragment.startsWith("/")) {
        target = registry.get(`${resource.base}#${fragment}`);
        if (!target) fail("invalid_schema", "Missing Schema anchor.");
      } else {
        let selected: Json = resource.node;
        for (const part of fragment.split("/").slice(1)) {
          if (/~(?:[^01]|$)/.test(part)) fail("invalid_schema", "Invalid Schema JSON Pointer.");
          const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
          if (
            (!objectSchema(selected) && !Array.isArray(selected)) ||
            !Object.hasOwn(selected, key)
          )
            fail("invalid_schema", "Missing Schema JSON Pointer.");
          selected = (selected as JsonObject)[key]!;
        }
        if (typeof selected !== "boolean" && !objectSchema(selected))
          fail("invalid_schema", "Reference does not select a Schema.");
        target = { node: selected, base: resource.base };
      }
    }
    const resolved = expand(target.node, target.base, path);
    return Object.keys(result).length
      ? { ...result, allOf: [...(Array.isArray(result.allOf) ? result.allOf : []), resolved] }
      : resolved;
  }
  const input = expand(roots[0]!, `${rootBase}/0`, new Set());
  function declaresObject(schema: JsonSchema): boolean {
    return (
      typeof schema !== "boolean" &&
      (schema.type === "object" ||
        (Array.isArray(schema.allOf) &&
          schema.allOf.some(
            (child) => (typeof child === "boolean" || objectSchema(child)) && declaresObject(child),
          )))
    );
  }
  if (typeof input !== "boolean" && input.type === undefined && declaresObject(input))
    input.type = "object";
  const result = expand(roots[1]!, `${rootBase}/1`, new Set());
  const message = expand(roots[2]!, `${rootBase}/2`, new Set());
  compileInputSchema(input);
  compileJsonSchema(result);
  compileJsonSchema(message);
  return {
    ...declaration,
    inputSchema: input as InputSchema,
    resultSchema: result,
    messageSchema: message,
  };
}
