# Deployment

准备阶段初版，尚无外部执行证据，不属于构想验收范围。后续只在获授权的隔离测试环境验证，不操作共享生产 daemon 或发布 npm。

## Steps

### D-S01: 准备受控 daemon 环境

固定 Kubo 版本、RPC 可达范围、联网与保留策略，使用专用测试 repo 及独立宿主目录。

### D-S02: 对照真实持久化与恢复

分别验证无 Kubo 的默认 local 和真实 Kubo 后端，观察重启、受控 GC、partial DAG、共享根与关闭行为。

## Acceptance criteria

### D-AC01: 可选部署与内容保真

记录实际版本和两种宿主运行结果，证明无 daemon 时 local 可用，Kubo 导入前后块字节及根 CID 相同，宿主测试目录没有额外块副本。

### D-AC02: 保留与故障可复核

在专用测试 repo 记录保留确认、daemon 重启及 GC 后结果、未完成导入恢复和共享根不被错误释放的证据；关闭 Store 后 daemon 仍响应，缺块与断连显式失败且联网符合选定策略。
