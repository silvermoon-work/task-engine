import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { ContentRefSchema, parseTaskBundleYaml } from "@silvermoon-work/task-protocol";
import { contractSchemas } from "../src/contract.js";

const primary = { parameters: { type: "object" }, result: true, message: false };

test("ContentRef TypeBox extension survives Schema serialization", () => {
  const documents = contractSchemas({
    parameters: Type.Object({ document: ContentRefSchema() }),
    result: ContentRefSchema({ description: "result document" }),
    message: false,
  });
  const byPath = new Map(documents.map(({ path, document }) => [path, document]));
  assert.deepEqual(byPath.get("schemas/parameters.json")?.properties, {
    document: { type: "string", "x-ipfs-content-ref": true },
  });
  assert.equal(byPath.get("schemas/result.json")?.type, "string");
  assert.equal(byPath.get("schemas/result.json")?.["x-ipfs-content-ref"], true);
  assert.equal(byPath.get("schemas/result.json")?.description, "result document");
});

test("named Schemas have stable paths and fallback IDs independent of insertion order", () => {
  const address = { type: "string" };
  const user = { $id: "https://example.test/user", type: "object" };
  const forward = contractSchemas({ ...primary, schemas: { user, address } });
  const reverse = contractSchemas({ ...primary, schemas: { address, user } });
  assert.deepEqual(forward, reverse);
  assert.deepEqual(
    forward.map(({ path }) => path),
    [
      "schemas/parameters.json",
      "schemas/result.json",
      "schemas/message.json",
      "schemas/shared/address.json",
      "schemas/shared/user.json",
    ],
  );
  assert.deepEqual(
    forward.map(({ document }) => document.$id),
    [
      "https://task.invalid/schema/0",
      "https://task.invalid/schema/1",
      "https://task.invalid/schema/2",
      "https://task.invalid/schema/shared/address",
      "https://example.test/user",
    ],
  );
});

test("named TypeBox and boolean shared definitions preserve their Schema semantics", () => {
  const user = Type.Object({ name: Type.String() }, { $id: "https://example.test/user" });
  const documents = contractSchemas({
    parameters: Type.Object({ user: Type.Ref(user) }),
    result: Type.Ref(user),
    message: Type.Never(),
    schemas: { user, impossible: false },
  });
  const byPath = new Map(documents.map(({ path, document }) => [path, document]));
  assert.equal(byPath.get("schemas/result.json")?.$ref, "https://example.test/user");
  assert.deepEqual(byPath.get("schemas/shared/impossible.json"), {
    $id: "https://task.invalid/schema/shared/impossible",
    not: {},
  });
  assert.deepEqual(byPath.get("schemas/shared/user.json"), {
    $id: "https://example.test/user",
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
});

test("unsafe, reserved, non-NFC and case-colliding shared names are rejected", () => {
  for (const name of [
    "",
    "../user",
    "nested/user",
    "nested\\user",
    ".",
    "..",
    "CON",
    "aux",
    "user:",
    "user?",
    "user ",
    "e\u0301",
  ])
    assert.throws(
      () => contractSchemas({ ...primary, schemas: { [name]: true } }),
      /portable file names/,
    );
  assert.throws(
    () =>
      contractSchemas({
        ...primary,
        schemas: { user: true, User: true },
      }),
    /portable file names/,
  );
});

test("shared Schema declarations must be objects, not legacy arrays or null", () => {
  for (const schemas of [[], [true], null, "user", false])
    assert.throws(() => contractSchemas({ ...primary, schemas }), /name-to-Schema object/);
  assert.equal(contractSchemas(primary).length, 3);
  assert.equal(contractSchemas({ ...primary, schemas: {} }).length, 3);
});

test("JSON and YAML contract parsing rejects duplicate decoded Schema names", () => {
  for (const text of [
    '{"parameters":{"type":"object"},"result":true,"message":false,"schemas":{"user":true,"user":false}}',
    '{"parameters":{"type":"object"},"result":true,"message":false,"schemas":{"user":true,"\\u0075ser":false}}',
    "parameters: {type: object}\nresult: true\nmessage: false\nschemas:\n  user: true\n  user: false\n",
  ])
    assert.throws(() => parseTaskBundleYaml(Buffer.from(text)), /Invalid JSON-subset YAML/);
});
