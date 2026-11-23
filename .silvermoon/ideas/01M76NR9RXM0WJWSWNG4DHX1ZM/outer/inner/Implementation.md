# Implementation

## Steps

### I-S01: 验证模块加载兼容性

使用独立 Node 22.15.0 与 24.11.1 验证同步 registerHooks、本地 bootstrap URL 的 createRequire 和 CJS require 入口组合，确认最低版本为 22.15.0。保留原生 CJS API；`require.resolve(ipfsURL)` 不走 Node hook 的既有限制须明确记录，不通过 monkey-patch 扩展。保持现有产物与握手协议，不把重建要求变成新的版本识别机制。

### I-S02: 接入受控 IPFS 模块加载

由 bundle-worker 启动，bundle-module 将 CID 别名规范化到唯一入口，只向 Worker 提供已验证内存 source；原始 URL 形态先校验，避免 URL 归一化隐藏越界。不在 hook 中联网，同步调整 Builder 地址生成、受影响的 Node 声明和模板，保持现有产物协议、任务生命周期及单文件交付形态。

### I-S03: 补齐回归验证与使用说明

覆盖重建产物加载、非法模块拒绝、CJS 行为、地址语义和生命周期，更新 CI、重建与使用说明；不新增产物 schema 或外部仓库交付依赖。[验证证据](verification.md) 对照实现及失败边界，[RC 发布计划](release-plan.md) 仅供后续逐包版本与顺序审阅，本阶段不发布。

## Acceptance criteria

### I-AC01: IPFS 入口保持任务行为

集成测试证明重建的 CJS bundle 可由 IPFS 入口运行，import.meta.url 正确，任务输入、结果、消息、日志和退出行为不退化；同一入口不重复求值且不同 Run 状态隔离。

### I-AC02: 读取与授权失败可观察

针对无效 CID、路径越界、非入口路径、跨 CID、内容校验失败、容量超限与取消的测试证明明确失败，且无静默 eval、源码改写或临时文件回退；重建产物仍通过现有 task.yaml 校验与 SDK 握手。

### I-AC03: 运行时及隔离边界成立

在 Node 22.15.0 与 24.11.1 验证 require.cache、require.resolve 的内置模块解析及 require.resolve.paths；回归测试证明 bootstrap 先于入口生效、宿主加载器未改变、关闭和并发执行不串用权限。直接受影响的声明、模板和 CI 与实际下限一致。强制退出不伪造宿主清理证明；既有 reclamation_unknown 语义保持。
