# Deployment

沿用用户授权的顺序迭代：一个 subagent 实施，主 Agent 独立验收 impl/deploy，发布新 RC 并在指定 Ubuntu 设备验证，目标 completed。本轮仅覆盖完整 DAG scope，不包含字节范围、IPNS、回源或永久 pin。

外部验证使用先同步的 [Ubuntu scope 验证脚本](verify-scopes-ubuntu.mjs)；fixture 使用本 Idea 的独立公共库工具，并增加 3 MiB、多层分块文件。脚本只从临时 registry consumer 解析安装包，不导入仓库产品内部模块。

实际发布、独立恢复/枚举、工具修正及清理结果见 [部署验收证据](deployment-verification.md)；归档已观察结果不改变先前同步的验证要求。

## Steps

### D-S01: 部署已知完整与不完整数据集

独立实现审查通过后，仅为实际受影响映射包选择未占用的新 RC；main 的准确发布提交 CI 全部通过后，使用不可变 package-specific tag 由 `publish-npm.yaml` Trusted Publishing 发布，保留 latest/canary 与历史版本。不本地 publish，不自动发布依赖。

本轮唯一映射包为 `@silvermoon-work/task-engine-cli@0.2.0-rc.3`，tag 为 `task-engine-cli-v0.2.0-rc.3`；内部依赖沿用已发布 `0.2.0-rc.0`。发布前观察为 latest=`0.1.0`、canary=`0.2.0-canary-261111-1`、rc=`0.2.0-rc.2`；版本/tag 已占用则停止，不移动已有 tag。

通过指定 SSH 设备，在专用临时 consumer 普通安装精确 registry 版本，核对 manifest 与 lockfile integrity；不改共享工具、全局配置或现有服务。准备已知 CID 的多块大文件、多层目录、HAMT、共享子图、identity links 和声明支持的非 UnixFS DAG，记录独立预期集合及故意缺失的后代。仅向本轮自有缓存放入测试数据，不能通过其他网关补全。

### D-S02: 执行独立客户端恢复与枚举

验证契约与脚本先同步 primary，再用独立 CAR 读取器及空仓库离线 Kubo 请求/导入三种 scope 与缺省范围，恢复文件、枚举 HAMT 目录、比较实际 CID 集合、证明 entity 目录没有子文件内容。对缺块、并发移除和预算故障验证显式失败，区分本地确定性资源测试与远程实测结果。

保存简洁可重放证据后，停止全部自有进程，删除精确命名的临时 consumer、Kubo 仓库、CAR、fixture、配置与测试载荷；不得删除或终止其他工作。

## Acceptance criteria

### D-AC01: 真实客户端获取正确范围

记录准确提交 CI、不可变 tag、发布 Actions、精确 registry 包身份与 integrity、历史渠道不变。保存请求、CID 集合、文件校验值与 HAMT 目录清单；独立比较均与预期一致，缺省 all 与显式 all 等价，文件 entity 能完整恢复，目录 entity 不递归包含子文件载荷，非 UnixFS entity/all 与声明一致。

### D-AC02: 不完整缓存不被冒充完整

独立客户端拒绝缺失必要后代的不完整结果；并发移除不会被视为完整成功。计数上游在成功和失败路径始终零调用，关闭上游后本地获取仍成功。预算、取消、GC 证据如实区分，不宣称缓存完整性或严格进程隔离。最终确认自有 listener 关闭、进程停止、测试目录不存在；仅保留精简证据。
