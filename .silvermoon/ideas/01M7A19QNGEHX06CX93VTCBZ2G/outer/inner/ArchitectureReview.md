# 强引用 DAG 与可重建索引：架构评估

2026-11-14。本文件支持 [Implementation](Implementation.md)，评估把 Task 核心事实迁入 IPFS DAG 的需求变更，不是已完成实现的证明，也不是独立契约。实施顺序见[分阶段计划](RefactorPlan.md)，需用户讨论的取舍见[待决定项](ideal/OpenQuestions.md)。

## 结论与决定状态

方向可行，但已经不只是引用编解码重构，而是一次事实存储与提交协议重构。不能沿用此前“仅余小细节、可以直接实施”的结论。

已确认的新要求：

- IpfsPayload 中声明的 CID 是强依赖，存储时成为真正的 IPLD 链接；正式承认的载荷须具备完整、可验证的依赖闭包。
- 按用户随后纠正的术语，以 RunHistory 为执行历史的记录和保留单位，不建立每个 Task 独占的 TaskHistory。请求、资格关联及恢复必需事实仍有耐久来源；SQLite 负责查询投影，不能是核心事实的唯一副本。
- pin 以逻辑记录根保护可达闭包，不由 Engine 枚举每个业务资源分别保留。
- 既有命名、三个通道、判别 union、按需 ipfs-tree、文件/目录 DU、资源 raw/UnixFS 范围、现有 Schema/API 版本不升级等要求继续有效。

用户确认 RunHistory 后，共享 Run 的模型歧义已经消除。2026-11-14 用户进一步确认 R-01 方案 A：Store 使用耐久 SQLite 协调元数据，查询 SQLite 提供可重建索引。R-02 至 R-04 仍待讨论；D-01 至 D-05 是补齐的实施约束。未标记为已确认的推荐项不等于用户已接受。

## 当前实现中的依据

路径相对于仓库根；行号指本次规划所读的实现，后续重构后应以保留的不变量而不是旧行号为准。

| 依据 | 当前机制 | 对重构的约束 |
| --- | --- | --- |
| `packages/task-engine-storage/src/index.ts:304`、`:453` | SQLite 保存事件、checkpoint、请求索引；append 在一个事务里比较 watermark 并提交 | 不能只把 checkpoint 换为 CID，丢掉整个批次的提交原子性 |
| `packages/task-protocol/src/types.ts:282`、`packages/task-engine/src/engine.ts:690` | Store.append/read 为同步接口，Engine 提交后立即推进状态 | IPFS pin/RPC 是异步且结果可能不确定，需要贯穿调用链的串行提交边界 |
| `packages/task-protocol/src/projection.ts:260`、`:291`、`packages/task-engine/src/engine.ts:1371` | Task 从事件及资格观测匹配 Run；多个 Task 可以服务于同一 Run | Task 并非 Run 的独占容器，不能改成每个 Task 固定创建一棵私有执行树 |
| `packages/task-protocol/src/projection.ts:301` | 对外 snapshot 包含查询时刻 timestamp，revision 来自全域 watermark | 不能把每次查询的 DTO 原样哈希为新的权威 Task 版本 |
| `packages/task-engine/src/engine.ts:1041`、`:1386`、`packages/task-engine-storage/test/startup.test.ts:20` | 消息先持久记录再投递；启动和 dispatch-generation 先原子提交再执行 | 重启不能因为 CID 存在而重新执行不确定副作用 |
| `packages/task-engine/src/retained-content.ts:8`、`packages/task-engine/src/bundle-engine.ts:244` | 保留仍由 Facts 中的 Task、历史 Run 和运行资源根计算 | 只有“当前 Task 的 pin”会漏掉仍需保留的历史 Run、未完成申请和幂等凭据 |
| `packages/ipfs-store/src/retention.ts:34`、`:162`、`:295` | Store 自己的 retention.sqlite 保存 owners、stages、intents 与 pin 阶段；完整 mark 后才 sweep | SQLite 查询库与 Store 协调元数据不是同一责任；pin 操作不能替代权威提交 |
| `packages/ipfs-store/test/kubo.test.ts:196`、`:227` | 多 owner、外部 pin、RPC 已生效但回包失败均有保护测试 | 不能通过根 pin 简化删除这些保障 |
| `packages/ipfs-store/src/dag.ts:156`、`packages/ipfs-store/src/store.ts:285` | 遍历目前识别 DAG-PB/raw，资源读取为 UnixFS 模型 | 结构化事实节点需要新增 codec 遍历，而不是伪装成 UnixFS 文件 |
| `packages/task-engine/src/engine.ts:1529` | 清理在无运行分配且资源回收可确认时发生，保留时窗内的记录不能删 | 新 DAG 的历史可达性必须与该清理语义一致 |

这些是对现有行为的直接检查，不是运行新架构测试的结果。

## R-01: pin 不等于提交，也不能决定哪个根是当前版本

### 失败例子

先有已提交根 A；写入并 pin B 后，进程在更新“当前根”前退出。重启发现 A、B 都 pinned。仅看 pin 集合、CID 或节点时间戳，无法知道 B 是正式提交还是未完成候选；另一个写入者还可能基于 A 产生 C。CID 的排序不代表提交顺序。

如果当前根、提交代次或幂等记录只在查询 SQLite 中，删除 SQLite 就会丢失权威信息，不能声称它是可重建索引。

### 已确认方案 A 的实施约束

- 保留现有“一 data domain 单活动 Engine”的约束，不在本次引入多主或共识协议。
- 在 Store 层保留小型、耐久的 head/commit registry：domain 身份、当前根、sequence、expected-head、pending 意图、pin owner 与 commitId。核心记录仍在 DAG，registry 只负责确定哪次提交已生效。
- 以当前 head 的条件更新作为唯一线性化点；先完整存储并保护候选根，再提交 head，再追赶索引，最后清理旧根/暂存。
- 过期 writer 必须被排除；仅在调用时检查 owner 名称而不持有有效排他权不足以覆盖长时间异步 RPC。

### 已确认的存储与备份边界

用户同意方案 A，保留 SQLite 作为高效查询方案，同时允许 Store 用独立 SQLite 耐久保存少量提交与保留协调信息。查询 SQLite 是可重建投影；Store 的 registry/retention 数据库不是可随意丢弃的缓存，属于必要备份。

RunHistory、消息、结果及必要恢复事实的完整内容仍在 DAG；协调库只记录数据域身份、当前提交根、序号、提交意图和保留关系等控制信息，不把业务内容搬回其中。提交成功而索引更新失败时，修复投影，不重新执行业务。

初期按独立数据库隔离两种责任，具体路径和表结构在 P2 细化。不实现“所有 SQLite 都是缓存”的方案 B，也不自建文件日志替代已选择的 SQLite 协调机制。丢失权威锚点时只做显式修复，不从零散块或 pin 的“最新时间”猜测并恢复执行。

## R-02: RunHistory 之外的恢复事实与历史回收边界

### 已由用户纠正的模型

记录单位是 RunHistory，不是 TaskHistory。Task A、B 匹配同一 Run 时，共用同一执行历史，不复制结果或按 Task 重建执行树。这一项已确定，无需再次选择。

### 失败例子

Task A、B 匹配同一 Run。清理 A 不能回收 B 仍需的执行与交付。反过来，一个历史 Run 暂时没有当前 Task，但仍在保留时窗内，也不能被当作孤儿回收。

资格观测、准入时间下界、拒绝/准备中的请求、幂等凭据并不都隶属一个已创建的 Task。只恢复 Task 的当前状态不能恢复这些事实，可能重复接纳已完成请求或改变匹配结果。

一个 RunHistory 的内部历史强链在其保留期内应继续可达，这是历史的用途，不是漏洞。但如果数据域的所有新根永久链接旧域根，已到期 RunHistory 仍会通过旧域根可达，无法按期回收；旧根的 unpin 本身不能改变该可达性。

### 建议

以不可变 RunHistory 版本聚合该 Run 的参数、消息、执行事实和交付记录。稳定 taskId/runId 与版本 CID 分开，Task 的匹配和查询结果从请求/资格事实及 RunHistory 投影，不维护另一份权威 TaskHistory。消息仍保存来源 Task、runId、generation 等路由证据；元数据业务身份字符串不伪装成 ContentRef。

示意关系：

```text
RunHistory CID
  ├─ Run 定义/parameters/Bundle
  ├─ 消息与执行事件段
  ├─ outcome/exit/清理证明
  └─ Delivery → result Payload → 强依赖资源
```

子 RunHistory 不反向链接尚未生成的父 RunHistory 版本；以稳定父 runId 或已有启动定义建立关系，必要时父历史再引用已生成的子交付根。

以一个数据域 manifest 或等价的“受管理根集合”覆盖：

```text
DataDomain manifest
  ├─ 活跃及仍需保留的 RunHistory 根集合
  ├─ 明确独立保留的 Delivery 根（如有）
  ├─ Run 产生前的 Request / Admission / 幂等事实
  └─ 跨 Run/Task 资格顺序及有界恢复 checkpoint
```

这不是把全部内容塞进一个大块，也不是要求 SDK 取得该根。逻辑根 pin 保护闭包，底层仍保留多 owner 协调。各业务根可共享同一子图，不复制资源。

建议在每个 RunHistory 的保留期内保留其必要历史，已关闭且满足保留策略后按 Run 单位释放，而不是悄悄删掉该 Run 的中间执行事实。跨 Run 的全域提交日志可通过 checkpoint 有界保留，不能永久强链旧域根从而间接保住全部过期 Run。

### 必须讨论的选择

RunHistory 记录单位已确定。剩余需确认：是否允许独立持久保存尚无 Run 的申请、全域准入/幂等事实，并由数据域 registry/manifest 管理 RunHistory 根集合；关闭的 RunHistory 是否按现有保留策略整份回收，而非默认永久保留。

若要求完整永久审计，需要明确接受其存储、隐私和无法回收的成本，并另行设计导出/归档根。

## R-03: 强闭包要求与未完成、被拒绝请求之间存在准入边界

### 失败例子

调用方传入一个尚未取得的 CID。Engine 要先持久保存 preparing 请求，才能在重启后继续准备。但若将这个参数立即编码为正式强链接 Payload，再 pin 包含它的请求根，pin 会因依赖缺失失败，连“正在取得依赖”这件事也无法记录。

结果返回缺失依赖时同样如此：不能让失败记录再次强链接那个不完整结果，否则失败本身也无法落盘。

### 建议

- 严格区分未验证的 AdmissionAttempt 与已验证的 IpfsPayload。前者只记录受大小约束的原始请求字节/描述符、请求身份和失败原因，不宣称这些字节中的 CID 字符串已成为可执行强引用。
- 取得并校验完整闭包后，才能产生正式 parameters/message/result 节点，并承认接纳、消息投递或结果发布成功。
- 未完成输入可用于幂等重试与恢复，但不能进入 Worker。不可执行的数据草稿不是给已接纳 Payload 偷加弱引用模式。
- 失败记录仅引用已有完整证据；缺失的目标可以作为错误文本中的 CID 字符串，不当成 ContentRef 链接。
- 依赖取得只使用宿主授权的来源、预算和时限，不因 CID 存在而绕过权限或无限联网；强引用要求完整，不等于允许任意自动获取。

### 必须讨论的选择

是否接受该“原始申请草稿/正式强 Payload”的分层，以保持当前 durable preparing 行为。替代方案是在完整闭包具备前不持久接纳、也不提供可恢复 preparing；这会改变当前用户可观察的提交语义，不能静默采用。

Worker 已产生外部副作用但结果依赖验证失败时，不自动重跑；维持失败/不确定与清理证明机制。

## R-04: 把所有核心事实存入 IPFS 会扩大数据暴露边界

### 失败例子

RunHistory 根可能可达参数、调用方、消息及执行证据，也可能被多个 Task 共享。Engine 的 HTTP 授权检查不会自动覆盖另一个可直接读取块的网关或 Kubo 服务。CID 是内容地址，不是访问凭据；recursive pin 也不是加密或 ACL。

把已可分享的 Bundle 存入同一个系统，与把所有私有执行事实放入可被网络取得的存储，不是同一个风险级别。IPFS 本身不意味着必然公开，但也不能从“Engine 有 scope”推断整个 DAG 私有。

### 建议与必须讨论的选择

推荐本次默认面向私有、受控 Store：不自动公开、广告或通过公共网关服务 RunHistory 核心根；公共资源/交付导出有独立授权，不能把数据域根交给 Worker 或普通调用方。

宿主凭据、签名密钥、游标密钥不写入业务 DAG；它们由部署/宿主管理。有效 CID/合法 Schema 不能授权读取另一个租户的块，私有依赖取得须保留访问范围。

需要确认目标部署是否能提供该私有存储边界。若要求在公共或不可信网络分发完整核心 DAG，则加密、密钥生命周期、授权导出与去重泄漏需另立设计，不能在本次作为小细节顺带实现。

## D-01: 分开交换表示、逻辑值和存储节点

建议结构化记录统一采用 DAG-CBOR，文件资源继续 raw/UnixFS；这是对新增存储要求的实施选型，不把 DAG-CBOR 加入面向文件树的 DU。

```text
IpfsPayload JSON (data + cidPaths)
  ↔ 通过 Schema 与路径验证的逻辑值（真实 CID 类型）
  ↔ 规范 DAG-CBOR 字节及 payloadCID
```

- ipfs-payload 负责纯转换/编码，不进行下载或 pin；ipfs-store 负责块验证、codec 感知遍历及保留；Engine 负责准入与提交。
- 公共 IpfsAccess.read 的 file/directory DU 继续处理资源。宿主结构化节点走明确的 DAG 编解码/块接口，不把结构化节点的原始 CBOR 字节冒充用户文件。
- 扩展全部真实路径：本地 Store、Kubo、CAR 导入导出、prepare/retain/reconcile，不能仅让 put 接受新 codec。
- DAG-CBOR CID 使用真正链接编码，不能保留成“看似 CID 的普通字符串”后声称 recursive pin 会保留它。
- 协议块布局、CID 规范化、允许 hash/codec、数字和路径规范化在 P1 形成固定向量；同一规范输入产生相同字节/CID。不同规则表达式不自动承诺语义相等时 CID 也相等，幂等比较使用明确的规范逻辑意图。
- JSON 的非法原型、getter、循环值等继续拒绝，不调用用户 toJSON；有限数值、Unicode、特殊对象键及 CID 表示要有往返向量，不静默舍入或转换普通业务对象。

依据：[IPLD DAG-CBOR 规范](https://ipld.io/specs/codecs/dag-cbor/spec/)明确 CID tag 42、字符串 map key 与规范编码规则。它提供内容身份，不提供事务、权限或副作用的 exactly-once 保证。

## D-02: cidPaths 是受约束的定位规则，不是可执行查询脚本

- 构建器只生成属性名、固定下标、通配符和可表达的字面量 discriminator 条件；不支持任意 JS、递归下降、用户函数或无限复杂过滤。
- JSONPath 先解析为受限 AST，严格转义属性名；按实际分支求具体引用位置，复杂组合回退到正确的具体位置，不能为了压缩扩大集合。
- 绑定契约时，校验数据结构与引用位置集合相等，既不能漏标，也不能多标。允许可选字段/空数组的零匹配，但不能把 required 缺失掩盖成正常空匹配。
- 限制表达式长度、数量、求值节点数、深度和结果集合；越限明确失败，不截断后成功。
- 保存为 DAG 后，真实链接是存储引用的依据；若节点布局保留 cidPaths，必须与真实链接集合一致。从 DAG 导出时重新生成或校验路径，不信任另一个不一致的标注副本。

## D-03: 异步持久化不能破坏事实顺序和副作用边界

当前同步 commit 必须改为可等待的串行事务队列，不用后台 fire-and-forget pin 伪装提交成功，也不把 Kubo RPC 塞进同步 API 阻塞事件循环。

每个 data domain 的批次保持全序；接纳、启动/派发、消息收到/确认、outcome、exit、资源清理与幂等记录保留原有不变量。任务执行、消息投递和用户成功响应必须等待相应 durable commit，而索引更新失败不能让已提交业务再执行一次。

候选根已经 pin、head 未提交：作为未生效候选保留/回收，不执行副作用。head 已提交、响应丢失或索引失败：按 commitId/幂等身份恢复既有结果，不从旧索引重新接纳。持有旧 head 的查询可继续读其完整视图，新查询不能把旧索引冒充最新提交。

同一 Run 的结果、exit 与清理证明是不同事实，不因取得一个“完成节点 CID”就合并或删除恢复证据。

## D-04: DAG 层级、体积及 pin 代价必须可测

- 不把无限消息数组、全部 Run 或完整历史编码为单个块。使用有界页/段和可替换的根集合，保留期内 RunHistory 的必要历史不断链，全域提交历史按明确 checkpoint 边界回收。
- 新事件写入的字节/块应局限于变化记录和索引页路径，不每次重写整个数据域快照。不可变快照不包含查询时间 timestamp。
- 当前 Store 有块大小、总字节、块数和 DAG 深度预算；业务载荷预算与全域索引/提交遍历预算需区分，不能沿用单次文件读取限额去限制所有 Task 总和。
- 验证及 pin 新全域根可能仍有遍历成本；不要承诺 Kubo recursive pin 为 O(1)。P2/P3 测量新块数、旧块读取次数、遍历深度、RPC 数和延迟，并在切换前固定支持上限。
- 缓存仅优化已验证且仍有保留证明的块，不能用旧“已存在”标记掩盖实际删除或损坏。强闭包验证失败时禁止 sweep。

## D-05: 版本、日志、恢复与部署边界

- 按用户要求，不因 breaking change 迭代现有 Schema/API version，包括既有 V1。新旧布局使用显式数据目录/存储域隔离，不靠“同为 V1”尝试自动兼容。
- 不改写、删除旧数据库或历史 Bundle；生产切换前排空旧 Worker，新构建 Bundle 只使用新接口。新域开始接纳后不能切回陈旧的旧数据库继续写。
- DAG 中必须有重建索引和恢复执行所需的事实；SQLite 可保存其投影副本，但失去副本不能改变事实或创建新业务身份。
- 诊断日志不默认为永久审计核心。生命周期证据必须进 RunHistory；普通日志沿用既有有界、可报告不可用的语义。若要求独立过期，日志段不得被长期 RunHistory 根强链接后再声称可以单独回收。
- 索引重建不是执行重放。清理证明、幂等窗口、观测顺序、共享 Run 匹配必须恢复，但已派发的不确定 Worker 不自动重跑。
- pin 保证受管理 Store 的本地保留，不自动意味着备份、跨机副本或完整导出。完整 CAR 的闭包与私有数据授权分别验证。

## 最小提交与故障矩阵

registry 使用已确认的耐久 SQLite；具体根集合等待 R-02 确认。以下是必须验证的提交/恢复边界。

| 边界 | 故障后必须成立 |
| --- | --- |
| 收集依赖/写入块中 | 旧 head 不变；半成品只有可恢复 staging 保护，不可见为成功 |
| 闭包验证失败 | 新提交不生效；失败/准备状态可按 R-03 落盘；不释放旧根 |
| pin 已生效、RPC 响应丢失 | 查证并幂等恢复意图，不擅自覆盖外部 pin 或宣布失败已回滚 |
| 新根已 pin、head CAS 前 | 不投递 Worker/消息；候选不被当作当前事实 |
| head CAS 成功、索引失败 | 业务已提交；索引追赶/重建，不重新产生 Task/Run/副作用 |
| 成功响应丢失 | 相同 requestId/messageId/commitId 返回同一既有事实 |
| 旧根清理中崩溃 | 允许可回收垃圾暂留，不允许丢失当前闭包；多 owner/外部 pin 不受损 |
| 查询 SQLite 丢失 | 从约定备份范围内的 registry 与完整 DAG 重建；无自动执行 |
| 权威根、协调记录或必需块丢失 | 明确停机/受限修复，不从不完整内容构造成功视图 |

## 开始实施前的门槛

R-01 已确认方案 A，R-02 至 R-04 仍需要明确选择。确认后更新分阶段计划，完成文档同步及准确 idealRevision 的构想验收。当前仅完成评估与计划，不执行数据迁移、不创建包、不发布，也不将已确认方案冒充已实现或已修复。

## 本次文档验证与现有基线

- 已核对 idea 内 9 份 Markdown 的本地链接/锚点，以及实施和部署契约的 10 个未勾选 ledger 条目；标题与稳定 ID 一致。
- 文档格式及 Silvermoon worktree/staged 验证通过；这些检查不证明新架构已经实现。
- 执行 pnpm check，现有 `packages/task-engine/test/bundle-contract-host.test.ts:81` 的模块宿主测试失败，实际得到 invalid_payload 而非 completed；与本会话此前未修改运行时代码时的失败一致。本次只有文档变更，没有修复或绕过该问题，也不宣称完整仓库检查通过。
- 后续阶段须记录并解决其范围内的实际失败，不能把当前非全绿基线当成降低新实现验收标准的理由。
