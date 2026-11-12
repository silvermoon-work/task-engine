# Kubo RC 发布与隔离验证计划

本文件服务于同世界
[Deployment](./Deployment.md)。用户已授权父 Agent 审批门禁、发布新 RC 并在指定 Ubuntu 主机 smoke；实施已接受，本文不授权扩大到 stable、未列包、移动 tag、共享 daemon 或本地真实 publish。

## 明确的五包范围

| 顺序 | 映射 ID          | 精确版本    | 原因                                                                |
| ---- | ---------------- | ----------- | ------------------------------------------------------------------- |
| 1    | ipfs-store       | 0.1.0-rc.2  | Kubo 后端、严格配置、具名保留提示及恢复                             |
| 2    | task-builder     | 0.2.0-rc.3  | 对齐新的运行时 Store 依赖和公共类型，避免消费者加载两份 Store 身份  |
| 3    | task-builder-cli | 0.2.0-rc.3  | 对齐 Builder／Store 宿主配置；也是 Engine 的 devDependency 发布前置 |
| 4    | task-engine      | 0.2.0-rc.3  | Task/Run 根关联、恢复、输出与清除                                   |
| 5    | task-engine-cli  | 0.2.0-rc.11 | managed 配置、导入、输出、prune 和部分成功回执                      |

Protocol / SDK `0.2.0-rc.1` 已可见，不换号；Storage / HTTP /
Server 没有本轮运行实现变更，不自动发布。Storage 新增测试不构成发布新包的理由。若出现计划外未发布依赖，停止并重定范围，不自动连带发布。

[发布前观察](./release-preflight.json)
记录五个版本均为真实 404、原 rc/latest/canary 指针；同轮 `git ls-remote --tags`
确认五个新 tag 均不存在。每包发布前再次检查，不能把认证／传输失败解释成版本不存在。

## 固定提交与不可变发布

仅用 package manager 更新上述 manifest
version，不改运行代码、依赖字段或已接受 Inner。冻结版本提交为 V；其准确 main
push CI 须包含 Node.js 22.15.0、24.11.1 和成功 `Release verification (v1)` /
`Confirm required checks succeeded`。本地或另一 SHA 的检查不能代替它。

每次只创建 `<package-id>-v<精确版本>` 指向 V，通过 `publish-npm.yaml` 的 tag
push／Trusted
Publishing 发布。工作流构建依赖后只 pack 一次、校验该 tarball 的身份与所有内部 dependency 字段，再发布同一 tarball。依赖的精确版本未可见前，不推下一个包的 tag；registry 延迟只允许有界只读等待，不重发已存在版本或移动 tag。

逐包记录 Actions
URL、精确版本、包 SHA-1/SHA-512、实际 tarball 摘要、公开 provenance 的仓库／workflow／ref／gitCommit 及发布前后指针。只推进 rc，不更改 latest、历史 canary 或旧版本。

## Ubuntu smoke 的独立边界

- 使用新 nonce
  consumer，从远端现有 registry 安装五个精确 RC 及必要的既有精确 SDK／Storage。不得导入 workspace
  src/dist、使用本地 packed tarball 或用 mock Kubo 代替真实结果。
- 固定与 CI 相同的 Node.js
  24.11.1，仅对测试命令调整 PATH，不修改 NVM 默认版本或系统工具。源验证已观察到远端默认 Node
  24.22.2 的既有模块探针失败；该版本不宣称本轮通过。
- Kubo 固定 0.43.1 Linux amd64，官方 GitHub asset SHA-256
  `3f2bf974ab2a3ec6d997fac7d8cb46f59983a7cddd0b55ef998e6ce379155fb2`；核对后只解压到独立目录。专用空 repo、loopback
  RPC、无 swarm 的离线启动是测试者的部署选择，不是 Engine 的联网策略。
- 进程与数据均有本轮 ownership marker；只关闭本轮创建的 Store、Engine、managed
  Server 和 Kubo
  PID。CLI 可使用仅子进程生效的 HOME／内容配置隔离，包安装仍使用原 HOME／registry；不编辑用户真实配置。

## 必须观察的结果

1. registry 包版本、实际模块路径、lock/integrity 和来源一致；默认 local 无 Kubo 可用，Builder/Engine 共用新 Store 的同一构造身份。
2. 真实块和 DAG 保真，父节点先到的暂存导入可完成；Kubo 内容路径无应用
   `blocks`、SQLite 块载荷和 CAR 影子副本。作者产生的测试 CAR 是输入夹具，不计作 Store 缓存。
3. 两个参与 Engine 的共享根、保留历史 Run、重开和正常 GC、prune 最后引用、其他可见 pin
   name、人工清理及 RPC 断连行为符合 best-effort 契约；依赖失败明确，不影响无 IPFS 依赖的数据库查询。
4. 至少一轮已发布 managed
   CLI 的真实 CAR 提交、输出、停止／重启和离线 prune；关闭 Store 不停止 Kubo，不在 close 时 unpin，不调用产品级全局 GC。

任何运行产品失败必须保留证据并重新评估实现门禁／新 RC，不能只修改断言使通过。纯验证驱动错误可修驱动，但先同步新 Outer
revision 再完整重跑。
