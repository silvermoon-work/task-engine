# 模块加载设计调研

## 已确认的范围

2026-11-12，用户对三个设计选择的明确答复为：仅当前 bundle 的入口；允许最低 Node 提高到至少 22.15，优先保留 CJS 行为；新加载机制要求重建旧 bundle。后续对 schema 归属的明确答复为由 task-engine 仓库维护并版本化，不依赖修改 potential-guide。这些答复是设计选择，不是构想验收。

由此不需要在首期引入运行时模块图、跨 CID 下载、额外的源码网络通道或旧产物 eval 兼容分支。具体需求由 [需求说明](requirements.md) 统一约束。

## 自主核实的事实

### Node API 与入口形式

- [Node 22.15 官方文档](https://nodejs.org/download/release/v22.15.0/docs/api/module.html#moduleregisterhooksoptions) 标明同步 registerHooks 自 22.15.0 引入；22.13 可用的是 register 异步 hook，运行在独立 loader 线程。
- 本机 Node 22.13.0 与 24.11.1 都拒绝直接 new Worker(ipfsURL)，返回 ERR_INVALID_URL_SCHEME。需要先启动引擎自带 bootstrap，再注册 hook 并加载任务入口；这不要求把 bundle 写入临时文件。
- [Node hook 文档](https://nodejs.org/docs/latest-v22.x/api/module.html#enabling) 区分动态 import、内置 require 和 createRequire 对 hook 的适用范围。不能把其中一种调用方式通过实验等同于全部 CJS/ESM 组合。

### CJS 行为差异

- 两个本机版本的异步 hook 都能加载以 IPFS URL 为身份的 CJS 源码，内置模块可用；但实验中的 require.cache 和 require.resolve.paths 为 undefined。
- 在 Node 24.11.1 上，同步 hook 配合 import(CJS) 的实验仍观察到受限 require；同步 hook 配合 bootstrap 的 CJS require 入口则保留 require.cache 与 require.resolve.paths，且非允许 IPFS 地址进入自定义拒绝路径。
- 因而仅将 register 替换成 registerHooks 不足以证明 CJS 兼容；实施需同时验证入口调用方式。同步 CJS 入口是当前有依据的优先方案，不把它扩展成对作者暴露的通用 require("ipfs://...") API。
- [异步 load 的官方限制](https://nodejs.org/docs/latest-v22.x/api/module.html#caveat-in-the-asynchronous-load-hook) 明确说明提供 CJS source 时的 API 差异；createRequire 也不能被视为异步 hook 的统一拦截点。hook 不构成 Node 能力沙箱。

### Builder 地址语义

- 当前 [Builder](../../../../../../packages/task-builder/src/esbuild.ts) 将 import.meta.url 替换为 __artifactURL，并用 pathToFileURL(__filename).href 初始化它。
- 对真实 Builder 生成的 26,295 字节 SDK bundle，在 Node 22.13.0 的异步入口、24.11.1 的异步入口和同步入口上均完成 SDK ready 与 callback complete。回调中的 __filename 是 IPFS URL，但 import.meta.url 是错误的 file:///.../ipfs:/... 地址，证明仅改引擎不足以闭合地址语义。
- 新产物必须直接保留逻辑 IPFS 模块 URL；已确认重建要求，因此无需通过源码替换或全局 URL API monkey-patch 修复旧产物。

## 迁移必须可识别

当前 [产物 schema](../../../../../../packages/task-protocol/src/task-schema-uri.ts) 使用外部 v1 schema URL，[声明验证](../../../../../../packages/task-protocol/src/bundle.ts) 对字段有严格约束。本次实际读取 [公开 v1 JSON Schema](https://shazhou-ww.github.io/potential-guide/schemas/artifacts/task/v1.json)，其注释仍描述 Git SHA-256 身份，而且未定义当前本仓库要求的 include 与 binary；外部文档不能直接证明当前产物契约，更不能默认为新加载契约已经发布。

Node 最低版本是运行时要求，不是产物加载版本；旧 Builder 允许作者设置较高 minVersion，不能据此辨识重建产物。

实施必须定义明确的产物加载契约版本或能力标识，并同步 Builder、Protocol、SDK 及引擎的检查。旧产物须在作者代码执行前拒绝，旧引擎也应明确拒绝新产物；不能等 SDK ready 再发现版本不匹配，也不能复用 Space 协议号。

新版本权威 schema 已确认由本仓库维护；精确字段、标识和可验证分发方式属于实施设计。保留历史 v1，不修改外部仓库来冒充本次交付，不把尚未部署的公开 URL 视为已完成分发。

升级对象是产物 task.yaml 与 Worker 握手共享的 taskSchemaUri，而不是业务 schema、Space 协议号或 JSON Schema draft。当前 [Protocol 文档](../../../../../../packages/task-protocol/README.md) 还明确记载了已移除的历史 Task v2；新标识须使用本仓库清晰的新身份，不与历史标识混淆。精确 URI 尚未确定，不把旧地址简单替换为 v2.json 作为已完成方案。构建配置 task-build/v1 若字段语义不变不需要随之升级，新的产物 $schema 身份也不需要再叠加含义重复的 loaderVersion。

## 当前可闭合的加载责任

宿主获取并验证 bundle，向每个 Run Worker 提供当前入口的已验证源码映射；bootstrap 安装局部 hook 后加载入口。首期 hook 不联网，其他 IPFS 路径和 CID 不可执行，Node 内置模块保持既有使用方式。不同 Run 的模块状态仍由现有每 Run 一个 Worker 的模型隔离。

这保留现有内容缓存、网关策略和容量控制，不增加 loader 线程到宿主的异步内容 RPC；最终入口实现需按已确认的运行时方向验证。文件系统路径语义不能被伪装成 IPFS 地址语义。

## 验证边界

以上是 Windows 上的设计可行性实验，不是实施验收。实验向 hook 提供内存源码映射，使用固定示例 IPFS URL，未验证真实 CID 获取、网络取消或端到端完整性；SDK 实验只覆盖握手和回调结果，不能据此声称完整生命周期已验证。

本机没有 Node 22.15.0，尚未在该版本执行实验。同步 API 的引入版本来自官方版本化文档；正式最低版本、平台范围、清理行为和完整回归必须在实施阶段验证。最低版本若最终高于 22.15，应明确说明依据并同步直接受影响的运行时声明、模板、CI 和文档。
