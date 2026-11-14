# @silvermoon-work/ipfs-payload

Pure typed references, self-contained JSON payloads and canonical DAG-CBOR.
No Store, Task SDK, Engine, file-tree dependency, network, pin or content access.

```ts
import { Type, type Static } from "@sinclair/typebox";
import {
  ContentRef, ContentRefSchema, encodePayload, decodePayload,
  encodePayloadBlock, decodePayloadBlock,
} from "@silvermoon-work/ipfs-payload";

const schema = Type.Object({
  document: ContentRefSchema(),
  label: Type.String(),
});
const parameters: Static<typeof schema> = {
  document: ContentRef.fromCID(targetCid),
  label: targetCid.toString(), // ordinary business text
};
const json = encodePayload(schema, parameters);
// { data: { document: "...", label: "..." }, cidPaths: ['$["document"]'] }
const restored = decodePayload(json, schema);
restored.document.cid; // native CID; no read methods or path
const block = await encodePayloadBlock(json, schema);
const roundTrip = await decodePayloadBlock(block.bytes, schema, { cid: block.cid });
```

`ContentRefSchema()` is a TypeBox extension with `Static<> = ContentRef`, a
registered author-side TypeBox validator, and serializable
`{ type: "string", "x-ipfs-content-ref": true }` semantics. The package's codecs
validate this keyword and the complete business schema; an unrelated JSON
Schema validator ignoring the keyword is **not** sufficient. Current Task
Builder/Engine protocol integration is a later phase, not added by this package.
Author fields require `ContentRef.fromCID(CID | string)`, not untyped strings,
lookalike `{ cid }` objects or bare native CIDs. References retain immutable
identity only; reading an exposed CID cannot mutate the original identity.

## Conversions and validation

- `encodePayload(schema, author, options?)` produces `IpfsPayload<JsonOf<T>>`.
- `validatePayload(unknown, schema?, options?)` validates and snapshots the
  exact `{ data, cidPaths }` envelope.
- `decodePayload(payload, schema?, options?)` restores `ContentRef` only at
  marked positions. Without a schema it validates the self-contained descriptor,
  not an absent business contract; admission must supply the contract.
- `toDagPayload` / `fromDagPayload` convert the same envelope between JSON and
  logical DAG values. Marked fields become genuine `multiformats` CID links.
  Every actual link must agree with the metadata, in both directions.
- `encodePayloadBlock` returns `{ cid, bytes }` using DAG-CBOR and SHA-256.
  `decodePayloadBlock` rejects noncanonical encodings and, when supplied,
  verifies `options.cid`. Neither function stores anything.

All conversions snapshot without invoking getters, `toJSON` or prototype
properties. Ordinary strings, `{ cid: "..." }`, `{ "/": "..." }` and even
CID-shaped business objects stay ordinary. `./dag-cbor` exposes `encodeDagCbor`
plus the standard codec `code`/`decode` for generic structured blocks: it reuses
the standard DAG-CBOR encoder options with identity-only CID detection, rather
than its permissive object-shape detection. `asNativeCID` rebases native instances
from separately loaded modern multiformats modules using data descriptors, never
getters or plain JSON object shapes. This subpath loads no TypeBox/AJV.

Finite JSON primitives, objects, arrays and tuples are supported. Sparse arrays,
undefined, custom prototypes, cycles, nonfinite numbers, negative zero, unsafe
integers and malformed Unicode fail rather than silently changing on round trip.
References may contain syntactically valid CIDs; host codec/hash allowlists and
target integrity/availability are separate Store responsibilities.

## Contracts and bounded paths

Supported schemas are the JSON-compatible TypeBox primitives, literals/enums,
objects, optional properties, homogeneous arrays, tuples, and unions. Common
JSON Schema value constraints are enforced by AJV in strict mode. Reference
unions require uniquely distinguishing **required literal object properties**;
direct `ContentRef | string`, optional/duplicate discriminators and ambiguous
branches fail. Reference-bearing non-object unions (including nullable direct
refs) are intentionally unsupported; use a tagged object union. `$ref`, recursive
schemas, transforms, intersections, patternProperties, formats and schema-valued
tuple additionalItems are rejected explicitly, not ignored.

Paths are relative to `data`. `parseCidPath` accepts only `$`, bracket properties,
nonnegative fixed array indices, array `[*]`, and array literal filters such as
`$["items"][?@["kind"] == "reference"]["value"]`. Quoted strings may use single
or double quotes with JSON escapes. No recursive descent, slices, functions,
logical expressions, evaluation or arbitrary query scripts are supported.

Encoding derives paths from the contract **and actual discriminator branches**.
It uses wildcards/filters only when they match no extra positions, otherwise
falls back to concrete indices. Re-encoding recomposed results recalculates
positions. Validation compares the exact selected location sets; missing, extra,
duplicate or overlapping matches fail. Optional/empty paths may match nothing;
with a contract such zero-match paths must be schema-declared.

`options.limits` may bound path count (default 1,024), each path's length (4,096),
structure/path depth (64), cumulative visited/evaluated nodes (100,000), and
JSON/encoded block bytes (2 MiB). Schema inspection and repeated path evaluation
consume the same operation budget. Canonical encoding fixes CBOR map ordering,
numbers and CID tags, not the semantic equivalence of differently written
but valid path expressions. Fixed byte/CID vectors are in `test/payload.test.ts`.

Encoding does not prove targets exist; pinning does not commit a business fact.
SQLite remains the authority. Finalized RunHistory assembly, retention intent
management and Task protocol switching are outside this foundation package.
