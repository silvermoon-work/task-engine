# @silvermoon-work/task-sdk

Generation-scoped Node Task Worker runtime (`runTask`, `RunFailure`) and
callback/context types. It uses
[@silvermoon-work/task-protocol](../task-protocol/README.md)'s lightweight
`/worker` entry without Ajv, plus `multiformats/cid` for canonical Space identities.

Migrated under the original MIT license from
[potential-guide at 6614f46](https://github.com/shazhou-ww/potential-guide/tree/6614f46bf0f4152c61bd2c73d6c4b21ab4cf366f/packages/task-sdk).
The runtime and public API are preserved; package imports now use the
`@silvermoon-work` workspace. The initial `0.1.0-canary-261109-1` was published through
[Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/42588331015)
with an exact dependency on protocol `0.1.0-canary-261109-2`.
Select an explicit SDK version or the `canary` dist-tag; `latest` is still the
`0.0.0` placeholder.

The current source candidate is `0.1.0-canary-261110-1`, paired with protocol
`0.1.0-canary-261110-1`. Publish these separately in dependency order only after
the exact candidate receives approval; the manifest is not npm availability evidence.

Versions from `0.1.0-canary-261109-2` additionally restore `TaskContext.invokeTask`,
`ChildTaskInvocation` author types and host-ACK child results, previously
provided only by the old SDK in integration fixtures. These changes are not
in the initial canary above; use version 2 or later for child Tasks.

## Authoring

Use the migrated workspace
[task-builder CLI init](../task-builder-cli/README.md#init-composition)
to create a private project, then build its module and CAR. Standalone `car`
accepts `dist/task.yaml`; CAR inspection is a library operation, not a Builder
`check` command in the redesigned interface.
Builder core version 2 and CLI version 1 generated the old SDK template;
use core version 3 and CLI version 3 for the migrated default. Existing projects can
explicitly select the SDK version with child invocation support:

```text
pnpm add @silvermoon-work/task-sdk@0.1.0-canary-261109-2
```

For the current workspace CLI:

```text
task-builder init my-task
```

```ts
import { runTask } from "@silvermoon-work/task-sdk";

runTask<{ text: string }, string>(async (input, context) => {
  await context.progress({ stage: "execution", percent: 50, message: "Working" });
  return input.text;
});
```

[Task Builder](../task-builder/README.md) owns compilation, contracts, resources
and CAR tooling. Explicit entries call `runTask(callback)` themselves; callback
mode wraps a selected export. The builder replaces the SDK's private binding
with the verified Bundle declaration. It does not accept a binding from author
configuration or `workerData`; calling the unbuilt SDK fails.

## Runtime contract

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

`context.invokeTask({ key, cid, path, input, timeoutMs })` requests a child
through the host and returns its acknowledged JSON result. The key is stable
within the parent Run; the host verifies the child's root against the parent
DAG, enforces authorization and budgets, and owns admission and cleanup.
Calls after finishing reject with `run_finished`; cancellation interrupts
submission. Child invocations share the bounded request channel but do not
occupy the sequential progress output queue.

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

### Spaces (breaking contract)

`context.bundle` is the immutable executing `ReadonlySpace`; `context.output`
is the Run's `ReadWriteSpace`. Both expose `sid` and `root`. Immutable Spaces
also expose `cid`. `context.space(canonicalCid)` synchronously creates another
immutable Space reference, not a network request. The SDK parses CIDs and
canonicalizes them to CIDv1 base32, so CIDv0/v1 aliases share the same SID.
The host validates canonical CID encoding, codecs, hashes, authorization and
DAGs when used.
There is no public constructor accepting arbitrary SIDs.

Static SIDs are `ipfs:<canonical-cid>`; the output SID is
`run:<runId>:output`. A `SpaceRef` exposes `space`, `path`,
`resolve(relativePath)` and `toJSON()` (`{sid,path}`). Root paths are `/`.
Resolution is synchronous and lexical: repeated separators and `.` normalize,
`..` cannot escape root, backslashes and NUL are rejected. Absolute `/…`
references resolve from the same Space root.

`await ref.read({signal?})` returns a discriminated `SpaceNode`: either
`{kind:"file",content:ReadableStream<Uint8Array>}` or
`{kind:"directory",entries:AsyncIterable<SpaceEntry>}`. Each entry has `name`, `kind` (`file` or
`directory`), and `ref`; follow that reference rather than rebuilding identity.

```ts
const file = await context.bundle.root.resolve("resources/data.bin").read();
if (file.kind !== "file") throw new Error("Expected a file");
await context.output.write("data.bin", file.content);
await context.output.link("original", context.bundle.root.resolve("resources"));
const snapshotCid = await context.output.getCid();
```

`write(path, content, {signal?})` accepts a byte stream; `link(path, ref,
{signal?})` links a Space reference. `getCid({signal?})` captures the current
immutable output snapshot without closing the writer. Completion waits for
outstanding writes/links and host finalization; failures cannot silently
become successful completion. The host attaches the final `outputCid` to the
completed Run outcome, not the callback's business result.

Native transferable streams provide backpressure, bounded transport chunks,
explicit stream errors and cancellation. A read's optional abort signal spans
both metadata lookup and the entire returned stream/iterator lifetime; cancel
a stream or break directory iteration to release it early. Run cancellation
aborts all operations. Request budgets are bounded.

`context.generation`, `context.checkpoint` and `context.bundle.read` are
removed. Rebuild existing Bundles: hosts explicitly require `spaceProtocol:1`
in the ready handshake and reject previously compiled SDK wrappers. The schema
identity itself is unchanged.

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
