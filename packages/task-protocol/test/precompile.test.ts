import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { compileInputSchema, compileJsonSchema, precompileSchema } from "../src/schema.js";
import { createInputContract, createJsonContract } from "../src/schema-runtime.js";
import { sharingCases } from "./sharing-fixtures.js";
import { precompileCases } from "./precompile-fixtures.js";

function generated(schema: unknown, input = false) {
  const module = { exports: {} };
  new Function("require", "module", "exports", precompileSchema(schema, input))(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  return module.exports as (value: unknown) => boolean;
}

for (const scenario of sharingCases)
  test(`precompiled projection and revision: ${scenario.name}`, () => {
    const old = compileInputSchema(scenario.schema);
    const next = createInputContract(scenario.schema, () => generated(scenario.schema, true));
    assert.equal(next.revision, old.revision);
    assert.deepEqual(next.validate(scenario.left), scenario.left);
    assert.deepEqual(next.validate(scenario.right), scenario.right);
    assert.equal(next.equals(scenario.left, scenario.right), scenario.equal);
    assert.equal(next.equivalenceKey(scenario.left), old.equivalenceKey(scenario.left));
    for (const options of [
      { maxInputBytes: 1 },
      { maxProjectionNodes: 1 },
      { maxProjectionBytes: 1 },
    ]) {
      const before = compileInputSchema(scenario.schema, options);
      const after = createInputContract(
        scenario.schema,
        () => generated(scenario.schema, true),
        options,
      );
      for (const operation of ["validate", "equivalenceKey"] as const) {
        const outcome = (contract: typeof before) => {
          try {
            return contract[operation](scenario.left);
          } catch (error) {
            return { code: (error as { code: string }).code, message: (error as Error).message };
          }
        };
        assert.deepEqual(outcome(after), outcome(before));
      }
    }
  });

for (const scenario of precompileCases)
  test(`precompiled validation expected outcomes: ${scenario.name}`, () => {
    const ordinary = compileJsonSchema(scenario.schema);
    const next = createJsonContract(scenario.schema, () => generated(scenario.schema));
    assert.equal(next.revision, ordinary.revision);
    for (const value of scenario.good) {
      const snapshot = structuredClone(value);
      assert.deepEqual(ordinary.validate(value), snapshot);
      assert.deepEqual(next.validate(value), snapshot);
      assert.deepEqual(value, snapshot);
    }
    for (const value of scenario.bad)
      for (const contract of [ordinary, next])
        assert.throws(() => contract.validate(value), {
          code: "invalid_input",
          message: "Input does not satisfy inputSchema.",
        });
  });

test("precompile rejects invalid contracts with the ordinary schema budgets", () => {
  for (const schema of [
    { type: "object", properties: { x: { $ref: "#/missing" } } },
    { type: "object", properties: { x: { $ref: "https://remote.test/schema" } } },
    { type: "object", properties: { x: { $dynamicRef: "#x" } } },
    { type: "object", unknownKeyword: true },
    { type: "object", properties: { x: { $ref: "#" } } },
  ])
    assert.throws(() => precompileSchema(schema, true), { code: "invalid_schema" });
});
