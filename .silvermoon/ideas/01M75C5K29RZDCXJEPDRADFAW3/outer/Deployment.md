# Deployment

用户已授权本轮通过 GitHub Actions 发布新的 RC，并连接指定 Ubuntu 设备验证；实现与部署门禁由主 Agent 根据证据验收。本契约只覆盖本地 raw gateway，不推进后续 Idea。

外部演练使用同步后的 [Ubuntu 验证脚本](verify-ubuntu.mjs)，安装依赖和执行结果记录在本世界的部署证据中。脚本只从当前独立 consumer 的 registry 安装解析包，不读取仓库源码。

## Steps

### D-S01: 发布 CLI RC

仅发布映射包 `@silvermoon-work/task-engine-cli@0.2.0-rc.1`，其余内部依赖沿用已发布的 `0.2.0-rc.0`。先同步版本到 main，等待准确提交的 main push CI 全部通过，再推送不可变 tag `task-engine-cli-v0.2.0-rc.1`，只由 `publish-npm.yaml` 执行 Trusted Publishing。已有版本或 tag 冲突必须停止；不移动 tag，不本地 publish，不变更 latest/canary 指针。

### D-S02: 配置 Ubuntu 隔离双节点环境

通过用户指定的 SSH 目标，在独立临时目录安装精确 registry RC，记录包完整性与工具版本；不改共享全局工具或其他服务。使用已发布 Builder 生成真实多 block CAR，启动两个独立受管进程。A 配置计数上游并通过 CAR 预置任务包后关闭上游，B 从空缓存开始且唯一上游为 A。显式 public 仅限 loopback；token 模式单独演练。

### D-S03: 执行独立校验与拒绝演练

由 B 经 CID 执行任务，逐块验证 A 的 raw bytes 与 multihash、HEAD、探测、条件缓存、未命中及 only-if-cached；再验证 token/disabled、损坏缓存与字节上限。保存非敏感、可重放的外部证据。停止所有自有进程，保留明确命名的证据；不删除或终止其他任务的资源。

## Acceptance criteria

### D-AC01: RC 发布身份与渠道正确

记录准确提交 CI、tag、发布 Actions、npm 精确版本与安装锁完整性；CLI 的 rc 指向新版本，而发布前 latest=`0.1.0`、canary=`0.2.0-canary-261111-1` 保持不变。精确版本与 tarball manifest 匹配，不能以本地工作区或上传 tarball 代替 registry 安装。

### D-AC02: 缓存共享实际可用

保存产物版本、可重放命令、两个进程身份、任务结果及逐块 CID 校验证据，证明 B 仅依赖 A 就能执行成功；默认禁用的 B 不暴露缓存。

### D-AC03: 不回源且访问与预算边界成立

记录计数上游在全部相关请求前后的零调用、关闭上游后读取成功，以及 GET/HEAD 404、only-if-cached 412、未授权 401、禁用 404、损坏 500、字节超限 413 等结果。token 不写入证据；超时/并发/取消的确定性实现测试与外部冒烟分开陈述，不将未执行的远程压力测试称为通过。
