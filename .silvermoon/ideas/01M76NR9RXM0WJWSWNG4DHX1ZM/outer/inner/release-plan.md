# RC 发布计划

此文件是实施阶段的部署可行性计划，不是发布证据或发布命令授权。本阶段不改包版本、不推 release tag、不发布。父 agent 验收精确 Inner World 后，部署阶段仍须同步精确部署契约并复核版本。

## 已观察版本与依赖顺序

2026-11-12 使用本机已配置的腾讯 npm registry 查询 `versions` 与 `dist-tags`，没有修改 registry。首次观察除 Engine CLI 的现有最高 RC 为 `0.2.0-rc.7`，下列包的最高 RC 均为 `0.2.0-rc.0`。随后普通 fast-forward 集成并发 IPNS 工作至 `f34c54c8e6a727f257fb456ad36817b09a412aa8`，其 Engine CLI manifest 已占用 `0.2.0-rc.8`，最终只读复核 registry 的 rc 也已为 `0.2.0-rc.8`。本 idea 因而计划下一版本 `0.2.0-rc.9`，绝不复用或覆盖 rc.8。

顺序依据各包 manifest 的 dependencies、devDependencies、peerDependencies、optionalDependencies 全部内部边；当前后两字段没有内部边。`workspace:*` 在打包时取各依赖的精确 manifest 版本，以下新版本尚未写入 manifest。

| 顺序 | package-id | 计划版本 | 前置内部包及字段 |
| --- | --- | --- | --- |
| 已存在，不重发 | task-protocol | 0.2.0-rc.0 | 无；本次协议不变 |
| 已存在，不重发 | task-sdk | 0.2.0-rc.0 | dependencies: task-protocol；SDK API 不变 |
| 已存在，不重发 | task-engine-storage | 0.2.0-rc.0 | dependencies: task-protocol；devDependencies: task-engine、task-builder-cli、task-sdk；运行时不加载 Engine |
| 已存在，不重发 | task-engine-http | 0.2.0-rc.0 | dependencies: task-protocol；devDependencies: task-engine、task-builder-cli、task-sdk；运行时不加载 Engine |
| 1 | task-builder | 0.2.0-rc.1 | dependencies: task-protocol；devDependencies: task-sdk |
| 2 | task-builder-cli | 0.2.0-rc.1 | dependencies: task-builder、task-protocol；devDependencies: task-sdk |
| 3 | task-engine | 0.2.0-rc.1 | dependencies: task-protocol；devDependencies: task-sdk、task-builder、task-builder-cli |
| 4 | task-engine-cli | 0.2.0-rc.9 | dependencies: task-engine、task-protocol；devDependencies: task-builder、task-builder-cli、task-sdk |
| 5（独立 Server 消费） | task-engine-server | 0.2.0-rc.1 | dependencies: task-protocol、task-engine、task-engine-http、task-engine-storage；devDependencies: task-builder-cli、task-sdk |

4 与 5 之间没有依赖边；CLI smoke 的最小发布闭包为 1–4，不依赖独立 Server 包。第 5 项只在父 agent 选择同时交付独立 Server 消费入口时发布，不自动扩大部署范围。保留 Protocol/SDK/Storage/HTTP 版本，因为它们的独立运行时 API 未改变；Storage/HTTP 只有 Engine 的开发依赖，没有新增 hook 运行时要求，不为统一版本或开发测试下限而重发。如果另行发布 Storage/HTTP，仍必须先满足其所有开发依赖的精确版本查询。

## 不变的发布与部署条件

- 先由父 agent 审阅上述顺序和每包精确版本；部署前重新查询并确认版本不存在、所有内部依赖精确版本已可见。如 registry 已前移，则更新计划和部署契约，不覆盖版本。
- 每次只处理一个显式映射包，tag 为 `<package-id>-v<version>`；每个 tag 的提交必须 main 可达，且该精确 commit 的 main push CI 成功。
- 仅通过 `.github/workflows/publish-npm.yaml`、npm environment 和 Trusted Publishing 发布 RC。构建选定包及依赖、禁 lifecycle pack 一次、验证并发布同一 tarball。禁止本地 npm publish、自动批量依赖发布或移动旧 tag。
- 当前 `latest`：Protocol/SDK/Builder/Builder CLI/Engine/Engine CLI 为 `0.1.0`，Storage/HTTP/Server 为 `0.0.0`。发布只移动 `rc`，保留 `latest`、历史版本及 legacy canary tag。
- Ubuntu 独立消费 smoke 使用 Node >=22.15.0、已发布的精确 RC、真实内容客户端及新版 Builder 重建 bundle，记录 CID、模块 URL、结果、错误与退出。SSH 账户等连接个人信息不写入仓库；不改变远端 registry。
- 发布成功不等于立即可查询；等待验证器使用的精确版本查询可见，再处理下一包。认证失败先查 Trusted Publisher 绑定，不用本地凭据绕过。
