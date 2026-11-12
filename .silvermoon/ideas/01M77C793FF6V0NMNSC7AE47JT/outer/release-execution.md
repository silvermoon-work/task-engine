# Kubo RC 与 Ubuntu 消费执行证据

本文服务于
[Deployment](./Deployment.md)。用户授权父 Agent 审批门禁、发布新 RC 及隔离 smoke；不从 Git、测试或 Agent 叙述推断验收。已接受 Inner 固定为
`c76d42ef88ea485d2a198c4e9852c93cf5ca6b3c`。

## 发布准备：已验证，尚未发布

[发布计划](./release-plan.md)
明确五包和顺序，[发布前观察](./release-preflight.json)
为远端真实 registry 结果：五候选 exact 均为 404，latest／canary／原 rc 已记录；五个新 Git
tag 查询均为空。Protocol / SDK `0.2.0-rc.1` 已可见，不发布计划外依赖。

本机 npm／pnpm 有效 registry 均为 Tencent，`nrm current` 为
`tencent-cloud`；只用 package
manager 更新五个 manifest 的 version，未创建 tag、运行 hook 或改变依赖字段。随后
`pnpm install --frozen-lockfile` 通过，lockfile 无变化，`pnpm test:release`
**21/21** 通过。

版本候选运行代码与已接受实现相同。仅将五个 version
manifest 的归档传入已归属本会话的 Ubuntu 源码验证目录；归档 SHA-256
`d9fbe234eccd13d442f73d2316b1eefbea931e897dd8a9633c63b0a457b17dcd`
核对通过。Node.js **24.11.1** 下完整 `pnpm check` 再次**退出 0**：Turbo
**44/44** 成功、8 个缓存命中、用时
**9m23.161s**，最终测试类型检查与全部 publint 通过。原始 `release-check.log`
SHA-256 为 `401be144c38fb8d0c77c85bdc3ecbc49974556c4ef8b57c9edebc88448178052`。

其后只补充 Outer 验证驱动／证据，以及两份 README 中与新后端不符的旧 SQLite／pin 绝对描述，不改运行源码、断言、依赖或已接受 Inner。README 格式检查、两份驱动
`node --check`
通过。证据目录原本被默认 Prettier 忽略，另用显式空 ignore 路径格式化驱动和本轮 Outer 文档，不宣称忽略文件被默认全量格式检查覆盖。

## 固定驱动，等待准确 V CI

- [observe-rc.mjs](./observe-rc.mjs)：只读复核精确版本、依赖、未变渠道、实际 tarball 摘要及公开 SLSA 的精确仓库／tag／workflow／commit；不安装或执行下载的包。
- [registry-kubo-smoke.mjs](./registry-kubo-smoke.mjs)：只从全新 consumer 的 registry 安装路径加载公开 API／CLI，使用专用真实 Kubo
  0.43.1，覆盖文件字节、两个 SQLite
  Engine、重启／GC／prune、外部清理、断连和 managed CLI。

初始准备时，两份驱动仅完成语法及审阅，尚未执行 registry RC
smoke；当时不勾选 D-* 或推断 Outer 完成。以下追加实际发生的结果。

## 固定 V 与准确 main CI：通过

V 固定为 `95b1cdbf76c70faf550b174fff97ca7df4d830cb`，普通 push 到 main。其
[CI 43246255308](https://github.com/silvermoon-work/task-engine/actions/runs/43246255308)
的 SHA／push 事件／main 分支和两个 Node
job、版本化 aggregate 及准确 step 均成功，完整结构见
[release-ci.json](./release-ci.json)。每次创建 tag 前刷新 primary 并证明 V 为其祖先，不追移动 HEAD。

## 五包逐一发布：全部通过

| 顺序 | 包与精确版本                | tag Actions                                                                            |
| ---- | --------------------------- | -------------------------------------------------------------------------------------- |
| 1    | ipfs-store 0.1.0-rc.2       | [43248509677](https://github.com/silvermoon-work/task-engine/actions/runs/43248509677) |
| 2    | task-builder 0.2.0-rc.3     | [43249395260](https://github.com/silvermoon-work/task-engine/actions/runs/43249395260) |
| 3    | task-builder-cli 0.2.0-rc.3 | [43250436919](https://github.com/silvermoon-work/task-engine/actions/runs/43250436919) |
| 4    | task-engine 0.2.0-rc.3      | [43251106592](https://github.com/silvermoon-work/task-engine/actions/runs/43251106592) |
| 5    | task-engine-cli 0.2.0-rc.11 | [43252118292](https://github.com/silvermoon-work/task-engine/actions/runs/43252118292) |

五次均为固定 V、唯一 package-specific tag、push 事件的成功 Actions，汇总见
[publication-actions.json](./publication-actions.json)。每次前一包 exact
record 和 artifact 来源已核对后才推下一 tag，包含 Engine 的 Builder CLI
development-only 前置边；未自动发布计划外依赖。

逐包原始 registry／实际 tarball 摘要／公开 SLSA 字段回执：
[Store](./ipfs-store-publication.json)、
[Builder](./task-builder-publication.json)、
[Builder CLI](./task-builder-cli-publication.json)、
[Engine](./task-engine-publication.json)、
[Engine CLI](./task-engine-cli-publication.json)。所有 tarball
SHA-1／SHA-512 与 registry 相符，Trusted
Publisher 标记存在，公开 SLSA 的精确仓库／workflow／tag／gitCommit=V 及 subject 摘要匹配；不把字段核对描述为自行验证了完整签名信任链。全部 latest 和历史 canary 未变，仅 rc 推进。

首包 Actions 成功先于 registry exact
record／rc 元数据可见：首个两分钟观察窗口返回 propagation
pending 后停止，随后同一精确 endpoint 已为 200，来源核对通过。没有重发包、rerun
publish 或移动 tag；后续观察只作有界只读等待。

## Ubuntu 消费准备：待执行

在远端已创建带 session／uid／V marker 的独立目录，Kubo
0.43.1 压缩包 SHA-256 与官方 asset digest 一致，仅解压，没有启动任何 daemon。

Smoke 驱动在实际执行前增加 PeerID 与本次 repo 配置一致的检查，防止随机端口争用时误操作其他服务；不是产品改动。新
[prepare-consumer.mjs](./prepare-consumer.mjs)
只从 registry 安装精确包并核对 lock／路径。两者语法检查通过，待同步本次 Outer
revision 后才执行。源码验证、下载工具和五包发布均不替代 registry
smoke；该准备点的 D-S03、D-AC* 仍未完成。

## Ubuntu 首轮：安装通过，ESM 驱动入口错误

在 primary `dc95ea2f08fb25f35afe1decc964a7b114d95055`、Outer `71c328c338eb`
同步重观察后，实际执行新 consumer 安装。见
[ubuntu-bootstrap.json](./ubuntu-bootstrap.json)：五个新 RC、既有 Protocol／SDK／Storage 的精确版本、registry
URL、lock
integrity 和非 symlink 路径核对通过。没有 workspace、源码或本地 tarball 替代；包安装没有修改真实 HOME／registry。

首轮驱动退出 1，原始 [stderr](./ubuntu-first-error.txt) 和
[状态回执](./ubuntu-first-result.json) 保留。原因是验证驱动用 CommonJS
`require.resolve` 去解析只声明 ESM import 条件的入口，触发
`ERR_PACKAGE_PATH_NOT_EXPORTED`；这不构成已发布 ESM
API 不可用的证据。失败发生在 fixture 初始化之前，远端确认 `work`
目录不存在，没有启动本轮 Kubo 或 Engine。

只修正 Outer 驱动：将其复制到 consumer 内，以标准 ESM `import()`
解析公开包和已安装依赖；增加实际执行位置断言。所有版本、运行代码、功能断言和已接受 Inner／Ideal 不变。先同步新的 Outer
revision，再在全新 nonce
consumer 中重装相同精确版本并完整重跑，不复用失败目录的暖缓存。D-AC01 的发布／安装来源证明已满足；D-S03、D-AC02/03 不勾选。

## Ubuntu 二轮：Builder 正确拒绝无效输入 Schema

在 primary `99019900ee5809ad869d1c33702bbfab7ef422b3`、Outer `9264a2abe7c5`
同步重观察后，创建新的 nonce consumer，重装相同八个精确版本，见
[ubuntu-bootstrap-replay.json](./ubuntu-bootstrap-replay.json)。实际 ESM 加载及 Store 构造身份核对通过，默认 local 在 daemon 启动前读写成功。

[ubuntu-second-result.json](./ubuntu-second-result.json)
退出 1：驱动错误地把 Task input Schema 写为布尔
`true`，Builder 按既有公开契约返回
`Task input Schema must be an object.`。不修改 Builder 或弱化校验，仅将夹具输入 Schema 改为
`{ type: "object" }`，与既有真实调用一致。二轮 finally 确认自建 Kubo 已退出，尚未运行 Engine 或 managed
CLI。

本次还增加自建 daemon 的 PID／退出码记录，便于后续明确核对资源释放。所有功能目标、包版本、运行源码和已接受 Inner／Ideal 不变；再次同步新 Outer 后在第三个全新 consumer 完整重跑。此刻只有已观察的两组检查通过，不勾选剩余部署标准。
