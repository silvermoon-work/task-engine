# @silvermoon-work/task-sdk

Generation-scoped Node Task Worker runtime (`runTask`, `RunFailure`) and
callback/context types. It uses
[@silvermoon-work/task-protocol](../task-protocol/README.md)'s lightweight
`/worker` entry without Ajv, plus typed ContentRef payload codecs.

Migrated under the original MIT license from
[potential-guide at 6614f46](https://github.com/shazhou-ww/potential-guide/tree/6614f46bf0f4152c61bd2c73d6c4b21ab4cf366f/packages/task-sdk).
The initial migration preserved the runtime and public API; package imports use the
`@silvermoon-work` workspace. The initial `0.1.0-canary-261109-1` was published through
[Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/42588331015)
with an exact dependency on protocol `0.1.0-canary-261109-2`.
The historical stable `0.1.0` release was paired with protocol `0.1.0` on `latest`.
Its publication and installed acceptance are recorded in the
[release notes](../../README.md#stable-010-2026-11-11).

The published `0.1.0-canary-261111-2` introduced the breaking Space context
contract; see the [release notes](../../README.md#space-context-canary-2026-11-11).
0.1.0 retains that contract. Rebuild older canary Bundles for the new host protocol.

Versions from `0.1.0-canary-261109-2` additionally restore `TaskContext.invokeTask`,
`ChildTaskInvocation` author types and host-ACK child results, previously
provided only by the old SDK in integration fixtures. These changes are not
in the initial canary above; use version 2 or later for child Tasks.

## Authoring

Use the migrated workspace
[task-builder CLI init](../task-builder-cli/README.md#init-composition)
to create a private project, then build its module and CAR. Standalone `car`
accepts `dist/<derived-package-name>/task.yaml`; CAR inspection is a library operation, not a Builder
`check` command in the redesigned interface.
Current source templates select SDK `0.2.0`, paired with Protocol `0.2.0`, and
require Node.js 22.15+ (23.x at least 23.5) for Bundle execution. These stable
versions are prepared in source, not yet publication or registry acceptance
claims. After publication, existing projects can select the SDK explicitly:

```text
pnpm add @silvermoon-work/task-sdk@0.2.0
```

For the current workspace CLI:

```text
task-builder init my-task
```

```ts
import { runTask } from "@silvermoon-work/task-sdk";

runTask<{ text: string }, string>(async (parameters, context) => {
  await context.progress({ stage: "execution", percent: 50, message: "Working" });
  return parameters.text;
});
```

[Task Builder](../task-builder/README.md) owns compilation, contracts, resources
and CAR tooling. Explicit entries call `runTask(callback)` themselves; callback
mode wraps a selected export. The builder replaces the SDK's private binding
with the verified Bundle declaration. It does not accept a binding from author
configuration or `workerData`; calling the unbuilt SDK fails.

## Runtime contract

The ContentRef / parameters contract below describes current source.
Historical release notes above apply only to their exact artifacts; local packed
validation is not evidence that modified source has been published.

The Engine validates business input/messages, completion and
failure evidence, plus JSON shape, byte limits, progress and logs. The SDK
forwards payloads without automatic business-schema validation. Authors may
bundle their own validators. Custom hosts must implement the same validation
and negative-ACK lifecycle, not acknowledge every frame.

The SDK owns bounded queues, generation/Run routing, declaration equality,
cancellation and resource streams. Explicit per-operation cancellation can be
caught and followed by another write; it does not poison the Run. Other output
write failures fail the Run even if the callback catches them. Rejected completion is reported as
failure; rejected `RunFailure` evidence is re-reported without that evidence.
Release follows an acknowledged terminal fact; an unavailable terminal channel
reports uncertainty. Cancellation keeps its stopping/release path.

`context.invokeTask({ key, bundle: context.bundle, path: "resources/child", parameters, timeoutMs })`
requests a child through the host and returns its acknowledged decoded result.
The key is stable within the parent Run. For an external target use its Bundle
root CID string as `bundle`; `path` is optional.
The host resolves and durably fixes the actual CID, child requestId and deadline
before dispatch. Replays retain that identity; changed intent conflicts.
There is no child-start authorization or CID whitelist. Existing resource access
constraints, independent child Runs, validation, cancellation and budgets remain.
External targets are completely prepared at invocation time.
Calls after finishing reject with `run_finished`; cancellation interrupts
submission. Child invocations share the bounded request channel but do not
occupy the sequential progress output queue.

The former `{cid, path}` and SpaceRef invocations are removed, not alternate protocols.
Update calls to Bundle CID / optional path and `parameters`, use matching SDK/Builder versions, rebuild bundles and
replace dependent CIDs. Existing artifacts are never rewritten. See
[migration](../task-builder/README.md#immutable-imports-and-migration).

Node structured clone transports IPC. Non-cloneable payloads reject locally
with `invalid_payload`; sendable non-JSON values are rejected by the host.
Failed sends do not consume message IDs or pending credits. Getters/custom
objects may be normalized during cloning, so authors should send plain JSON.
Receiver byte limits govern acceptance, not transport allocation.

`context` preserves `runId`, `startedAt`, `scope`, `signal`, `messages`, `progress`, and typed
async `log` receipts. Diagnostics have a separately bounded channel and do not
replace business outputs.

The managed Engine CLI can select durable logging for newly built SDK wrappers:
log sends are serialized by acknowledgments, including unawaited calls, and the
terminal outcome waits for those acknowledgments. Unavailable storage is not
silently treated as complete logs. Existing hosts retain their bounded receipt
behavior. An already compiled Bundle does not acquire a new SDK automatically;
producer-reported log loss remains explicit rather than becoming a successful
complete log query. This source change is not evidence of an SDK release.

<a id="spaces-breaking-contract"></a>

### Typed content (breaking contract)

Historical Space-contract links land here; that API has been replaced below.

`context.bundle` is the executing Bundle's root CID **string**, not a Space.
`resolveContent(cid, path, {signal?})` resolves a content path to a native CID;
`readContent(cid, {signal?})` returns either
`{kind:"file",content:ReadableStream<Uint8Array>}` or
`{kind:"directory",entries:AsyncIterable<{name,kind,cid}>}`.
`putContent(stream, {signal?})` stores a file and returns its native CID.
Content I/O belongs to the host, not to ContentRef.

```ts
import { ContentRef } from "@silvermoon-work/task-sdk";

const source = await context.resolveContent(context.bundle, "resources/data.bin");
const file = await context.readContent(source);
if (file.kind !== "file") throw new Error("Expected a file");
const cid = await context.putContent(file.content);
const document = ContentRef.fromCID(cid);
```

Declare a reference field with `ContentRefSchema()` from
`@silvermoon-work/task-protocol` (or `@silvermoon-work/ipfs-payload/typebox`);
TypeBox `Static<>` infers `ContentRef`. Construct values with
`ContentRef.fromCID(CID | string)`, not a CID string or lookalike `{cid}`.
The SDK decodes parameter references and encodes result references according to
the bound contract. Wire channels carry `{data,cidPaths}`; ordinary CID-shaped
strings remain business text. CLI `--parameters` accepts an envelope or wraps a
plain object with empty `cidPaths`; a reference input needs the explicit envelope.
See [payload codecs](../ipfs-payload/README.md).

Completion settles pending content writes. Core Task/Run results are directly
`result: {data,cidPaths}`. The CLI command envelope is `{ok,output?,error?}`,
so the CLI path is `output.result.data`, not `data.output.result.data`.
Its `output` is not a legacy output directory or an automatic root CID.
Content I/O confirms backend retention before reporting success.
Return typed references to stored files in the
business result. References retain identity, not an availability or publication
guarantee; the host's configured backend and retention govern readability.

Native transferable streams provide backpressure, bounded transport chunks,
explicit stream errors and cancellation. A read's optional abort signal spans
both metadata lookup and the entire returned stream/iterator lifetime; cancel
a stream or break directory iteration to release it early. Run cancellation
aborts all operations. Request budgets are bounded.

`context.generation`, `context.checkpoint`, `context.space`, `context.output`
and `context.bundle.root` are absent. Rebuild existing Bundles with matching
SDK/Builder, replace their CARs/CIDs and rebuild dependent parents.
Use a fresh Engine data directory for incompatible persisted facts; upgrading
installed packages does not rewrite a Worker embedded in an old Bundle.

Do not locate resources through `__dirname`, `import.meta.url` or cwd: Workers
can execute verified CommonJS source in memory. Workers are lifecycle/isolation
boundaries, not security sandboxes.

The preserved wire contract is documented in the source's
[Task Worker specification](https://github.com/shazhou-ww/potential-guide/blob/6614f46bf0f4152c61bd2c73d6c4b21ab4cf366f/docs/task-bundle-worker.md)
and [Run Logs](https://github.com/shazhou-ww/potential-guide/blob/6614f46bf0f4152c61bd2c73d6c4b21ab4cf366f/docs/task-run-logs.md).
Release this SDK separately after its matching protocol version is available,
using the `task-sdk-v<version>` mapping in the root
[release guide](../../README.md#publish-one-package). Never publish dependencies
automatically.
