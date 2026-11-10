# Deployment

准备阶段的轻量初版，尚未部署。用户已授权后续 canary 发布、本地安装和 smoke，
父代理负责精确版本门限与最终 canary 审批；构想或设计通过均不代替实施、部署验收。
待验证的四包计划为 protocol→SDK→Engine→CLI：前三包
`0.1.0-canary-261110-1`，CLI `0.1.0-canary-261110-2`。
这只是明确候选，不预填发布或安装成功；四个映射之外的包不得自动发布。

## Steps

### D-S01: 核实精确 canary 发布候选

在部署契约同步后核实已审查精确版本、main 可达提交及该提交 main push CI 的
Release verification (v1)，逐包核对映射和已发布准确内部 runtime/peer 及 verifier
检查的 dev workspace 依赖。Builder core 当日 1 已确认；Builder CLI 当日 1 的
官方只读检查仍报 missing，相关 Engine/CLI 发布必须先停在此前置条件，
交父代理另行协调，不能绕过 verifier 或自动发布该额外依赖。

### D-S02: 发布并本地安装 canary

经父代理最终审批后，通过不可变单包 canary tag 和 Trusted Publishing 工作流，
验证并发布同一次 pack 的 tarball；manual workflow 仅 dry-run，不能替代发布。
每次仅一个映射 tag，严格按 protocol 1→SDK 1→Engine 1→CLI 2；
每步确认准确版本已可用且依赖验证通过后才进入下一步，不批量推 tag。
本机遵循 NRM 的 Tencent 镜像，不覆盖或回退官方 registry；仅安装已核实的 canary。

### D-S03: 验证安装后的真实运行闭环

从安装入口验证帮助、配置、本地服务启停、CAR/CID 执行、查询/日志/await、
重启持久化和离线清理；保存版本、外部命令结果及资源释放证据供父代理验收，
不以仓库内测试或示例替代真实运行。

## Acceptance criteria

### D-AC01: 单包发布证据精确一致

通过精确 main CI、不可变 tag、工作流、tarball 及 registry 版本证据证明同一 canary
已发布，包身份及完整版本一致，内部依赖准确可用；无 stable、批量发布、移动 tag 或 force push。
证据须逐包覆盖上述四个精确版本，包含 verifier 要求的内部 dev 依赖；
任何 tag/版本已占用或准确依赖缺失都阻断，不以镜像 E404 推断官方未发布。

### D-AC02: 本地安装入口可独立使用

通过本地安装记录、解析后的可执行入口及版本/帮助输出证明安装的是指定 canary，
不是仓库源码或旧入口；配置与默认路径符合 Spec，消费端不依赖 Builder 编译工具。

### D-AC03: 真实生命周期与数据闭环成立

通过安装后 smoke 的 JSON、退出码、任务标识及重启前后读取/清理证据证明执行结果、
完整释放、持久历史/日志/缓存和本地停机正确；残留或不可确认事项如实失败并交父代理审查。
