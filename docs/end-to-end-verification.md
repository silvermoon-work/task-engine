# 跨平台验证：Init → Build → CAR → Run

主流程只验证作者工具、Bundle 和真实 Worker 执行，不再手写 task
service、认证、SQLite 数据库或任务轮询。Windows、macOS、Linux 使用相同的 pnpm 命令与 Node.js 脚本。HTTP/SQLite 的专项验证见最后一节，不因新增 CLI 而取消。

## 前置条件

- 使用满足所选包 `engines` 和 `packageManager` 声明的 Node.js 与 pnpm。
- `@silvermoon-work/task-builder` 与独立 `task-builder-cli`
  提供 init/build/car/check。
- `@silvermoon-work/task-engine-cli` 提供命令和可复用的 `runBundle`；它依赖包含
  `drain`、公开 `MemoryStore` 与 Gateway `close` 的新版 engine。
- SDK 已迁入本仓库；验证迁移结果时，所选模板必须声明兼容的
  `@silvermoon-work/task-sdk`，不能以旧 scope
  SDK 的成功运行代替迁移验收。不需要额外的旧 build、CAR 或 artifact 工具。

本指南不指定 registry、发布 channel 或版本号。选择已发布且相互兼容、具备本文所需命令与 API 的包，将命令中的版本占位替换为本次验证选择的版本，并保留安装 lockfile。占位字符串不是可直接执行的版本；不要把未包含目标能力的包当作验证对象。本地 tarball 只算开发验证，不算已发布包 smoke
test；不要在本流程里发包或推送 tag。

使用当前环境已配置且获准访问的 registry。安装前确认实际配置：

```text
npm config get registry
pnpm config get registry
```

同时检查 scope
override 和已有 lockfile 下载 URL，确保与环境策略一致。包或版本不可用时报告阻塞，不擅自切换源、不关闭 TLS 校验。

## 1. Init

已发布版本可直接初始化一个不存在、且父目录已存在的新项目：

```text
pnpm dlx --allow-build=esbuild @silvermoon-work/task-builder-cli@<builder-cli-version> init "<absolute-new-project-directory>" --name task-engine-e2e
cd "<absolute-new-project-directory>"
pnpm install
```

默认模板从已安装 CLI 的 metadata 选择兼容 builder 依赖，无本地 override。
`--allow-build=esbuild` 是 pnpm dlx 的安装审批，不是 builder
CLI 配置。另行安装包含所选运行入口的已发布 engine CLI：

```text
pnpm add --save-dev @silvermoon-work/task-engine-cli@<engine-cli-version>
```

模板生成 private 项目、pnpm scripts、SDK 作者入口、相对 TS import、JSON
contract、具名 `schemas.text`/`$ref`
和 greeting 资源。只批准模板指定的 esbuild 安装脚本；发布年龄例外仅限明确选定的包，不全局关闭供应链检查。项目不要执行
`npm publish`。

## 2. Build → CAR → Check

```text
pnpm build
pnpm car
pnpm check
```

这里生成项目的 `pnpm check` 是 `task-builder check bundle.car`，不是 task-engine
monorepo 的全量检查。命令失败立即停止，不继续运行旧输出。

得到 `dist/` Bundle、`bundle.car` 和 `bundle.cid`；`bundle.cid`
是 UnixFS 根 CID，不是 CAR 文件路径或摘要。完整 check 消费所有内容，验证 manifest、Schema 闭包、文本规范、资源、CID 和 DAG 块，不只验证文件能打开。输出必须是新路径；重复验证创建另一新项目，不递归删除任意路径。

参数、格式与流所有权细节复用 [builder 文档](../packages/task-builder/README.md)
和 [builder CLI 文档](../packages/task-builder-cli/README.md)：

```text
pnpm exec task-builder --help
pnpm exec task-builder check bundle.car --format text
```

## 3. Run：按内容源选择一条路径

省略 `--input`
默认从 stdin 读取一个 JSON 对象直到 EOF，无需创建输入文件。下面的管道命令适用于 PowerShell 和 macOS/Linux
shell。显式 `--input -` 等价；需要文件输入时才使用
`--input <file>`。空输入、无效 JSON 或超出容量应明确失败，不使用空对象兜底。

### 已有 Gateway：直接 CLI

如果 Bundle 已经能从受控 Gateway 读取，把 `<bundle-root-cid>` 替换为
`bundle.cid` 的内容，然后运行：

```powershell
echo '{"text":"world"}' | pnpm exec task-engine run <bundle-root-cid> --gateway <gateway-base-origin> --timeout-ms 30000 --max-runtime-ms 60000
```

不启动 task-engine HTTP
service。CLI 自己等待 preparation、任务和 Run 物理回收，输出单行 JSON 后自动退出。通过条件是退出码 0、`status: "succeeded"`、根结果为
`Hello world`，且所有 Run 都有 `reclaimedAt`、无
`cleanupUnknown`。仅看到根任务结果或被 watchdog 杀掉，不算成功退出。

多层子任务 Bundle 需要显式
`--allow-children`；默认仍拒绝子调用，既有身份、父子关联、期限和预算不放宽。普通 Echo 模板不需要该开关。CID 模式的内容源仍需独立可用；CLI 不上传、不 pin，也不管理 Gateway 节点。输入/授权/失败/超时/中断/清理的退出码见
[engine CLI 文档](../packages/task-engine-cli/README.md)。

### 只有本地 CAR：直接运行 CLI

无需编写 JavaScript、启动 Gateway、Docker 或 Kubo，直接执行：

```powershell
echo '{"text":"world"}' | pnpm exec task-engine run --car bundle.car --timeout-ms 30000 --max-runtime-ms 60000
```

CLI 先完整校验 CAR，再按唯一根 CID 驱动同一个 engine；不从作者源码或 `dist`
执行，不做网络 fallback。可选 `--expected-cid <bundle-root-cid>` 对照
`bundle.cid`；不需要另传 CID 或 `--gateway`，混用明确拒绝。

通过条件同 Gateway 路径：自然退出 0、`succeeded`、根结果
`{text:"Hello world",bytes:6,chunks:1}`、全体 Task 完成、Run 已回收且无 cleanupUnknown。CLI 负责关闭 CAR 内存和文件句柄。错误类型输入
`{"text":42}` 应退出 3，损坏 CAR 或 expected
CID 不符应退出 2，均不得报告成功。每次运行使用独立非持久域，不复用上次任务。多层子任务仍需显式
`--allow-children`。

所选 engine CLI 必须包含
`--car`；本地代码测试通过不冒充已发布 CLI 验收。目标能力尚未发布时只能使用下节开发替代，不能声称发布验收通过。

### 大资源变体

在另一新项目的第一次 build 前，只修改 greeting：

```text
node -e "require('node:fs').writeFileSync(require('node:path').join('assets','greeting.txt'),'Hello\r\n'+' '.repeat(600000))"
```

重复步骤 2 和离线 Run。原始 600,007 字节经 CRLF → LF 后是 600,006 字节，结果仍为
`Hello world`，`chunks > 1`。未消费完流不算内容已完整验证。

## 发布前的开发替代

此路径要求 checkout 同时包含所需 builder 与 engine
CLI 实现。只想复现已发布包 smoke test 时，不使用此节，不用本地依赖兜底。

如果目标模板所需 SDK 或 protocol 尚未发布，先构建并打包相应 workspace，通过
`createCliTaskProject` 的 `sdkVersion`、`builderVersion`、`cliVersion` 指定本地
`file:` 包，并在生成项目的 pnpm
overrides 中将 SDK/protocol 依赖指向对应本地 tarball。此时不要直接用下面默认 init 的依赖安装命令请求不存在的发布版本。详细选项见
[builder CLI 文档](../packages/task-builder-cli/README.md)。该路径只证明本地集成，不证明 SDK 或其依赖已发布。

```text
pnpm install
pnpm --filter @silvermoon-work/task-builder-cli... build
pnpm --filter @silvermoon-work/task-engine-cli... build
pnpm --filter @silvermoon-work/task-builder --config.ignore-scripts=true pack --out "<absolute-path-to-builder.tgz>"
pnpm --filter @silvermoon-work/task-builder-cli --config.ignore-scripts=true pack --out "<absolute-path-to-builder-cli.tgz>"
pnpm --filter @silvermoon-work/task-engine --config.ignore-scripts=true pack --out "<absolute-path-to-engine.tgz>"
pnpm --filter @silvermoon-work/task-engine-cli --config.ignore-scripts=true pack --out "<absolute-path-to-engine-cli.tgz>"
node packages/task-builder-cli/dist/bin.js init "<absolute-new-project-directory>" --name task-engine-e2e --cli-version "file:<absolute-path-to-builder-cli.tgz>" --builder-version "file:<absolute-path-to-builder.tgz>"
```

tarball 父目录必须已存在。打包不发布且禁用 lifecycle
hooks；builder 的两个 tarball 及 scoped override 仍由 CLI init 装配。在生成的
`pnpm-workspace.yaml` 中保留已有 override，并添加：

```yaml
overrides:
  "@silvermoon-work/task-builder": "file:<absolute-path-to-builder.tgz>"
  "@silvermoon-work/task-engine": "file:<absolute-path-to-engine.tgz>"
```

填写 Windows 反斜杠路径时，YAML 值使用单引号，或在双引号中转义每个反斜杠；不要直接把
`C:\...` 填进 YAML 双引号字符串。

进入生成项目，确认有效 registry 后安装：

```text
pnpm install
pnpm add --save-dev "@silvermoon-work/task-engine-cli@file:<absolute-path-to-engine-cli.tgz>"
```

engine
override 确保 CLI 的 packed 精确依赖也使用新版 engine，而不是试图下载未发布版本。若出现发布年龄限制，只为明确选择的包添加例外。之后复用步骤 2 和步骤 3，仍直接使用命令，不再维护运行脚本。

## 验收范围与证据记录

主流程通过条件：

- init/build/CAR/完整 check 均成功，使用所选的已发布兼容包或明确标记的开发制品。
- 真实 SDK Worker 的根结果和资源字节正确；Run 已物理回收，进程自然退出。
- 本地 CAR CLI 验证错误类型输入、损坏 CAR 和 expected
  CID 不符明确拒绝，文件句柄和 CAR 内存释放；保存单行 JSON 输出及实际进程退出码。
- 大资源变体经历多 chunk，规范化后字节数准确。
- 发布验收必须另保留 registry 安装来源、准确版本、integrity 和真实 publish
  run；本地 tarball、仓库 dist 或开发脚本通过不能替代它。

**CLI 的非持久运行不能验证 HTTP 认证、SQLite 持久化、重启恢复或历史幂等。**
需要这些专项证明时，继续使用
[原 HTTP/SQLite 验证脚本](https://github.com/silvermoon-work/task-engine/blob/2597d79a4ab778e9288675eaba0dfa230a406491/docs/end-to-end-verification.md#3-从-car-跑真实-http--sqlite--worker)
的独立路径；保留 401、Schema 拒绝、物理回收、关闭内容源后重启、历史/幂等查询不再读取块或重跑 Worker 的断言。仓库 engine/HTTP/storage/server 回归属于补充证据，不冒充已发布包的这些专项验证。

将每次实际验证的环境、包名、解析版本、安装来源、integrity、命令、退出码和结果单独保存为验收证据，不把它们写成本文固定的环境要求。
[已有 builder 发布验证](../.silvermoon/ideas/01M6ZAPC3GKWYMHYVT3186PP5A/outer/published-builder-verification.md)
是一次具体执行的记录，不代表以后选择的包或平台自动通过。

HTTP/SQLite 专项验证在 Windows 上应选择较短的独立数据库目录，并为临时副本和 sidecar 留出路径余量；遇到路径错误应明确失败，不放宽恢复断言。本流程不证明生产认证、pin/GC、SSE 或 OS 沙箱；目标平台仍须实际执行验证。
