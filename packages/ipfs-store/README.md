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
not store responsibilities. `ContentBlocks` in `./dag` is the bounded in-memory
Low-level verified blocks are SHA-256 codec-neutral (for example a raw gateway
may retain DAG-CBOR); full UnixFS preparation still rejects unsupported DAG codecs. `ContentBlocks` in `./dag` is the bounded in-memory
block primitive for such transfers, not another application-level acquisition API.

`scope(limits?)` borrows the same backing store with an independent, no-larger
reader budget and cancellation lifetime. Closing a scope does not close its parent.
Engine uses scopes for its own retention limits; logical file/path/execution
budgets remain in Builder/Engine, separately from unique-block accounting.
`IpfsStore.fromClient(port, limits?, dataDir?)` explicitly adapts a caller-owned
block source (for example an offline CAR); it never closes that source. Without a
dataDir this adapter is memory-only. Neither construction nor import loads config.

## Public configuration

CLI hosts use `@silvermoon-work/ipfs-store/node`. The default file is
`%LOCALAPPDATA%\TaskContent\config.json` on Windows and
`~/.config/task-content/config.json` elsewhere; `TASK_CONTENT_CONFIG` selects
another file. Its optional keys are `gateway` (explicit HTTP(S) URL or ordered
URL list) and `dataDir` (relative to that config file).
Default dataDir is `~/.silvermoon.work/content`, independent of Engine databases.
No gateway is guessed when unset; local misses fail.

Builder's `--content-gateway` / `--content-data-dir` and Engine server's
`--ipfs-gateway` / `--content-data-dir` override the common defaults separately.
Existing `server.dataDir` remains the Engine database path, not content storage.
Engine startup rejects using that same directory as content storage.
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
