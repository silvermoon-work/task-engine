# Implementation

本文件是准备阶段的实施种子。按最新订正保留 SQLite 权威，以 IPFS 辅助归档定稿 RunHistory；先按[架构评估](ArchitectureReview.md)确认剩余行为，再按[分阶段计划](RefactorPlan.md)实施，当前不授权写实现代码。

## Steps

### I-S01: 依据确认契约实现引用往返

对应 P1。建立 ipfs-access、ipfs-payload 与 Store 的结构化 DAG 支持，以规范向量和充分单测验证 JSON/真实 CID/DAG 往返、判别分支及完整强闭包，保持资源 file/directory DU 与 raw/UnixFS 范围。具体约束见[IPFS Payload 设计](IpfsPayload.md)。

### I-S02: 建立 SQLite 管理的历史归档

对应 P2/P3。SQLite 持续保存活动状态、请求与恢复事实，管理定稿历史的归档/保留意图；生成 RunHistory 强引用 DAG，允许记录与详情独立保留。验证归档、unpin、迟到完成及丢失详情时的正确性，不建立第二个权威 head 或全域 DAG 索引恢复。

### I-S03: 完成协议切换与隔离交付

对应 P4/P5/P6。统一 parameters/message/result 和所有内外部调用，移除 Worker Space 与旧 output 交换协议，保持已有 Schema/API 版本；ipfs-tree 独立按需引入。完成全链路、包体、性能、归档故障和数据库恢复验证，不自动修改旧存储或发布。

## Acceptance criteria

### I-AC01: 引用与普通 JSON 无歧义往返

以包级规范向量及三通道测试证明引用在 JSON、逻辑值和 DAG 间往返，普通数据不误转换；引用路径只覆盖实际引用分支，真链接可遍历，缺失/损坏/未知 codec/超限的闭包不能声称为完整归档。

### I-AC02: 归档保留与详情缺失可验证

以 local/隔离 Kubo 及真实重启证明归档重试、保留代次和清理不破坏 SQLite 权威状态或外部持有；记录存在但详情缺失可查询可报告，unpin 不误报物理删除，恢复不重复运行，不从残余 DAG 重建或复活数据库业务记录。

### I-AC03: 新协议全链路与按需依赖成立

以真实构建 Task 的参数、消息、父子调用、结果及 file/directory 流式访问证明全量替换，保留原有调度/失败语义且版本号不迭代；未引入 ipfs-tree 的产物不含其运行时模块。全部相关测试、类型检查、构建和 pnpm check 通过，有明确性能预算与超限证据。
