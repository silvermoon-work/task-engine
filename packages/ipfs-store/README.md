# @silvermoon-work/ipfs-store

Shared verified IPFS/UnixFS acquisition for Builder and Engine, independent of
task scheduling and Engine databases. Library callers own and inject content
objects; importing this package does not read configuration or start a client.

```ts
import { IpfsStore } from "@silvermoon-work/ipfs-store";

const content = new IpfsStore({
  dataDir: contentDirectory,
  gateway: "https://gateway.example", // omit for strictly local operation
  limits: { bytes: 256 * 1024 * 1024, blocks: 16_384, depth: 64 },
});
const output = await buildTaskBundle(input, { ...buildOptions, content });
const engine = createTaskEngine({ store: engineDatabase, ipfsStore: content, authorize });
// Both borrow the same object. The host closes it after all consumers finish.
```

`read(cidOrCidPath, { signal? })` returns a discriminated UnixFS node: files
(`type: "file" | "raw"`) expose `content()` as an async byte stream; directories
expose `entries()` as an async iterator. It does not materialize the whole file
or apply Task portable-path rules. The UnixFS node profile is SHA-256 raw/DAG-PB regular
files and UnixFS directories. Missing local blocks are fetched only through an
explicit gateway, verified before atomic publication, and reused by later readers.
Corrupt local content fails rather than silently fetching a replacement.

`prepare(cid, { signal? })` verifies the complete linked DAG with unique-block,
byte and depth limits. `block.get` and verified `put` support offline block
transfer; CAR encoding, task manifests, imports, path policy and DAG grafting are
not store responsibilities.
Low-level verified blocks are SHA-256 codec-neutral (for example a raw gateway
may retain DAG-CBOR); full UnixFS preparation still rejects unsupported DAG codecs.
`ContentBlocks` in `./dag` is the bounded in-memory
block primitive for such transfers, not another application-level acquisition API.

`scope(limits?)` borrows the same backing store with an independent, no-larger
reader budget and cancellation lifetime. Closing a scope does not close its parent.
Engine uses scopes for its own retention limits; logical file/path/execution
budgets remain in Builder/Engine, separately from unique-block accounting.
`IpfsStore.fromClient(port, limits?, dataDir?)` explicitly adapts a caller-owned
block source (for example an offline CAR); it never closes that source. Without a
dataDir this adapter is memory-only. The borrowed **source** is read-only:
adapter `put` still verifies and writes its own ContentBlocks/SharedContent,
never a source `put`. Closing the adapter never closes the source.
`writable` does not imply durable coordination: adapters expose
`supportsRetention: false` and reject retention operations. Engine checks that
separate capability. Neither construction nor import loads config.

## Optional Kubo backend

```ts
const content = new IpfsStore({
  backend: "kubo",
  apiUrl: "http://127.0.0.1:5001",
  coordinationDir: "/shared/task-content-retention",
  timeoutMs: 30_000,
  limits: { bytes: 256 * 1024 * 1024, blocks: 16_384, blockBytes: 2 * 1024 * 1024, depth: 64 },
});
```

Kubo is a direct raw-block backend, not a local cache backed by a Gateway. No
application `blocks` directory or temporary CAR is written. Original bytes and
SHA-256 raw, DAG-PB and DAG-CBOR block CIDs are preserved; UnixFS traversal
supports raw and DAG-PB as before. RPC responses, including errors, are bounded
while streaming. The same read/unique-block/depth limits apply. `limits.bytes`
and `retainedBytes` measure in-process retention, **not disk quotas**.

Explicit trusted remote HTTP(S) RPC endpoints are supported. The host owns
authentication, transport and access policy; URL user information is sent as
Basic authorization and is not included in RPC error messages. The library
does not discover, expose, start, stop, reconfigure or globally GC a daemon.
Daemon networking is entirely its startup policy. A network-offline daemon can
serve existing blocks; a missing block or unreachable RPC fails the dependent
operation. There is no local or Gateway fallback, including Gateway hints.

`pin(root)` verifies the complete DAG with fresh backing reads and requests a
recursive retention hint; `unpin(root)` releases an unreferenced known hint.
Neither `put` nor `prepare` pins. Local pins are durable SQLite metadata, not
no-ops; releasing one does not delete blocks or add automatic disk GC.
Kubo hints use `@silvermoon-work/task-engine/<coordinator-id>` names.
Existing differently named or unnamed recursive pins are left unchanged;
an external direct pin that cannot be upgraded without renaming causes an
explicit unfinished error. Names are **best-effort provenance labels**, not
ownership, authentication, independent leases or permanent availability.
External deletion/renaming between checks is not prevented. Reads still verify
real bytes; missing content is fetched only from the explicitly configured
backend/source or fails. Closing stores/scopes never unpins.

### Participating Engines and recovery

All cooperating Engines must use the **same durable coordination directory**
and preserve it across restarts. It contains only identity, reference and
operation metadata, never blocks or CARs. Defaults are `<local-dataDir>/retention`
or a user-level directory keyed by the exact Kubo API URL. For endpoint aliases,
remote hosts or distinct configurations, explicitly inject the same directory
on storage that provides SQLite locking/durability; separate registries are not
a distributed ownership service. Different registry names are treated as
external and are never claimed or automatically removed by this registry.

Engine automatically registers its persistent Store identity and publishes
Task/Run bundle roots and optional output CIDs, including historical Runs.
Protection is arranged before publishing new content references. Durable
write-ahead intents bridge the RPC/database commit gap; after database commit,
confirmation publishes the root again before clearing the intent. Recovery
uses the persisted Store's actual full root set. Hosts sharing one business
identity supply `retentionOwner` and `retentionRoots` and recover that owner once,
while its executions are stopped.

For custom hosts the primitives are `registerOwner`, `retain`,
`confirmRetained`, `recoverOwner`, and `reconcile`. `retain` publishes an intent
and confirms the pin request; call `confirmRetained` only after committing the
business reference. Use `reconcile(owner, () => readPersistedRoots())` so the
snapshot is read **inside** the participant mutex, not before waiting for it.
`recoverOwner` discards abandoned intents/import sessions only when that owner's
old executions are known to have stopped. Never recover an active shared owner.
Its optional `isIdle` predicate and root callback are evaluated inside the mutex;
Engine uses this for collection without racing a newly preparing request.

Mark-and-sweep first verifies every participating owner's retained graph and
pending publication/import references. Only then can it remove this
coordinator's currently named, unreferenced hints. Other visible names remain.
Missing/corrupt references, inaccessible coordination, cancellation or RPC
failure prevent a successful cleanup result. An interrupted or uncertain
pin/unpin remains journaled for retry; no successful pin/unpin is inferred from
a timeout. Unpin counts are hints removed, not disk bytes reclaimed.

Staging also persists an absent/indirect/already-own before-state before the
atomic raw put. If naming fails after that put created an unnamed pin, recovery
retries its name assignment, checks the visible result, then permits ordinary
named cleanup. Another failure remains an explicit unfinished responsibility,
not a discarded journal row. A genuinely preexisting external unnamed pin has
no such claim and is never renamed or removed. This is best-effort recovery of a
recorded system operation, not protection from outsiders racing the request.

For block-by-block imports, `stageBlock(session, cid, bytes)` atomically pins a
raw alias of each Kubo block before later DAG publication; the alias uses the
same multihash/bytes and does not create an application block copy. This also
handles CAR parents arriving before their children. `finishImport(session,
root, owner?)` verifies and recursively pins the finished DAG before releasing
the session's staging responsibility. A later coordinated sweep removes
unreferenced staging hints. Interrupted imports retain durable retry/recovery
metadata and never claim a complete root.

## Public configuration

CLI hosts use `@silvermoon-work/ipfs-store/node`. The default file is
`%LOCALAPPDATA%\TaskContent\config.json` on Windows and
`~/.config/task-content/config.json` elsewhere; `TASK_CONTENT_CONFIG` selects
another file. The canonical configuration is a strict union:

- `{ "backend": "local", "dataDir": "...", "gateway": "https://..." }`
- `{ "backend": "kubo", "apiUrl": "http://127.0.0.1:5001" }`

Both branches accept `limits` and optional `coordinationDir`; only Kubo accepts
`timeoutMs`. Local `gateway` can also be an ordered URL list. Unknown fields,
cross-branch fields, malformed URLs and non-positive/non-integral limits fail.
Local paths are relative to the config file. Legacy local JSON without
`backend`, and legacy `{ dataDir, gateway?, limits? }` constructors, still work.
Default dataDir is `~/.silvermoon.work/content`, independent of Engine databases.
No gateway is guessed when unset; local misses fail.

Builder's `--content-gateway` / `--content-data-dir` and Engine server's
`--ipfs-gateway` / `--content-data-dir` override the common defaults separately.
Existing `server.dataDir` remains the Engine database path, not content storage.
Engine startup rejects using that same directory as content storage.
Local CLI overrides conflict explicitly with a selected Kubo configuration;
they never silently change its backend. Selecting a different backend in an
existing file requires replacing that file's branch, not merging its fields.
Migrate old private cache settings explicitly; no blocks/databases are moved.
Libraries accept injected stores and do not read user configuration themselves.
`createConfiguredContent()` is an explicit host helper returning an `IpfsStore`
with its resolved `configuration`; it is never invoked by library imports.

The backing storage verifies disk reads and writes a uniquely named complete file
before atomic hard-link publication. Concurrent processes cannot publish partial
blocks; an interrupted pending file is not a cache hit. Existing published bytes
are validated, never overwritten with unverified data. Close aborts owned work
but never removes blocks or closes an injected source. Stores own and close only the gateways they create. Disk retention has no automatic GC.
In-flight acquisition is deduplicated within each instance, not across processes.
Canceling one reader detaches only that reader; shared acquisition belongs to
the client's lifetime and remains available to other readers.
CID storage accounting and logical file/path/execution budgets remain independent.
