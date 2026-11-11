# Deployment

用户要求沿用上一轮由 subagent 实施、主 Agent 审批 impl/deploy 并推进到 completed 的流程。本轮使用新 CLI RC 与指定 Ubuntu 设备进行隔离验证；只验证显式 block-scope CAR/path profile，不声明完整 DAG、文件范围、递归回源或 IPNS。

## Steps

### D-S01: 准备独立路径查询客户端

主 Agent 完成实现复核后，选择唯一受影响映射包的新 RC，确认历史版本/tag 未占用。发布前同步准确版本到 main，并等待准确提交 main push CI 全部通过；只经 package-specific 不可变 tag 和 `publish-npm.yaml` Trusted Publishing 发布，保留 latest/canary 指针。通过指定 SSH 设备，在专用临时 consumer 普通安装精确 registry 版本，不改共享工具或服务。

本轮仅发布 `@silvermoon-work/task-engine-cli@0.2.0-rc.2`，tag 为 `task-engine-cli-v0.2.0-rc.2`；其余内部依赖沿用已发布 `0.2.0-rc.0`。发布前观察到 latest=`0.1.0`、canary=`0.2.0-canary-261111-1`、rc=`0.2.0-rc.1`。若精确版本/tag 已占用则停止，不移动已有 tag。

准备真实任务 bundle 和带多层目录的任务输出，记录请求根 CID 与路径。独立客户端使用既有 CAR 读取器及 Kubo，从请求根验证路径关系，不相信 CAR roots 或服务端附带的终点声明。

### D-S02: 演练成功和中断传输

执行根及多层路径的 block-scope CAR GET/HEAD、协商与探测，并确认只包含路径证明和终点 blocks，而不是完整后代。对缺块、篡改证明、删除中间节点和中断传输分别验证失败；记录缓存未命中和 only-if-cached 行为、零回源观测及 raw 回归。

验证要求、脚本及预算先同步主分支，再运行外部检查；结果保存在本世界的简洁证据。停止所有自有进程，删除精确命名的测试目录、Kubo 仓库、证书、CAR 和随机 fixture；不得终止或删除其他工作。

## Acceptance criteria

### D-AC01: 外部客户端验证路径

记录准确提交 CI、发布 Actions、不可变 tag、精确 registry 版本、安装锁 integrity 与历史渠道不变的证据。客户端从请求根验证多层路径，校验每个 block 的 multihash 及原始 bytes；终点及路径与独立准备的 fixture 一致，删除/篡改证明后不能通过。HEAD 无 body，响应实际内容与声明 scope/版本/顺序/去重一致。

### D-AC02: 不完整传输明确失败

根缺失在响应开始前收到正确错误，输出后缺块/断连不被客户端接受为完整证明；不支持的 scope/变体明确拒绝，不能静默降级。请求计数证明路径查询与失败不向上游拉取，raw 兼容保留。结束后自有 listener 均关闭、进程停止、测试目录不存在；本地确定性资源测试和外部观测分开陈述，不将未执行的压力测试称为通过。
