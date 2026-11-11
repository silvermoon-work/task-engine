# Deployment

用户已授权夜间按顺序自主推进：新 subagent 实施，主 Agent 独立审批门禁、发布 RC、连接指定 Ubuntu 设备验证并清理自有测试资源。不得开放公网监听、修改共享全局工具或绕过失败测试；真实 blocking issue 应保留现场并停止后续迭代。

## Steps

### D-S01: 在目标拓扑验证互操作

实现审查通过后，仅为实际受影响映射包选择未占用的新 RC；准确 main push CI 全部通过后，经不可变 package-specific tag 和 `publish-npm.yaml` Trusted Publishing 发布，保留 latest/canary 与历史版本。不本地 publish、不自动发布依赖、不移动 tag。

在指定 SSH 设备的专用临时 consumer 普通安装精确 registry RC，核对 manifest/lock integrity。使用已经固定的规范/suite 提交、fixtures 与适用测试矩阵，记录每项测试、实际结果和有范围依据的排除项，不能以跳过代替通过。

实际浏览器以独立 origin 验证 CORS、preflight、可读响应头、token/no-token 与缓存语义；可通过仅绑定 loopback 的自有 SSH tunnel 使用集成浏览器，不修改共享浏览器或设备工具。直接 HTTP 与本轮自有 TLS/HTTP2 代理分别验证流式语义；证书只作本轮显式信任，不关闭 TLS 验证。

### D-S02: 执行共载与故障演练

验证契约、脚本和实现阶段预先冻结的数值负载/阈值先同步 primary，再执行共载任务与网关流量。测量真实任务延迟、RSS 增长、活跃请求/并发上限、失败分类、输出量和回收时间；演练慢读、断连、GC/缺块、损坏缓存与可控 IO 故障。不得在看到失败后放宽阈值。

只保留精简可重放的测试/指标/浏览器证据。完成后关闭自有 tunnel/listener、停止自有实例，删除本轮 consumer、suite 下载物、fixtures、证书、配置、Kubo repos、CAR 和随机载荷；不得终止或删除其他工作。

## Acceptance criteria

### D-AC01: 目标环境符合能力声明

准确提交 CI、不可变 tag、发布 Actions、精确 registry 身份/integrity 和历史渠道不变有证据。固定 suite 的全部适用测试通过，声明能力内失败不得改为排除；浏览器能按策略读取正确内容与暴露头，代理不破坏流式/CORS/缓存。适用传输要求有 TLS/HTTP2 协商证据，不冒充公开互联网部署。

### D-AC02: 共载与故障恢复达标

按先冻结阈值报告实际任务延迟/RSS/并发/回收时间；命中、缺块、存储错误及取消的观测可区分，正常任务在负载中和演练后均执行成功。资源回落与关闭验证有证据，不能仅以进程存活或 HTTP 200 判定。最终自有进程停止、listener 关闭、测试目录不存在。
