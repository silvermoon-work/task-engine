import { Ajv2020 } from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { addContentRefKeyword } from "@silvermoon-work/ipfs-payload";
import { fail, type Json, type JsonObject } from "./json.js";
import {
  createInputContract,
  createJsonContract,
  type SchemaCompiler,
  type SchemaLimits,
} from "./schema-runtime.js";

export type * from "./schema-runtime.js";

const record = (value: Json | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function compiler(standalone?: (source: string) => void): SchemaCompiler {
  return (schema, nodes, locations) => {
    const options = {
      strict: true,
      allowUnionTypes: true,
      validateFormats: false,
      ownProperties: true,
      code: { source: true },
    };
    try {
      let ajv = new Ajv2020(options);
      addContentRefKeyword(ajv);
      let validate = ajv.compile(schema);
      if (
        [...nodes].some(
          (node) =>
            typeof node !== "boolean" &&
            record(node.properties) &&
            Object.hasOwn(node.properties, "__proto__"),
        )
      ) {
        const compiledSchema = structuredClone(schema);
        for (const location of locations) {
          let node: Json = compiledSchema;
          for (const part of location.slice(1).split("/").slice(1))
            node = (node as JsonObject)[part.replaceAll("~1", "/").replaceAll("~0", "~")]!;
          if (
            !record(node) ||
            !record(node.properties) ||
            !Object.hasOwn(node.properties, "__proto__")
          )
            continue;
          const patterns = record(node.patternProperties) ? node.patternProperties : {};
          const pattern = "^__proto__(?![\\s\\S])";
          const child = { $ref: `${location}/properties/__proto__` };
          patterns[pattern] = Object.hasOwn(patterns, pattern)
            ? { allOf: [patterns[pattern]!, child] }
            : child;
          node.patternProperties = patterns;
        }
        // Ajv skips properties.__proto__; validate authors' strict schema before
        // adding an equivalent, potentially overlapping compiler-owned pattern.
        ajv = new Ajv2020({ ...options, allowMatchingProperties: true });
        addContentRefKeyword(ajv);
        validate = ajv.compile(compiledSchema);
      }
      standalone?.(standaloneCode.default(ajv, validate));
      return validate;
    } catch (error) {
      fail("invalid_schema", error instanceof Error ? error.message : "Invalid input Schema.");
    }
  };
}

export function compileParametersSchema<Parameters = Json>(
  value: unknown,
  options: Partial<SchemaLimits> = {},
) {
  return createInputContract<Parameters>(value, compiler(), options);
}
export function compileInputSchema<Input = Json>(
  value: unknown,
  options: Partial<SchemaLimits> = {},
) {
  return compileParametersSchema<Input>(value, options);
}

export function compileJsonSchema(value: unknown, options: Partial<SchemaLimits> = {}) {
  return createJsonContract(value, compiler(), options);
}

/** Build-only source generation, using exactly the ordinary contract checks. */
export function precompileSchema(value: unknown, input = false): string {
  let source = "";
  const compile = compiler((generated) => {
    source = generated;
  });
  if (input) createInputContract(value, compile);
  else createJsonContract(value, compile);
  return source;
}
