# Implementation

父复核的适配器自有写入兼容、暂存命名中断恢复已修正，managed contentOwner 改为持久 UUID。父 Agent 独立验证 Store/真实 Kubo 16/16、Engine 12/12、CLI 9/9、SQLite 重开 1/1；在隔离 Ubuntu 以准确 CI Node.js 24.11.1 对固定源码快照执行完整 `pnpm check`，退出 0，44/44 Turbo 任务通过，测试类型检查及 publint 通过。产品树未变，I-* 完成；详细环境限制和失败记录保留在实施证据。

候选尚未同步或提交 Inner，由父协调者负责审查与后续操作。实施遵循已接受 Ideal `34ed6b34053cce97c0ee0a996bfa50dc11158eaa`，不改动 Ideal 内容。

2026-11-12 的真实 Kubo 0.43.1 探针证明原生 pin 不提供所有者租约、引用计数或条件删除。用户据此允许具名 best-effort hint；原绝对所有权阻塞已解除，历史证据仍保留在 [历史阻塞与澄清](./ownership-blocker.md) 和 [探针](./ownership-probe.mjs)。当前实现、边界及验证回执集中于 [实施证据](./implementation-evidence.md)。

## Steps

### I-S01: 收口配置与所有权契约

基于已合入 Store 落实严格后端 union、旧 local 配置与构造调用兼容、统一 pin/unpin、具名提示及参与 Engine 的引用协调契约；Kubo 联网与部署访问保护由用户管理，Engine 不接管 daemon。

不要求部署独占 repo 或新的强制协调服务来约束外部调用方；名称不是安全隔离。只按当前可见本系统名称和协调引用做清除，异常或标记不完整时明确失败，不把 best effort 解释为吞错。

统一为 `backend` 严格 union；`limits`、可选 `coordinationDir` 为公共项，`dataDir/gateway` 仅 local，`apiUrl/timeoutMs` 仅 Kubo。保留旧 local 构造与宿主 JSON，拒绝跨分支 override。参与者共享一个 SQLite 元数据目录和稳定身份；不增加强制服务或 daemon 管理行为，SQLite 仅在实际保留操作时加载。

### I-S02: 接入可选块后端

在统一 Store 内增加 Kubo 原始块读写与根保留，接入持久化 Task/Run 的 bundle/output 引用及 prune 标记清除，保持校验、预算和错误边界；调整 managed / DiskContent 调用链避免重复磁盘块缓存。

采用直接 RPC、具名 pin、local 持久标记、引用发布意图与完整标记后清除。原生 `block/put --pin` 为递归 pin，因此导入以相同 multihash 的 raw 别名进行原子暂存保护，支持 CAR 父节点先于子节点到达；完成后验证原 DAG 并 pin 原根。Kubo 路径不写应用块目录、SQLite 块载荷或 CAR 副本；业务事实与 CID 关联仍按原持久化方式保存。

### I-S03: 验证兼容与失败边界

补充聚焦的配置、块保真、资源限制、跨 Engine 保留和失败恢复测试，检查 Builder / Engine / CLI 调用链。

用聚焦测试覆盖两个 Engine、两个 managed 仓库、SQLite Engine 重开、历史 Run 与纯 JSON 根提取、正常并发与同 owner/CID 重叠发布、协调/标记失败、未知 pin name、partial DAG、结果未知的 pin/unpin、取消及关闭。真实 Kubo 测试使用隔离离线 repo，按父节点优先顺序逐块导入并在每步执行该测试 repo 的 GC；不触及已有 daemon 或共享 repo。最后执行 `pnpm check` 和 Silvermoon worktree 检查。

## Acceptance criteria

### I-AC01: 默认与配置兼容

通过类型检查及运行时配置测试证明默认 local、旧配置过渡和严格分支拒绝；Builder / Engine 在无 daemon 时不新增 Kubo 依赖。

复核前结果：严格 union、旧 local 构造/JSON、缺省 local 与显式宿主注入通过；既有 Builder CLI 13/13、legacy local CLI 17/17、managed 生命周期 7/7 回归通过，没有隐藏警告来绕过兼容检查。父复核补充的适配器自有写入兼容按修正章节重新验证，不能由这些旧回执推断完成。

本轮结果：适配器自身内存／磁盘 put、scope 写读、源 put/close 不被调用、独立 supportsRetention 路由及 managed 身份迁移的聚焦测试通过；父 Agent 的准确 CI Node.js 24.11.1 Ubuntu 完整校验通过，Builder 文件完整性校验未被放宽。Windows ctime 变化及较新 Node.js 24.22.2 的既有模块测试失败仍如实保留，不声称这些环境已全部通过。

### I-AC02: 内容与边界一致

用同一 DAG fixture 和受控 RPC 测试证明字节与 CID 保真、UnixFS 读取一致，校验、累计读取、唯一块数、深度及内存保留限制未弱化。

复核前结果：原 DAG 的所有块/根 CID 与字节对照通过；实际 17 字节成功且 `retainedBytes=17`、18 字节拒绝，多块 DAG 的 bytes/blocks/depth 限额及有界响应通过。真实 Kubo 0.43.1 父节点优先暂存、逐步 GC、Store 重开及最后引用清除通过；Kubo 应用目录无块/CAR 副本。

本轮结果：上述字节／限额及真实 Kubo 场景在 16/16 Store 复验中再次通过。

### I-AC03: 故障与资源所有权明确

通过持久化与重启、参与 Engine 共享根、prune 最后引用、其他 pin name、已知并发新增引用和标记失败测试证明按提示契约清除；模拟人工删 local 块或 Kubo pin／块后依赖读取真实恢复或报错。取消、断连、partial DAG 及 pin/unpin 失败显式传播且可恢复，不回退 local。close 不终止外部 daemon 或因关闭释放 pin，scope 不干扰其他 reader。

复核前结果：两个 Engine 和两个持久化 managed 仓库的共享 bundle/output、历史 Run、JSON 无 CID、空/其他 pin name、并发发布、锁/标记失败、无效持久 CID、未知操作结果及重开恢复通过。已提交元数据后的清理失败保留确认计数并报未完成；临时 Kubo 业务域丢弃后清退引用但不因 close unpin。父复核指出 put 成功到命名成功之间的缺口，本轮修正单独补证，不把原未知结果用例当作已覆盖；外部覆盖与远程/Ubuntu 部署边界仍按实施证据列示。

本轮结果：新增 absent-before 暂存命名前 503 用例证明失败责任持久保留、持续失败明确报错，恢复后实际 unpin；预先存在的外部空名 pin 始终不被认领。Engine 12/12 与 CLI 9/9 复验通过，稳定身份重开／移动／大小写与旧路径清退已验证。
