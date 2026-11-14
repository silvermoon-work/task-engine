# 待决定项：SQLite 权威与 RunHistory 辅助归档

本文件支持 [Idea](Idea.md)。2026-11-14 用户订正后，以 SQLite 为真正权威、IPFS 为定稿历史的辅助存储；原 DAG 事实源/可丢弃查询库方案已撤回。细节见[架构评估](../ArchitectureReview.md)和[分阶段计划](../RefactorPlan.md)。

## R-01: SQLite 权威已经确认

运行、准入、消息、幂等、Task/记录是否过期均由 SQLite 决定，不由 IPFS head 或 pin 集合决定。SQLite 是必要备份，不能仅从 RunHistory 重建整个业务系统。

此前“只有少量协调 SQLite 权威，查询 SQLite 可删除”的方案 A 由本次更明确的订正取代。不再需要另外决定 IPFS 数据域当前根或如何把全部运行状态迁入 DAG。

## R-02: 记录与详情的保留可以分离

记录单位为 RunHistory，不是 TaskHistory。未执行和执行中的状态留在 SQLite，不在 IPFS 持续保存活动历史；请求/准入/全域恢复事实无需另造 IPFS 根。

用户明确允许 SQLite 记录仍在，但归档已经 unpin 或详细内容无法取得。记录过期和内容保留以 SQLite 规则为准；unpin 不证明块已经删除，仍 pinned 也不授予已过期记录新的有效性。

该主要取舍已解决，具体期限与字段由实施设计补齐，不把查询缺失伪装成完整空历史。

## R-03: 归档完成边界，已确认

此前“不完整请求无法形成强 DAG 而无法持久记录”的问题已消除：原始申请与失败状态保存在 SQLite，正式归档仍要求强闭包完整。

2026-11-14 用户确认以下建议：

1. Run 已终止且纳入历史的退出、消息结算及资源清理事实稳定后定稿，不能仅以 Worker 返回结果作为定稿点；清理尚不确定时不伪造最终历史。
2. 业务完成以 SQLite 已提交事实为准。首次归档失败也独立报告并重试，不撤销已完成结果、不重跑 Run；重试遵守 SQLite 保留资格与资源预算，不无界延长保留。
3. 运行期间的 CID 资源访问/临时写入继续与状态归档分层，不取消已确认的 context 能力。

R-01 至 R-04 的设计阻塞均已消除；具体状态字段、退避和故障测试按实施计划完成。

## R-04: Store 管理可见性，已确认

2026-11-14 用户明确 Engine 不负责数据可见性。builtin IPFS Store 不公开；复用 Kubo 时，由节点管理者决定公开和网络/网关策略。

本次不在 Engine 增加发布/私有模式或加密方案，不修改 Kubo 管理配置。原有 Task API 请求授权及资源预算继续存在，但不能控制另一个 Store 入口的内容可见性。该职责取舍已解决，不再列为实施前阻塞。

## 已保留的其他决定

- data/cidPaths 自包含、判别 union 推导位置、真 IPLD 强引用，不退回正式载荷弱引用。
- parameters/message/result 全量切换，Worker Space 移除，CID 内容访问与轻量 ContentRef 分离。
- ipfs-access、ipfs-payload、按需 ipfs-tree、ipfs-store 分工；文件/目录 DU、资源 raw/UnixFS 与结构化 DAG 编码分层。
- 已有 Schema/API 版本不递增；不自动重写历史制品或删除旧数据库。
- 文档语义引用图不自动解释，pin 不是权限、业务完成证明或异地备份。

## 生命周期

用户明确授权主 Agent 负责全部门限审批，并安排 subagent 按顺序实施各 iteration。主 Agent 仍须验证准确修订、同步 primary 并记录对应 submit/accept；授权不等于跳过验证或预先宣称后续实施完成。

中间 iteration 及本 Idea Deployment 只做本地验收，不发 RC。全部 iteration 完成后再进入统一 RC 发布及 Smoke 阶段，遵守仓库逐包 Actions 发布规则，不用本地 publish 或批量发布替代该流程。
