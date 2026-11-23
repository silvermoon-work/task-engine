# 真实发布与已发布包 smoke test

本文支撑
[Deployment](Deployment.md)，不是另一份验收契约。实际包名、版本与 release
commit 必须根据 ready 的实现填写，不能从示意命令推断。

## 代码交接包清单

本次实现的目标制品为以下两个明确映射的公开包，版本仍是未发布候选：

| 顺序 | Package ID        | npm 名称                           | 候选版本                | 发布理由                                                                                 |
| ---- | ----------------- | ---------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| 1    | `task-engine`     | `@silvermoon-work/task-engine`     | `0.1.0-canary-261109-2` | 提供 `drain`、公开 `MemoryStore` 和 Gateway `close`，CLI 依赖这些新能力                  |
| 2    | `task-engine-cli` | `@silvermoon-work/task-engine-cli` | `0.1.0-canary-261109-1` | 提供 `runBundle`、`main` 与 `task-engine` bin，需要首次发布身份及 Trusted Publisher 就绪 |

`apps/task-engine` 仅为 private launcher，不发包。protocol 本次未修改，依赖现有
`@silvermoon-work/task-protocol@0.1.0-canary-261109-2`；仍需在真正发布前检查该版本和所有 packed
runtime/peer 依赖确实可用。engine 必须先发布，否则 CLI 的 packed 精确依赖不能通过现有发布守卫。选择真实版本前重新检查 registry 与不可变 Git 标签是否占用候选版本，不能移动或复用标签。准确 main
SHA 和 CI 链接在同步实现之后记录；当前清单不冒充已发布或 CI 已成功事实。

## 本轮停止边界

用户已授权主 agent 自主处理门限，并要求本轮只推进到
`deploying`。Implementation 就绪、验证、同步和验收后，进入部署阶段但不接受 Outer
World，不把首次初始化或本地 smoke test 当作 deployment 完成。

首次发包需要等待用户安排的另一 agent；它负责新增包初发及 Trusted
Publisher 配置。主 agent 提供已 ready 的包身份、映射、依赖闭包、main
commit 和 CI 证据，不会在此之前抢先创建发布标签、使用 token、本地发布或绕过 OIDC。初始化占位版本若仅用于注册包身份，不证明本次功能已经发布。

## 发布门槛

遵循仓库 [单包发布流程](../../../../README.md#publish-one-package)、
[发布映射](../../../../scripts/release-packages.js) 和
[publish 工作流](../../../../.github/workflows/publish-npm.yaml)：

1. 明确要发布的可公开包、准确版本和依赖顺序；根包与 apps 保持 private。
2. 对被本次修改且需进入消费者依赖闭包的库分别选择新版本；内部 runtime/peer/optional 依赖必须已经真实发布并满足 packed
   manifest。不能让 CLI 运行到 registry 中尚未包含新能力的旧 engine。
3. 每个包单独对应不可变 `<package-id>-v<version>` 标签。标签、tagged
   manifest 和 packed manifest 身份及版本一致，包括 prerelease。
4. 发布提交可从 main 到达，并有准确 SHA 的 main push CI 成功证据。手动 workflow
   dispatch 只做 dry run，不能证明真实发布。
5. 通过 Trusted
   Publishing 验证并发布同一份 tarball；不能使用保存的 token，不能移动失败标签或覆盖已经存在的版本。

发布、依赖发布与标签授权只在具备准确目标及前置条件后执行，不自动批量发布。部署开始前先同步这份契约，随后对该准确 deployment
revision 执行并记录证据。

## 网络与发布前置条件

依赖安装遵循执行环境的 registry 配置，仓库不固定设备级镜像策略。
消费者安装前检查有效 registry、scope override 及 lockfile download URL，
保留合法私有 scope 配置。发布元数据检查与 Trusted Publishing 使用 npm 官方
registry；不可用时明确报告阻塞。本轮不做发布，真实发布仍须另行授权。

## 本地 CAR 的发布验收

包含 `--car`
的新 CLI 必须从 registry 安装后重新验证；现有 builder 发布结果不证明 CLI 已发布。本地模式复用
`@silvermoon-work/task-builder@0.1.0-canary-261109-2` 的 `./car`
runtime 依赖，不需要安装 builder
CLI 来运行 CAR，也不新增独立 CAR 格式。发布时确保 packed
dependency 与该已发布核心版本一致。

smoke 增加 `task-engine run --car <file> --input <file>`
的单任务和多层子任务场景，证明不需要 Gateway、用户宿主脚本或网络 fallback。验证完整校验、expected
CID 不符、损坏内容、默认子权限拒绝、业务失败、整次超时、中断，以及最后的文件句柄和内存释放。还需确保 CID/Gateway 路径兼容，没有将 CAR 路径变成任务身份。

## 当前已验证的发布前置

2026-11-09 已独立安装并验证新发布的 builder `0.1.0-canary-261109-2` 与 builder
CLI `0.1.0-canary-261109-1`，默认与大资源的 Init → Build → CAR → Check
→ 已发布旧 engine Worker 兼容路径通过。具体发布来源、integrity、命令及边界见
[已发布 builder 验证](published-builder-verification.md)。

这两个包不是上面的 engine / engine
CLI 发布目标。当时 registry 尚未提供新 engine 的准确候选版本或 engine
CLI；不得以 builder 发布成功、旧 engine 可运行，或本地新 CLI 测试通过勾选 D-*。

## 已发布包验证环境

使用仓库外的新建 consumer 目录，支持的 Node 与包管理器，固定已发布版本。安装命令来自有效 registry，不使用
`workspace:*`、本地 link、`file:`
依赖、本地 tarball 或仓库构建结果作为替代。记录实际依赖树和入口解析路径，确保所有被测试的新 API 来自已发布依赖版本。安装成功不等于功能成功；mirror 尚未同步版本时明确等待或报告，不静默改测旧版本。

为 smoke
test 准备受控 Gateway 和固定 CID 的真实 Bundle，包括一个有限单任务、一个至少两层派生的任务包，以及可重复的失败/中断场景。需要内容源不等于需要预先启动 task-engine
HTTP service。测试只能操作属于该 consumer 的运行域和资源。

## 必须保存的证据

实际执行后在 Outer World 支持文档中记录：

- Node、OS、包管理器版本，有效 registry 和执行时间。
- 包名、准确版本、dist-tag、registry integrity 及解析出的完整依赖版本。
- release main SHA、exact-commit CI run、不可变标签、实际成功 publish run。
- fresh consumer 安装命令、依赖树、公共入口解析结果。
- 单任务与多层派生的命令、预期结果、实际汇总、终态及自然退出码。
- 任务失败和中断的非零退出码及诊断，以及对共享内容源的非破坏性结果。

真实 CLI 子进程要在有限预算内自然退出；到预算后被测试工具杀掉属于失败，不能据此勾选自动退出标准。没有在 registry 安装的真实新版本，或仅有本地/packed 制品验证时，所有发布相关验收条目保持未完成。
