import {
  compileInputSchema,
  emptyFacts,
  type InputSchema,
  type JsonObject,
  reduce,
} from "../src/index.js";
import { fixture } from "./fact-fixtures.js";

interface SharingCase {
  name: string;
  schema: InputSchema;
  left: JsonObject;
  right: JsonObject;
  equal: boolean;
}
const text = { text: { type: "string" } };
const value = { type: "object", properties: { value: { type: "number" } } };
export const sharingCases: SharingCase[] = [
  {
    name: "allowed undeclared fields",
    schema: { type: "object", properties: text, required: ["text"] },
    left: { text: "hello", extra: 1 },
    right: { text: "hello", extra: 2 },
    equal: false,
  },
  {
    name: "explicit fields",
    schema: {
      type: "object",
      properties: { ...text, extra: { type: "number" } },
      required: ["text"],
    },
    left: { text: "hello", extra: 1 },
    right: { text: "hello", extra: 2 },
    equal: false,
  },
  {
    name: "nested local reference",
    schema: {
      type: "object",
      $defs: { value },
      properties: { ...text, nested: { $ref: "#/$defs/value" } },
    },
    left: { text: "hello", nested: { value: 1, extra: 1 } },
    right: { text: "hello", nested: { value: 1, extra: 2 } },
    equal: false,
  },
  ...[false, true].map((equal) => ({
    name: `schema-valued dictionary equal=${equal}`,
    schema: {
      type: "object",
      properties: { ...text, dictionary: { type: "object", additionalProperties: value } },
    },
    left: { text: "hello", dictionary: { key: { value: 1, extra: 1 } } },
    right: { text: "hello", dictionary: { key: { value: equal ? 1 : 2, extra: equal ? 1 : 2 } } },
    equal,
  })),
  ...["allOf", "anyOf", "oneOf"].map((keyword) => ({
    name: `nested ${keyword} structural union`,
    schema: {
      type: "object",
      properties: {
        ...text,
        nested: {
          type: "object",
          [keyword]: [
            {
              properties: { x: { type: "number" }, kind: { const: "a" } },
              required: ["x", "kind"],
            },
            {
              properties: {
                y: { type: "number" },
                kind: keyword === "oneOf" ? { const: "b" } : { type: "string" },
              },
              required: ["y", "kind"],
            },
          ],
        },
      },
    },
    left: { text: "hello", nested: { kind: "a", x: 1, y: 1 } },
    right: { text: "hello", nested: { kind: "a", x: 1, y: 2 } },
    equal: false,
  })),
];

export function sharingFacts(scenario: SharingCase) {
  const f = fixture();
  const owner = f.task(1, 0);
  const run = f.run(2, 0);
  const follower = f.task(3, 0);
  const events = structuredClone(f.events);
  for (const event of events) {
    if (event.type !== "task.created" && event.type !== "run.started") continue;
    const record = event.type === "task.created" ? event.data.task : event.data.run;
    record.binding.inputSchema = structuredClone(scenario.schema);
    record.binding.contractRevision = compileInputSchema(scenario.schema).revision;
    record.input = structuredClone(
      event.taskId === follower.taskId ? scenario.right : scenario.left,
    );
    if (event.type === "task.created") {
      const { value: _value, ...request } = event.data.task.request;
      event.data.task.request = { ...request, ...record.input };
    }
  }
  return {
    owner,
    run,
    follower,
    events,
    facts: reduce(emptyFacts("domain"), events),
  };
}
