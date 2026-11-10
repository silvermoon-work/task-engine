# @silvermoon-work/task-protocol

The generic protocol is already migrated and published as
`0.1.0-canary-261109-2`. Workspace SDK, builder and Engine packages depend on
this package, not the old-scope protocol. Protocol URI strings and source
specification links retain their original identity; they are not package
dependencies.

The current source candidate is `0.1.0-canary-261110-1` for the managed Engine
delivery. This manifest preparation is not a publication claim and must not
overwrite an existing npm version.

## Task Bundle bytes and structure

The Bundle protocol owns `taskBundleLimits`, `TaskBundleFileLimits`,
`isTaskBundlePath`, `parseTaskBundleYaml`, and `readTaskBundle`.
Limits preserve the 64 MiB total/per-file, 256-file, 512-path and 72 MiB CAR
budgets. Paths are portable, relative, NFC-normalized names without traversal,
reserved device names or ambiguous casing.
`parseTaskBundleYaml` reads bounded UTF-8 JSON-subset YAML, without aliases,
tags, duplicate keys or non-finite numbers; it also reads author build
declarations before their own schema validation.
`readTaskBundle` takes an already supplied `ReadonlyMap<string, Uint8Array>`
and checks exact file inclusion, capacities, nonempty UTF-8 Worker bytes and
offline Schema resources. It returns declaration, resolved schemas, bytes and
file count without evaluating the Worker, reading a directory or fetching data.
Every declaration requires an exact `binary` array, sorted and unique, containing
only included `resources/` files; an empty selection is explicitly `[]`.
All other bytes must be valid UTF-8 with LF-only line endings, including manifest,
Worker and Schemas. Reading rejects old declarations and non-normalized text,
without rewriting anything. `normalizeTaskText` preserves all bytes except CRLF
and lone CR (converted to LF), including a UTF-8 BOM; invalid UTF-8 names its path.
`createTaskTextNormalizer(path)` provides the same rules incrementally:
`push(bytes)` validates split UTF-8 and normalizes split CRLF, while `finish()`
rejects truncated UTF-8 at EOF. Use one normalizer per stream and call `finish()`
only after complete consumption; partial/canceled streams do not prove validity.
Author tools share `taskBundlePattern` / `selectTaskBinary` for case-sensitive,
portable final-path globs. No content/extension sniffing determines binary.
Both author tooling and Engine use this implementation independently of
`artifact-files`. Filesystem safety and Node runtime eligibility remain caller
responsibilities; Engine cache/hint/retention budgets are not protocol limits.
Browser reference and presentation subpaths remain independent of this reader
and its YAML/Schema implementation.

Task Bundle 的引用为根 CID 字符串或 `{cid, hint}`：
`parseBundleReference(reference)` 接受 CID 文本或对象 JSON，
`formatBundleReference(bundle)` 保留其填写形状及有序 hint。
两者复用 `validateBundleReference` 的 CID/HTTP(S) gateway 基址约束；
hint 可为非空字符串或非空数组，不允许凭据、query、fragment、空项或非法 URI。
Engine 另施加宿主 hint 数量预算，非法输入与容量超限明确区分。
Request 原始表示参与幂等；内容判等与缓存使用 `bundleCid(reference)` 规范化根 CID。
旧 URL/Digest 或 URL#Digest 引用明确拒绝，不做双轨转换。
辅助函数同时从包根与浏览器安全的 `@silvermoon-work/task-protocol/bundle-reference`
子入口导出；浏览器使用子入口，不引入 Node Schema 编译与摘要依赖。

可信宿主资源声明采用 `resourceLifetime: "request"`，或提供独立
`confirmResourceRelease(RunResourceContext)` 证明跨请求 owner/句柄已释放。
上下文包含可信 workerGeneration；这些宿主函数不进入类型 Worker。
失败 Result 与成功 Result 一样经纯 terminal 业务复验，不能改写或在恢复前放宽。

通用 Task/完整 Run 的 JSON、schema、请求、事件、Store 与服务边界。

Task Bundle/Worker 使用唯一 `taskSchemaUri` v1，包含独立诊断日志协议。
项目尚未正式发布，v1 可原地演进；已移除的 Task v2 和未来未知 URL 明确拒绝，不做别名。
TaskType 仅声明 type/version/inputSchema/resultSchema/messageSchema 和完整 run 入口；
Host 用 RegisteredType 本地模块描述注册，不传动态函数对象给 Engine。

matchPolicy / MatchPolicy 使用 starts-after-eligible、terminates-after-eligible 两值，after 包含等号。
时间对应完整 Run 开始/实际退出，不对应业务 Execution；已开始但未终结的 Run
可在可信源资格边界满足 terminates 条件。Stage 为 initial/running/stopping/stopped/completed/failed；
stage、canceled、按当前 now 推导的时间标签互相独立，取消或终态不冻结后两者。
Progress 另用 preparation/allocation/execution、可选有限 0–100 percent 与展示字符串。

`aggregateTaskStatus(task, now)` 是纯展示聚合函数，`now` 必须显式传入 epoch 毫秒。
输入仅需 `stage`、`canceled`、`eligibleAt`、`deadlineAt`，兼容 TaskSnapshot / TaskSummary。
返回 `{ status, qualifiers }`，不含文案、颜色或 i18n；各 UI 自行映射。
`status` 为 completed / failed / stopped / canceled / timedOut / stopping / running /
pending（待生效）/ waiting（已生效、等待匹配）。
优先保留运行结局，再判断取消、超时，之后保留 running / stopping，
仅 initial 按生效边界区分 pending / waiting；已匹配运行不因时钟回拨显示待生效。
终结后取消附加 `demandWithdrawn`；取消或超时但运行未终结附加 `runNotEnded`；
其余 `qualifiers` 为空数组。这些标识不证明资源回收或结果是否按时产生。
时间输入遵循协议 canonical UTC，截止不得早于生效时间；无效输入抛出 `TaskError`。
聚合结果不存储，也不用于匹配、取消或回收决策。

浏览器使用独立入口，避免加载服务端 schema / crypto：

```ts
import { aggregateTaskStatus } from "@silvermoon-work/task-protocol/presentation";

const { status, qualifiers } = aggregateTaskStatus(task, now);
```

messageSchema 支持 boolean，false 是 Never，{} / true 不是 Never。
messages 必选、Task 归属及确认与生命周期控制分离；checkpoint 是独立、按 resultSchema 验证的机器证据。
公共服务消息操作使用 taskId/messageId、可信 Caller、持久化状态，不改 Input/deadline。

Facts projection v5；Task 仅存受理/取消事实，匹配与状态按源前缀推导。
新 submission 的 `bundleProtocol:"ipfs"` 区分当前受理记录与不支持的旧协议；
即使新请求因非法引用而被拒绝，仍可跨重启读取其原始意图及持久拒绝结果。
Task/Run Binding 保留原 inputSchema；实时共享与纯事实重放都使用该 Schema 编译的结构 Equals。
历史分组的 equivalenceKey 与 Equals 共用投影和序列化，由绑定 Schema 与原 Input 重建，不落盘为匹配权威。
允许但未声明的额外字段也参与比较，不能忽略其存在或取值差异。
Request 幂等冲突检查仍比较完整原始 Request，不使用结构 Equals。
全域源 revision、完整集合封装和 fromRevision 补读不使用每 Task 权威快照或绑定事务。
旧版本明确拒绝，无隐式数据迁移或删除。
完整协议与历史/取消/资源边界见 [Task Engine](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-engine.md)。
