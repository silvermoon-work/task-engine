# Implementation

实施已开始，但尚未完成，不具备提交 Inner 验收条件。Store 抽象已通过 `61b5661` 合入 primary；用户进一步澄清 pin 为具名 best-effort hint，修订 Ideal 后按准确 revision 重新审查。

2026-11-12 的真实 Kubo 0.43.1 探针证明原生 pin 不提供所有者租约、引用计数或条件删除。用户据此明确允许用 `@silvermoon-work/task-engine` pin name 作为提示，不要求抵御外部删除或覆盖；local 内容同样可被人工清空。原绝对所有权阻塞已按需求澄清解除，实测证据保留在 [历史阻塞与澄清](./ownership-blocker.md) 和 [探针](./ownership-probe.mjs)。产品实现仍未完成，全部 I-* 保持未完成。

## Steps

### I-S01: 收口配置与所有权契约

基于已合入 Store 落实严格后端 union、旧 local 配置与构造调用兼容、统一 pin/unpin、具名提示及参与 Engine 的引用协调契约；Kubo 联网与部署访问保护由用户管理，Engine 不接管 daemon。

不要求部署独占 repo 或新的强制协调服务来约束外部调用方；名称不是安全隔离。只按当前可见本系统名称和协调引用做清除，异常或标记不完整时明确失败，不把 best effort 解释为吞错。

### I-S02: 接入可选块后端

在统一 Store 内增加 Kubo 原始块读写与根保留，接入持久化 Task/Run 的 bundle/output 引用及 prune 标记清除，保持校验、预算和错误边界；调整 managed / DiskContent 调用链避免重复磁盘块缓存。

### I-S03: 验证兼容与失败边界

补充聚焦的配置、块保真、资源限制、跨 Engine 保留和失败恢复测试，检查 Builder / Engine / CLI 调用链。

## Acceptance criteria

### I-AC01: 默认与配置兼容

通过类型检查及运行时配置测试证明默认 local、旧配置过渡和严格分支拒绝；Builder / Engine 在无 daemon 时不新增 Kubo 依赖。

### I-AC02: 内容与边界一致

用同一 DAG fixture 和受控 RPC 测试证明字节与 CID 保真、UnixFS 读取一致，校验、累计读取、唯一块数、深度及内存保留限制未弱化。

### I-AC03: 故障与资源所有权明确

通过持久化与重启、参与 Engine 共享根、prune 最后引用、其他 pin name、已知并发新增引用和标记失败测试证明按提示契约清除；模拟人工删 local 块或 Kubo pin／块后依赖读取真实恢复或报错。取消、断连、partial DAG 及 pin/unpin 失败显式传播且可恢复，不回退 local。close 不终止外部 daemon 或因关闭释放 pin，scope 不干扰其他 reader。
