# Deployment

实现已由获授权父 Agent 接受为
`c76d42ef88ea485d2a198c4e9852c93cf5ca6b3c`。用户授权发布新 RC，并在
`scottwei@office-ubuntu` 隔离消费；实际版本、顺序及验证矩阵见
[发布与隔离验证计划](./release-plan.md)。不操作共享生产 daemon，真实 npm 发布仅经仓库 Actions；源码验证不冒充 registry
smoke。

## Steps

### D-S01: 准备受控 daemon 环境

冻结五个显式映射包的精确 RC、所有依赖字段的发布顺序和单一发布提交 V；等待 V 的准确 main
push CI 成功。固定已验证 Node.js 24.11.1、Kubo 0.43.1、私有协调目录和专用 daemon
repo，禁止操作其他实例。

### D-S02: 逐包发布授权 RC

每次仅推一个固定 V 的 package-specific
tag，验证其 Actions、精确 registry 记录、依赖、tarball
integrity 和 provenance 后再继续下一包；不移动 tag，不改变 latest 或历史渠道，不本地 publish。

### D-S03: 隔离消费与故障验证

在远端全新目录从 registry 安装精确 RC，分别验证默认 local、真实 Kubo、持久 Task/Run 根、prune、外部清理、断连与 close。保留失败和修正记录，确认测试自建进程均释放，不把工具链连通或源码测试当作部署结果。

## Acceptance criteria

### D-AC01: 精确 RC 与来源可复核

五个精确版本均经固定 V 的 tag Actions 发布，registry
metadata、实际下载 tarball 摘要及公开 provenance 与版本和 V 一致；latest／历史渠道不变，消费者不是 workspace、源码或本地 tarball 替代。

### D-AC02: 可选部署与内容保真

记录实际工具版本和 consumer 清单，证明无 daemon 时 local 可用、统一 Store 可供已发布 Builder/Engine 消费，真实 Kubo 导入前后块字节及根 CID 相同；Kubo 宿主目录和业务数据库没有额外块/CAR 副本。

### D-AC03: 保留与故障可复核

在专用测试 repo 证明无外部干预时 Task/Run 的 bundle/output 在重启和正常 GC 后可读，最后一个协调引用被 prune 后清除本系统具名 pin，其他可见名称及标记失败不会主动清除；人工删 pin／块后依赖读取真实恢复或报错，记录部分成功恢复而不承诺绝对保留。关闭 Store 后 daemon 仍响应，RPC 不可达使依赖请求报错，联网模式由用户启动 daemon 时配置。

结果：五包 tag
Actions、精确 registry/tarball/provenance 与未变历史渠道均已核对；新 Ubuntu
consumer 的完整真实 smoke **11/11** 通过，两个前置驱动错误保留。使用 Node.js
24.11.1／Kubo
0.43.1，不宣称覆盖未测试运行时或任意远程认证代理。四次自建 Kubo 及 managed
PID 均已物理退出；详见
[执行证据](./release-execution.md)、[完整结果](./ubuntu-third-result.json)、[资源后检](./ubuntu-postcheck.json)
和
[最终 registry 状态](./registry-final-state.json)。这些结果仍需父 Agent 对准确 Outer
revision 记录审批，不从 ledger 勾选推断验收。
