import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { CID } from "multiformats/cid";
import { create } from "multiformats/hashes/digest";
import { ContentRef, compileTrustedContract, decodePayload, encodePayload } from "../src/index.js";
import { ContentRefSchema } from "../src/typebox.js";

const cid = CID.parse("bafkreigh2akiscaildcjlywwfme6ngynt5kwhr6bpcf3r7nnbyurphdisi");
const text = cid.toString();
const ref = () => ContentRef.fromCID(cid);
const trusted = (schema: unknown) => compileTrustedContract(schema);

test("Task dialect keeps $ref, boolean roots, prefixItems and allOf while converting only ContentRef", () => {
  const parameters = {
    $id: "https://task.invalid/schema/0",
    type: "object",
    additionalProperties: false,
    required: ["document", "label"],
    properties: {
      document: { $ref: "#/$defs/ref" },
      baseline: { $ref: "#/$defs/ref" },
      label: { type: "string" },
    },
    $defs: { ref: { type: "string", "x-ipfs-content-ref": true } },
  };
  const encoded = trusted(parameters).encode({
    document: ref(),
    baseline: ref(),
    label: text,
  });
  assert.deepEqual(encoded.cidPaths.sort(), ['$["baseline"]', '$["document"]']);
  assert.equal((encoded.data as { label: string }).label, text);
  const decoded = trusted(parameters).decode(encoded) as {
    document: ContentRef;
    label: string;
  };
  assert.ok(decoded.document instanceof ContentRef);
  assert.equal(decoded.label, text);

  const result = trusted(true).encode({ note: text, lookalike: { cid: text } });
  assert.deepEqual(result.cidPaths, []);
  assert.deepEqual(result.data, { note: text, lookalike: { cid: text } });
  assert.throws(() => trusted(false).encode({}), /match schema|boolean/);

  const tuple = {
    type: "array",
    prefixItems: [{ type: "string" }, { type: "string", "x-ipfs-content-ref": true }],
    items: false,
    minItems: 2,
    maxItems: 2,
  };
  const prefixed = trusted(tuple).encode([text, ref()]);
  assert.deepEqual(prefixed.cidPaths, ["$[1]"]);
  assert.equal((prefixed.data as unknown[])[0], text);

  const intersected = {
    allOf: [
      { type: "object", properties: { document: { type: "string", "x-ipfs-content-ref": true } } },
      { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    ],
  };
  const combined = trusted(intersected).encode({ document: ref(), label: "keep" });
  assert.deepEqual(combined.cidPaths, ['$["document"]']);
  assert.equal((combined.data as { label: string }).label, "keep");
});

test("three channels round-trip JSON, ContentRef and DAG without copying child trees", async () => {
  const parameters = Type.Object({
    document: ContentRefSchema(),
    label: Type.String(),
  });
  const message = Type.Object({
    instruction: Type.String(),
    document: Type.Optional(ContentRefSchema()),
  });
  const result = Type.Object({
    issues: Type.Array(
      Type.Object({
        message: Type.String(),
        references: Type.Array(ContentRefSchema()),
      }),
    ),
  });
  const child = trusted(result).encode({
    issues: [{ message: "one", references: [ref()] }],
  });
  const parent = trusted(result).decode(child) as {
    issues: { message: string; references: ContentRef[] }[];
  };
  const parametersPayload = trusted(parameters).encode({ document: ref(), label: "doc" });
  const messagePayload = trusted(message).encode({ instruction: "check", document: ref() });
  const combined = trusted(result).encode({
    issues: [{ message: "parent", references: [parent.issues[0]!.references[0]!, ref()] }],
  });
  assert.equal((parametersPayload.data as { label: string }).label, "doc");
  assert.ok((parametersPayload.data as { document: unknown }).document);
  assert.deepEqual(messagePayload.cidPaths, ['$["document"]']);
  assert.equal(combined.cidPaths.includes('$["issues"][*]["references"][*]'), true);
  const combinedData = combined.data as { issues: { references: string[] }[] };
  assert.equal(combinedData.issues[0]!.references[0], text);
  assert.equal(combinedData.issues[0]!.references[1], text);
  const dag = trusted(result).toDag(combined);
  const node = dag.data as { issues: { references: CID[] }[] };
  assert.ok(CID.asCID(node.issues[0]!.references[0]));
  assert.ok(node.issues[0]!.references[0]!.equals(cid));
  assert.deepEqual(trusted(result).fromDag(dag), combined);
});

test("ordinary strings stay strings; mixed unions convert only the reference branch", () => {
  const schema = Type.Object({
    items: Type.Array(
      Type.Union([
        Type.Object({ kind: Type.Literal("reference"), value: ContentRefSchema() }),
        Type.Object({ kind: Type.Literal("text"), value: Type.String() }),
      ]),
    ),
  });
  const payload = trusted(schema).encode({
    items: [
      { kind: "text", value: text },
      { kind: "reference", value: ref() },
    ],
  });
  assert.deepEqual(payload.cidPaths, ['$["items"][?@["kind"] == "reference"]["value"]']);
  assert.equal((payload.data as { items: { value: string }[] }).items[0]!.value, text);
  const value = trusted(schema).decode(payload) as {
    items: { kind: string; value: string | ContentRef }[];
  };
  assert.equal(typeof value.items[0]!.value, "string");
  assert.ok(value.items[1]!.value instanceof ContentRef);
  assert.throws(
    () => trusted(Type.Union([ContentRefSchema(), Type.String()])).encode(ref()),
    /discriminator/,
  );
});

test("injected Task validators are used and P1 encodePayload still rejects $ref", () => {
  const schema = {
    type: "object",
    properties: { document: { $ref: "#/$defs/ref" } },
    $defs: { ref: { type: "string", "x-ipfs-content-ref": true } },
  };
  let validated = false;
  const contract = compileTrustedContract(schema, {
    validate: (data) => {
      validated = true;
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        typeof data.document !== "string"
      )
        throw new Error("Task validator rejected parameters.");
    },
  });
  const payload = contract.encode({ document: ref() });
  assert.equal(validated, true);
  assert.deepEqual(payload.cidPaths, ['$["document"]']);
  assert.throws(() => encodePayload(schema as never, { document: ref() } as never));
  assert.throws(() => decodePayload(payload, schema));
});

test("parameters, message and result round-trip JSON, ContentRef and DAG without copying trees", () => {
  const parameters = Type.Object({ source: ContentRefSchema() });
  const message = Type.Object({ attachment: ContentRefSchema() });
  const result = Type.Object({
    fromParent: ContentRefSchema(),
    fromChild: ContentRefSchema(),
  });
  const source = ref();
  const child = ContentRef.fromCID(CID.createV1(0x55, create(0x12, new Uint8Array(32).fill(2))));
  const encodedParameters = trusted(parameters).encode({ source });
  const encodedMessage = trusted(message).encode({ attachment: source });
  const encodedResult = trusted(result).encode({
    fromParent: source,
    fromChild: child,
  });
  assert.deepEqual(encodedParameters.cidPaths, ['$["source"]']);
  assert.deepEqual(encodedMessage.cidPaths, ['$["attachment"]']);
  assert.deepEqual(encodedResult.cidPaths.sort(), ['$["fromChild"]', '$["fromParent"]']);
  assert.equal(
    (encodedResult.data as { fromParent: string }).fromParent,
    (encodedParameters.data as { source: string }).source,
  );
  const dag = trusted(result).toDag(encodedResult);
  const dagData = dag.data as { fromParent: CID; fromChild: CID };
  assert.ok(CID.asCID(dagData.fromParent));
  assert.ok(CID.asCID(dagData.fromChild));
  const restored = trusted(result).fromDag(dag) as typeof encodedResult;
  const logical = trusted(result).decode(restored) as {
    fromParent: ContentRef;
    fromChild: ContentRef;
  };
  assert.ok(logical.fromParent.cid.equals(source.cid));
  assert.ok(logical.fromChild.cid.equals(child.cid));
});
