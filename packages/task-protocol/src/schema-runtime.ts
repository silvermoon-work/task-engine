import { createHash } from "node:crypto";
import { canonical, fail, freeze, type Json, type JsonObject, json } from "./json.js";

export type InputSchema = JsonObject;
export type JsonSchema = boolean | JsonObject;
export interface JsonContract {
  readonly schema: JsonSchema;
  readonly revision: string;
  validate(value: unknown): Json;
}

/** Result 与消息契约支持 boolean 根；false 表示 Never。 */
export function createJsonContract(
  value: unknown,
  compiler: SchemaCompiler,
  options: Partial<SchemaLimits> = {},
): JsonContract {
  const schema = json(value, options.maxSchemaBytes ?? 262_144);
  if (
    typeof schema !== "boolean" &&
    (schema === null || typeof schema !== "object" || Array.isArray(schema))
  )
    fail("invalid_schema", "JSON Schema must be a boolean or object.");
  const contract = compileContract(schema, options, compiler);
  return Object.freeze({
    schema: freeze(schema) as JsonSchema,
    revision: createHash("sha256").update(canonical(schema)).digest("hex"),
    validate(input: unknown) {
      const parsed = json(input, options.maxInputBytes ?? 65_536);
      contract.validate(parsed);
      return parsed;
    },
  });
}
export interface SchemaLimits {
  maxSchemaBytes: number;
  maxSchemaNodes: number;
  maxReferenceExpansions: number;
  maxInputBytes: number;
  maxProjectionNodes: number;
  maxProjectionBytes: number;
}
export interface InputContract<Input = Json> {
  readonly inputSchema: InputSchema;
  readonly revision: string;
  validate(value: unknown): Input;
  equals(left: unknown, right: unknown): boolean;
  equivalenceKey(value: Json): string;
}
const defaults: SchemaLimits = {
  maxSchemaBytes: 262_144,
  maxSchemaNodes: 4096,
  maxReferenceExpansions: 16_384,
  maxInputBytes: 65_536,
  maxProjectionNodes: 262_144,
  maxProjectionBytes: 1_048_576,
};
type Schema = boolean | JsonObject;
const maps = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
];
const singles = [
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
];
const arrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
const record = (value: Json | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSchema = (value: Json | undefined): value is Schema =>
  typeof value === "boolean" || record(value);
const fields = (value: Json | undefined): value is JsonObject =>
  record(value) && Object.keys(value).length > 0;

/** Contracts are trusted registration data, never schemas uploaded with a request. */
export function createInputContract<Input = Json>(
  value: unknown,
  compiler: SchemaCompiler,
  options: Partial<SchemaLimits> = {},
): InputContract<Input> {
  const schema = json(value, options.maxSchemaBytes ?? 262_144);
  if (!record(schema) || schema.type !== "object")
    fail("invalid_schema", "Input Schema must declare root type object.");
  return compileContract(schema, options, compiler) as InputContract<Input>;
}
export type SchemaCompiler = (
  schema: JsonSchema,
  nodes: ReadonlySet<JsonSchema>,
  locations: ReadonlySet<string>,
) => (value: unknown) => boolean;
function compileContract<Input = Json>(
  value: JsonSchema,
  options: Partial<SchemaLimits>,
  compiler: SchemaCompiler,
): InputContract<Input> {
  const limits = { ...defaults, ...options };
  for (const [key, limit] of Object.entries(limits))
    if (!Number.isSafeInteger(limit) || limit <= 0)
      fail("invalid_schema", `${key} must be a positive safe integer.`);
  const parsed = json(value, limits.maxSchemaBytes);
  if (!isSchema(parsed)) fail("invalid_schema", "JSON Schema must be a boolean or object.");
  const schema = parsed;
  const nodes = new Set<Schema>();
  const locations = new Set<string>();
  const children = new Map<Schema, Schema[]>();
  const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
  function collect(node: Schema, location: string): void {
    locations.add(location);
    if (locations.size > limits.maxSchemaNodes)
      fail("invalid_schema", "Schema node budget exceeded.");
    if (nodes.has(node)) return;
    nodes.add(node);
    if (typeof node === "boolean") return;
    if (
      ["$async", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"].some((key) =>
        Object.hasOwn(node, key),
      )
    )
      fail("invalid_schema", "Only synchronous, static local references are supported.");
    // Nested resource IDs change pointer resolution and are intentionally unsupported.
    if (node !== schema && Object.hasOwn(node, "$id"))
      fail("invalid_schema", "Nested schema resources are unsupported.");
    const next: [Schema, string][] = [];
    for (const key of maps) {
      const map = node[key];
      if (record(map))
        for (const [name, child] of Object.entries(map))
          if (isSchema(child)) next.push([child, `${location}/${key}/${pointer(name)}`]);
    }
    for (const key of singles)
      if (isSchema(node[key])) next.push([node[key], `${location}/${key}`]);
    for (const key of arrays) {
      const list = node[key];
      if (Array.isArray(list))
        for (const [index, child] of list.entries())
          if (isSchema(child)) next.push([child, `${location}/${key}/${index}`]);
    }
    children.set(
      node,
      next.map(([child]) => child),
    );
    for (const [child, path] of next) collect(child, path);
  }
  collect(schema, "#");
  const refs = new Map<JsonObject, Schema>();
  for (const node of nodes) {
    if (typeof node === "boolean" || node.$ref === undefined) continue;
    if (typeof node.$ref !== "string" || !/^#(?:\/(?:[^~%]|~[01])*)*$/.test(node.$ref))
      fail("invalid_schema", "References must be local JSON Pointers without URI encoding.");
    let target: Json = schema;
    for (const part of node.$ref.slice(1).split("/").slice(1)) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if ((!record(target) && !Array.isArray(target)) || !Object.hasOwn(target, key))
        fail("invalid_schema", "Unresolved local schema reference.");
      target = (target as JsonObject)[key]!;
    }
    if (!isSchema(target) || !locations.has(node.$ref))
      fail("invalid_schema", "Reference target is not a schema location.");
    refs.set(node, target);
  }
  let expansions = 0;
  function visit(node: Schema, ancestors: Set<Schema>, depth: number): void {
    if (++expansions > limits.maxReferenceExpansions || depth > 64)
      fail("invalid_schema", "Schema reference expansion budget exceeded.");
    if (ancestors.has(node)) fail("invalid_schema", "Cyclic schema reference.");
    if (typeof node === "boolean") return;
    const path = new Set(ancestors).add(node);
    for (const child of children.get(node) ?? []) visit(child, path, depth + 1);
    const ref = refs.get(node);
    if (ref !== undefined) visit(ref, path, depth + 1);
  }
  visit(schema, new Set(), 0);
  const validate = compiler(schema, nodes, locations);
  freeze(schema);
  function shapes(node: Schema, output: JsonObject[]): void {
    if (typeof node === "boolean") return;
    const ref = refs.get(node);
    if (ref !== undefined) shapes(ref, output);
    if (
      fields(node.properties) ||
      fields(node.patternProperties) ||
      record(node.additionalProperties) ||
      record(node.unevaluatedProperties) ||
      Array.isArray(node.prefixItems) ||
      isSchema(node.items) ||
      record(node.unevaluatedItems)
    )
      output.push(node);
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      const list = node[key];
      if (Array.isArray(list)) for (const child of list) if (isSchema(child)) shapes(child, output);
    }
    for (const key of ["then", "else"]) if (isSchema(node[key])) shapes(node[key], output);
    for (const key of ["dependentSchemas", "dependencies"])
      if (record(node[key]))
        for (const child of Object.values(node[key])) if (isSchema(child)) shapes(child, output);
  }
  const compiledShapes = new Map<Schema, JsonObject[]>();
  const patterns = new Map<JsonObject, [string, RegExp, Schema][]>();
  for (const node of nodes) {
    const selected: JsonObject[] = [];
    shapes(node, selected);
    compiledShapes.set(node, selected);
    if (typeof node !== "boolean" && record(node.patternProperties))
      patterns.set(
        node,
        Object.entries(node.patternProperties)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([pattern, child]) => [pattern, new RegExp(pattern, "u"), child as Schema]),
      );
  }
  function projection(node: Schema, input: Json, budget: { remaining: number }): Json {
    if (--budget.remaining < 0)
      fail("projection_budget_exceeded", "Input projection budget exceeded.");
    const available = compiledShapes.get(node) ?? [];
    if (!available.length) return ["json", input];
    // Local JSON type selects shape, never a validator result or the other operand.
    const selected = available.filter((shape) =>
      Array.isArray(input)
        ? Array.isArray(shape.prefixItems) ||
          isSchema(shape.items) ||
          record(shape.unevaluatedItems)
        : record(input) &&
          (fields(shape.properties) ||
            fields(shape.patternProperties) ||
            record(shape.additionalProperties) ||
            record(shape.unevaluatedProperties)),
    );
    if (!selected.length) return ["invalid-shape", input];
    return [
      "shapes",
      ...selected.map((shape): Json => {
        if (--budget.remaining < 0)
          fail("projection_budget_exceeded", "Input projection budget exceeded.");
        const objectShape =
          fields(shape.properties) ||
          fields(shape.patternProperties) ||
          record(shape.additionalProperties) ||
          record(shape.unevaluatedProperties);
        const arrayShape =
          Array.isArray(shape.prefixItems) ||
          isSchema(shape.items) ||
          record(shape.unevaluatedItems);
        if (objectShape && !(arrayShape && Array.isArray(input))) {
          if (!record(input)) return ["invalid-object", input];
          const properties = record(shape.properties) ? shape.properties : {};
          const entries: Json[] = [];
          for (const key of Object.keys(properties).sort()) {
            if (--budget.remaining < 0)
              fail("projection_budget_exceeded", "Input projection budget exceeded.");
            const child = properties[key];
            if (isSchema(child))
              entries.push([
                key,
                Object.hasOwn(input, key)
                  ? ["present", projection(child, input[key]!, budget)]
                  : ["missing"],
              ]);
          }
          for (const key of Object.keys(input).sort()) {
            if (--budget.remaining < 0)
              fail("projection_budget_exceeded", "Input projection budget exceeded.");
            let matched = Object.hasOwn(properties, key);
            for (const [pattern, regex, child] of patterns.get(shape) ?? []) {
              if (--budget.remaining < 0)
                fail("projection_budget_exceeded", "Input projection budget exceeded.");
              if (regex.test(key)) {
                matched = true;
                entries.push(["pattern", pattern, key, projection(child, input[key]!, budget)]);
              }
            }
            if (!matched && record(shape.additionalProperties))
              entries.push([
                "additional",
                key,
                projection(shape.additionalProperties, input[key]!, budget),
              ]);
            if (!matched && record(shape.unevaluatedProperties))
              entries.push([
                "unevaluated",
                key,
                projection(shape.unevaluatedProperties, input[key]!, budget),
              ]);
            if (
              !matched &&
              !record(shape.additionalProperties) &&
              !record(shape.unevaluatedProperties)
            )
              entries.push(["additional", key, projection(true, input[key]!, budget)]);
          }
          return ["object", ...entries];
        }
        if (!Array.isArray(input)) return ["invalid-array", input];
        const tuple = Array.isArray(shape.prefixItems) ? shape.prefixItems : [];
        return [
          "array",
          ...input.map((item, index) => {
            const child =
              index < tuple.length
                ? tuple[index]
                : isSchema(shape.items)
                  ? shape.items
                  : shape.unevaluatedItems;
            return projection(isSchema(child) ? child : true, item, budget);
          }),
        ];
      }),
    ];
  }
  function projectionKey(value: Json): string {
    let bytes = 0;
    const chunks: string[] = [];
    function emit(text: string): void {
      bytes += Buffer.byteLength(text);
      if (bytes > limits.maxProjectionBytes)
        fail("projection_budget_exceeded", "Input projection byte budget exceeded.");
      chunks.push(text);
    }
    function write(value: Json): void {
      if (Array.isArray(value)) {
        emit("[");
        value.forEach((item, index) => {
          if (index) emit(",");
          write(item);
        });
        emit("]");
      } else if (record(value)) {
        emit("{");
        Object.keys(value)
          .sort()
          .forEach((key, index) => {
            if (index) emit(",");
            emit(JSON.stringify(key));
            emit(":");
            write(value[key]!);
          });
        emit("}");
      } else emit(JSON.stringify(value));
    }
    write(value);
    return chunks.join("");
  }
  function equivalenceKey(value: Json): string {
    return projectionKey(projection(schema, value, { remaining: limits.maxProjectionNodes }));
  }
  return Object.freeze({
    inputSchema: schema as InputSchema,
    revision: createHash("sha256")
      .update(`task-input-projection-v3\n${canonical(schema)}`)
      .digest("hex"),
    validate(value: unknown): Input {
      const input = json(value, limits.maxInputBytes);
      if (!validate(input)) fail("invalid_input", "Input does not satisfy inputSchema.");
      return input as Input;
    },
    equals(left: unknown, right: unknown): boolean {
      return (
        equivalenceKey(json(left, limits.maxInputBytes)) ===
        equivalenceKey(json(right, limits.maxInputBytes))
      );
    },
    equivalenceKey,
  });
}
