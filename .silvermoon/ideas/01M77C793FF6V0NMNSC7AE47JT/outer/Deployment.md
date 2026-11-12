# Deployment

准备阶段初版，尚无外部执行证据，不属于构想验收范围。后续只在获授权的隔离测试环境验证，不操作共享生产 daemon 或发布 npm。

## Steps

### D-S01: 准备受控 daemon 环境

固定 Kubo 版本、RPC 访问保护、用户配置的联网模式及协调所有权边界，使用专用测试 repo、独立宿主目录和两个参与协调的 Engine。

### D-S02: 对照真实持久化与恢复

分别验证无 Kubo 的默认 local 和真实 Kubo 后端，观察持久化引用、prune 标记清除、重启、受控 GC、partial DAG、共享根与关闭行为。

## Acceptance criteria

### D-AC01: 可选部署与内容保真

记录实际版本和两种宿主运行结果，证明无 daemon 时 local 可用，Kubo 导入前后块字节及根 CID 相同，宿主测试目录没有额外块副本。

### D-AC02: 保留与故障可复核

在专用测试 repo 证明保留 Task/Run 的 bundle/output 在重启和 GC 后可读，最后一个协调引用被 prune 后可 unpin，其他 Engine 或外部保留及标记失败不会误清除；记录部分成功恢复。关闭 Store 后 daemon 仍响应，RPC 不可达使依赖请求报错，联网模式由用户启动 daemon 时配置。
