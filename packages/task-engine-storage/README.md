# @silvermoon-work/task-engine-storage

显式本地 SQLite Store：WAL、foreign keys、FULL durability、事务事件/索引/检查点及独占 lease。
Facts projection 与 SQLite user_version 均为 5。v4、旧版本、未知格式和混合记录在写入前明确拒绝；
不会迁移、覆盖或删除现有用户数据库，请选择新路径。
格式预检使用同目录的临时只读副本（含存在的 WAL），不修改原数据库或 sidecar；
兼容 Node.js 22.13，不依赖 SQLite URI 文件名支持。

Task 仅持久化受理/取消事实；必要的资格观测载荷只有 observedAt，不写绑定或 Task 权威快照。
Run 从准备前开始；开始、投递代际、进度、结构化证据、可靠 outcome、停止请求/确认、退出、
消息状态和物理清理分别持久化。未退出的 Run 恢复为 stopped，不伪造其实际退出或回收。
旧 Run 的未知副作用不自动重跑；准备 checkpoint 不恢复调用栈。
检查点是完整源前缀重放可核验的物化视图，不是独立权威。
持久保存数据域身份、单调 ULID 准入下界、仍可受理 ID 的幂等凭据及签名游标密钥；
固定水位分页/SSE 和受引用/未回收资源保护的 compact 不使下界回退。
未确认清理不释放 Engine lease，也不伪造 reclaimed 事实。

Preparing Request、到达时资格、原始意图和处理结果也持久化；
accepted 与 Task 创建同事务，rejected 保留幂等依据。
终态跟踪可见性按首次 terminalAt 单独清理，不清理准备中请求，也不删除 Task。
历史读取不执行原业务 Worker，不因 Bundle 内容淘汰而重跑或丢失事实。
完整说明见 [Task Engine](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-engine.md)。
Run diagnostic logs use independent additive `run_logs` storage, not lifecycle
events or Result. Its writes/status retention use the same exclusive Engine
lease; lifecycle projection version remains 5. See
[Run Logs](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-run-logs.md) for logical budgets, expiry/missing states,
SQLite high-water allocation, and the separate `logFault` test hook.

IPFS blocks and logical recursive-retention roots are stored in additive
`ipfs_blocks` and `run_content_roots` tables. Roots may be retained before the
Run outcome is recorded, and multiple Runs may retain the same CID. Blocks are
immutable; conflicting bytes are rejected. There is no content garbage
collection: neither forgetting a Run nor compacting lifecycle history deletes
retained blocks or roots. Mutations require the exclusive Engine lease.
`run_content_access` stores diagnostic Run/space associations, not authorization
grants. The additive `run.content-access` lifecycle event authoritatively
projects de-duplicated SIDs onto Run snapshots and the Task snapshot's nested
Run. Read methods do not create tables or require a lease.

Completed outcomes optionally retain `outputCid` in the existing `run.outcome`
event and its projection. Existing v5 events remain valid without it, so neither
the projection nor SQLite format version changes; old v5 stores add the content
tables on their first owner-authorized content mutation.

## Finalized RunHistory management (metadata only)

`SqliteStore.runHistory` implements the optional, coherent `RunHistoryStorage`
capability from task-protocol. It does **not** start an archiver or change
existing Engine execution, V1 APIs, projection 5, or SQLite user_version 5.
Compatible databases add the owned `run_history_archives` table on the first
owner-authorized archive mutation. Reads do not create it; incompatible owned
layouts fail preflight without modifying the database or its sidecars.

- `finalize(owner, runId, {now, retainUntil, maxAttempts, retryDelayMs,
  maxSourceBytes})` atomically captures a bounded, immutable source at a SQLite
  watermark. Exit, settled messages and confirmed resource reclamation are all
  required. An outcome alone, recovery exit alone or `cleanupUnknown` is
  insufficient. Resolved cleanup uncertainty remains in the source events.
- The source contains the Run, settled messages, Run-related events (and message
  Task cancellations), content roots and diagnostic content associations. It
  excludes Store secrets, active-state snapshots, other Runs, Task matching
  projections and separately mutable diagnostic logs. Multiple Tasks still
  share one RunHistory; subsequent Task matching never rewrites it.
- `claimArchive` commits a bounded attempt, retention generation, expiring
  lease and unique Store retention owner. `setArchiveRoot` records the candidate
  CID **before** retention I/O. `completeArchive` records the trusted service's
  verified closure counts and retention observations, not just root existence.
  `failArchive` retains an error and retry deadline without changing business
  facts. Attempts stop at the configured limit or retention deadline.
- `requestRelease`, deadline recovery and `records.forgotten` revoke retention,
  fence publication and discard the separate archive source. Forgetting and its
  release intent commit atomically. Business records, messages, results and
  idempotency credentials otherwise follow their existing SQLite policies.
  Compact does not discard archive/release tombstones.
- `claimRelease` / `completeRelease` / `failRelease` coordinate idempotent cleanup
  for each attempt owner, with leases and backoff. A late publisher re-arms its
  release revision even after an earlier release acknowledgement; stale cleanup
  acknowledgements cannot erase that new intent. Failed/uncertain attempts retain
  their cleanup work. `recover(owner, runId, now)` reconciles expiry and abandoned
  leases; page `list(afterRunId, limit)` (maximum 1000) to bound recovery work.

All mutations use the existing exclusive Engine owner and synchronous
transactions, including the `beforeCommit` / `afterCommit` fault seams. Network
operations must run **between**, never inside, these methods. `readSource(runId,
now)` rejects released/expired sources; `read` returns metadata even when the
business record or source has been removed. A repeated `finalize` returns the
original policy/identity and never extends or re-grants retention.

### Archive service

Engine (`packages/task-engine/src/run-history-archive.ts`) publishes the DAG
using each lease `owner` for Store retention and `${owner}/archive` staging.
It records the candidate root with `setArchiveRoot` **before** retain I/O, then
conditionally `completeArchive` with verified `blockCount`/`byteLength`. Network
I/O runs between `runHistory.*` transactions. On cancel or a false completion it
settles in-flight I/O and services the recorded release intent with owner-aware
`recoverOwner`/`reconcile`, never a global unpin/GC. Restart recovers SQLite
leases then continues I/O; archive retry is not Worker re-execution.

Archive outcome, retention state and `lastRead` are independent. The latter is
a dated `available` / `unauthorized` / `unreachable` / `missing` / `corrupt`
observation, never a current availability guarantee. Released means this
owner's retention was relinquished, **not** physical deletion or revoked
external access. Unpin is not physical deletion. Store controls visibility and
protects other owners; Engine API authorization does not cover another Kubo
ingress. Builtin local Store is not publicly distributed. Isolated test
fixtures may GC only their own offline daemon, never a shared node.

SQLite remains the necessary authority/backup for admission, Tasks, Runs,
messages, expiry and idempotency credentials. Restore a closed database
together with its WAL/SHM sidecars; do not reconstruct records from leftover
IPFS blocks. If auxiliary archive details are absent after restore, query
status is `missing` / `not_archived` and business completion is unchanged.
Detail cleanup follows `requestRelease` plus owner-aware unpin; leftover DAG
bytes may remain until the Store backend's own GC, which product code never
invokes on a shared daemon.
