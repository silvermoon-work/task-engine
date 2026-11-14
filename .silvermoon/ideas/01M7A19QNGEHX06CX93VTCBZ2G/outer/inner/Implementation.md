# Implementation

本文件是准备阶段的实施种子。最新强引用与 DAG 事实源要求带来新的严重取舍，先按[架构评估](ArchitectureReview.md)确认，再按[分阶段计划](RefactorPlan.md)实施；当前不授权写实现代码。

## Steps

### I-S01: 依据确认契约实现引用往返

对应 P1。建立 ipfs-access、ipfs-payload 与 Store 的结构化 DAG 支持，以规范向量和充分单测验证 JSON/真实 CID/DAG 往返、判别分支及完整强闭包，保持资源 file/directory DU 与 raw/UnixFS 范围。具体约束见[IPFS Payload 设计](IpfsPayload.md)。

### I-S02: 建立权威 DAG 提交与可重建索引

对应 P2/P3。先验证 head/意图/pin 的耐久提交与故障恢复，再以 RunHistory 聚合执行、交付和消息 DAG，必要的 Run 前/全域事实另行持久记录；Task 是请求/关联/投影，不独占执行历史。SQLite 成为带提交边界的查询投影，保留顺序、资格、幂等和不确定恢复语义。

### I-S03: 完成协议切换与隔离交付

对应 P4/P5/P6。统一 parameters/message/result 和所有内外部调用，移除 Worker Space 与旧 output 交换协议，保持已有 Schema/API 版本；ipfs-tree 独立按需引入。完成新数据域全链路、包体、性能、故障和索引恢复验证，不自动修改旧存储或发布。

## Acceptance criteria

### I-AC01: 引用与普通 JSON 无歧义往返

以包级规范向量及三通道测试证明引用在 JSON、逻辑值和 DAG 间往返，普通数据不误转换；引用路径只覆盖实际引用分支，真链接可遍历，缺失/损坏/未知 codec/超限的闭包不能成功接纳或发布。

### I-AC02: 提交保留与索引恢复可验证

以 local/隔离 Kubo 的故障矩阵及真实重启证明提交只出现完整旧/新批次，pin/清理不破坏共享或外部持有；丢失测试查询 SQLite 后从约定的权威根与 DAG 重建同等查询、幂等、匹配及恢复状态，不重复执行副作用。

### I-AC03: 新协议全链路与按需依赖成立

以真实构建 Task 的参数、消息、父子调用、结果及 file/directory 流式访问证明全量替换，保留原有调度/失败语义且版本号不迭代；未引入 ipfs-tree 的产物不含其运行时模块。全部相关测试、类型检查、构建和 pnpm check 通过，有明确性能预算与超限证据。
