# @silvermoon-work/task-sdk

Generation-scoped Node Task Worker runtime (`runTask`, `RunFailure`) and
callback/context types. Its only runtime dependency is
[@silvermoon-work/task-protocol](../task-protocol/README.md), using the
lightweight `/worker` entry without Ajv or a CID parser.

Migrated under the original MIT license from
[potential-guide at 6614f46](https://github.com/shazhou-ww/potential-guide/tree/6614f46bf0f4152c61bd2c73d6c4b21ab4cf366f/packages/task-sdk).
The runtime and public API are preserved; package imports now use the
`@silvermoon-work` workspace. The initial `0.1.0-canary-261109-1` was published through
[Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/42588331015)
with an exact dependency on protocol `0.1.0-canary-261109-2`.
Select an explicit SDK version or the `canary` dist-tag; `latest` is still the
`0.0.0` placeholder.

Versions from `0.1.0-canary-261109-2` additionally restore `TaskContext.invokeTask`,
`ChildTaskInvocation` author types and host-ACK child results, previously
provided only by the old SDK in integration fixtures. These changes are not
in the initial canary above; use version 2 or later for child Tasks.

## Authoring

Use the migrated workspace
[task-builder CLI init](../task-builder-cli/README.md#init-composition)
to create a private project, then build, encode and check its Bundle.
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

The Engine validates business input/messages, checkpoints, completion and
failure evidence, plus JSON shape, byte limits, progress and logs. The SDK
forwards payloads without automatic business-schema validation. Authors may
bundle their own validators. Custom hosts must implement the same validation
and negative-ACK lifecycle, not acknowledge every frame.

The SDK owns bounded queues, generation/Run routing, declaration equality,
cancellation and resource streams. A rejected checkpoint remains a failed
output even if the callback catches it. Rejected completion is reported as
failure; rejected `RunFailure` evidence is re-reported without that evidence.
Release follows an acknowledged terminal fact; an unavailable terminal channel
reports uncertainty. Cancellation keeps its stopping/release path.

`context.invokeTask({ key, cid, path, input, timeoutMs })` requests a child
through the host and returns its acknowledged JSON result. The key is stable
within the parent Run; the host verifies the child's root against the parent
DAG, enforces authorization and budgets, and owns admission and cleanup.
Calls after finishing reject with `run_finished`; cancellation interrupts
submission. Child invocations share the bounded request channel but do not
occupy the sequential progress/checkpoint output queue.

Node structured clone transports IPC. Non-cloneable payloads reject locally
with `invalid_payload`; sendable non-JSON values are rejected by the host.
Failed sends do not consume message IDs or pending credits. Getters/custom
objects may be normalized during cloning, so authors should send plain JSON.
Receiver byte limits govern acceptance, not transport allocation.

`context` provides `signal`, `messages`, `progress`, `checkpoint` and typed
async `log` receipts. Diagnostics have a separately bounded channel and do not
replace business outputs.

`context.bundle.cid` is the readonly host-verified executing root. The host
owns CID parsing, codec/hash and DAG checks; the SDK treats it as an opaque
nonempty string of at most 256 characters and echoes it in the ready handshake.
It is not task input or a self-referential compiled identity.

`context.bundle.read(relativePath, { signal? })` returns a demand-driven
`ReadableStream<Uint8Array>` with cancellation and explicit stream errors:

```ts
const chunks: Uint8Array[] = [];
for await (const chunk of context.bundle.read("resources/data.bin")) chunks.push(chunk);
const bytes = Buffer.concat(chunks);
```

Resources belong to the current immutable Bundle root. Absolute paths,
traversal and absent files fail. Do not locate resources through `__dirname`,
`import.meta.url` or cwd: Workers can execute verified CommonJS source in memory.
Workers are lifecycle/isolation boundaries, not security sandboxes.

The preserved wire contract is documented in the source's
[Task Worker specification](https://github.com/shazhou-ww/potential-guide/blob/6614f46bf0f4152c61bd2c73d6c4b21ab4cf366f/docs/task-bundle-worker.md)
and [Run Logs](https://github.com/shazhou-ww/potential-guide/blob/6614f46bf0f4152c61bd2c73d6c4b21ab4cf366f/docs/task-run-logs.md).
Release this SDK separately after its matching protocol version is available,
using the `task-sdk-v<version>` mapping in the root
[release guide](../../README.md#publish-one-package). Never publish dependencies
automatically.
