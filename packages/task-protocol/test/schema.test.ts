import assert from "node:assert/strict";
import test from "node:test";
import { compileInputSchema, type InputSchema } from "../src/index.js";
import { sharingCases } from "./sharing-fixtures.js";

for (const scenario of sharingCases)
  test(`sharing key uses generated Equals: ${scenario.name}`, () => {
    const contract = compileInputSchema(scenario.schema);
    contract.validate(scenario.left);
    contract.validate(scenario.right);
    assert.equal(contract.equals(scenario.left, scenario.right), scenario.equal);
    assert.equal(
      contract.equivalenceKey(scenario.left) === contract.equivalenceKey(scenario.right),
      scenario.equal,
    );
    assert.equal(
      compileInputSchema(structuredClone(scenario.schema)).equivalenceKey(scenario.left),
      contract.equivalenceKey(scenario.left),
    );
  });

test("prototype-named fields require own JSON values and retain validation and projection", () => {
  for (const key of ["toString", "constructor", "__proto__"]) {
    const schema = {
      type: "object",
      properties: { [key]: { type: "number" } },
      required: [key],
      additionalProperties: false,
    };
    const c = compileInputSchema(schema);
    assert.equal(key in {}, true);
    assert.equal(Object.hasOwn({}, key), false);
    assert.throws(() => c.validate({}), { code: "invalid_input" }, key);
    assert.deepEqual(c.validate({ [key]: 1 }), { [key]: 1 });
    assert.throws(() => c.validate({ [key]: "wrong" }), { code: "invalid_input" }, key);
    assert.throws(() => c.validate({ [key]: 1, [`${key}\n`]: 2 }), { code: "invalid_input" });
    assert.equal(c.equals({}, { [key]: 1 }), false);
    assert.equal(c.equals({ [key]: 1 }, { [key]: 1 }), true);
    assert.equal(c.equals({ [key]: 1 }, { [key]: 2 }), false);
    assert.equal(c.equals({ [key]: "wrong", extra: 1 }, { [key]: "wrong", extra: 2 }), false);
    const inherited = Object.create({ [key]: 1 });
    assert.throws(() => c.validate(inherited), { code: "invalid_payload" });
    assert.throws(() => c.equals(inherited, {}), { code: "invalid_payload" });
    const optional = compileInputSchema({ ...schema, required: [] });
    assert.deepEqual(optional.validate({}), {});
  }
  const c = compileInputSchema({
    type: "object",
    $defs: { value: { type: "object", properties: { x: { type: "number" } } } },
    properties: { ["__proto__"]: { $ref: "#/$defs/value" } },
    required: ["__proto__"],
    additionalProperties: false,
  });
  c.validate({ ["__proto__"]: { x: 1 } });
  assert.throws(() => c.validate({ ["__proto__"]: { x: "wrong" } }), { code: "invalid_input" });
  assert.equal(
    c.equals({ ["__proto__"]: { x: 1, extra: 1 } }, { ["__proto__"]: { x: 1, extra: 2 } }),
    false,
  );
  assert.ok(Object.hasOwn(c.inputSchema.properties as object, "__proto__"));
  assert.equal(c.inputSchema.patternProperties, undefined);
});

test("unevaluatedItems contributes local structural tails, never evaluated annotations", () => {
  const item = (field: string) => ({ type: "object", properties: { [field]: { type: "number" } } });
  const array = (schema: InputSchema) =>
    compileInputSchema({
      type: "object",
      properties: { list: { type: "array", ...schema } },
    });
  const c = array({ unevaluatedItems: item("x") });
  assert.equal(c.equals({ list: [{ x: 1, extra: 1 }] }, { list: [{ x: 1, extra: 2 }] }), false);
  assert.equal(c.equals({ list: [{ x: 1 }] }, { list: [{ x: 2 }] }), false);
  assert.equal(c.equals({ list: [{ x: 1 }, { x: 2 }] }, { list: [{ x: 2 }, { x: 1 }] }), false);
  assert.equal(c.equals({ list: [{}] }, { list: [{}, {}] }), false);
  assert.equal(c.equals({ list: [{ x: "invalid" }] }, { list: [{ x: "invalid" }] }), true);
  assert.throws(() => c.validate({ list: [{ x: "invalid" }] }), { code: "invalid_input" });
  for (const items of [true, false]) {
    const explicit = array({ items, unevaluatedItems: item("x") });
    assert.equal(
      explicit.equals({ list: [{ x: 1, extra: 1 }] }, { list: [{ x: 1, extra: 2 }] }),
      false,
    );
    const booleanOnly = array({ unevaluatedItems: items });
    assert.equal(booleanOnly.equals({ list: [{ extra: 1 }] }, { list: [{ extra: 2 }] }), false);
  }
  const tuple = { prefixItems: [item("head")], minItems: 1, maxItems: 1 };
  const tail = array({ ...tuple, unevaluatedItems: item("x") });
  const left = {
    list: [
      { head: 1, x: 2 },
      { x: 3, y: 1 },
    ],
  };
  const right = {
    list: [
      { head: 1, x: 99 },
      { x: 3, y: 2 },
    ],
  };
  assert.equal(tail.equals(left, right), false);
  assert.throws(() => tail.validate(left));
  const explicitTail = array({ ...tuple, items: item("y"), unevaluatedItems: item("x") });
  assert.equal(explicitTail.equals(left, right), false);
  assert.equal(explicitTail.equals(left, { list: [{ head: 1 }, { x: 99, y: 1 }] }), false);
  const combined = array({ allOf: [{ ...tuple, items: false }, { unevaluatedItems: item("x") }] });
  assert.equal(
    combined.equals({ list: [{ head: 1, x: 2 }] }, { list: [{ head: 1, x: 3 }] }),
    false,
  );
  const contains = array({ contains: item("tag"), unevaluatedItems: item("x") });
  assert.equal(contains.equals({ list: [{ tag: 1, x: 2 }] }, { list: [{ tag: 2, x: 2 }] }), false);
  assert.equal(contains.equals({ list: [{ tag: 1, x: 2 }] }, { list: [{ tag: 1, x: 3 }] }), false);
});

test("validation and equality are independent; JSON presence, types and defaults remain exact", () => {
  const contract = compileInputSchema({
    type: "object",
    properties: { foo: { type: "number", minimum: 1, default: 10 } },
    required: ["foo"],
    additionalProperties: false,
  });
  assert.throws(() => contract.validate({ foo: 0 }), { code: "invalid_input" });
  assert.throws(() => contract.validate({ foo: 1, extra: true }), { code: "invalid_input" });
  assert.throws(() => contract.validate({}), { code: "invalid_input" });
  assert.equal(contract.equals({}, {}), true);
  assert.equal(contract.equals({ foo: 0, extra: 1 }, { foo: 0, extra: 2 }), false);
  assert.equal(contract.equals({}, { foo: 10 }), false);
  assert.equal(contract.equals({}, { foo: null }), false);
  assert.equal(contract.equals({ foo: -0 }, { foo: 0 }), true);
  assert.equal(contract.equals({ foo: "1" }, { foo: 1 }), false);
  assert.equal(contract.equals([], {}), false);
  assert.equal(contract.equals(null, null), true);
  assert.throws(() => contract.equals({ foo: Infinity }, {}), { code: "invalid_payload" });
});

test("free JSON, dictionaries, patterns and boolean additionalProperties have explicit shapes", () => {
  for (const additional of [undefined, true, false]) {
    const schema: InputSchema = { type: "object", properties: { foo: { type: "object" } } };
    if (additional !== undefined) schema.additionalProperties = additional;
    const contract = compileInputSchema(schema);
    assert.equal(contract.equals({ foo: { a: 1 }, x: 1 }, { foo: { a: 1 }, x: 2 }), false);
    assert.equal(contract.equals({ foo: { a: 1 } }, { foo: { a: 2 } }), false);
  }
  for (const schema of [{ type: "object" }, { type: "object", properties: {} }])
    assert.equal(compileInputSchema(schema).equals({ a: 1 }, { a: 2 }), false);
  const dictionary = compileInputSchema({
    type: "object",
    additionalProperties: {
      type: "object",
      properties: { value: { type: "number" } },
    },
  });
  assert.equal(
    dictionary.equals({ a: { value: 1, extra: 1 } }, { a: { value: 1, extra: 2 } }),
    false,
  );
  assert.equal(dictionary.equals({ a: {} }, { b: {} }), false);
  const pattern = compileInputSchema({
    type: "object",
    patternProperties: { "^x": { type: "object", properties: { id: {} } } },
  });
  assert.equal(pattern.equals({ x: { id: 1 }, extra: 1 }, { x: { id: 1 }, extra: 2 }), false);
  assert.equal(pattern.equals({ x: { id: 1 } }, { x: { id: 2 } }), false);
});

test("composition is structural union, never OR of equality; equivalence laws include invalid inputs", () => {
  const permissiveBranch = compileInputSchema({
    type: "object",
    anyOf: [{ properties: { text: { type: "string" } }, additionalProperties: false }, {}],
  });
  permissiveBranch.validate({ text: "hello", extra: 1 });
  permissiveBranch.validate({ text: "hello", extra: 2 });
  assert.equal(
    permissiveBranch.equals({ text: "hello", extra: 1 }, { text: "hello", extra: 2 }),
    false,
  );
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const c = compileInputSchema({
      type: "object",
      [keyword]: [
        { properties: { x: { type: "number" } } },
        { properties: { y: { type: "number" } } },
        { minProperties: 1 },
      ],
    });
    const values = [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 0, extra: 2 },
      {},
      null,
      [],
      "bad",
    ];
    assert.equal(c.equals(values[0], values[1]), false);
    assert.equal(c.equals(values[1], values[2]), false);
    assert.equal(c.equals(values[0], values[3]), false);
    for (const a of values) {
      assert.equal(c.equals(a, a), true);
      for (const b of values) {
        assert.equal(c.equals(a, b), c.equals(b, a));
        for (const d of values)
          if (c.equals(a, b) && c.equals(b, d)) assert.equal(c.equals(a, d), true);
      }
    }
  }
});

test("refs retain siblings, tuples preserve boundaries, advanced standard constraints validate", () => {
  const c = compileInputSchema({
    type: "object",
    $defs: { base: { type: "object", properties: { x: { type: "number" } } } },
    $ref: "#/$defs/base",
    properties: {
      y: {
        type: "array",
        prefixItems: [
          { type: "object", properties: { a: { type: "number" } } },
          { type: "string" },
        ],
        items: false,
        minItems: 2,
      },
    },
    required: ["y"],
    dependentRequired: { x: ["y"] },
  });

  c.validate({ x: 1, y: [{ a: 1 }, "value"] });
  assert.throws(() => c.validate({ y: [{ a: 1 }, 2] }));
  assert.throws(() => c.validate({ y: [{ a: 1 }, "value", 2] }));
  assert.equal(c.equals({ x: 1 }, { x: 2 }), false);
  assert.equal(
    c.equals({ y: [{ a: 1, ignored: 1 }, "v"] }, { y: [{ a: 1, ignored: 2 }, "v"] }),
    false,
  );
  assert.equal(c.equals({ y: [1, 2] }, { y: [2, 1] }), false);
  assert.equal(c.equals({ y: [1] }, { y: [1, null] }), false);
  const conditional = compileInputSchema({
    type: "object",
    properties: { tag: { type: "string" } },
    if: { properties: { tag: { const: "a" } } },
    // biome-ignore lint/suspicious/noThenProperty: Standard JSON Schema conditional keyword.
    then: { properties: { a: {} }, required: ["a"] },
    else: { properties: { b: {} }, required: ["b"] },
  });
  assert.equal(conditional.equals({ tag: "a", a: 1, b: 2 }, { tag: "a", a: 1, b: 3 }), false);
  assert.throws(() => conditional.validate({ tag: "a" }));
});

test("local JSON type selects union shapes without validating constraints", () => {
  const c = compileInputSchema({
    type: "object",
    properties: {
      value: {
        anyOf: [
          { type: "object", properties: { x: { type: "number", minimum: 10 } } },
          { type: "array", items: { type: "object", properties: { y: { type: "number" } } } },
        ],
      },
    },
  });
  assert.equal(c.equals({ value: { x: 0, extra: 1 } }, { value: { x: 0, extra: 2 } }), false);
  assert.equal(c.equals({ value: [{ y: 1, extra: 1 }] }, { value: [{ y: 1, extra: 2 }] }), false);
  assert.equal(c.equals({ value: { x: 0 } }, { value: [{ y: 0 }] }), false);
  assert.equal(c.equals({ value: "invalid" }, { value: "invalid" }), true);
  assert.throws(() => c.validate({ value: { x: 0 } }));
});

test("schema budgets and unsupported references fail at registration; annotation data is not traversed", () => {
  for (const fragment of [
    { $ref: "https://example.test/schema" },
    { $ref: "#" },
    { $dynamicRef: "#x" },
    { $async: true },
    { $ref: "#/$defs/missing" },
    { $defs: { loop: { $ref: "#/$defs/loop" } } },
    { $defs: { child: { $id: "other", type: "object" } } },
    { privateValidation: true },
    { const: true, additionalProperties: true, $ref: "#/const" },
  ])
    assert.throws(() => compileInputSchema({ type: "object", ...fragment }), {
      code: "invalid_schema",
    });
  compileInputSchema({
    type: "object",
    default: { $ref: "https://not-a-schema", $async: true },
    const: { $ref: "https://also-data" },
  });
  for (const limit of [0, -1, Infinity, 1.5])
    assert.throws(() => compileInputSchema({ type: "object" }, { maxSchemaNodes: limit }));
  assert.throws(() =>
    compileInputSchema({ type: "object", properties: { a: {} } }, { maxSchemaNodes: 1 }),
  );
  assert.throws(() =>
    compileInputSchema({ type: "object", properties: { a: {} } }, { maxReferenceExpansions: 1 }),
  );
  const bounded = compileInputSchema(
    { type: "object", properties: { a: {} } },
    { maxProjectionNodes: 1 },
  );
  assert.throws(() => bounded.equals({ a: 1 }, { a: 1 }), { code: "projection_budget_exceeded" });
  const byteBounded = compileInputSchema({ type: "object" }, { maxProjectionBytes: 10 });
  assert.throws(() => byteBounded.equals({ a: "value" }, { a: "value" }), {
    code: "projection_budget_exceeded",
  });
  const source = { type: "object", properties: { a: { type: "number" } } };
  const frozen = compileInputSchema(source);
  source.properties.a.type = "string";
  frozen.validate({ a: 1 });
  assert.ok(Object.isFrozen(frozen.inputSchema.properties));
  assert.equal(frozen.revision, compileInputSchema(frozen.inputSchema).revision);
});
