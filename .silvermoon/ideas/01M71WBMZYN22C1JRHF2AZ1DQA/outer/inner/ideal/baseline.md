# 已批准设计基线与审查边界

本世界内的 [需求模型](./task-engine-cli-requirements.md) 和
[CLI Spec v1.0](./task-engine-cli-spec.html) 是仓库 `docs` 下同名权威文档的逐字节规范副本，
来源为设计提交 `91130a8`，2026-11-10 19:37 定稿。二者共同绑定当前 idealRevision，
不是第二套接口设计；不得独立修改副本造成分歧。未来产品变更必须明确审查并同步权威文档与副本，
重新提交受影响的构想版本，不能让仓库外层文档的移动引用暗中改变已验收范围。

副本中的“本次不实现代码、不修改 Idea”描述的是 19:37 设计定稿操作的授权边界，
不表示未来实施已获生命周期验收，也不撤销用户随后 19:45 的实施/部署委托。
本次只准备对齐并提交构想，等待父代理验收；不实施、不发布、不记录任何 accept*。

用户 19:45 委托父代理负责各阶段门限审查，由唯一实施/部署 subagent 推进工作。
父代理依据该委托审查精确 idealRevision、implementationRevision 和 deploymentRevision，
不得把委托或设计批准写成用户已亲自审阅未来代码或部署结果。

后续 canary 发布、本地安装和 smoke 已获用户授权，仍须父代理核实具体候选并作最终 canary 审批。
只按显式包映射逐包发布，不批量、不自动发布依赖；不发布 stable、不 force push、不移动 tag。
本机沿用 NRM 的 Tencent registry；镜像缺包不能证明官方未发布，也不得据此回退官方 registry。

本构想不再包含 Builder 需求或 dry-run、TUI、Credential 等旧候选范围；
旧支持文档从本候选移除，历史可由 Git 查询。并行 Builder 的文件、版本和独立 Idea 不受本次变更影响。
