import { Kind, OptionalKind, ReadonlyKind } from "@sinclair/typebox";
import { isTaskBundlePath, json, type JsonObject } from "@silvermoon-work/task-protocol";

const kinds = new Set([
  "Object",
  "String",
  "Number",
  "Integer",
  "Boolean",
  "Null",
  "Literal",
  "Array",
  "Tuple",
  "Union",
  "Intersect",
  "Record",
  "Ref",
  "Never",
]);
const maps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const singles = new Set([
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
]);
const arrays = new Set(["anyOf", "allOf", "oneOf", "prefixItems"]);

export function toTaskSchema(value: unknown): unknown {
  let nodes = 0;
  function visit(value: unknown, schema: boolean, depth: number): unknown {
    if (++nodes > 16_384 || depth > 64) throw new Error("Contract Schema budget exceeded.");
    if (value === null || typeof value !== "object") {
      if (["function", "symbol", "undefined", "bigint"].includes(typeof value))
        throw new Error("Contract must contain only JSON semantics.");
      return value;
    }
    if (Array.isArray(value)) return value.map((child) => visit(child, schema, depth + 1));
    const node = value as Record<PropertyKey, unknown>;
    for (const symbol of Object.getOwnPropertySymbols(node))
      if (![Kind, OptionalKind, ReadonlyKind, Symbol.for("TypeBox.Hint")].includes(symbol))
        throw new Error("Unsupported TypeBox metadata or transform.");
    if (node[Kind] !== undefined && !kinds.has(String(node[Kind])))
      throw new Error(`Unsupported TypeBox kind: ${String(node[Kind])}.`);
    if (
      schema &&
      ["format", "contentEncoding", "contentMediaType", "contentSchema"].some((key) =>
        Object.hasOwn(node, key),
      )
    )
      throw new Error("Engine does not enforce format or content annotations.");
    if (
      schema &&
      node[Kind] === "Tuple" &&
      node.additionalItems !== undefined &&
      node.additionalItems !== false
    )
      throw new Error("Unsupported TypeBox Tuple additionalItems override.");
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (schema && node[Kind] === "Tuple" && (key === "items" || key === "additionalItems"))
        continue;
      let result: unknown;
      if (schema && maps.has(key)) {
        if (!child || typeof child !== "object" || Array.isArray(child))
          throw new Error("Invalid Schema map.");
        result = Object.fromEntries(
          Object.entries(child).map(([name, entry]) => [name, visit(entry, true, depth + 1)]),
        );
      } else result = visit(child, schema && (singles.has(key) || arrays.has(key)), depth + 1);
      Object.defineProperty(output, key, { value: result, enumerable: true });
    }
    if (schema && node[Kind] === "Tuple") {
      const items = visit(node.items ?? [], true, depth + 1);
      if (!Array.isArray(items)) throw new Error("Invalid TypeBox Tuple items.");
      if (items.length) output.prefixItems = items;
      output.items = false;
    }
    return output;
  }
  return visit(value, true, 0);
}

export function contractSchemas(value: unknown): { path: string; document: JsonObject }[] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("input" in value) ||
    !("result" in value) ||
    !("message" in value) ||
    Object.keys(value).some((key) => !["input", "result", "message", "schemas"].includes(key))
  )
    throw new Error("Contract must contain { input, result, message, schemas? }.");
  const schemas = "schemas" in value ? value.schemas : {};
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas))
    throw new Error("Contract schemas must be a name-to-Schema object, not an array.");
  const shared = Object.entries(schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const names = new Set<string>();
  for (const [name] of shared) {
    if (
      !name ||
      name.includes("/") ||
      !isTaskBundlePath(name) ||
      !isTaskBundlePath(`schemas/shared/${name}.json`) ||
      names.has(name.toLowerCase())
    )
      throw new Error(`Shared Schema names must be unique portable file names: ${name}`);
    names.add(name.toLowerCase());
  }
  const entries = [
    { path: "schemas/input.json", identity: "0", schema: value.input },
    { path: "schemas/result.json", identity: "1", schema: value.result },
    { path: "schemas/message.json", identity: "2", schema: value.message },
    ...shared.map(([name, schema]) => ({
      path: `schemas/shared/${name}.json`,
      identity: `shared/${encodeURIComponent(name)}`,
      schema,
    })),
  ];
  return entries.map(({ path, identity, schema }, index) => {
    const normalized = json(toTaskSchema(schema));
    const id = `https://task.invalid/schema/${identity}`;
    if (typeof normalized === "boolean") {
      if (!index) throw new Error("Task input Schema must be an object.");
      return {
        path,
        document: { $id: id, ...(normalized ? {} : { not: {} }) },
      };
    }
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized))
      throw new Error("Contract Schema must be an object or boolean.");
    return {
      path,
      document: {
        ...normalized,
        $id: normalized.$id ?? id,
      },
    };
  });
}
