# Implementation

准备阶段初版，尚未执行，不属于构想验收范围。Store 抽象已通过 `61b5661` 合入 primary；[设计讨论](./ideal/backend-design.md#实施前阻塞评估) 中 B01-B04 的行为已获用户确认，所有权协调与故障恢复仍需技术验证。

## Steps

### I-S01: 收口配置与所有权契约

基于已合入 Store 落实严格后端 union、旧 local 配置与构造调用兼容、统一 pin/unpin 及跨 Engine 引用所有权契约；Kubo 联网与部署访问保护由用户管理，Engine 不接管 daemon。

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

通过持久化与重启、跨 Engine 共享根、prune 最后引用、外部 pin、并发新增引用和标记失败测试证明不误 unpin；取消、断连、partial DAG 及 pin/unpin 失败显式传播且可恢复，不回退 local。close 不终止外部 daemon 或释放持久 pin，scope 不干扰其他 reader。
