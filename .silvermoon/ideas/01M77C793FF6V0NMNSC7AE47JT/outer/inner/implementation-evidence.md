# Kubo Store 实施证据

本文服务于 [Implementation](./Implementation.md)，不代表生命周期提交、批准、发布或外部部署。已接受 Ideal 保持不变；历史绝对所有权反例已由用户澄清的具名 best-effort hint 语义取代。

## 产品落点

| 范围 | 文件与行为 |
| --- | --- |
| 配置 | `packages/ipfs-store/src/configuration.ts`、`node.ts`：严格 local/Kubo union；未知字段、跨分支字段、无效 URL/限额拒绝；保留旧 local 构造、JSON 路径、环境变量及相对路径基准。库 import 不读配置，也不因普通 Builder 读取加载 SQLite。 |
| RPC | `packages/ipfs-store/src/kubo.ts`、`store.ts`：直接 `block/get` / `block/put`，使用 `cid-codec` 保持 SHA-256 raw/DAG-PB/DAG-CBOR 块身份；响应 CID 规范化核对、读写校验、有界流式响应及错误体、超时/取消/关闭。UnixFS 遍历仍限 raw/DAG-PB；不承诺任意 codec/hash。 |
| 提示与协调 | `packages/ipfs-store/src/retention.ts`：local 可观察持久标记；Kubo 名称 `@silvermoon-work/task-engine/<coordinator-id>`；稳定身份、参与者根集、计数化发布意图、导入暂存及 pin/unpin 意图持久化。 |
| Engine | `packages/task-engine/src/retained-content.ts`、`bundle-engine.ts`：收集所有保留 Task/Run 的 bundle、实际 output CID 和 Run 根关联；包含历史 Run，读取事实格式版本后才标记。JSON result 不解释为 CID。发布前安排提示，业务提交后确认；collect 先提交元数据再协调清除，可独立重试 `reconcileContent()`。 |
| managed / DiskContent | CLI 的 `data.ts`、`execution.ts`、`managed.ts`、`car.ts`、`commands.ts`、`index.ts`：Kubo 不走 retained-block→fromClient→磁盘缓存分支；上传 CAR 在有界内存校验后直接暂存到 Kubo，只持久化根 CID；输出直接写注入后端。prune 汇总仓库内全部持久化事实，而非只看当前 TaskRecord.roots。保留 local 旧缓存读取与显式私有缓存清理；legacy local runner 仍是只读源加一次性内存业务域，不凭空创建持久 owner/pin，Kubo 分支仍直接可写。 |
| 文档 | Store、Engine、CLI README 记录配置、权限/联网职责、提示语义、协调目录、提交顺序、错误恢复及 prune 的部分成功。 |

没有依赖、版本或发布映射变更。`IpfsStore.fromClient` 借用的源只读，但适配器仍可向自身内存／磁盘后端执行已验证的 put，绝不转发给源；`supportsRetention=false` 独立于可写性，不能因此获得可写 Kubo 后端或协调能力。

## 协调、提交与恢复

采用两个本地 SQLite 文件：`mutex.sqlite` 仅承担参与者间互斥，`retention.sqlite` 以 FULL 同步持久化身份、owner 根快照、发布意图计数、暂存会话及操作阶段。互斥与数据文件分开，使网络操作期间进程退出时锁自动释放，而之前提交的意图仍能恢复。

- 新引用先写发布意图并完成根验证/pin，再提交业务引用；确认时重新发布该根，随后清除一次对应意图。相同 owner/CID 的重叠发布分别计数，不因第一次确认而释放第二次尚未提交的保护。
- `reconcile(owner, () => readPersistedRoots())` 在互斥内读取当前快照，合并所有参与者快照、未确认发布与暂存引用；完整验证与递归 pin 确认完成后才开始移除提示。
- 只移除日志中已知、且当前可见名称恰好属于本协调目录的无引用提示。其他名称、空名称和未知记录不被主动占有或清除。已有外部 direct pin 无法不改名地升级时，显式返回未完成。
- pin、unpin 或导入发生取消、超时、部分成功时保留持久阶段，下一次恢复/协调核对真实状态；不根据超时假定 daemon 未执行。关闭 Store 不反向 unpin，不关闭 daemon。
- `recoverOwner` 按真实业务根集撤销遗弃意图与暂存责任；Engine 重启和 managed 启动/离线 prune 在确认旧执行已停止后安排该步骤。普通 Engine collect 的 idle 条件与根快照在互斥内检查，确认没有准备请求或未回收 Run 才清退遗弃意图，不用旧 idle 快照撤销新发布。正常输出提交结束自身暂存会话；scope/close 本身不做 pin 清除或元数据回收。
- 元数据 prune 已提交后若恢复、标记、RPC 或协调失败，CLI 返回 `RETENTION_UNFINISHED` 及已确认删除计数，不声称整体回滚或清理成功。取消保留 `INTERRUPTED` 语义。Kubo unpin 数量不是回收字节数。

参与 Engine 必须保留同一个 `coordinationDir`，且底层存储提供 SQLite 所需的互斥与持久性。默认 Kubo 目录按准确 API URL 派生；API 别名、不同配置或不同宿主需要显式指向同一协调目录。它不是跨独立文件系统的分布式服务；未加入该目录的其他名称按外部提示保守处理。该前提已在公开配置文档明确，不增加强制 pin proxy 或独占 Kubo repo。

## 正常导入与 GC

真实 Kubo 0.43.1 的 `block/put --pin` 递归 pin，而不是单块 direct pin。若 CAR 先给出父节点，立即对原 DAG-PB CID 递归 pin 会因子节点尚未到达而失败。

实现先用相同 multihash/原字节的 raw CID 原子写入并 pin，再保留原 codec 的 CID。Kubo 按 multihash 存块，不重编码载荷，也没有应用层磁盘块/CAR 副本。暂存 raw pin 不遍历尚未到达的子节点；完整导入后，应用按预算验证原 DAG，再确认原根递归 pin。后续标记清除可以撤销无引用暂存提示，不删除共享块或在产品代码调用全局 GC。

真实测试明确反转 importer 的产出顺序，父节点先到；在每一个暂存块之后仅对该独立测试 repo 执行 GC，随后仍可按原 CID 读出完全相同的字节。完成、Store 重开和 GC 后原 DAG 仍可读；最后参与者引用删除后具名原根不再 pin。

## 聚焦验证回执

环境：Windows，Node.js `v24.11.1`，pnpm `11.22.0`；有效 npm registry 为 `https://mirrors.cloud.tencent.com/npm/`。未执行依赖安装或 registry override。所有命令从仓库根执行：

```powershell
$env:KUBO_REAL_TEST='1'
pnpm --filter @silvermoon-work/ipfs-store exec tsx --test test\kubo.test.ts test\kubo-real.test.ts
pnpm --filter @silvermoon-work/task-engine exec tsx --test test\ipfs-store.test.ts test\drain.test.ts
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test test\kubo.test.ts test\data.test.ts
pnpm --filter @silvermoon-work/task-engine-storage exec tsx --test test\kubo.test.ts
pnpm --filter @silvermoon-work/task-builder-cli exec tsx --test test\cli.test.ts
```

| 验证 | 已观察结果 |
| --- | --- |
| Store mock + 真实 Kubo | 12/12 通过，退出码 0；其中真实 daemon 测试只在显式 `KUBO_REAL_TEST=1` 时执行。 |
| Engine + drain 回归 | 12/12 通过，退出码 0；两个 Engine 的共享 bundle/output、历史 Run、JSON 无 CID、collect 最后引用、已有未 pin 输入块的暂存保护、提交后确认失败的显式诊断及既有 drain 同步拒绝语义通过。最终全量验证还覆盖无效持久 CID 不得被当作“无 CID”而跳过标记。 |
| managed Kubo + local data 回归 | 7/7 通过，退出码 0；两个仓库的 CAR 导入、执行输出、完整持久化引用、prune 最后引用及元数据已删但提示清理失败的计数回执通过。Kubo 路径读取 SQLite retained-block 回调会直接抛错，测试未触发；`ipfs_blocks` 载荷行数为 0，管理目录无 `blocks`。最终全量验证还覆盖临时 Kubo MemoryStore 业务域丢弃后清空引用、不在 close 时 unpin，随后显式 prune 可回收其无引用提示。 |
| SQLite Engine 重开 | 1/1 通过，退出码 0；storeId 稳定、持久 Run 输出根恢复、手工移除 native pin 后重设提示、真实缺块使协调失败但数据库查询仍可用。 |
| Builder CLI | 13/13 通过，退出码 0；全量检查曾发现静态加载 SQLite 带来的 stderr 警告，已改为实际保留操作才加载，未用隐藏警告绕过回归。 |
| legacy local CLI | 17/17 通过，退出码 0；一次性 local runner 保持原只读借用与内存业务域，不凭空创建持久 pin owner，保留安静成功、源/pin 所有权、嵌套任务及信号退出语义。 |
| managed 生命周期 | 7/7 通过，退出码 0；正常停止和中断的物理资源证明通过。回归曾发现关闭 scope 后再写保留元数据会错误阻止资源回收，已移除该 close 副作用，由完成导入、互斥内 idle collect 和显式恢复处理暂存责任。 |

限额测试不是只核对常量：实际 17 字节块在 `blockBytes=17, bytes=17` 下成功且 `retainedBytes=17`；18 字节块被拒绝；实际多块 DAG 分别触发累计 bytes、唯一块数及深度限制。受控 RPC 返回超限响应会在流式读取时取消；校验失败、调用取消、超时、scope/close、外部名称、协调锁不可用、标记源失败、同 owner/CID 重叠发布、结果未知的 pin/unpin 与 partial DAG 恢复均有聚焦断言。

真实测试 daemon：已有本机 Kubo `0.43.1`，新建 `.cache` 内隔离 repo，空 Bootstrap、test profile、`--offline --routing=none`、随机 loopback RPC/Gateway 端口；`id` 确认没有 swarm 地址。测试自行关闭自己的 Store/子进程并删除自身 repo，不接触用户现有 daemon 或共享 repo。未把 mock 结果描述成真实 RPC 验证。

## 复核前候选校验（历史）

复核前候选执行 `pnpm check`：退出码 **0**，Turbo **44/44** 任务成功（20 个缓存命中），用时 `24m13.887s`；format、release lint/tests、各 workspace lint/typecheck/test/build、测试类型检查及 publint 全部通过。该回执不掩盖父复核发现的两项缺口，也不作为修正后候选的最终回执。

其后再次执行 `ipfs version` 确认 `0.43.1`，并重新运行上述 `KUBO_REAL_TEST=1` 的 Store mock/真实测试：**12/12** 通过，退出码 **0**，无跳过。产品代码在最终全量与本次真实验证之间没有变更。

更新 I-* 完成项后的 `silvermoon check --worktree --audience agent` 退出码 **0**，snapshot 验证通过；`git diff --check` 退出码 **0**。Ideal 子树、Deployment 和事件文件与 HEAD 的差异检查退出码 **0**；ledger 差异仅为六个 I-* 勾选，D-* 未变。最终真实 Kubo fixture repo 残留数量为 **0**。

未推断任何验收，未同步、提交、发布或写生命周期事件；临时全量日志在结果记录后清理，不作为交付文件保留。

## 父复核修正与复验

- **适配器兼容：** 恢复 fromClient 自有 ContentBlocks/SharedContent 的验证写入；源的 put/close 均不被调用。独立 `supportsRetention` 能力控制 Engine 与宿主协调，不能用“源只读”推导“适配器不能写”。
- **暂存命名中断：** 在原子 raw put 之前，根据可见 absent/indirect/本系统名称写入独立 `stage_claims`。恢复、保留或清除前先恢复该已知操作的名称；继续失败时保留责任并报未完成，不删除记录。预先存在的外部空名 pin 没有 claim，保持原样。名称仍不是安全隔离，不抵御未参与者在检查与请求之间的修改。修正前已丢失记录的未知空名 pin 不会被无依据认领。
- **稳定 managed 身份：** 在现有 metadata 表新增持久 UUID，不改变 cursor、业务事实或 user_version。重开、数据库移动与 Windows 大小写别名保持 contentOwner；独立复制数据库不属于不同并发身份。启动／离线 prune 先发布稳定身份的实际根，再清退同一已知路径的旧 owner。在完成这次旧 owner 清退前已经搬走的旧候选路径无法自动猜测，须明确恢复已知旧路径 owner；managed instance 的 dataDir/进程身份检查不因此放宽。

已新增内存／磁盘适配器写入、两种空名 pin 前置状态、持续失败责任保留、managed 身份重开／移动／大小写及旧路径引用清退回归。

本轮准确命令与已观察结果：

```powershell
$env:KUBO_REAL_TEST='1'
pnpm --filter @silvermoon-work/ipfs-store exec tsx --test test\adapter.test.ts test\kubo.test.ts test\kubo-real.test.ts
pnpm --filter @silvermoon-work/task-engine exec tsx --test test\ipfs-store.test.ts test\drain.test.ts
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test test\data.test.ts test\kubo.test.ts
pnpm typecheck:tests
```

- Store：**16/16**，退出码 0；包含真实 Kubo 0.43.1，source put/close 调用数均为 0、适配器自有内存／磁盘写入及 hash/容量边界、命名前 503 的持久 claim、持续失败明确未完成、随后恢复并真正 unpin，以及预先存在的外部空名 pin 不被认领。
- Engine：**12/12**，退出码 0；使用独立 supportsRetention 路由，不把适配器能够 put 误当作持久协调能力。
- CLI data/Kubo：**9/9**，退出码 0；覆盖 DiskContent 适配器写读一致、源所有权、持久 UUID 的重开／移动／Windows 大小写别名、cursor 与 user_version 不变、旧路径 owner 退休后最后引用确实清除。
- `pnpm typecheck:tests`：退出码 0。曾有一处新增测试先登记旧路径根、后导入块，导致预期的缺块失败；已将旧路径模拟放在完整 CAR 导入之后，未更改产品错误边界。

两次本轮 `pnpm check` 均退出 **1**，停止在未修改的 Builder CLI 交付检查：

1. `faults.test.ts:57` 首次 build 返回 1 而非 0。保留断言临时补充结果诊断，独立复跑 **1/1** 通过。
2. 再次全量在 `imports.test.ts:85` 返回 `DELIVERY_UNCERTAIN`；同次 faults 用例已通过。没有把不同用例的暂时通过当作全量通过。

对 `test\faults.test.ts test\imports.test.ts` 做临时诊断，捕获到已有 `directoryTree` 的 `INPUT_CHANGED`。一份实际文件身份数据如下，生成文件为 `resources/child/worker.cjs`：

| 字段 | 读取前 | 读取后／重新打开 |
| --- | --- | --- |
| dev | 8955306 | 8955306 |
| ino | 14073748837871508 | 14073748837871508 |
| size | 20 | 20 |
| mtimeNs | 1794493692115599100 | 1794493692115599100 |
| ctimeNs | 1794493692115599100 | 1794493692275203300 |

这解释了为何既有严格文件身份校验拒绝交付，但不证明是谁修改了 ctime；没有推断某个外部进程或放宽校验。临时诊断和断言消息已全部还原，`git diff --exit-code` 确认 Builder CLI `src/index.ts`、`src/node.ts`、`test/faults.test.ts` **无差异**。还原后同一双文件测试仍 **1/2** 失败，faults 在原有 `data.car` 断言处遇到未验证交付没有 data；该组件未被本轮产品修正改动。

这是新增的全量验证阻塞，不是旧 pin 绝对所有权问题，也不是本轮两项修正的聚焦失败。需要排除该 Windows 文件元数据变化，或在不放宽文件完整性规则的环境中重新完成全量；本 Agent 不擅自修改独立 Builder 交付契约。I-S01/I-S02/I-AC02/I-AC03 按已观察的聚焦结果完成，I-S03/I-AC01 保持未完成，不进入 Inner 门禁。Ideal、Outer、events 和版本不变。

## 剩余边界

- 名称不具备鉴权、租约或条件删除。外部可覆盖/删除 pin 或块；检查与 unpin 之间的外部同 CID 干预不受保护。这是已接受的 best-effort 边界，不再是旧绝对所有权阻塞。
- 原生 RPC 与业务数据库不是跨系统原子事务。异常保留可恢复意图；永久不可达的源或损坏的协调目录必须修复，不能以“best effort”吞错或自动切换后端。
- 本次真实验证限 Kubo 0.43.1 的隔离离线 daemon；不宣称所有旧版本、真实远程认证代理、跨宿主共享文件系统或任意网络寻块环境均已验证。
- 未执行 RC 发布、Ubuntu smoke、真实部署 daemon 重启或外网策略检查；这些属于父协调者的 Outer 工作。所有版本保持原值，未提交、同步或写生命周期事件。

## 父 Agent 独立复核与完整源码验证

父 Agent 阅读配置、RPC、保留协调、Engine 根提取和宿主调用链，独立复现并退回两处问题。修正后再次执行同一反例：适配器 `put` 成功，命名失败后的暂存 pin 在恢复中实际清除（`removed=1`、原生 pin 不存在），而不是只删协调记录。另去掉无调用者的恒真 `writable` getter，仅保留实际参与保留路由的 `supportsRetention`。

Windows 独立复验：Store mock/真实 Kubo **16/16**、Engine/drain **12/12**、managed/data **9/9**、SQLite Engine 重开 **1/1** 全部退出 0；同一批 Builder guard 双文件仍 **1/2** 失败，原校验未被修改，不能把这个环境宣称为全量通过。

为在不放宽校验的环境完成全量，冻结 Git index tree `2b886ccd63ad73c37e97545a2de0ac3929e55143`，归档 SHA-256 `406e197e37c1b14947d199a36b09cabbe5fb11f5b4f0eeb704175e94888a9b0f`，传至获授权 Ubuntu 主机的新隔离目录。远端核对归档散列后普通 `pnpm install --frozen-lockfile`，不改 HOME、registry、全局工具或其他会话资源。这是**源码候选验证，不是 registry RC smoke**。

远端默认 Node.js `24.22.2` 首轮完整检查失败于未修改的 `bundle-contract-host.test.ts`：模块探针返回的非有限 JSON 触发既有断言。未改产品或断言，也不把它当作通过。主机缺少 CI 的固定 Node 版本，于本次独立目录下载 Node.js `24.11.1`，使用官方 `SHASUMS256.txt` 核对压缩包后仅调整该命令 PATH；不变更用户的 NVM 默认版本或系统安装。

准确 CI Node.js `24.11.1` 下，同一模块文件测试 **28/28** 通过；随后完整 `pnpm check` **退出 0**，Turbo **44/44** 成功（27 个缓存命中），Turbo 用时 **8m38.534s**，最终测试类型检查和全部 publint 也通过。没有跳过失败项、隐藏警告或修改源码。

远端原始日志散列：

- 完整 `check-ci-node.log`：SHA-256 `26025a7eae75205ad1995f16424f2cef92919c628b46b9c4163129bb24c6ad64`。
- 准确 Node 的聚焦模块测试：SHA-256 `1316e8c5631872169d73c59ae963be6187a362b83864cd24d7b67a428fdd7f8c`。

验证快照的产品树 `packages` 为 `5eeffcc466904df8324f44df702cbded252c0c09`，`scripts` 为 `d12162fbf66c7e60d09298c7de807a8f3c8fc0f2`，`.github` 为 `c6568fb99d0c5e549b178cdb781af2c06e40362e`。其后只更新本世界证据和 ledger，不改变这些已验证树。I-* 据此完成；准确 Inner 仍需同步、submitInner 和获授权父 Agent 的单独审批，不从测试成功推断验收。后续发布仍必须由发布提交的准确 main push CI 再验证 Node 22.15.0 / 24.11.1，Ubuntu 的 registry smoke 将显式固定已验证运行时并保留较新 Node 的已知限制。
