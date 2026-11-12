# Deployment

轻量部署初版，尚无本 Idea 的产品外部验证证据。用户已授权实现通过门禁后发布新 RC，并在 `scottwei@office-ubuntu` 的隔离环境 smoke test；不操作共享生产 daemon，真实 npm 发布仅经仓库 Actions。

## Steps

### D-S01: 准备受控 daemon 环境

固定 Kubo 版本、RPC 访问保护、用户配置的联网模式及具名 pin 约定，使用专用测试 repo、独立宿主目录和两个参与协调的 Engine。部署阶段再冻结实际受影响包的精确 RC 版本、逐包顺序与 main CI 提交。

### D-S02: 对照真实持久化与恢复

分别验证无 Kubo 的默认 local 和真实 Kubo 后端，观察持久化引用、prune 标记清除、重启、受控 GC、partial DAG、共享根与关闭行为。

## Acceptance criteria

### D-AC01: 可选部署与内容保真

记录实际版本和两种宿主运行结果，证明无 daemon 时 local 可用，Kubo 导入前后块字节及根 CID 相同，宿主测试目录没有额外块副本。

### D-AC02: 保留与故障可复核

在专用测试 repo 证明无外部干预时 Task/Run 的 bundle/output 在重启和正常 GC 后可读，最后一个协调引用被 prune 后清除本系统具名 pin，其他可见名称及标记失败不会主动清除；人工删 pin／块后依赖读取真实恢复或报错，记录部分成功恢复而不承诺绝对保留。关闭 Store 后 daemon 仍响应，RPC 不可达使依赖请求报错，联网模式由用户启动 daemon 时配置。
