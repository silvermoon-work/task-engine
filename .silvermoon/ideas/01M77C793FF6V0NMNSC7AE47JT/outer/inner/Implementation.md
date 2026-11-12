# Implementation

准备阶段初版，尚未执行，不属于构想验收范围。Store 抽象已通过 `61b5661` 合入 primary；实施前先解决 [设计讨论](./ideal/backend-design.md#实施前阻塞评估) 中 B01-B04 的保留责任、释放、联网及 RPC 信任边界决策。

## Steps

### I-S01: 收口配置与所有权契约

基于已合入 Store 落实 B01-B04 的明确决定、严格后端 union、旧 local 配置与构造调用兼容，以及保留、联网、关闭契约。

### I-S02: 接入可选块后端

在统一 Store 能力内增加 Kubo 原始块读写，保持公共校验、预算和错误边界；调整 managed 的目录假设及 DiskContent 的 retained-block 适配，确保完整宿主调用链不引入重复磁盘块缓存。

### I-S03: 验证兼容与失败边界

补充聚焦的配置、块保真、资源限制及失败恢复测试，检查 Builder / Engine / CLI 调用链。

## Acceptance criteria

### I-AC01: 默认与配置兼容

通过类型检查及运行时配置测试证明默认 local、旧配置过渡和严格分支拒绝；Builder / Engine 在无 daemon 时不新增 Kubo 依赖。

### I-AC02: 内容与边界一致

用同一 DAG fixture 和受控 RPC 测试证明字节与 CID 保真、UnixFS 读取一致，校验、累计读取、唯一块数、深度及内存保留限制未弱化。

### I-AC03: 故障与资源所有权明确

通过取消、超时、缺块、损坏、partial DAG 和保留失败测试证明错误不被吞掉、不回退 local，close 不终止外部 daemon，scope 不干扰其他 reader；保留成功遵循选定契约。
