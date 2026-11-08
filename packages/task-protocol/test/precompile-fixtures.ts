export const precompileCases: {
  name: string;
  schema: unknown;
  good: unknown[];
  bad: unknown[];
}[] = [
  { name: "Never", schema: false, good: [], bad: [null, {}, 1] },
  { name: "boolean", schema: true, good: [null, {}, [1]], bad: [] },
  {
    name: "constraints and tuple",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 2, maxLength: 4, pattern: "^a" },
        optional: { type: "boolean" },
        list: {
          type: "array",
          prefixItems: [{ type: "integer", minimum: 1, maximum: 3 }, { type: "boolean" }],
          items: false,
          minItems: 2,
        },
      },
      required: ["text", "list"],
      additionalProperties: false,
    },
    good: [
      { text: "abc", list: [2, true] },
      { text: "ab", list: [1, false], optional: true },
    ],
    bad: [
      { text: "b", list: [2, true] },
      { text: "ab", list: [0, true] },
      { text: "ab", list: [2, true, 1] },
      { list: [2, true] },
      { text: "ab", list: [1, false], optional: 1 },
    ],
  },
  {
    name: "refs with siblings and unevaluated",
    schema: {
      type: "object",
      $defs: { number: { type: "number", minimum: 0 } },
      properties: { x: { $ref: "#/$defs/number", type: "number", maximum: 2 } },
      required: ["x"],
      unevaluatedProperties: false,
    },
    good: [{ x: 1 }],
    bad: [{ x: 3 }, { x: -1 }, { x: 1, extra: 1 }],
  },
  {
    name: "records and composition",
    schema: {
      type: "object",
      patternProperties: { "^x": { type: "integer" } },
      additionalProperties: false,
      minProperties: 1,
    },
    good: [{ x1: 1 }, { x2: 2 }],
    bad: [{}, { x1: "bad" }, { other: 1 }],
  },
  {
    name: "compositions and conditionals",
    schema: {
      type: "object",
      properties: { x: { anyOf: [{ type: "string" }, { type: "number" }] } },
      required: ["x"],
      allOf: [{ not: { properties: { x: { const: "forbidden" } } } }],
      if: { properties: { x: { type: "number" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword, not a promise handler.
      then: { properties: { x: { type: "number", minimum: 1 } } },
      else: { properties: { x: { type: "string", minLength: 2 } } },
    },
    good: [{ x: 1 }, { x: "okay" }],
    bad: [{ x: 0 }, { x: "x" }, { x: "forbidden" }, { x: false }],
  },
  {
    name: "contains and unevaluatedItems",
    schema: {
      type: "array",
      contains: { type: "integer" },
      minContains: 1,
      maxContains: 2,
      unevaluatedItems: { type: "string" },
    },
    good: [
      [1, "x"],
      [1, false],
    ],
    bad: [[true], [1, 2, 3]],
  },
  {
    name: "unevaluated elements",
    schema: { type: "array", unevaluatedItems: { type: "string" } },
    good: [["x"]],
    bad: [[false]],
  },
  ...["__proto__", "constructor", "toString"].map((key) => ({
    name: `prototype ${key}`,
    schema: {
      type: "object",
      properties: { [key]: { type: "number" } },
      required: [key],
      additionalProperties: false,
    },
    good: [{ [key]: 1 }],
    bad: [{}, { [key]: "bad" }, { [key]: 1, extra: 2 }],
  })),
];
