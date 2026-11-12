# Implementation

实施已开始，但尚未完成，不具备提交 Inner 验收条件。Store 抽象已通过 `61b5661` 合入 primary；已接受 Ideal 保持不变。

2026-11-12 使用本机 Kubo 0.43.1 的独立离线 daemon 完成所有权可行性探针，复现核心阻塞：原生 pin 没有所有者租约、引用计数或条件删除；系统之外对同一 CID 的新增保留要求无法可靠识别，也无法与 unpin 原子协调。当前不能同时证明“最后系统引用后清除”和“保留未参与协调的人工／外部 pin”。详见 [实施阻塞与实测证据](./ownership-blocker.md) 及可重跑的 [真实 Kubo 探针](./ownership-probe.mjs)。未用不安全假设替代该约束；未添加不完整的产品后端，全部 I-* 保持未完成。

## Steps

### I-S01: 收口配置与所有权契约

基于已合入 Store 落实严格后端 union、旧 local 配置与构造调用兼容、统一 pin/unpin 及跨 Engine 引用所有权契约；Kubo 联网与部署访问保护由用户管理，Engine 不接管 daemon。

先证明所有权边界可实现；仅有参与 Engine 的共享锁或持久化日志，不足以约束不参与协调的 RPC 调用方。当前此项被实测阻塞，不能据此进入自动清除实现。

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
