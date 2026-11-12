# Task content

Shared verified IPFS/UnixFS acquisition for Builder and Engine, independent of
task scheduling and Engine databases. Library callers own and inject content
ports; importing this package does not read configuration or start a client.

`ContentBlocks` in `@silvermoon-work/task-content/dag` verifies SHA-256 raw and
DAG-PB blocks, retains a bounded full DAG by unique CID, and separately bounds
UnixFS logical expansion. No automatic GC or unconfigured source fallback.

## Public configuration

CLI hosts use `@silvermoon-work/task-content/node`. The default file is
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
Libraries accept injected ports and do not read user configuration themselves.

`SharedContent` verifies every read and writes a uniquely named complete file
before atomic hard-link publication. Concurrent processes cannot publish partial
blocks; an interrupted pending file is not a cache hit. Existing published bytes
are validated, never overwritten with unverified data. Close aborts owned work
but never removes blocks or closes an injected source. Configured factories own
and close only the gateways they create. Disk retention has no automatic GC.
In-flight acquisition is deduplicated within each instance, not across processes.
CID storage accounting and logical file/path/execution budgets remain independent.
