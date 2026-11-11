# Deployment

用户已授权夜间按顺序自主推进：新 subagent 实施，主 Agent 独立审批门禁、发布 RC、连接指定 Ubuntu 设备验证并清理自有测试资源。不得开放公网监听、修改共享全局工具或绕过失败测试；真实 blocking issue 应保留现场并停止后续迭代。

外部回放使用已同步的 [公共包 CLI 回放](inner/replay.mjs) 与 [真实浏览器检查页](inner/browser.html)，不导入产品私有源码。协议套件固定 `ipfs/gateway-conformance v0.14.1` / `011d20bd61c4736e3301d35e8fe388773e492511`；固定选择器和数值阈值继承实现契约，不在外部失败后调整。

历史外部部署未通过的结果见 [阻塞证据与清理记录](deployment-blocker.md)。用户随后明确批准修正测量规则并继续：废弃“生命周期 peak RSS 减去当前 RSS”的阶段增长口径，不将 Node RSS 观测当成硬内存限制。新协议须先冻结并同步，再独立重验；D 清单保持未勾选，不追溯性放行旧结果。

## Steps

### D-S01: 在目标拓扑验证互操作

实现审查通过后，仅为实际受影响映射包选择未占用的新 RC；准确 main push CI 全部通过后，经不可变 package-specific tag 和 `publish-npm.yaml` Trusted Publishing 发布，保留 latest/canary 与历史版本。不本地 publish、不自动发布依赖、不移动 tag。

本轮仅发布 `@silvermoon-work/task-engine-cli@0.2.0-rc.5`，tag 为 `task-engine-cli-v0.2.0-rc.5`。发布前 latest=`0.1.0`、canary=`0.2.0-canary-261111-1`、rc=`0.2.0-rc.4`；内部依赖沿用已发布 `0.2.0-rc.0`。版本/tag 已占用则停止。

在指定 SSH 设备的专用临时 consumer 普通安装精确 registry RC，核对 manifest/lock integrity。使用已经固定的规范/suite 提交、fixtures 与适用测试矩阵，记录每项测试、实际结果和有范围依据的排除项，不能以跳过代替通过。

实际浏览器以独立 origin 验证 CORS、preflight、可读响应头、token/no-token 与缓存语义；可通过仅绑定 loopback 的自有 SSH tunnel 使用集成浏览器，不修改共享浏览器或设备工具。直接 HTTP 与本轮自有 TLS/HTTP2 代理分别验证流式语义；证书只作本轮显式信任，不关闭 TLS 验证。

### D-S02: 执行共载与故障演练

验证契约、脚本和修正后实现阶段预先冻结的数值负载/阈值先同步 primary，再执行同条件任务对照与网关共载。两个 arm 使用相同 Node、数据、任务、并发与热身，采用预先规定的配对顺序与至少三轮测量；采样当前 RSS、heapUsed/heapTotal、external/arrayBuffers，覆盖静默基线、负载、排空后窗口，报告有界样本和多轮趋势。生命周期 maxRSS 仅为诊断，不参与阶段增长计算；Worker 所在进程 RSS 与调用线程的 JS/external 指标必须明确区分，不把 ArrayBuffer 与 external 重复相加。

内存采用同条件配对的增量回归预算：各 arm 的本阶段采样峰值减去自身静默基线，再比较 treatment 与 control 的差异。128 MiB 保留为明确负载下的实验性增量预算，不是全进程 RSS 硬上限。具体采样节奏、覆盖检查、配对聚合与判定规则须在新测量前冻结，不缺样本默认为成功、不挑最佳一轮、不通过强制 GC 通过；多轮排空后趋势不能被称作无泄漏证明。应用的并发/块/队列/输出预算可确定性验证，OS/container 硬内存限制不在本实现中。

既有成功任务、延迟、并发、429、回收、故障分类等门限不因此放宽。另演练慢读、断连、GC/缺块、损坏缓存与可控 IO 故障；如修正协议仍失败则如实阻塞，而不是再次改门限。

只保留精简可重放的测试/指标/浏览器证据。完成后关闭自有 tunnel/listener、停止自有实例，删除本轮 consumer、suite 下载物、fixtures、证书、配置、Kubo repos、CAR 和随机载荷；不得终止或删除其他工作。

## Acceptance criteria

### D-AC01: 目标环境符合能力声明

准确提交 CI、不可变 tag、发布 Actions、精确 registry 身份/integrity 和历史渠道不变有证据。固定 suite 的全部适用测试通过，声明能力内失败不得改为排除；浏览器能按策略读取正确内容与暴露头，代理不破坏流式/CORS/缓存。适用传输要求有 TLS/HTTP2 协商证据，不冒充公开互联网部署。

### D-AC02: 共载与故障恢复达标

按先冻结的修正协议报告每个对照/共载 arm 的当前内存样本、阶段摘要、配对差异及排空后多轮趋势，采样覆盖有效且增量预算达标；不得将历史 maxRSS 差值当作阶段峰值，也不得据有限轮次宣称 RSS 硬限制或无泄漏。报告实际任务延迟/并发/回收时间；命中、缺块、存储错误及取消的观测可区分，正常任务在负载中和演练后均执行成功。资源回收与关闭验证有证据，不能仅以进程存活或 HTTP 200 判定。最终自有进程停止、listener 关闭、测试目录不存在。
