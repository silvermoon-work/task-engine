# SQLite 权威与 RunHistory 辅助归档：分阶段重构计划

本文件支持 [Implementation](Implementation.md)。按用户最新订正，保留 SQLite 作为业务权威，IPFS 只保存定稿的 RunHistory 辅助详情，不持续保存活动 Task/Run 状态。此前的 DAG 权威 head、全域事实搬迁及删除 SQLite 后重建方案撤回。风险见[架构评估](ArchitectureReview.md)。

## 实施原则

- SQLite 继续保证顺序、幂等、准入、消息与运行恢复；IPFS 归档结果不反向决定运行完成或过期。
- 先证明强引用编解码与可恢复归档，再切换公开接口；不同时维护两套权威业务存储。
- 记录和详情保留独立；允许记录仍在而详情无法取得，读取必须明确报告，不能返回成功形状的空历史。
- 未获完整构想验收前不实现、不迁移、不发布。本文是更新后的计划，不是已完成证据。
- 用户授权主 Agent 负责全部门限审批。每个 implementation iteration 使用独立 subagent 顺序执行，主 Agent 负责验收、集成和准确修订的门限记录；未完成前一轮验收不启动下一轮。
- 中间 iteration 不发 RC，不做发布后 Smoke。本 Idea 的 Deployment 简化为本地验收；全部 iteration 完成后统一进入 RC/Smoke 阶段，不把本地通过当成已发布验证。

## 阶段与实际依赖

| 阶段 | 前置 | 产物 | 退出门槛 | 对应契约 |
| --- | --- | --- | --- | --- |
| P0 准备实施门限 | 无 | 已确认归档行为、基线及顺序迭代安排 | 准确构想修订完成同步与主 Agent 验收 | 准备阶段 |
| P1 引用与访问基础 | P0 | ipfs-access、ipfs-payload、Store 结构化 codec | 规范向量、强闭包、file/directory DU 测试 | I-S01、I-AC01 |
| P2 SQLite 归档管理 | P1 | 稳定历史选取、归档/保留意图、代次与恢复 | 故障边界正确，业务状态只由 SQLite 决定 | I-S02、I-AC02 |
| P3 RunHistory 辅助存储 | P2 | 完整归档发布、详情获取、unpin 与缺失语义 | 数据库记录保留且详情缺失的场景可恢复可查询 | I-S02、I-AC02 |
| P4 全链路协议切换 | P1、P3 | 三通道 IpfsPayload 与 CID context，移除 Space | Builder/SDK/Engine/HTTP/CLI 全链路及原行为测试 | I-S03、I-AC03 |
| P5 按需文件树 | P1 | 独立 ipfs-tree | read/list/resolve 与依赖隔离证明 | I-S03、I-AC03 |
| P6 集成和交付候选 | P4、P5 | 冷恢复、归档故障、包体与预算证据 | 相关测试、构建及 pnpm check 通过 | I-AC01 至 I-AC03 |

执行顺序固定 P0 → P1 → P2 → P3 → P4 → P5 → P6。P5 的技术前置仍只有 P1，排在 P4 后是用户要求的串行调度，不人为增加代码依赖。

## P0: 确认基线并完成准确修订门限

- R-01/R-02 已由 SQLite 权威订正解决，保留政策和运行前事实在数据库中。
- R-03 已确认终止且历史事实稳定后归档；归档失败独立报告并重试，不阻止 SQLite 确认业务完成，不重跑 Run。
- R-04 已确认 Store 管理可见性：builtin 不公开，Kubo 由节点管理者定义；不在 Engine 设计另一套公开/私有机制。
- 将运行时 CID 资源读写与活动状态归档分开；若用户还希望禁止前者，则先重新讨论 context 能力，不能在实现中猜测。
- 由一个只读 preflight subagent 定向复现已知模块宿主测试基线，记录准确命令与影响；不为前期讨论不断重跑完整 suite，也不先实现未经门限的代码。
- 主 Agent 检查契约、ledger 与本地 Deployment 范围后同步到 primary，为准确修订 submitIdeal 并在用户委托下 acceptIdeal，随后才启动 P1。

## Subagent 交接与本地门限

每轮启动新的实现 subagent，只交付该轮目标、允许修改路径、共享接口约束和既有验收用例。subagent 不自行进入下一轮、不改门限事件、不发包，默认不自行 commit/push；主 Agent 统一处理集成。

每轮提交实际改动、接口变化、验证命令及结果、剩余风险；主 Agent 只复核需要关注的逻辑和证据，完成最小相关测试、必要构建与本地验收后，记录稳定提交再分派下一轮。遇到前置接口或设计阻塞回到主 Agent，不偷改其他 iteration 的范围。

本地测试失败不通过门限；已知基线问题先确定原因，必要的紧耦合修复单独明确，不能以旧失败豁免新迭代。主要接口切换保持整个仓库可构建，不能把半切换状态推为完成。

全部 P1 至 P6 及本地 Deployment 完成后才开始最终发布准备：枚举受影响包、确定对应 RC 版本与所有依赖字段的拓扑顺序、核对 main 精确提交 CI，再依仓库规则逐包推送授权 tag 触发 Actions。一个统一发布阶段不等于批量发布；不重复发布已存在版本，不移动 tag。

最终 Smoke 使用已发布精确版本在独立消费环境验证，而不是 workspace 链接或本地 tarball。具体发布清单和版本在该阶段生成并按发布规则核对，前期不预占版本或提前发布。

## P1: 基础工具包与强链接能力

- 建立 ipfs-access 的轻量只读/写入契约与文件/目录 DU；资源范围 raw/UnixFS，不为结构化归档增加伪文件节点。
- 建立 ipfs-payload 的 ContentRef、TypeBox 扩展、data/cidPaths 验证与 JSON/逻辑值/DAG-CBOR 往返，纯编解码不做 I/O。
- 扩展 ipfs-store 的结构化块和混合 codec 遍历，覆盖 prepare、pin、CAR 等实际路径，不只让 put 接受字节。
- 用固定字节/CID 向量覆盖普通字符串、同形对象、混排/嵌套 DU、可选字段、特殊键；路径集合校验、预算、未知 codec/哈希和缺失块必须失败。
- 新包遵循 workspace/catalog、构建脚本及独立 release mapping，不发布。

完成时必须证明 DAG 中是真链接，而非保存 CID 字符串却依赖 recursive pin 保护它。

## P2: SQLite 中的归档状态与可恢复意图

- 保留现有 SQLite 事实事务，新增归档管理字段/记录及保留策略，不建立第二个当前运行 head。
- 明确可定稿历史所需 outcome、exit、清理证明与消息结算；活动状态只留在数据库。
- 在数据库事务中取得归档源版本和保留代次；记录意图后执行 Store 操作，完成后条件更新。
- 归档工作只读 SQLite 已定稿内容，不重新运行 Worker。失败可报告、重试或等待恢复，是否影响完成确认按 P0 决定。
- pin 意图、外部 owner 和临时保护复用现有机制；业务权威数据库与 Store 协调数据库按实际需要划分，不强制另造一份可丢弃业务库。

测试必须覆盖数据库提交/进程退出、pin 已生效但回包失败、重复重试，以及释放保留与归档完成的竞争。迟到的归档任务不能复活已过期记录或重新授予详情可用状态。

## P3: 归档与详情缺失的完整纵向样例

- 从稳定 SQLite 历史生成 RunHistory → parameters/messages/Delivery → 强引用资源的完整 DAG，不建立 TaskHistory 或活动运行快照链。
- 归档成功记录准确 CID 和已观察的写入/保留结果；不能仅存 hash 或因根块存在就声明完整归档。
- 摘要/状态列表读 SQLite，按需获取详细历史时才访问 IPFS。未归档、未授权、不可达、块缺失及损坏有不同的明确错误。
- SQLite 按记录/详情策略发出释放保留意图；unpin 不等于物理删除，不推导记录已过期。共享根或外部 pin 仍可保护内容。
- 清理允许记录长期于详情存在；保留请求幂等保护，不因详情缺失重新接纳旧请求。
- 针对运行时资源只实现已确认的读取和临时存储保护，不归档活动 Task/Run 状态；归档前不能过早释放它仍需的依赖。

退出门槛：关闭运行形成完整归档后，释放本 owner 保留、在隔离 fixture 回收部分块，数据库仍正确返回完成/过期事实，详情明确不可得；恢复数据库不自动恢复已丢详情，也不重执行 Run。

## P4: 一次性替换公开协议

- P1 的独立 payload Schema profile 不是现有 Task 契约的替代验证器。P4 必须在 ipfs-payload 中提供复用严格快照/路径转换的受信编译契约桥接，继续使用 Task 的完整 Schema dialect 与校验器；保留现有 `$ref`、boolean schema、prefixItems、intersection 等非引用语义，不丢弃关键字或绕过业务验证。只拒绝真正有歧义的引用布局。
- 统一 parameters/message/result、父子调用和外部 HTTP/CLI 的 IpfsPayload，SDK 编解码真实引用，直接调用方传完整信封。
- 保留消息接收/接受/拒绝、请求 key/deadline、共享 Run、资格与退出/回收语义。
- 移除 input 旧别名、Worker Space/sid 和独立 output 文件树交换协议；Bundle/子任务目标使用 CID。
- 正式需要的引用资源验证不绕过；但不要求为了提交每个 SQLite 生命周期事件先存储和 pin 一个活动历史 DAG。
- 适配所有直接调用方后形成单一可构建候选，不部署半切换状态。
- 已有 Schema/API 版本不递增，采用显式新测试/部署数据目录，不自动读取不兼容旧布局、不删改历史数据库或制品。

## P5: 独立 ipfs-tree

- 基于 ipfs-access 只读子集封装 root CID + path 的 read/list/resolve，不恢复 Space 身份、挂载、保留或写入权限。
- 文件返回流，目录条目含 CID；验证路径、取消、预算和文件/目录类型错误。
- SDK/ipfs-payload 不依赖、不重新导出 ipfs-tree，也不被迫加载完整 Store。
- 两个最小 Task 构建样例验证：不 import 的产物没有 ipfs-tree 运行时模块，import 的样例确实可读/列举。记录大小差异，不凭 tree-shaking 声称隔离。

## P6: 整体证明与切换候选

- local 与专用隔离 Kubo 运行相同的完整/缺失闭包、pin 意图、不确定 RPC、共享 owner 及清理测试；禁止对共享 daemon 运行测试 GC。
- 复跑原有启动、准入、幂等、消息、资格、exit 与清理证据测试。归档故障不越过 P0 决定的业务确认边界。
- 以 100、1,000、10,000 条消息的受控样例测量最终归档块大小、深度、总字节、pin RPC 与内存；分段而非单个无限数组块，预算 limit/limit+1 有测试。
- 数据库备份恢复须保留运行状态和幂等；辅助详情可缺失时按事实报告，不用 IPFS 反向创建记录或推断是否过期。
- 经 Engine 导出历史须遵守现有 API 请求授权并验证闭包；数据本身的可见性由 Store 定义。验证 builtin 不公开分发，Kubo 适配不修改节点管理者的网络/网关策略，不声称 API 授权覆盖外部块访问。
- 运行最小相关测试后执行 pnpm check，实际失败不标成通过；更新使用说明、备份/详情清理操作和独立包发布映射。

## 中断与部署规则

SQLite 是必要备份，IPFS 是仍需保存详情的另一个备份范围；不能只复制归档块宣称恢复了执行系统。旧 Worker 排空后显式切换新候选，新数据一旦写入不可回退到旧数据库继续接纳而丢弃新事实。

归档和清理失败保留意图并报告，不自动重执行已完成 Run，不自动删除用户数据。每阶段失败停止后续轮次。主 Agent 代理验收仍需真实证据；中间 Deployment 为本地验证，最终 RC 与 Smoke 必须等待全部 iteration 完成。

## 已完成的准备证据

- 用户已明确由主 Agent 负责全部门限审批；最终归档行为与中间本地 Deployment 契约已同步。
- 准确 idealRevision `ce606efcd682040b81fdc074cecf18c3f6a0aaeb` 已在 primary 上 submit/accept，Idea 已进入 implementing。该验收仅覆盖构想，不预先接受 P1 至 P6。
- 只读 preflight 子 Agent 定向复现 Node 26.13.0 上已知模块宿主 fixture 的 invalid_payload 失败；未修改验证器或放宽断言。
- 已安装的受支持 Node 24.12.0 上，原样运行 self-entry 与 non-entry 拒绝两个测试，2/2 通过。后续迭代使用该 Node 的进程级 PATH，不更改设备全局版本或把 Node 26 错称为不受支持。

基线验证命令（仓库根为当前目录）：

```powershell
$env:TSX_DISABLE_CACHE = '1'
$node24 = 'C:\Users\Wei\AppData\Roaming\nvm\v24.12.0\node.exe'
Set-Location 'packages\task-engine'
& $node24 '..\..\node_modules\tsx\dist\cli.mjs' --test --test-concurrency=1 --test-name-pattern='^IPFS module (entry preserves Builder URLs, CJS APIs, cache and per-Run isolation|hook rejects non-entry addresses without disclosing credentials)$' 'test\bundle-contract-host.test.ts'
```

后续工作使用进程级 `$env:PATH = 'C:\Users\Wei\AppData\Roaming\nvm\v24.12.0;' + $env:PATH` 执行 pnpm，不以这两个基线测试代替各 iteration 的功能与完整验收。

## P1 本地验收证据

- P1 subagent 完成 ipfs-access 类型契约、ipfs-payload JSON/逻辑值/DAG 编解码与受限路径校验，以及 Store 的 mixed-codec prepare/retain/reconcile 和加法式 readContent/resolveContent。
- Node 24.12.0 下，subagent 报告定向套件 46 passed、1 skipped；真实 Kubo 测试仍为 opt-in，不把 mock 结果写成真实服务证据。
- 主 Agent 复核新增接口和 Store 改动，并执行 `pnpm exec turbo run lint typecheck test build --filter=@silvermoon-work/ipfs-access --filter=@silvermoon-work/ipfs-payload --filter=@silvermoon-work/ipfs-store --concurrency=1 --output-logs=errors-only`：12/12 tasks 通过。
- 主 Agent 执行 `pnpm check`，退出码 0；未修改此前 Node 26 的模块宿主 fixture 或放宽断言。无 RC/tag/发布。
- P1 仅承诺读取适配及 putContent 接口；受控流式 writer 由 P2 的暂存管理和 P4 的 context 集成实现。当前原有 Store.read 保留，原有节点类型改名 UnixfsNode，以区分共享 IpfsNode DU。
- P4 必须补齐上述完整 Task Schema 桥接，以及 Builder/CLI 的 CAR 遍历消费点，不能直接把 serialized Task Schema 传给 P1 的窄 profile。该限制明确纳入后续验收，不宣称完整 Task 协议已实现。

P1 基础轮次本地验收通过；本 Idea 的完整 I-AC 条目仍待 P2 至 P6 的端到端证据，不能提前 submitInner。

## P2 本地验收证据

- 新增可选 Store.runHistory 元数据接口，在 MemoryStore/SqliteStore 复用状态机：定稿源、归档/释放租约、根写前意图、失败重试、保留代次、读取观察与恢复均不含网络事务。
- 定稿要求 exit、消息结算与清理证明；SQLite 仍是业务权威。归档失败不改写完成，不重跑 Worker；释放确认之后迟到的 pin 结果重新触发有代次保护的清理，不复活归档。
- SQLite forgetting 与释放意图原子提交，tombstone 保留到后续协调处理；不迭代既有数据库/协议版本。普通诊断日志不属于冻结源，生命周期事实仍保留。
- 主 Agent 复核 SQLite/Memory 事务、冻结源和租约条件，并运行两处 run-history.test.ts：26/26 通过；pnpm typecheck:tests 与 pnpm check 均退出 0，使用既定进程级 Node 24.12.0。
- P3 必须实现服务调度、实际 DAG 写入/保留/详情读取和恢复；按 lease owner 区分暂存及清理，先持久记录候选 root 再进行保留 I/O。目前 runtime 自动归档未开启，不冒充 P3 已完成。

P2 本地验收通过，无 RC 或发布后 Smoke；I-S02/I-AC02 的完整端到端验收仍待 P3/P6。

## P3 本地验收证据

- Engine 在注入具备保留能力的 `archiveStore` 后启用归档服务：从定稿 `RunHistorySource` 生成 DAG-CBOR，`contentRoots` 与 outcome/output CID 为 tag-42 原生链接；普通 CID 字符串和同形对象保持字符串。写路径为 `${lease.owner}/archive` staging → `setArchiveRoot` → `retain`/`confirmRetained` → 闭包计量 → `completeArchive`。列表/状态读 SQLite，详情按需读 IPFS。
- `waitForIdle` 仍只等待业务退出与 `reclaimedAt`，不阻塞于归档。归档 I/O 在 tick 之外；失败进入 `failArchive`/`failRelease`，不写入 `engine.errors`，不改 stage/outcome，不重跑 Worker。`close` 中止并结算 in-flight 归档 I/O 后再释放 Store。
- 主 Agent 复核 DAG 编解码、lease owner 暂存/清理、write-ahead 根和详情缺失路径，并复跑未缓存套件（Node 24.12.0，`TSX_DISABLE_CACHE=1`）：`task-engine` 的 `run-history.test.ts` + `run-history-archive.test.ts` 18/18 通过；`task-engine-storage` 对应 23/23 通过。`pnpm exec turbo run lint typecheck test build --filter=@silvermoon-work/task-engine --filter=@silvermoon-work/task-engine-storage --filter=@silvermoon-work/task-protocol --concurrency=1 --output-logs=errors-only` 18/18 通过。
- 覆盖：完整归档与 CID 真链接、drain 不等待归档、I/O 失败后完成态保持、write-ahead 根在重启后不变、release 后隔离回收块并报告 missing、迟到 completeArchive 不能复活、共享 owner pin 不受 unpin 影响。证据来自本地 `IpfsStore` dataDir / Memory，不对共享 Kubo 做 GC。
- 本轮只复制归档根块与各 content root 的单块；更深 UnixFS 子块仍依赖归档 Store 中已有闭包，由 `prepare`/闭包校验拒绝不完整图。多块树形复制与公开协议切换属 P4/P5；隔离 Kubo、万级消息分段和 `pnpm check` 全仓属 P6。无 RC 或发布。

P3 本地验收通过；I-S02 的实现工作已完成。I-AC02 仍待 P6 的隔离 Kubo 与全仓证明，不能提前 submitInner。

## P4 本地验收证据

- 公开交换一次性切到 `IpfsPayload`（`data` + `cidPaths`）：`parametersSchema` / `parameters`、`message`、`result`。Worker `run(parameters, context)`；CLI `--parameters`；子任务 `bundle` 为 CID（可选 path 先解析）。删除 Task 面向 Space/sid/`context.output`。`context` 提供 `readContent` / `resolveContent` / `putContent`。Schema/API 仍为 V1，SQLite facts / user_version 仍为 5；旧 `input` / `{result,cid}` 布局明确拒绝，不迁移历史库。
- `ipfs-payload` 增加 `compileTrustedContract` / `inspectTaskSchema`，使用完整 Task Schema dialect（`$ref`、boolean schema、`prefixItems`、`allOf`），由 Engine 注入业务校验器。无判别的 `ContentRef | string` 拒绝。DAG-CBOR 在引用位存原生 CID；普通字符串与同形对象保持字符串。
- 主 Agent 复核公开类型、Space 导出清除、`waitForIdle` 仍不等待归档，并复跑未缓存套件（Node 24.12.0）：ipfs-payload `contract`+`payload` 17/17；task-sdk 4/4；task-engine composition/drain/archive/space-worker 42/42。subagent 的 12 包 turbo lint/typecheck/test/build 48/48。
- 内部编译契约仍保留 `InputContract.inputSchema` 字段名与部分错误文案；`run_content_access.sid` 存 CID 字符串以免升版。未引入 ipfs-tree。无 RC 或发布。

P4 本地验收通过。I-S01 / I-AC01 已有包级三通道与真链接证据。I-S03 / I-AC03 仍待 P5 按需树形包与 P6 全仓证明，不能提前 submitInner。

## P5 本地验收证据

- 新增 `@silvermoon-work/ipfs-tree`：`ReadonlyIpfsTree` 仅包装宿主 `ReadonlyIpfsAccess` 的 `read` / `list` / `resolve`（root CID + 相对 path）。不恢复 Space、挂载、保留或写入。目录列举复用 file/directory DU 的 entries 流。非法路径、文件/目录类型错误、不支持 codec、取消与预算失败均明确失败。已加入 `scripts/release-packages.js`，未发布。
- SDK 与 ipfs-payload 不依赖、不重导出 ipfs-tree。Builder 样例：未 import 的 worker.cjs 为 524B 且不含 ipfs-tree 运行时错误字符串；显式 import 后为 1877B（+1353B）并能实际 list/read。这是按需引入，不是 tree-shaking 声明。
- 主 Agent 复跑未缓存套件（Node 24.12.0）：ipfs-tree 6/6；ipfs-payload isolation 1/1；task-sdk runtime 2/2。无 RC 或发布。

P5 本地验收通过。I-S03 / I-AC03 / I-AC02 仍待 P6 的隔离 Kubo、万级消息预算与全仓 `pnpm check`，不能提前 submitInner。

## P6 本地验收证据

- RunHistory 消息按 `messagePageSize=256` 分段编码；limit/limit+1 与单块 `blockBytes` 精确预算有测试。受控样例（Node 24.12.0，`TSX_DISABLE_CACHE=1`）测量：100 条 1 页 / 3 块 / 31154B；1,000 条 4 页 / 6 块 / 302052B；10,000 条 40 页 / 42 块 / 3012889B。深度 1，单块不超过 Store 限额，每归档根 1 次 pin RPC。
- Kubo 缺失块映射为 `missing_block`；SQLite 备份恢复保留运行状态与幂等，辅助详情缺失时报告 `missing`/`not_archived`，不从 IPFS 重建业务记录。`GET /runs/:id/archive` 复用 history 授权并校验闭包；未授权 403。
- 主 Agent 执行 `pnpm check`（Node 24.12.0，`TSX_DISABLE_CACHE=1`）退出码 0；turbo lint/typecheck/test/build 56/56。隔离离线 Kubo（`KUBO_REAL_TEST=1`，独立 daemon，不对共享节点 GC）：MemoryStore 8/8、SqliteStore 8/8。HTTP leftover 字段提交类型与 P4 信封对齐。无 RC 或发布。`ipfs-tree` 已在 `scripts/release-packages.js`。

P6 本地验收通过。I-S03 / I-AC02 / I-AC03 已有可核对证据。最终 RC/Smoke 仍待 Implementation 验收后的 Deployment，不能提前发布。
