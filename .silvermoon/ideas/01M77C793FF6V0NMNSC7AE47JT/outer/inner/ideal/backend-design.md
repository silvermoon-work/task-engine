# 可选 Kubo 后端：准备阶段设计讨论

本文服务于同世界 [Idea](./Idea.md)，记录影响可行性和验收含义的约束与风险，不是实施计划或已批准的 pin 方案。Implementation / Deployment 仅为可调整的下游初版。

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

## 配置契约候选

以 `backend: "local" | "kubo"` 为判别字段，公共 `limits` 与后端专属字段分离。基于已合入 Store 命名的候选如下；最终声明须在下述保留与联网决策后收口：

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

这不是最终完整 schema：联网、超时与保留策略的字段仍取决于下文决策。Kubo 分支拒绝 `dataDir` / `gateway` 及其他 local 专属字段；local 分支拒绝 Kubo RPC 字段。运行时 JSON 同样严格校验未知字段、类型、判别值、URL、正整数和跨字段组合，不能只依赖 TypeScript。

宿主读取配置并显式注入；库 import 不读用户文件。建议在旧配置及旧构造调用的兼容入口把缺少 backend 的既有 local 形状归一化，再进入严格 union 校验。显式新 union 必须有判别字段；不要用宽松合并让跨后端字段泄漏，也不要猜测 Kubo。已合入的 `new IpfsStore({ dataDir, gateway?, limits? })` 调用应保持行为兼容，不以“尚在 RC”为由顺带移除；具体兼容入口的类型组织属于实施细节，不增加待决的破坏性迁移。

兼容核对范围：

- 公共配置 helper 保留原路径、环境变量、local 默认目录和相对路径基准；后端切换时跨分支 override 应明确拒绝或显式替换整分支，不能隐式继承旧 local 字段。
- Builder CLI 现有 `--content-gateway` / `--content-data-dir` 和 Engine 的 `server.ipfsGateway` / `server.contentDataDir` 继续映射 local；与 Kubo 选择冲突时显式报错。此处不预定新增命令或 flag。
- `server.dataDir` 仍为 Engine 数据库路径，不是 Kubo repo。managed 实例元数据不得要求 Kubo 的 `configuration.dataDir`，data 层不得把已注入 Kubo Store 再包装为 SharedContent。
- `fromClient` 的只读适配语义不变；不能把它当成完整可写 Kubo 后端。统一对象、scope、CAR 调用点与所有权须同时验证。

## 原始块 RPC 与完整性

候选以 Kubo 管理 RPC 的 `block/get` / `block/put` 读取和写入已有块；不重新 `add` 文件，不改变分块、编码或 DAG。写前验证输入 CID 与字节，按 CID 的 codec / multihash 选择受支持参数，并核对响应 CID 的内容身份；RPC 版本、参数支持和 CID 表示兼容性需真实 daemon 证明，不能默认所有 codec 都可写。

保留我们控制的 UnixFS 解析和完整 DAG 遍历。RPC 响应体应边读边限额并取消超大响应，不能先无限缓冲再检查；错误响应体也须有界。读取累计预算和保留预算须分别核对其现有计账范围，至少不得弱化已有边界。

管理 RPC 通常是 `http://127.0.0.1:5001`，不是 Gateway 的 8080。它有管理权限，不应暴露公网；宿主显式提供 apiUrl，不自动探测公网端点。远程访问的认证、传输保护及部署信任边界待确认，日志不得泄露凭据。

## 持久保留、GC 与失败恢复：待决

原始块写入成功只说明块已进入 daemon，不能据此宣称完整 DAG 已持久保留。单块 pin 与根 DAG 递归 pin 不同；未受保留保护的块可能被 Kubo GC 回收，内存 reader scope 也不是持久保留凭证。

候选策略 A：导入协调者完成完整 DAG 校验后显式请求根递归 pin，并确认 daemon 返回成功及根的递归保留状态；`put` 本身不承诺 DAG 保留。需要评估导入中 GC 的竞态，以及是否用临时保护避免未完成块被回收。RPC 写入和根 pin 不是一个事务。

候选策略 B：由宿主管理保留，Store 仅承诺块 I/O，宿主另行完成并证明递归 pin。它减少 Store 的管理职责，但必须让导入成功与“已持久保留”的 API 结果明确区分。两种策略都不能在 pin 失败后返回保留成功。

共享 Kubo 上，同一根可由多个任务、应用和人工同时使用；pin 不是天然的独占租约或跨应用引用计数。必须决定谁拥有根保留记录、如何识别既有 pin、如何跨进程协调释放，以及应用外的 pin 如何受保护。任务删除不得直接映射成 unpin。保守候选是本阶段不提供自动释放，只允许明确所有权下的显式管理；这有磁盘增长成本，需用户确认。

partial DAG 或中断导入必须显式标为未完成，不作为完整保留成果；失败重试可按 CID 幂等补块，但不能假定先前块仍存在。超时或取消可能发生在 daemon 已完成写入或 pin 之后，应查询真实状态并恢复，而不是无条件撤销未知所有权的 pin。清理不得调用全局 GC、删除共享块或回滚他人的保留。

## 联网、请求与生命周期：待决及约束

- Kubo `block/get` 可能联网寻块；本地 RPC 地址不等于离线。必须决定默认严格离线还是显式允许网络，并对选定版本验证可用的离线调用机制；不能依赖臆测参数。若该版本无法保证逐请求离线，应要求 daemon 级离线部署或拒绝该模式，不能静默联网。
- 既有 hints / allowGateway 不能绕过 Kubo 的联网策略或重新引入 local 副本。缺块应受所选策略约束并清晰报错，是否允许显式 Gateway 补块需另行决定，默认不推定支持。
- 请求需要有界超时、调用方取消和 Store lifetime 取消；写入、读流、pin 等待均适用。保留缺块、校验失败、容量超限、不可达、超时和取消的可区分语义；无静默 local fallback。重试只适用于已定义的幂等动作，不能用重试掩盖副作用状态不明。
- Store 借用外部 daemon；`close` 仅取消自身请求、等待自有资源收敛并释放有界内存，不调用 shutdown、不自动 unpin、不停止 Kubo。关闭单个 scope 不影响其他调用者。

## 实施前阻塞评估

结论：统一 Store 的代码前置依赖已解除，但尚不能开始 Kubo 产品实现。以下四项会改变公共行为或持久化责任，必须由用户明确选择；表中的建议均未获批准，构想验收也不自动批准建议。

| ID | 必须决定的行为 | 建议供用户选择 | 未决定的影响 |
| --- | --- | --- | --- |
| B01 | 谁协调完整导入后的根递归保留，何时报告保留成功 | 宿主导入流程协调，Store 提供显式保留能力；`put` 仅确认单块写入，完整校验并确认递归 pin 后才报告根已保留 | 决定 Store 端口、导入成功边界和 partial DAG 恢复责任；不能把只读 `prepare` 暗改为 pin |
| B02 | 首版是否包含自动释放及共享 pin 所有权管理 | 首版不自动 unpin；任务删除和 Store close 都不释放 pin，清理由外部管理员显式处理并接受磁盘增长 | 若要求自动释放，必须先确定跨进程、跨应用的所有权与协调契约，不能靠任务引用计数推断 |
| B03 | Kubo 后端默认严格离线还是允许 daemon 联网 | 默认严格离线，联网必须显式允许；不增加独立 Gateway 补块路径 | 决定读取缺块的行为、配置字段与 hints 处理；本机 RPC 不能自动当作离线证明 |
| B04 | 首版只支持本机受信 daemon，还是支持远程 RPC | 首版限定 loopback 的受信 daemon，远程 RPC 的认证与传输保护另行设计 | 决定 apiUrl 校验、信任边界与可部署范围；不得自动暴露管理 RPC |

### 不需要额外人类决策，但必须验证的技术项

- 选定受支持 Kubo 版本，验证原始块 RPC 的 codec、hash、CID 表示和离线机制。技术验证失败会形成明确阻塞；不得以静默联网、重编码或 local fallback 绕过，也不能提前宣称兼容所有版本。
- 验证导入与 GC 并发、pin 结果不明及部分成功的恢复；根据 B01/B02 的选择设计有界临时保护，不自动撤销未知所有权的 pin。
- 修改 managed / DiskContent 的目录假设及 retained-block 包装，覆盖 CAR 导入、普通内容读取与输出块写入路径；不能只绕过一个构造点。既有数据库业务持久化不在此处顺带重构，须明确区分业务记录与重复块缓存。
- 配置默认、旧 local 调用、override 冲突、scope 所有权和资源预算属于已明确约束下的兼容工作，不应重复上升为产品选择。新增字段的具体命名、错误类型复用及测试组织属于实施细节。

此外，当前 Idea 尚无 `acceptIdeal`；文档调整会使旧 `submitIdeal` 失效，必须针对新 revision 完成准备与同步后再提交。B01-B04 未收口前，本候选不宣称准备完成，不请求用旧 revision 验收，也不开始产品实现。

## 验证方向

后续实施应以同一 DAG 对照 local / Kubo 的块字节、根 CID、文件与目录读取，检查严格配置拒绝、限额、取消和异常传播；真实 Kubo 还须覆盖 daemon 重启、受控 GC、partial DAG、pin 失败及共享根。证明“无额外磁盘副本”须检查宿主测试目录读写，而非仅验证构造对象类型。

目前没有 B01-B04 的逐项批准、Kubo 实现完成或外部验证证据。
