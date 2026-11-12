# 可选 Kubo 后端：准备阶段设计讨论

本文服务于同世界 [Idea](./Idea.md)，记录影响可行性和验收含义的约束、用户已确认的行为及仍需验证的风险，不是详细实施计划。Implementation / Deployment 仅为可调整的下游初版；行为确认不等于生命周期验收。

## 基线与关联

2026-11-12 已核对合入 primary 的重构提交 `61b5661`（`refactor(ipfs): inject one content store into Builder and Engine`）；本次文档基线为 `b07a2b4eac0452ec69519bb80a1e5fcdf2f7f654`。Store 重构已完成合入，不再等待另一 worktree 的未提交代码；合入不等于已发布或已验证 Kubo。相邻 session 的后续发布改动不属于本 Idea，不复制或提交。

- [store.ts](../../../../../../packages/ipfs-store/src/store.ts)：构造 `SharedContent(dataDir, source)`，source 可为 Gateway；`put` 写当前 backend。`fromClient` 借用只读 `IpfsClient.block.get`，其 `put` 不会转发给注入客户端。当前尚无 Kubo 后端或 backend 判别字段。
- [storage.ts](../../../../../../packages/ipfs-store/src/storage.ts)：SharedContent 是自有磁盘块存储，校验读写，以临时完整文件和硬链接原子发布，并缓存 source 返回的块；当前无自动磁盘 GC。
- [dag.ts](../../../../../../packages/ipfs-store/src/dag.ts) 与 store.ts：`limits.bytes` / `retainedBytes` 为进程内读取保留预算，不是磁盘配额。单块、唯一块数与深度限制已有独立含义。
- [node.ts](../../../../../../packages/ipfs-store/src/node.ts)：宿主显式调用配置 helper；公共配置只有 `dataDir` / `gateway`，缺省使用共享内容目录，不因 import 读取配置。
- Builder 使用注入的 `content`；Engine 使用 `ipfsStore` 并借用 reader scope。已有 [跨调用者测试](../../../../../../packages/task-engine/test/ipfs-store.test.ts) 覆盖同一对象供 Builder 和两个 Engine 使用，以及 Engine 不关闭宿主对象。这里仅引用现有测试定义，不宣称本次重新执行。
- [managed.ts](../../../../../../packages/task-engine-cli/src/managed.ts) 仍无条件读取 `shared.configuration.dataDir`，做数据库目录比较并写入实例元数据。[data.ts](../../../../../../packages/task-engine-cli/src/data.ts) 的 DiskContent 在普通 Store 分支使用 `source.scope()`；但 managed 实际提供 retained-block 回调，会走 `fromClient(..., directory)`，再次启用 SharedContent。只修改 Store 构造函数不足以消除该调用链的自有块副本。

关联但不重复：现有 [任务依赖 Idea 的 Store 抽象要求](../../../../01M76NH3WE2K9B03HDFT2XTEFV/outer/inner/Implementation.md) 定义统一注入对象；[IPFS fetch Idea](../../../../01M76NXWH50ZXJBAN92MEH2ZAQ/outer/inner/ideal/Idea.md) 关注内容访问。本 Idea 单独讨论存储后端与持久保留，不扩展任务调度、DAG graft 或公开 Gateway 产品能力。

## 已确认的目标边界

- 默认仍为 local。Kubo 是直接块存储，不是 SharedContent 的 Gateway source；Kubo 路径不得创建或填充自有 `blocks` 目录、临时 CAR 磁盘副本或其他等价块缓存。
- Builder / Engine 面向同一 Store 能力，不按后端复制 UnixFS 解析或强制启动 Kubo；允许校验及流控所需的有界内存缓冲。
- local 的磁盘容量与淘汰策略只属于 local；当前并无此磁盘配额或自动 GC，不在本 Idea 顺带实现。Kubo 的磁盘管理与 GC 由 daemon 负责。
- 两种后端都必须保留 CID 校验、单块大小、读取累计字节预算、唯一块数、DAG 深度和进程内块保留预算。不能把读取预算改名为磁盘限额，也不能因 Kubo 已校验而移除应用边界。
- Store 提供统一的 `pin` / `unpin` 能力；为 Engine 持久化保留的所有 Task / Run 所引用的 bundle 与 IPFS output 根设置保留提示。prune 后按剩余引用标记清除，而不是逐条删除任务时直接 unpin。用户已明确 pin 不是对外部清理的绝对保护：Kubo 的 pin 可被其他调用方移除，local 的 dataDir 也可能被人工清空。

## 配置契约候选

以 `backend: "local" | "kubo"` 为判别字段，公共 `limits` 与后端专属字段分离。基于已合入 Store 命名的候选如下；保留 API 与所有权协调的具体类型在实施时收口：

```ts
type StoreConfiguration =
  | {
      backend: "local";
      dataDir: string;
      gateway?: string | readonly string[];
      limits?: Partial<ContentLimits>;
    }
  | {
      backend: "kubo";
      apiUrl: string;
      limits?: Partial<ContentLimits>;
    };
```

这不是最终完整 schema：超时与所有权协调配置仍需实施细化，但不新增 Engine 控制 Kubo 联网的开关。Kubo 分支拒绝 `dataDir` / `gateway` 及其他 local 专属字段；local 分支拒绝 Kubo RPC 字段。运行时 JSON 同样严格校验未知字段、类型、判别值、URL、正整数和跨字段组合，不能只依赖 TypeScript。

宿主读取配置并显式注入；库 import 不读用户文件。建议在旧配置及旧构造调用的兼容入口把缺少 backend 的既有 local 形状归一化，再进入严格 union 校验。显式新 union 必须有判别字段；不要用宽松合并让跨后端字段泄漏，也不要猜测 Kubo。已合入的 `new IpfsStore({ dataDir, gateway?, limits? })` 调用应保持行为兼容，不以“尚在 RC”为由顺带移除；具体兼容入口的类型组织属于实施细节，不增加待决的破坏性迁移。

兼容核对范围：

- 公共配置 helper 保留原路径、环境变量、local 默认目录和相对路径基准；后端切换时跨分支 override 应明确拒绝或显式替换整分支，不能隐式继承旧 local 字段。
- Builder CLI 现有 `--content-gateway` / `--content-data-dir` 和 Engine 的 `server.ipfsGateway` / `server.contentDataDir` 继续映射 local；与 Kubo 选择冲突时显式报错。此处不预定新增命令或 flag。
- `server.dataDir` 仍为 Engine 数据库路径，不是 Kubo repo。managed 实例元数据不得要求 Kubo 的 `configuration.dataDir`，data 层不得把已注入 Kubo Store 再包装为 SharedContent。
- `fromClient` 的只读适配语义不变；不能把它当成完整可写 Kubo 后端。统一对象、scope、CAR 调用点与所有权须同时验证。

## 原始块 RPC 与完整性

候选以 Kubo 管理 RPC 的 `block/get` / `block/put` 读取和写入已有块；不重新 `add` 文件，不改变分块、编码或 DAG。写前验证输入 CID 与字节，按 CID 的 codec / multihash 选择受支持参数，并核对响应 CID 的内容身份；RPC 版本、参数支持和 CID 表示兼容性需真实 daemon 证明，不能默认所有 codec 都可写。

保留我们控制的 UnixFS 解析和完整 DAG 遍历。RPC 响应体应边读边限额并取消超大响应，不能先无限缓冲再检查；错误响应体也须有界。读取累计预算和保留预算须分别核对其现有计账范围，至少不得弱化已有边界。

管理 RPC 通常是 `http://127.0.0.1:5001`，不是 Gateway 的 8080。用户已确认允许显式配置受信远程 RPC；认证、传输和访问保护由用户部署负责。Engine 不自动发现、启动或公开 RPC；“允许远程”不等于允许无保护地暴露管理接口，日志不得泄露凭据。

## 持久保留与标记清除：已确认的行为

原始块写入成功只说明块已进入 daemon，不能据此宣称完整 DAG 已 pin。单块 pin 与根 DAG 递归 pin 不同；未受保留保护的块可能被 Kubo GC 回收，内存 reader scope 也不是 pin 记录。pin 确认只代表本次操作成功，不是以后永不缺块的承诺。

用户已明确 Store 应提供 `pin` / `unpin`，Engine 对持久化中保留的 Task / Run 的 bundle 和 IPFS output 负责调用和协调。`put` 仅写块；只读 `prepare` 不暗中 pin。根 pin 覆盖完整可达 DAG，校验和递归 pin 确认后才能报告本次 pin 成功；local 分支也须具有可观察的保留标记和释放语义，不能用静默空实现冒充 pin/unpin，但不因此新增自动磁盘 GC。

标记的根集来自所有仍被 Engine 持久化保留的 Task / Run，不仅是当前运行或最近一次成功记录：包含历史保留记录、子任务和 Run 的 bundle 根及存在的 output CID；纯 JSON result 没有 CID 时不虚构 IPFS 根。同一 CID 及其 DAG 子图可由多个记录共享；在本系统可见的协调范围内，不能因一条记录被 prune 就主动清除其他记录仍需的提示。

prune 提交删除之后，依据剩余持久化引用完整标记可达内容。清除只对当前可见名称属于本系统、在协调根集中已不再被引用的 pin 执行 unpin，不调用全局 GC 或直接删共享块。unpin 只是移除保留提示，物理回收何时发生仍由 Kubo 管理，不能把 unpin 数量当成释放磁盘字节数。

### 跨 Engine 标记与外部干预边界

针对原生 pin 缺少所有者租约的实测反例，用户进一步明确：用 pin name 标记 `@silvermoon-work/task-engine` 的来源即可；Engine pin 是优化 hint，不保证绝对 pin 住。此项修订取代此前要求“对任何未参与协调的同 CID 外部保留都提供绝对隔离”的解释，不再要求专用 repo 或强制所有外部写入经过协调服务。

- 本系统 pin 使用可识别的 `@silvermoon-work/task-engine` 名称命名空间，具体的 Engine 身份和引用标记编码属于实施细节；名称不是鉴权、租约、独占所有权或原子条件删除。
- 对参与本系统协调的 Engine，保留稳定身份和可恢复的引用依据；不能只扫当前任务而忽略其他已知 Engine 或保留 Run。标记或协调失败时跳过清除并显式报告未完成，避免本系统自身可预防的引用丢失。
- 不主动清除当前名称为空、属于其他应用或无法识别的 pin，不为已有外部 pin 强行改名以占有它。外部调用方可覆盖同 CID 的名称或在检查与 unpin 之间修改 pin，Engine 不能检测所有此类干预，也不保证保留外部对同 CID 的独立意图。
- 对本系统参与者协调标记和引用更新，避免已知并发新增引用被旧快照清除；不把此内部协调宣称为对未参与者的全局线性一致性。
- 人工删除 local 内容或 Kubo pin／块后，重新读取仍须校验内容；不能因为数据库里有根引用或以前 pin 成功就返回假内容。可按显式来源重新获取，获取不到或 RPC 不可达时让依赖请求报错，不启动 Kubo、不静默切换 local 或其他 Gateway。

### partial DAG 与恢复

写块、pin、Engine 数据库提交和 unpin 不是跨系统原子事务。发布持久化引用时须安排并确认相应 pin 提示；pin RPC 失败不能报告 pin 成功，记录已写但 pin 未确认的部分成功应显式报告并可恢复。pin 是 best effort 不等于吞掉当前已知的 RPC 或校验错误。清除以已提交的剩余引用为依据，失败或中断保留可重试的清理责任。

partial DAG 或中断导入显式标为未完成；重试按 CID 补块，但不能假定先前块仍存在。处理导入期间的正常 GC 竞态，但不承诺抵御任意外部删除。超时或取消可能发生在 daemon 已完成写入、pin 或 unpin 之后，应核对真实状态并恢复，不盲目撤销其他可见名称的 pin。标记、协调或 unpin 失败不能返回“全部清理完成”；若元数据 prune 已提交，应明确报告元数据已删、提示清理未完成，不能声称已回滚全部操作。

## 联网、请求与生命周期：已确认的职责

- Kubo 的联网、寻块和离线模式由用户启动 daemon 时配置；Engine 不启动、停止或重配 Kubo，不另设强制离线／允许联网策略。`block/get` 是否能获取缺块由 daemon 决定，本机 RPC 地址不构成离线证明。
- 区分 daemon 以离线网络模式运行但 RPC 可达，与 daemon 进程停止、RPC 不可达。前者仍可服务已有内容，缺失内容按 daemon 结果报错；后者使依赖 IPFS RPC 的请求明确失败。已有经验证内容是否足以完成某请求由实际依赖决定，不因一次断连让无 IPFS 依赖的数据库查询全部失败。
- 既有 Gateway hints / allowGateway 不得把 Kubo 请求静默转交另一网络来源或重新引入 local 副本；Kubo 后端的内容获取走显式 RPC，local 的既有 Gateway 行为保持不变。
- 请求需要有界超时、调用方取消和 Store lifetime 取消；写入、读流、pin 等待均适用。保留缺块、校验失败、容量超限、不可达、超时和取消的可区分语义；无静默 local fallback。重试只适用于已定义的幂等动作，不能用重试掩盖副作用状态不明。
- Store 借用外部 daemon；`close` 仅取消自身请求、等待自有资源收敛并释放有界内存，不调用 shutdown、不因关闭自动 unpin、不停止 Kubo。pin 的释放来自显式能力和协调后的 prune，而不是 scope 生命周期；关闭单个 scope 不影响其他调用者。

## 实施前阻塞评估

结论：Store 重构前置依赖已解除，B01-B04 的用户行为选择已明确；用户已将 pin 语义明确为具名 best-effort hint，原“必须证明对外部 pin 的绝对所有权隔离”阻塞不再适用。仍需实现并验证本系统的引用协调、资源边界和错误传播。

| ID | 已确认的行为 | 实施约束 |
| --- | --- | --- |
| B01 | Store 提供 pin/unpin，为持久化保留的 Task/Run bundle 和 output 根设置保留提示 | 使用本系统 pin name；确认只表示本次操作成功，不承诺抵御外部删除 |
| B02 | prune 后标记清除，协调本系统 Engine 引用 | 只清除可见名称属于本系统的无引用 pin；其他名称及标记失败不清除，不声称名称提供所有者隔离 |
| B03 | 用户自行配置 Kubo 联网，Engine 不管理 daemon | RPC 不可达时依赖请求报错，daemon 网络离线不妨碍读取已有块 |
| B04 | 支持显式配置受信远程 RPC，访问保护由用户部署负责 | 不自动公开或发现管理 RPC，不泄露凭据 |

### 不需要额外人类决策，但必须验证的技术项

- 选定受支持 Kubo 版本，验证原始块 RPC 的 codec、hash、CID 表示和递归 pin/unpin 行为。技术验证失败会形成明确阻塞；不得以重编码或 local fallback 绕过，也不能提前宣称兼容所有版本。
- 验证完整 Task/Run 根集、参与 Engine 的引用协调、具名 pin 的保守筛选、正常导入与 GC 竞态及部分成功恢复。现有 CLI prune 读取 managed task.roots 不构成全部 Engine Task/Run 引用已覆盖的证据；必须核对持久化事实而不是只复用旧扫描范围。
- 修改 managed / DiskContent 的目录假设及 retained-block 包装，覆盖 CAR 导入、普通内容读取与输出块写入路径；不能只绕过一个构造点。既有数据库业务持久化不在此处顺带重构，须明确区分业务记录与重复块缓存。
- 配置默认、旧 local 调用、override 冲突、scope 所有权和资源预算属于已明确约束下的兼容工作，不应重复上升为产品选择。新增字段的具体命名、错误类型复用及测试组织属于实施细节。

本次用户澄清改变了原绝对保留解释，需以修订后的准确 Ideal revision 重新同步、提交并由获授权父 Agent 审查批准，再继续实现；不把原 revision 的批准冒充新契约已通过。

## 验证方向

后续实施应以同一 DAG 对照 local / Kubo 的块字节、根 CID、文件与目录读取，检查严格配置拒绝、限额、取消和异常传播。真实 Kubo 验证还须覆盖：无外部干预时 Task/Run 根在重启和正常 GC 后可读；prune 最后一个协调引用后清除本系统具名 pin；其他可见名称与已知参与者引用不会被主动清除；标记不完整不清除。显式模拟人工删除 local 内容／Kubo pin 并回收块，确认依赖读取按真实来源恢复或显式失败，不伪称 pin 永久有效。证明“无额外磁盘副本”须检查宿主测试目录读写，而非仅验证构造对象类型。

上述行为已获用户确认；目前没有 Kubo 实现完成、外部验证或生命周期验收证据。
