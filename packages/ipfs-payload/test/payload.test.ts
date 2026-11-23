import assert from "node:assert/strict";
import test from "node:test";
import * as dagCbor from "@ipld/dag-cbor";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CID } from "multiformats/cid";
import {
  ContentRef,
  decodePayload,
  decodePayloadBlock,
  encodePayload,
  encodePayloadBlock,
  fromDagPayload,
  parseCidPath,
  toDagPayload,
  validatePayload,
} from "../src/index.js";
import { ContentRefSchema } from "../src/typebox.js";
import { encodeDagCbor } from "../src/dag-cbor.js";

const cid = CID.parse("bafkreigh2akiscaildcjlywwfme6ngynt5kwhr6bpcf3r7nnbyurphdisi");
const text = cid.toString();
const ref = () => ContentRef.fromCID(cid);
const reference = Type.Object({ kind: Type.Literal("reference"), value: ContentRefSchema() });
const plain = Type.Object({ kind: Type.Literal("text"), value: Type.String() });
const union = Type.Union([reference, plain]);

test("TypeBox inference and serialized contracts retain explicit references without shape guessing", async () => {
  const schema = Type.Object({
    ref: ContentRefSchema(),
    text: Type.String(),
    lookalike: Type.Object({ cid: Type.String() }),
    slash: Type.Object({ "/": Type.String() }),
    spoof: Type.Object({ "/": Type.String(), bytes: Type.String() }),
  });
  const author: Static<typeof schema> = {
    ref: ref(),
    text,
    lookalike: { cid: text },
    slash: { "/": text },
    spoof: { "/": text, bytes: text },
  };
  assert.ok(Value.Check(schema, author));
  assert.equal(Value.Check(schema, { ...author, ref: text }), false);
  const payload = encodePayload(schema, author);
  assert.deepEqual(payload.cidPaths, ['$["ref"]']);
  assert.equal(payload.data.ref, text);
  const restored = decodePayload(payload, schema);
  const inferred: ContentRef = restored.ref;
  assert.ok(inferred.cid.equals(cid));
  assert.deepEqual(restored.lookalike, author.lookalike);
  assert.deepEqual(restored.slash, author.slash);
  assert.deepEqual(restored.spoof, author.spoof);
  const serialized = JSON.parse(JSON.stringify(schema));
  assert.deepEqual(encodePayload(serialized, restored), payload);
  const block = await encodePayloadBlock(payload, serialized);
  assert.deepEqual(await decodePayloadBlock(block.bytes, serialized, { cid: block.cid }), payload);
  const independent = decodePayload(payload) as typeof restored;
  assert.ok(independent.ref instanceof ContentRef);
  assert.equal(independent.text, text);
  assert.ok(Object.isFrozen(author.ref));
  const exposed = author.ref.cid;
  exposed.bytes.fill(0);
  assert.equal(
    author.ref.cid.toString(),
    text,
    "A borrowed CID cannot mutate the reference identity.",
  );
});

test("optional fields, homogeneous and nested arrays, tuples and special keys round trip", () => {
  const schema = Type.Object({
    absent: Type.Optional(ContentRefSchema()),
    refs: Type.Array(ContentRefSchema()),
    nested: Type.Array(Type.Array(ContentRefSchema())),
    tuple: Type.Tuple([Type.String(), ContentRefSchema(), Type.Optional(ContentRefSchema())]),
    "a'\"\\\n": ContentRefSchema(),
    "": ContentRefSchema(),
  });
  const value = {
    refs: [ref(), ref()],
    nested: [[], [ref()]],
    tuple: [text, ref(), ref()] as [string, ContentRef, ContentRef],
    "a'\"\\\n": ref(),
    "": ref(),
  };
  const payload = encodePayload(schema, value);
  assert.ok(payload.cidPaths.includes('$["refs"][*]'));
  assert.ok(payload.cidPaths.includes('$["nested"][*][*]'));
  assert.deepEqual(encodePayload(schema, decodePayload(payload, schema)), payload);
  assert.ok(value.refs.every((item) => item instanceof ContentRef));
  const optional = Type.Object({ refs: Type.Optional(Type.Array(ContentRefSchema())) });
  assert.deepEqual(encodePayload(optional, {}), { data: {}, cidPaths: [] });
  assert.deepEqual(encodePayload(optional, { refs: [] }), { data: { refs: [] }, cidPaths: [] });
  assert.deepEqual(validatePayload({ data: {}, cidPaths: ["$['refs'][*]"] }, optional).data, {});
  assert.throws(
    () => validatePayload({ data: {}, cidPaths: ["$['forged']"] }, optional),
    /declared/,
  );
});

test("mixed discriminated arrays select only reference branches and regenerate after reordering", () => {
  const schema = Type.Object({ items: Type.Array(union) });
  const original = {
    items: [
      { kind: "reference" as const, value: ref() },
      { kind: "text" as const, value: text },
      { kind: "reference" as const, value: ref() },
    ],
  };
  const payload = encodePayload(schema, original);
  assert.deepEqual(payload.cidPaths, ['$["items"][?@["kind"] == "reference"]["value"]']);
  const restored = decodePayload(payload, schema);
  assert.equal(restored.items[1]!.value, text);
  const rearranged = { items: [restored.items[1]!, restored.items[2]!, restored.items[0]!] };
  const next = encodePayload(schema, rearranged);
  assert.deepEqual(next.cidPaths, payload.cidPaths);
  assert.equal(decodePayload(next, schema).items[0]!.value, text);
  assert.ok(original.items[0]!.value instanceof ContentRef);
  assert.throws(
    () => validatePayload({ ...payload, cidPaths: ['$["items"][*]["value"]'] }, schema),
    /exactly match/,
  );
  assert.throws(
    () => validatePayload({ ...payload, cidPaths: ['$["items"][0]["value"]'] }, schema),
    /exactly match/,
  );
});

test("nested unions fall back to concrete paths when a wildcard would select text", () => {
  const nested = Type.Object({ items: Type.Array(Type.Object({ inner: union })) });
  const payload = encodePayload(nested, {
    items: [
      { inner: { kind: "text", value: text } },
      { inner: { kind: "reference", value: ref() } },
    ],
  });
  assert.deepEqual(payload.cidPaths, ['$["items"][1]["inner"]["value"]']);
  assert.deepEqual(encodePayload(nested, decodePayload(payload, nested)), payload);
  const deep = Type.Array(Type.Object({ inner: Type.Array(union) }));
  const filtered = encodePayload(deep, [
    {
      inner: [
        { kind: "reference", value: ref() },
        { kind: "text", value: text },
      ],
    },
    { inner: [{ kind: "text", value: text }] },
  ]);
  assert.deepEqual(filtered.cidPaths, ['$[*]["inner"][?@["kind"] == "reference"]["value"]']);
  assert.deepEqual(encodePayload(deep, decodePayload(filtered, deep)), filtered);
});

test("ambiguous direct unions, discriminator failures and malformed CID values fail symmetrically", () => {
  const ambiguous = Type.Union([ContentRefSchema(), Type.String()]);
  assert.throws(() => encodePayload(ambiguous, ref()), /discriminator/);
  assert.throws(() => decodePayload({ data: text, cidPaths: ["$"] }, ambiguous), /discriminator/);
  const duplicate = Type.Union([
    reference,
    Type.Object({ kind: Type.Literal("reference"), value: Type.String() }),
  ]);
  assert.throws(
    () => encodePayload(duplicate, { kind: "reference", value: ref() }),
    /discriminator/,
  );
  const missing = Type.Union([
    Type.Object({ kind: Type.Optional(Type.Literal("reference")), value: ContentRefSchema() }),
    plain,
  ]);
  assert.throws(
    () => validatePayload({ data: { value: text }, cidPaths: [] }, missing),
    /discriminator/,
  );
  for (const data of [
    { value: text },
    { kind: "unknown", value: text },
    { kind: "reference", value: "bad" },
  ])
    assert.throws(() => decodePayload({ data, cidPaths: ["$['value']"] }, union));
  assert.throws(() => ContentRef.fromCID("not-a-cid"));
  assert.throws(
    () => encodePayload(ContentRefSchema(), text as unknown as ContentRef),
    /exactly match/,
  );
  assert.throws(() => encodePayload(Type.Any(), ref()), /exactly match/);
  assert.throws(() => decodePayload({ data: "not-a-cid", cidPaths: ["$"] }));
});

test("self-contained metadata is strict, bounded and never executable", () => {
  const schema = Type.Object({ ref: ContentRefSchema(), text: Type.String() });
  const payload = encodePayload(schema, { ref: ref(), text });
  for (const bad of [
    { data: payload.data },
    { ...payload, extra: true },
    { ...payload, cidPaths: [] },
    { ...payload, cidPaths: ["$['text']"] },
    { ...payload, cidPaths: ["$['ref']", '$["ref"]'] },
    { ...payload, cidPaths: ["$['ref']", "$"] },
    { ...payload, cidPaths: [1] },
  ])
    assert.throws(() => decodePayload(bad, schema));
  for (const path of [
    "$..ref",
    "$.ref",
    "$[-1]",
    "$[01]",
    "$[0:2]",
    "$[?@['x'] != 1]",
    "$[?@['x'] == true || process.exit()]",
    "$[(@.length-1)]",
    "$['ref'] trailing",
  ])
    assert.throws(() => parseCidPath(path), /CID path/);
  assert.throws(() => validatePayload(payload, schema, { limits: { maxPathLength: 2 } }), /path/i);
  assert.throws(
    () => validatePayload(payload, schema, { limits: { maxBytes: 10 } }),
    /oversized|capacity/,
  );
  assert.throws(() => validatePayload(payload, schema, { limits: { maxNodes: 2 } }), /capacity/);
  assert.throws(() => parseCidPath("$[0][0]", { maxDepth: 1 }), /capacity/);
  assert.throws(
    () =>
      validatePayload({ data: [text, text], cidPaths: ["$[0]", "$[1]"] }, undefined, {
        limits: { maxPaths: 1 },
      }),
    /capacity/,
  );
  assert.throws(() => validatePayload(payload, schema, { limits: { maxNodes: 0 } }), /limit/);
});

test("strict snapshots do not call accessors or revive JSON objects, even with prototype keys", async () => {
  const schema = Type.Any();
  let calls = 0;
  const getter = {
    get cid() {
      calls++;
      return text;
    },
  };
  assert.throws(() => encodePayload(schema, getter), /accessors/);
  assert.throws(() => fromDagPayload({ data: getter, cidPaths: [] }), /accessors/);
  assert.equal(calls, 0);
  const sparse: unknown[] = [];
  sparse.length = 2;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -0,
    2 ** 60,
    new Date(),
    new Uint8Array(),
    sparse,
    "\ud800",
  ])
    assert.throws(() => encodePayload(schema, value));
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.throws(() => encodePayload(schema, cyclic), /Cyclic/);
  const data = JSON.parse(
    '{"__proto__":{"cid":"' + text + '"},"constructor":{"prototype":1},"":2}',
  );
  const payload = encodePayload(schema, data);
  assert.deepEqual(payload.data, data);
  const block = await encodePayloadBlock(payload);
  assert.deepEqual(await decodePayloadBlock(block.bytes), payload);
  assert.equal(Object.getPrototypeOf(payload.data), Object.prototype);
});

test("DAG conversion requires actual links to agree with metadata in both directions", async () => {
  const payload = encodePayload(Type.Object({ ref: ContentRefSchema(), text: Type.String() }), {
    ref: ref(),
    text,
  });
  const dag = toDagPayload(payload) as { data: { ref: CID; text: string }; cidPaths: string[] };
  assert.ok(dag.data.ref instanceof CID);
  assert.equal(dag.data.text, text);
  assert.deepEqual(fromDagPayload(dag), payload);
  assert.throws(() => fromDagPayload(payload), /exactly match/);
  assert.throws(() => fromDagPayload({ ...dag, cidPaths: [] }), /exactly match/);
  assert.throws(
    () => fromDagPayload({ data: { ref: cid, text: cid }, cidPaths: payload.cidPaths }),
    /exactly match/,
  );
  const block = await encodePayloadBlock(payload);
  const decoded = dagCbor.decode<{ data: { ref: CID } }>(block.bytes);
  assert.ok(decoded.data.ref instanceof CID);
  assert.ok(decoded.data.ref.equals(cid));
  await assert.rejects(decodePayloadBlock(block.bytes, undefined, { cid }), /verification/);
  await assert.rejects(decodePayloadBlock(dagCbor.encode(payload)), /exactly match/);
  assert.deepEqual(await decodePayloadBlock(encodeDagCbor(dag)), payload);
});

test("literal filters accept only exact primitive discriminators", () => {
  const boolean = Type.Array(
    Type.Union([
      Type.Object({ kind: Type.Literal(true), value: ContentRefSchema() }),
      Type.Object({ kind: Type.Literal(false), value: Type.String() }),
    ]),
  );
  const payload = encodePayload(boolean, [
    { kind: true, value: ref() },
    { kind: false, value: text },
  ]);
  assert.deepEqual(payload.cidPaths, ['$[?@["kind"] == true]["value"]']);
  assert.deepEqual(encodePayload(boolean, decodePayload(payload, boolean)), payload);
  assert.deepEqual(parseCidPath("$[?@['kind'] == 're\\'f']['a\\u0022b']"), [
    { kind: "filter", key: "kind", value: "re'f" },
    { kind: "property", key: 'a"b' },
  ]);
});

test("canonical DAG-CBOR bytes/CID agree with the standard codec and reject alternate encodings", async () => {
  const schema = Type.Object({ ref: ContentRefSchema(), text: Type.String() });
  const payload = encodePayload(schema, { ref: ref(), text });
  const block = await encodePayloadBlock(payload);
  const hex =
    "a26464617461a263726566d82a58250001551220c7d01489080858c495e2d62b09e69b0d9f5563c7c1788bb8fdad0e29179c68926474657874783b6261666b726569676832616b69736361696c64636a6c797777666d65366e67796e74356b77687236627063663372376e6e627975727068646973696863696450617468738168245b22726566225d";
  assert.equal(Buffer.from(block.bytes).toString("hex"), hex);
  assert.equal(block.cid.toString(), "bafyreiatyguskb4ci22ucouumpyglc5cfa5h5bulkb6o2sniy3yamitca4");
  assert.deepEqual(block.bytes, dagCbor.encode(toDagPayload(payload)));
  const reordered = encodePayload(schema, { text, ref: ref() });
  assert.deepEqual((await encodePayloadBlock(reordered)).bytes, block.bytes);
  assert.deepEqual(await decodePayloadBlock(Buffer.from(hex, "hex")), payload);
  // A nonminimal integer, wrong map order, duplicate keys, trailing bytes and indefinite map.
  for (const invalid of [
    "a26464617461180068636964506174687380",
    "a268636964506174687380646461746100",
    "a364646174610064646174610068636964506174687380",
    "a26464617461006863696450617468738000",
    "bf64646174610068636964506174687380ff",
  ])
    await assert.rejects(decodePayloadBlock(Buffer.from(invalid, "hex")));
});

test("schema validation and metadata evaluation cannot escape their structure budgets", () => {
  const optional = Type.Object({ ref: Type.Optional(ContentRefSchema()) });
  assert.throws(
    () => validatePayload({ data: {}, cidPaths: [] }, Type.Object({ ref: ContentRefSchema() })),
    /schema/,
  );
  assert.deepEqual(validatePayload({ data: {}, cidPaths: ["$['ref']"] }, optional).data, {});
  const payload = {
    data: Array.from({ length: 40 }, () => ({ kind: "text" })),
    cidPaths: Array.from({ length: 20 }, (_, i) => `$[?@["kind"] == ${i}]`),
  };
  assert.throws(
    () => validatePayload(payload, undefined, { limits: { maxNodes: 600 } }),
    /evaluation capacity/,
  );
  for (const schema of [
    Type.String({ format: "cid" }),
    Type.Transform(Type.String())
      .Decode((value) => value)
      .Encode((value) => value),
    { type: "string", "x-ipfs-content-ref": false },
    {
      type: "object",
      properties: { hidden: { $ref: "#/$defs/ref" } },
      $defs: { ref: ContentRefSchema() },
    },
  ])
    assert.throws(() => validatePayload({ data: text, cidPaths: [] }, schema));
});

test("separately loaded native CID instances remain links without reviving business lookalikes", async () => {
  const other = (await import(
    `${import.meta.resolve("multiformats/cid")}?independent-instance`
  )) as typeof import("multiformats/cid");
  const foreign = other.CID.parse(text);
  assert.equal(foreign instanceof CID, false);
  const payload = { data: text, cidPaths: ["$"] };
  const value = { data: foreign, cidPaths: ["$"] };
  assert.deepEqual(fromDagPayload(value), payload);
  assert.deepEqual(encodeDagCbor(value), (await encodePayloadBlock(payload)).bytes);
  const plain = { ...foreign };
  assert.throws(
    () => fromDagPayload({ data: plain, cidPaths: ["$"] }),
    /Custom payload prototypes/,
  );
});
