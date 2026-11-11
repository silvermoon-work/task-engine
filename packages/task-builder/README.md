# @silvermoon-work/task-builder

Build Task Bundles with esbuild from a read-only file tree into another read-only
file tree. No pguide command protocol, Gulp, Vinyl, CAR, network, publication, or
output-directory management is part of the transformation.
Separate `./init` and `./car` exports provide project templates and offline CAR
streams without turning build into a multi-output operation. The root entry
does not re-export or load these modules; init/CAR do not load esbuild.
Subpaths isolate module loading, not npm dependency installation.
Builder owns `./tree`: compilation requires a traversable, repeatable read port,
not a one-shot importer iterator. `./car` combines the standard `@ipld/car`,
UnixFS importer/exporter and multiformats libraries with bounded staging and
existing Protocol validation. These are compiler-free subpaths, not a separate
package or a custom CAR codec. Engine CLI owns a smaller offline block-source
adapter and never installs Builder. No independent CAR package is published.

Builder keeps esbuild as a runtime dependency because building author source
needs a compiler. Its OS/CPU-specific optional package supplies the required
precompiled binary. Skipping dependency installation scripts is supported;
do not omit optional dependencies. Build calls the binary, not `install.js`.
esbuild's postinstall checks/optimizes installation and can recover a missing
platform package; it is not a prerequisite for normal builds.
This package has no CLI binary, process signal handlers or host filesystem
adapter. The independent
[@silvermoon-work/task-builder-cli](../task-builder-cli/README.md) library owns
Commander-based interaction and local I/O. `./tree` exposes the shared pure VFS
contract, factories and stream helpers; the old `./node` entry has moved to
`@silvermoon-work/task-builder-cli/node`.
The library-only layout and init/CAR/tree APIs are published in
`0.1.0-canary-261109-2`. The older `0.1.0-canary-261109-1` artifact has the
previous CLI layout; use the separate CLI package for commands.
Version `0.1.0-canary-261109-3` updates init to the migrated SDK with child
invocation support and removes all old-project development dependencies.
The `0.1.0-canary-261111-2` release updates init and the Echo example
to the breaking Space context API and selects the matching SDK. Rebuild old
canary Bundles before running them with the new Space host protocol.

## Transformation

```ts
import {
  buildTaskBundle,
  type ReadonlyFileTree,
} from "@silvermoon-work/task-builder";

const output: ReadonlyFileTree = await buildTaskBundle(input, {
  name: "Echo",
  runtime: { minVersion: "22.13.0" },
  source: {
    entry: "src/main.ts",
    contract: {
      input: { type: "object", properties: { text: { type: "string" } } },
      result: { type: "string" },
      message: false,
    },
    mode: "explicit",
  },
  include: [{ from: "assets/**", to: "resources/" }],
  binary: ["resources/images/**"],
  signal,
});

const entries = await output.list("");
const resource = await output.read("resources/config.json", { signal });
```

The input variable is a caller-supplied tree, not a host path:

```ts
interface ReadonlyFileTree {
  list(path: string, options?: { signal?: AbortSignal }): Promise<readonly {
    name: string;
    kind: "file" | "directory";
    target?: string;
  }[]>;
  read(path: string, options?: {
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>>;
}
```

`""` lists the root. Listings contain direct children, with names rather than
full paths. Logical paths use `/` on every OS; absolute paths, traversal,
backslashes, colons and control characters are rejected. Missing paths, wrong
file/directory kinds, invalid entries and input failures are explicit errors.
Every read must return a new stream of the same bytes. The caller must keep the
input version and its lifetime stable while using the output.
An optional `target` is a canonical path inside the same tree for an alias;
ordinary virtual trees need not provide it. The directory adapter supplies it
for confined links so package imports resolve from their real dependency
location, including pnpm's virtual store.

## Streaming and ownership

The generated primary Schemas are `schemas/input.json`, `schemas/result.json`
and `schemas/message.json`; the manifest references those exact paths.
Additional contract Schemas use a name-to-Schema object, for example
`schemas: { user: UserSchema, address: AddressSchema }`, and become
`schemas/shared/user.json` and `schemas/shared/address.json`. Names must be
single portable file-name stems with no traversal, separators, reserved device
names, non-NFC spellings or case-insensitive collisions. Array declarations are
rejected rather than automatically numbered. Named Schemas are sorted by name
for deterministic output, independent of object insertion order.
Author-supplied `$id` and `$ref` values are preserved. Primary fallback IDs
remain unchanged; shared definitions without an `$id` receive
`https://task.invalid/schema/shared/<URI-encoded-name>`. References use Schema
identities, not object keys; missing references or conflicting identities fail.
Existing output directories are not renamed automatically; rebuild into a new
directory to obtain the new layout.

- Module source, package metadata and contracts are aggregated **per file**
  because esbuild's `onLoad` requires complete bytes. Source reads and the module
  graph have separate byte/file/path budgets; this is not a fully streaming JS
  compiler.
- Building reads resource listings, but does not open resource contents.
  `output.read()` itself does not open the input resource either: first demand
  does. Resource chunks pass through with backpressure, without whole-resource
  aggregation or a temporary snapshot. Normalization buffers at most an upstream
  chunk plus its transformed bytes and UTF-8 decoder state. Input adapters should
  emit reasonably sized chunks; the Node adapter uses 64 KiB.
- Text validates incremental UTF-8 and normalizes CRLF/lone CR to LF, including
  CRLF and UTF-8 sequences split across chunks. BOM and all other bytes are
  preserved. Explicit binary resource globs preserve bytes exactly.
- Cancel or abort of a resource stream cancels its upstream reader. Each read
  has independent normalization and cancellation state. The build signal applies
  only to construction; output reads use their own signal.
- Generated Worker, manifest and Schema bytes are owned by the output. Readers
  receive copies. Resources retain a reference to the input, not a byte snapshot;
  changing or closing the input changes or breaks subsequent reads.
- Manifest, path collisions, Schema closure and generated bytes are validated
  before build returns. Resource UTF-8, input failures and byte capacities can
  fail later during reading, including at EOF. **A returned tree is not proof
  that all resource bytes have been validated.** Consume every file to EOF before
  treating it as a distributable Bundle. Partial reads do not validate the tail.
- Resource capacity accounting tracks the maximum observed normalized length per
  logical file across reads, so repeated/concurrent reads do not double-count.
  Protocol defaults remain 64 MiB per file/total, 256 files and 512 paths.

## Modules and contracts

An esbuild namespace confines module loading to the input tree. `enhanced-resolve`
uses a tree-backed filesystem for relative imports, extension resolution,
`.js` to `.ts` aliases, `node_modules`, package exports/imports and Node
import/require conditions. Only Node builtins remain external. Missing
dependencies never fall back to the builder's own node_modules.

Dependencies must be present in the input tree. There is no install, network
resolver, automatic tsconfig discovery, tsconfig path mapping, arbitrary asset
loader or externally supplied esbuild plugin in this first implementation.
Compilation targets Node 22 CommonJS and rejects non-static import/require calls.
The build host must use Node >=22.13; execution runtime eligibility belongs to
the Engine.

`source.mode` defaults to `explicit`: the entry calls the SDK's `runTask`
itself. `callback` wraps a lazily imported callback; `exportName` defaults to
`default` and is only accepted in that mode. `source.sdk` defaults to
`@silvermoon-work/task-sdk` for callback wrappers and can explicitly select an
SDK already present in the tree. The
[workspace SDK](../task-sdk/README.md) supplies the runtime; `source.sdk` can
explicitly select another SDK supplied by the input tree. There is no dedicated
old-scope SDK recognition or dependency.
Recognized SDK `binding.js`/`binding.ts` modules are replaced with the resolved
Bundle declaration without evaluating the Worker or author callback.

`source.contract` accepts an object, a tree-relative JSON file, or a trusted
TS/JS module default-exporting `{ input, result, message, schemas? }`. Objects
can contain plain JSON Schema or supported TypeBox 0.34.52 schemas; transforms
and unsupported metadata/format semantics are rejected. Code contracts require
`allowContractExecution: true`. They are compiled using the same tree resolver,
then **executed as trusted Node code, not in a sandbox**. Builtins and global
APIs can have side effects; a read-only tree is not an execution security boundary.
Evaluation runs in a short-lived Node process (30-second internal budget).
Console and standard-stream output attempts, including dependencies and caught
or deferred calls, fail with `CONTRACT_OUTPUT_FORBIDDEN`; captured bytes are
never forwarded. CLI build supplies execution permission automatically; the
library retains its explicit `allowContractExecution` opt-in. Runtime Worker
logging is unaffected.
Their `__filename`, `__dirname` and `import.meta.url` are logical `task-tree:///`
locations, not host source paths. Use JSON contracts for non-executing builds.

For example, a JSON contract can share one definition between input and result:

```json
{
  "input": {
    "type": "object",
    "properties": {
      "user": { "$ref": "https://example.invalid/schemas/user" }
    }
  },
  "result": { "$ref": "https://example.invalid/schemas/user" },
  "message": false,
  "schemas": {
    "user": {
      "$id": "https://example.invalid/schemas/user",
      "type": "object",
      "properties": { "name": { "type": "string" } }
    }
  }
}
```

Text contracts reject duplicate JSON/YAML keys during strict parsing, including
escaped JSON keys with the same decoded spelling. JS/TS objects can overwrite
duplicate keys before evaluation returns; that information cannot be recovered
by the builder. Case-insensitive name collisions are still checked after
evaluation. The build YAML and final `task.yaml` protocol structure do not change;
the latter only lists the newly named files in `include`.

## Additional transformations

### Init: configuration to a read-only template tree

```ts
import { createTaskProject } from "@silvermoon-work/task-builder/init";

const project = createTaskProject({
  name: "@example/my-task",
  taskName: "Echo",
});
const entries = await project.list("");
const source = await project.read("src/main.ts");
```

The pure synchronous function returns an owned, repeatable file tree with a
private npm package, a TypeBox `src/contract.ts`
contract with a named shared text Schema, typed SDK entry/helper and a streamed
greeting resource. It performs no I/O, install or ancestor package modification.
The generated package explicitly depends on `@sinclair/typebox@0.34.52`.
The contract exports `Input` and `Result` using `Static<typeof ...>`; the Worker
imports them with `import type` and calls `runTask<Input, Result>`. Its shared
text reference preserves string inference, while runtime Schemas require
nonempty text, integer bytes >=0 and chunks >=1, forbid extra input/result
properties, and disable messages. The TS contract is trusted executable code;
esbuild transpilation is not typechecking. JSON contracts remain supported.
The default dependency and author import use
`@silvermoon-work/task-sdk@0.1.0-canary-261109-2` in builder version
`0.1.0-canary-261109-3`. Older builder versions still emit the old SDK template;
use the version 3 core and version 3 CLI for the migrated template.
An explicit local `sdkVersion` specifier (such as `file:task-sdk.tgz`) remains
available for development.
`sdkVersion`, `minRuntimeVersion`, `taskName` and npm `name` can be supplied.
Without `taskName`, the package's unscoped name is used. The CLI does not expose
SDK/runtime/version overrides; authors edit the generated project instead.
Init fixes `outDirectory` to `dist/<derived-name>` from the npm package name,
independently of `taskName`: `echo-task` becomes `dist/echo-task`, and
`@acme/echo-task` becomes `dist/acme-echo-task`. Invalid npm names and unsafe
derived paths (including reserved device names and trailing dots) are rejected,
not sanitized. Renaming the package later does not change this generated value.
This template convention does not change the general build output defaults.
It has no CLI dependency, npm scripts, package-manager selection or pnpm
installation policy. The CLI composes this tree with its own scripts,
dependency versions and scoped release-age exceptions before writing it to disk.

### CAR: file-tree streams to a bounded offline archive

```ts
import {
  encodeTaskBundleCar,
  readTaskBundleCar,
} from "@silvermoon-work/task-builder/car";
const encoded = await encodeTaskBundleCar(bundleTree, { signal });
try {
  await consumeCarStream(encoded.stream);
  console.log(encoded.cid);
} finally {
  await encoded.close();
}

const decoded = await readTaskBundleCar(carStream, {
  expectedCid,
  signal,
});
try {
  console.log(decoded.cid, decoded.declaration, decoded.bytes, decoded.files);
  const resource = await decoded.tree.read("resources/greeting.txt");
  // The caller owns this offline content source; it structurally matches Engine's read port.
  const ipfsClient = { block: decoded.block };
} finally {
  await decoded.close();
}
```

CAR v1 requires the root CID in its header. Encoding therefore consumes each
input file once into bounded staged UnixFS blocks, validates the staged Bundle,
then returns `{ cid, stream, retainedBytes, close() }`. It does not collect
whole resource files or the complete archive. The CAR stream is single-use,
demand-driven and emits at most 64 KiB per output chunk. It releases staged
blocks at EOF or cancellation; call `close()` when abandoning an unread result.
The encode signal spans staging and output, unlike the build signal's
construction-only lifetime. Output no longer depends on the input after staging.

Decoding consumes the full source stream before returning, verifies SHA-256
blocks, one CAR v1 root, exact reachable DAG (no duplicate/unreachable blocks),
canonical UnixFS layout, exact manifest, UTF-8/LF, Schema closure and all resources.
It returns a repeatable read-only `tree`, declaration/resolved Schema, statistics
and a read-only `block.get(cid, {signal?})` port. Reads return owned byte copies;
closing clears memory and makes subsequent tree/block reads fail explicitly.
The read signal applies to acquisition; subsequent tree/block reads have their
own cancellation signals. This is not a persistent node, pin or upload service.

`TaskCarOptions` supports `maxCarBytes` (default 72 MiB), `retainedBytes`
(default 72 MiB), `maxBlocks` (default 16,384), `maxBlockBytes` (default 2 MiB)
and reduced `fileLimits`. Retention counts unique block bytes, not whole-file
buffers. Peak memory also includes input/parser chunks, one encoded record and
aggregated manifest/Schema control files; these are not an RSS limit. Malformed
CAR records are bounded by the archive limit before decoded block-size checking.
Text is validated, not normalized during CAR encoding: pass a built Bundle tree.

The deterministic layout preserves the existing CID contract: CIDv1, raw leaves,
256 KiB fixed chunks, balanced layout (174 children), wrapped directory, no
sharding, sorted paths and no mtime/mode metadata.

`consumeCarStream` and `carStream` above are caller-provided sinks/sources.
For host directories, use the independent
[CLI Node adapters](../task-builder-cli/README.md#node-adapters), not a core
filesystem API. See the [end-to-end guide](../../docs/end-to-end-verification.md)
for CLI init, build, CAR, real Server execution and recovery.

The included [Echo task](./examples/echo/task.build.yaml) remains an author-input
example. A built SDK Worker is meant to be started by a Task Engine, not executed
directly as a standalone script.

## Validation

```sh
pnpm --filter @silvermoon-work/task-builder... build
pnpm --filter @silvermoon-work/task-builder test
pnpm check
```

The contract conversion and SDK binding behavior were extracted from
potential-guide's MIT-licensed author tooling; its license notice is retained.
