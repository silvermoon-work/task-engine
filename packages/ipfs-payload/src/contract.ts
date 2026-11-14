import { Ajv2020 } from "ajv/dist/2020.js";
import { Budget, propertyPath, snapshot, type JsonValue } from "./value.js";

type Schema = boolean | SchemaObject;
interface SchemaObject {
  [key: string]: unknown;
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema | Schema[];
  prefixItems?: Schema[];
  additionalProperties?: boolean | Schema;
  additionalItems?: boolean | Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  const?: JsonValue;
  "x-ipfs-content-ref"?: boolean;
}

const metadata = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

export function addContentRefKeyword(ajv: Ajv2020): void {
  ajv.addKeyword({ keyword: "x-ipfs-content-ref", schemaType: "boolean", errors: false });
}

function record(value: unknown): value is SchemaObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pointer(root: Schema, ref: string, budget: Budget, depth: number): Schema {
  budget.visit(depth);
  if (typeof ref !== "string" || !ref.startsWith("#") || (ref !== "#" && !ref.startsWith("#/")))
    throw new Error("Only local schema references are supported.");
  if (ref === "#") return root;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key))
      throw new Error("Unresolved local schema reference.");
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node === "boolean") return node;
  if (!record(node)) throw new Error("Reference target is not a schema location.");
  return node;
}

function extras(schema: SchemaObject): SchemaObject {
  const rest: SchemaObject = {};
  for (const [key, value] of Object.entries(schema))
    if (key !== "$ref" && !metadata.has(key))
      Object.defineProperty(rest, key, { value, enumerable: true });
  return rest;
}

function isRef(schema: Schema): schema is SchemaObject {
  return record(schema) && schema["x-ipfs-content-ref"] === true;
}

/** Locate ContentRef positions using the Task JSON Schema dialect; never the P1 keyword allowlist. */
export function inspectTaskSchema(
  input: unknown,
  data: JsonValue,
  budget: Budget,
  validate?: (data: JsonValue) => void,
) {
  const root = snapshot(input, budget, undefined, true) as Schema;
  budget.bytes(root);
  if (validate) validate(data);
  else {
    const ajv = new Ajv2020({
      strict: true,
      strictTuples: false,
      allowUnionTypes: true,
      validateFormats: false,
      ownProperties: true,
      allErrors: false,
    });
    addContentRefKeyword(ajv);
    if (!ajv.validateSchema(root)) throw new Error("Invalid payload schema.");
    const check = ajv.compile(root);
    if (!check(data))
      throw new Error(`Payload does not match schema: ${ajv.errorsText(check.errors)}.`);
  }
  const cache = new WeakMap<object, Schema>();
  const resolve = (schema: Schema, depth: number, trail: Set<Schema>): Schema => {
    budget.visit(depth);
    if (!record(schema) || schema.$ref === undefined) return schema;
    const cached = cache.get(schema);
    if (cached) return cached;
    if (trail.has(schema)) throw new Error("Cyclic schema reference.");
    const target = resolve(
      pointer(root, schema.$ref, budget, depth + 1),
      depth + 1,
      new Set(trail).add(schema),
    );
    const rest = extras(schema);
    const combined: Schema = Object.keys(rest).length
      ? record(target)
        ? { allOf: [target, rest] }
        : rest
      : target;
    cache.set(schema, combined);
    return combined;
  };
  const checkRef = (schema: Schema): boolean => {
    if (!isRef(schema)) return false;
    if (
      schema.type !== "string" ||
      Object.keys(schema).some(
        (key) =>
          !metadata.has(key) && !["type", "x-ipfs-content-ref", "$ref", "$id", "$anchor"].includes(key),
      )
    )
      throw new Error("Invalid ContentRef schema.");
    return true;
  };
  const unionOf = (schema: SchemaObject) => schema.anyOf ?? schema.oneOf;
  const discriminators = new Map<SchemaObject, string>();
  const references = new Map<Schema, boolean>();
  const inspect = (schema: Schema, depth: number, trail: Set<Schema>): boolean => {
    budget.visit(depth);
    schema = resolve(schema, depth, trail);
    if (typeof schema === "boolean") {
      references.set(schema, false);
      return false;
    }
    if (checkRef(schema)) {
      references.set(schema, true);
      return true;
    }
    let hasRefs = false;
    if (schema.allOf) {
      let refNodes = 0;
      for (const child of schema.allOf) {
        const resolved = resolve(child, depth + 1, trail);
        if (checkRef(resolved)) refNodes++;
        hasRefs = inspect(child, depth + 1, trail) || hasRefs;
      }
      if (
        refNodes &&
        schema.allOf.some((child) => {
          const resolved = resolve(child, depth + 1, trail);
          return (
            record(resolved) &&
            !checkRef(resolved) &&
            !!(resolved.properties || resolved.items || resolved.prefixItems || unionOf(resolved))
          );
        })
      )
        throw new Error("Reference unions require a unique required literal discriminator.");
    }
    for (const child of Object.values(schema.properties ?? {}))
      hasRefs = inspect(child, depth + 1, trail) || hasRefs;
    if (record(schema.additionalProperties))
      hasRefs = inspect(schema.additionalProperties, depth + 1, trail) || hasRefs;
    const prefix = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
    if (prefix) for (const child of prefix) hasRefs = inspect(child, depth + 1, trail) || hasRefs;
    if (schema.items && !Array.isArray(schema.items))
      hasRefs = inspect(schema.items, depth + 1, trail) || hasRefs;
    if (record(schema.additionalItems))
      throw new Error("Schema-valued additionalItems are unsupported; use a homogeneous array.");
    const options = unionOf(schema);
    if (options) {
      let unionRefs = false;
      for (const branch of options) unionRefs = inspect(branch, depth + 1, trail) || unionRefs;
      if (unionRefs) {
        const first = options[0];
        const key =
          record(first) &&
          Object.keys(first.properties ?? {}).find((key) => {
            const literals = new Set<string>();
            for (const branch of options) {
              const resolved = resolve(branch, depth + 1, trail);
              const property = record(resolved) ? resolved.properties?.[key] : undefined;
              const field = property ? resolve(property, depth + 2, trail) : undefined;
              if (
                !record(resolved) ||
                !resolved.required?.includes(key) ||
                !record(field) ||
                !Object.hasOwn(field, "const") ||
                (field.const !== null && typeof field.const === "object") ||
                field["x-ipfs-content-ref"] ||
                unionOf(resolved)
              )
                return false;
              const literal = JSON.stringify(field.const);
              if (literals.has(literal)) return false;
              literals.add(literal);
            }
            return true;
          });
        if (!key)
          throw new Error("Reference unions require a unique required literal discriminator.");
        discriminators.set(schema, key);
      }
      hasRefs = hasRefs || unionRefs;
    }
    if (options && (schema.properties || schema.items || schema.prefixItems || schema.additionalProperties))
      throw new Error("Reference traversal does not support union structural siblings.");
    references.set(schema, hasRefs);
    return hasRefs;
  };
  inspect(root, 0, new Set());
  const expected = new Map<string, string>();
  const rules = new Set<string>();
  const selected = (schema: SchemaObject, value: JsonValue): Schema => {
    const key = discriminators.get(schema)!;
    const options = unionOf(schema)!;
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key))
      throw new Error("Missing payload discriminator.");
    const branches = options.filter((branch) => {
      const resolved = resolve(branch, 0, new Set());
      const property = record(resolved) ? resolved.properties?.[key] : undefined;
      const field = property ? resolve(property, 0, new Set()) : undefined;
      return record(field) && field.const === (value as Record<string, unknown>)[key];
    });
    if (branches.length !== 1) throw new Error("Invalid or ambiguous payload discriminator.");
    return resolve(branches[0]!, 0, new Set());
  };
  const filter = (path: string, key: string, literal: unknown) =>
    `${path}[?@[${JSON.stringify(key)}] == ${JSON.stringify(literal)}]`;
  const constant = (schema: Schema, key: string): unknown => {
    const property = record(schema) ? schema.properties?.[key] : undefined;
    const field = property ? resolve(property, 0, new Set()) : undefined;
    return record(field) ? field.const : undefined;
  };
  const walk = (
    schema: Schema,
    value: JsonValue | undefined,
    path: string,
    rule: string,
    depth: number,
  ) => {
    budget.visit(depth);
    schema = resolve(schema, depth, new Set());
    if (typeof schema === "boolean" || !references.get(schema)) return;
    if (checkRef(schema)) {
      rules.add(rule);
      if (value !== undefined) expected.set(path, rule);
      return;
    }
    if (schema.allOf) {
      for (const child of schema.allOf) walk(child, value, path, rule, depth + 1);
      return;
    }
    const options = unionOf(schema);
    if (options) {
      const branch = value === undefined ? undefined : selected(schema, value);
      for (const option of options) {
        const resolved = resolve(option, depth + 1, new Set());
        walk(resolved, resolved === branch ? value : undefined, path, rule, depth + 1);
      }
      return;
    }
    if (schema.properties)
      for (const [key, child] of Object.entries(schema.properties))
        walk(
          child,
          value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
            ? value[key]
            : undefined,
          propertyPath(path, key),
          propertyPath(rule, key),
          depth + 1,
        );
    if (
      record(schema.additionalProperties) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    )
      for (const [key, item] of Object.entries(value))
        if (!Object.hasOwn(schema.properties ?? {}, key))
          walk(
            schema.additionalProperties,
            item,
            propertyPath(path, key),
            propertyPath(rule, key),
            depth + 1,
          );
    const prefix = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
    if (prefix)
      prefix.forEach((item, i) => {
        walk(
          item,
          Array.isArray(value) ? value[i] : undefined,
          `${path}[${i}]`,
          `${rule}[${i}]`,
          depth + 1,
        );
      });
    const rest =
      schema.items && !Array.isArray(schema.items)
        ? resolve(schema.items, depth + 1, new Set())
        : undefined;
    if (rest !== undefined) {
      const key = record(rest) ? discriminators.get(rest) : undefined;
      if (key && record(rest) && unionOf(rest)) {
        for (const branch of unionOf(rest)!) {
          const resolved = resolve(branch, depth + 2, new Set());
          walk(resolved, undefined, path, filter(rule, key, constant(resolved, key)), depth + 1);
        }
      } else walk(rest, undefined, path, `${rule}[*]`, depth + 1);
      if (Array.isArray(value))
        value.forEach((child, i) => {
          if (prefix && i < prefix.length) return;
          const branch = key && record(rest) ? selected(rest, child) : rest;
          walk(
            branch,
            child,
            `${path}[${i}]`,
            key ? filter(rule, key, constant(branch, key)) : `${rule}[*]`,
            depth + 1,
          );
        });
    }
  };
  walk(root, data, "$", "$", 0);
  if (rules.size > budget.limits.maxPaths)
    throw new Error("Schema reference path capacity exceeded.");
  return { expected, rules };
}
