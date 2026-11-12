# 部署计划

## 已批准基线与范围

父 agent 已验收 `implementationRevision=1adb16e34ee852991d84b8f3ea735bf5686803ac`；精确 main `58d9089dda9dbdf5f2020489729fc9e36de42cb7` 的 CI `43151057630` 在 Node 22.15.0 / 24.11.1 与 Release verification (v1) 全绿，acceptInner 已在 `9730efa894663dbe16b69492b14fc4601a7e5164` 同步。本阶段不修改 inner 目录（包括已有 release-plan.md）。

本部署只发布四包最小 CLI 消费闭包，顺序如下；其余内部包使用已发布 `0.2.0-rc.0`：

| 顺序 | package-id | 精确版本 | 必须已发布的内部依赖（含开发字段） |
| --- | --- | --- | --- |
| 1 | task-builder | 0.2.0-rc.1 | dependencies: task-protocol；devDependencies: task-sdk |
| 2 | task-builder-cli | 0.2.0-rc.1 | dependencies: task-builder、task-protocol；devDependencies: task-sdk |
| 3 | task-engine | 0.2.0-rc.1 | dependencies: task-protocol；devDependencies: task-sdk、task-builder、task-builder-cli |
| 4 | task-engine-cli | 0.2.0-rc.9 | dependencies: task-engine、task-protocol；devDependencies: task-builder、task-builder-cli、task-sdk |

这四包没有额外内部 peerDependencies/optionalDependencies 边。不自动发布缺失依赖、不发布独立 Server；版本被占用则返回父 agent，不擅自递增。

## 发布准备与执行

1. 先同步此契约并观察稳定 deploymentRevision，再开始外部预检。保存 registry 的精确版本不存在结果、四包 latest 基线及 Protocol/SDK 精确 rc.0 可见性；不修改本机或远端 registry。
2. 可一次准备提交只更新上述四个 manifest 版本，保持 workspace:*，必要时恢复依赖并执行项目检查；确认 inner tree 未变。普通 Git 同步到 main，等待该精确提交 main push CI 的 Node 22.15.0 / 24.11.1 与 Release verification (v1) 成功。核对 publish-npm.yaml 的 verifier 仍要求同名 v1 aggregate。
3. 每次重新验证当前包版本不存在及全部内部依赖精确版本已可见，然后只推一个 `<package-id>-v<version>` tag，绑定成功 CI 的 main 可达提交。不移动 tag、force push、本地 npm publish 或使用 token 绕过 Trusted Publishing。
4. 等待一个 publish-npm.yaml workflow 成功，再查 registry 的该精确版本、dist-tag rc、tarball URL、integrity 与 shasum。现有 workflow 构建 selected+deps，禁生命周期 pack 一次，并将同一文件传给 artifact verifier、publint 和 publish。记录日志及 registry tarball 身份，再处理下一包；metadata 暂不可见时等待，不覆盖版本。
5. 最后复核四包 latest 与最初基线一致；人工 dry-run 不算发布。认证失败检查 Trusted Publisher / npm environment 并报告，不自行换认证方式。

## Ubuntu 独立消费验证

- 先只读确认 Node/npm 路径和版本、磁盘、现有 registry 配置；不改变 NVM 全局选择、registry 或已有服务。所有新目录使用本操作独立名称，仓库证据不保存 SSH 账户、主机或个人路径。
- 作者环境只安装精确 registry Builder CLI rc.1、SDK rc.0 及 fixture 所需已发布依赖；确认实际 Builder 为 rc.1。独立运行环境仅安装 Engine CLI rc.9，其传递 Engine 必须为 rc.1，安装图不得出现 Builder/Builder CLI；不通过 file:/link:/workspace 或工作树 dist 供包。
- 新 Builder 构建 fixture 为 task.yaml、worker.cjs 与 CAR；可以保留作者构建输出，但 Worker 加载不得产生额外 bundle 入口源码文件。
- 以本操作自建、仅本地监听的 Gateway/发布端提供真实 CID 多块内容，消费端使用实际内容客户端获取并验证；运行 CLI/Engine 并保存 CID、入口 URL、CJS/cache、业务结果、日志、进度及 Run 退出信息。运行中的 Node、包和 lockfile 路径必须来自独立 registry 安装。
- fixture 同时验证 require.cache、require.resolve 内置模块、require.resolve.paths，self require/import 复用；明确不承诺 require.resolve(ipfsURL)，其既有 MODULE_NOT_FOUND 不是回退。宿主本地模块导入仍可用。
- 非入口/跨 CID/编码越界/query/hash/凭据请求拒绝，错误保留规范入口而不回显凭据；内容缺失或损坏不可静默执行；合作取消、阻塞 Worker 强停及关闭有物理退出证据。独立清理证明不足时保留 reclamation_unknown，不伪造完成。
- 所有自建进程最终按本操作持有的 PID/句柄或 authenticated managed stop 关闭，确认退出；不使用按名称杀进程或影响已有服务。证据保留可重放脚本、脱敏输出与 registry 锁定信息。

## 收尾

将发布、安装、成功及故障证据写入 Outer World，必要修改先同步新契约再重跑相应外部验证。保持 Inner World 精确 revision 不变；只在 D-* 证据完成后更新 ledger，检查、同步 primary，append 精确 submitOuter。停止等待父 agent 独立 acceptOuter，不自行记录验收。
