# 发布 CLI 制品并验证已发布包的单次执行

用户要求 deployment 使用真实发包和已发布包 smoke
test，而非只验证本地构建或 tarball。本轮只推进到
`deploying`；代码 ready 后，首次发包及 Trusted
Publisher 配置由用户安排的另一 agent 完成。在该外部前置条件满足前，不执行发布、不声称 deployment 完成。详见
[发布与已发布包验证](publication-smoke-plan.md)。

## Steps

### D-S01: 确认首次发布与可信发布就绪

代码 ready 后交接确切包身份、发布映射、依赖顺序、main
commit 和 CI 证据。等待另一 agent 完成新增包的首次发布及 Trusted
Publisher 配置；确认发布所需网络策略、仓库环境与 OIDC 绑定均满足要求。

### D-S02: 通过标准流程真实发布指定包

外部前置条件满足后，按仓库标准发布流程对确切包和版本逐包发布。要求 main 可达、exact-commit
CI 成功、不可变标签、依赖版本已发布、同一份已验证 tarball 和 Trusted
Publishing；不批量发布，不以手工 dry run 代替真实发布。

### D-S03: 从 registry 安装并执行 smoke test

在独立 consumer 中仅使用 registry 安装的目标版本及其真实依赖，通过已安装的公共入口运行受控 Bundle 与多层子任务。验证自动退出、结果及失败诊断，记录实际环境、命令、包完整性与执行证据。

## Acceptance criteria

### D-AC01: 实际发布身份与来源可信

记录每个目标包的准确名称、版本、dist-tag、registry integrity、不可变标签、main
commit、成功 CI 与实际 publish run；证明已发布的是本次实现，不是占位首发。

### D-AC02: 已发布包可独立安装并运行

保留 fresh consumer 的安装记录和实际解析出的包版本，证明没有 workspace
link、本地 tarball、仓库 dist 或源码入口兜底；文档命令不依赖预启动 task-engine
HTTP service。

### D-AC03: 真实任务闭包与退出结果正确

使用已发布包记录单任务、多层派生、失败及中断的汇总和进程退出；证明最后一个子任务完整执行、成功退出码为 0、错误有非零退出码，并且不会关闭共享内容源。缺少任一必要证据时不提交或接受 Outer
World。
