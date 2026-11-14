import { Ajv } from "ajv";
import { CID } from "multiformats/cid";
import { Budget, propertyPath, snapshot, type JsonValue } from "./value.js";

interface Schema {
  [key: string]: unknown;
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema | Schema[];
  anyOf?: Schema[];
  additionalProperties?: boolean | Schema;
  const?: JsonValue;
}

const keywords = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "anyOf",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "x-ipfs-content-ref",
]);

export function inspectSchema(input: unknown, data: JsonValue, budget: Budget) {
  const root = snapshot(input, budget, undefined, true) as Schema;
  budget.bytes(root);
  const discriminators = new Map<Schema, string>();
  const references = new Map<Schema, boolean>();
  const ajv = new Ajv({ strict: true, strictTuples: false, allErrors: false, ownProperties: true });
  ajv.addKeyword({
    keyword: "x-ipfs-content-ref",
    schemaType: "boolean",
    validate: (enabled: boolean, value: unknown) => {
      if (!enabled || typeof value !== "string") return false;
      try {
        CID.parse(value);
        return true;
      } catch {
        return false;
      }
    },
    errors: false,
  });
  if (!ajv.validateSchema(root)) throw new Error("Invalid payload schema.");
  const inspect = (schema: Schema, depth: number): boolean => {
    budget.visit(depth);
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      throw new Error("Expected a supported object schema.");
    for (const key of Object.keys(schema))
      if (!keywords.has(key)) throw new Error(`Unsupported payload schema keyword: ${key}.`);
    if (schema.type !== undefined && typeof schema.type !== "string")
      throw new Error("Use explicit union schemas.");
    if (Object.hasOwn(schema, "x-ipfs-content-ref")) {
      if (
        schema["x-ipfs-content-ref"] !== true ||
        schema.type !== "string" ||
        Object.keys(schema).some(
          (key) => !["type", "x-ipfs-content-ref", "title", "description"].includes(key),
        )
      )
        throw new Error("Invalid ContentRef schema.");
      references.set(schema, true);
      return true;
    }
    let hasRefs = false;
    for (const child of Object.values(schema.properties ?? {}))
      hasRefs = inspect(child, depth + 1) || hasRefs;
    if (schema.items)
      for (const child of Array.isArray(schema.items) ? schema.items : [schema.items])
        hasRefs = inspect(child, depth + 1) || hasRefs;
    if (schema.additionalItems && typeof schema.additionalItems === "object")
      throw new Error("Schema-valued additionalItems are unsupported; use a homogeneous array.");
    if (schema.additionalProperties && typeof schema.additionalProperties === "object")
      hasRefs = inspect(schema.additionalProperties, depth + 1) || hasRefs;
    if (schema.anyOf) {
      let unionRefs = false;
      for (const branch of schema.anyOf) unionRefs = inspect(branch, depth + 1) || unionRefs;
      if (unionRefs) {
        const first = schema.anyOf[0]!;
        const key = Object.keys(first.properties ?? {}).find((key) => {
          const literals = new Set<string>();
          for (const branch of schema.anyOf!) {
            const property = branch.properties?.[key];
            if (
              branch.type !== "object" ||
              !branch.required?.includes(key) ||
              !property ||
              !Object.hasOwn(property, "const") ||
              (property.const !== null && typeof property.const === "object") ||
              property["x-ipfs-content-ref"] ||
              branch.anyOf
            )
              return false;
            const literal = JSON.stringify(property.const);
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
    // Sibling validation clauses can narrow a union but must not add a second reference meaning.
    if (schema.anyOf && (schema.properties || schema.items || schema.additionalProperties))
      throw new Error("Reference traversal does not support union structural siblings.");
    references.set(schema, hasRefs);
    return hasRefs;
  };
  inspect(root, 0);
  const validate = ajv.compile(root);
  if (!validate(data))
    throw new Error(`Payload does not match schema: ${ajv.errorsText(validate.errors)}.`);

  const expected = new Map<string, string>();
  const rules = new Set<string>();
  const selected = (schema: Schema, value: JsonValue): Schema => {
    const key = discriminators.get(schema)!;
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key))
      throw new Error("Missing payload discriminator.");
    const branches = schema.anyOf!.filter(
      (branch) => branch.properties![key]!.const === value[key],
    );
    if (branches.length !== 1) throw new Error("Invalid or ambiguous payload discriminator.");
    return branches[0]!;
  };
  const filter = (path: string, key: string, literal: unknown) =>
    `${path}[?@[${JSON.stringify(key)}] == ${JSON.stringify(literal)}]`;
  const walk = (
    schema: Schema,
    value: JsonValue | undefined,
    path: string,
    rule: string,
    depth: number,
  ) => {
    budget.visit(depth);
    if (!references.get(schema)) return;
    if (schema["x-ipfs-content-ref"]) {
      rules.add(rule);
      if (value !== undefined) expected.set(path, rule);
      return;
    }
    if (schema.anyOf) {
      const branch = value === undefined ? undefined : selected(schema, value);
      for (const option of schema.anyOf)
        walk(option, option === branch ? value : undefined, path, rule, depth + 1);
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
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object" &&
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
    if (schema.items) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((item, i) => {
          walk(
            item,
            Array.isArray(value) ? value[i] : undefined,
            `${path}[${i}]`,
            `${rule}[${i}]`,
            depth + 1,
          );
        });
      } else {
        const item = schema.items;
        const key = discriminators.get(item);
        if (key) {
          for (const branch of item.anyOf!)
            walk(
              branch,
              undefined,
              path,
              filter(rule, key, branch.properties![key]!.const),
              depth + 1,
            );
        } else walk(item, undefined, path, `${rule}[*]`, depth + 1);
        if (Array.isArray(value))
          value.forEach((child, i) => {
            const branch = key ? selected(item, child) : item;
            walk(
              branch,
              child,
              `${path}[${i}]`,
              key ? filter(rule, key, branch.properties![key]!.const) : `${rule}[*]`,
              depth + 1,
            );
          });
      }
    }
  };
  walk(root, data, "$", "$", 0);
  if (rules.size > budget.limits.maxPaths)
    throw new Error("Schema reference path capacity exceeded.");
  return { expected, rules };
}
