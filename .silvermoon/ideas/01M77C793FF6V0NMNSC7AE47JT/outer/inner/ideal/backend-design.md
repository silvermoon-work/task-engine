# 可选 Kubo 后端：准备阶段设计讨论

本文服务于同世界 [Idea](./Idea.md)，记录影响可行性和验收含义的约束与风险，不是实施计划或已批准的 pin 方案。Implementation / Deployment 仅为可调整的下游初版。

## 基线与关联

2026-11-12 只读检查了相邻 worktree `task-dependency-merkle-node-discussion`。
它的 HEAD 为 `e0e4f0043fe9f77ff1335b41d9db3774001fcb20`，但以下 Store 重构属于未提交候选，不属于该提交的已发布能力，也不在当前独立 worktree 中。实施前必须重新核对其最终合入契约，不能复制或提交另一 session 的改动。

- 候选 `packages/ipfs-store/src/store.ts`：构造 `SharedContent(dataDir, source)`，source 可为 Gateway；`put` 写当前 backend。`fromClient` 借用只读 `IpfsClient.block.get`，其 `put` 不会转发给注入客户端。
- 候选 `packages/ipfs-store/src/storage.ts`：SharedContent 是自有磁盘块存储，校验读写，以临时完整文件和硬链接原子发布，并缓存 source 返回的块；当前无自动磁盘 GC。
- 候选 `packages/ipfs-store/src/dag.ts` 与 `store.ts`：`limits.bytes` / `retainedBytes` 为进程内读取保留预算，不是磁盘配额。单块、唯一块数与深度限制已有独立含义。
- 候选 `packages/ipfs-store/src/node.ts`：宿主显式调用配置 helper；公共配置只有 `dataDir` / `gateway`，缺省使用共享内容目录，不因 import 读取配置。
- 候选 Builder 使用注入的 `content`；Engine 使用 `ipfsStore` 并借用 reader scope。Builder CLI 显式构建配置对象；Engine CLI 的 managed / data 层仍有本地目录与 source 包装假设。

关联但不重复：现有 [任务依赖 Idea 的 Store 抽象要求](../../../../01M76NH3WE2K9B03HDFT2XTEFV/outer/inner/Implementation.md) 定义统一注入对象；[IPFS fetch Idea](../../../../01M76NXWH50ZXJBAN92MEH2ZAQ/outer/inner/ideal/Idea.md) 关注内容访问。本 Idea 单独讨论存储后端与持久保留，不扩展任务调度、DAG graft 或公开 Gateway 产品能力。

## 已确认的目标边界

- 默认仍为 local。Kubo 是直接块存储，不是 SharedContent 的 Gateway source；Kubo 路径不得创建或填充自有 `blocks` 目录、临时 CAR 磁盘副本或其他等价块缓存。
- Builder / Engine 面向同一 Store 能力，不按后端复制 UnixFS 解析或强制启动 Kubo；允许校验及流控所需的有界内存缓冲。
- local 的磁盘容量与淘汰策略只属于 local；当前并无此磁盘配额或自动 GC，不在本 Idea 顺带实现。Kubo 的磁盘管理与 GC 由 daemon 负责。
- 两种后端都必须保留 CID 校验、单块大小、读取累计字节预算、唯一块数、DAG 深度和进程内块保留预算。不能把读取预算改名为磁盘限额，也不能因 Kubo 已校验而移除应用边界。

## 配置契约候选

以 `backend: "local" | "kubo"` 为判别字段，公共 `limits` 与后端专属字段分离。基于当前命名的候选如下；最终声明与迁移细节在 Store 基线合入后复核：

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

宿主读取配置并显式注入；库 import 不读用户文件。建议仅在宿主的旧配置归一化入口把缺少 backend 的既有 `{ dataDir?, gateway? }` 识别为 local，再进入严格 union 校验。显式新 union 必须有判别字段；不要用宽松合并让跨后端字段泄漏，也不要猜测 Kubo。是否保留旧构造签名作为过渡，需要结合未发布 Store 候选决定。

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

## 验证方向与需要决定的问题

后续实施应以同一 DAG 对照 local / Kubo 的块字节、根 CID、文件与目录读取，检查严格配置拒绝、限额、取消和异常传播；真实 Kubo 还须覆盖 daemon 重启、受控 GC、partial DAG、pin 失败及共享根。证明“无额外磁盘副本”须检查宿主测试目录读写，而非仅验证构造对象类型。

需要在实施前确认：

1. 选择 Store 协调根保留还是宿主管理；何时可以对调用者报告“完整导入且已保留”？
2. 是否接受首版无自动 unpin；若需释放，采用什么跨调用者所有权契约？
3. 默认严格离线还是显式允许 Kubo 联网；首版是否只支持本机受信 daemon？

这些问题可以在构想评审时讨论；目前没有任何逐项批准、实现完成或外部验证证据。
