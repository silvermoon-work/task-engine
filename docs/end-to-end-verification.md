# 端到端验证：安装 → Init → Build → Server → 持久任务

当前源码 CLI 包为 `@silvermoon-work/ipfspawn`，仅提供 `ipfspawn` 命令；
`@silvermoon-work/task-engine` 核心包、数据与配置路径保持不变。新包 `0.2.1`
已发布至
`latest`，可按下列步骤从 registry 安装；验证未发布源码时仍使用文末的独立 tarball 流程。旧
`@silvermoon-work/task-engine-cli@0.2.0` 的 registry 验收属于历史记录，其
`task-engine` 命令不能替代新包验收。

本文描述**0.2.0 正式版的 typed ContentRef /
parameters 接口**；发布和独立 registry 安装验收范围见
[正式版记录](../README.md#stable-020-2026-11-16)。历史 0.1.0 的 `data.result` /
`data.outputCid` 和较早 0.2.0 RC 的 `data.output: {cid, result}` 封装见
[发布记录](../README.md#release-candidate-channels)，不能混用旧 Space 示例。当前 CLI 外层是
`{ok, output?, error?}`，业务结果位于 `output.result: {data,cidPaths}`；其中
`data` 是载荷字段，不是旧 CLI 外层。核心 Task/Run 和通用 HTTP API 直接使用
`result`，HTTP 外层信封不变。 `output`
只是 CLI 命令响应，不是文件空间，没有自动生成的输出目录根 CID；业务输出文件由
`putContent()`
返回 CID，通过结果中的 ContentRef 保留。重建旧 Bundle，并为不兼容的旧事实选择新 Engine 数据目录。

下面以 PowerShell 为主；macOS/Linux 使用相同命令，把本地路径的 `.\`/`\` 换为
`./`/`/`。每步检查退出码，失败即停止，不继续执行旧输出。示例固定用一个尚不存在的
`task-engine-e2e` 目录，默认派生包名也为 `task-engine-e2e`。如果换目录名或
`--package-name`，同时替换后续产物路径。

## 0. 选择制品来源

使用 Node.js 22.15+（23.x 至少 23.5，建议 Node.js
24），无需克隆仓库或编译 CLI。使用环境已获准的 registry，不修改 registry、TLS 或用户配置来绕过失败。安装前保留实际 registry 和版本信息：

```powershell
node --version
npm --version
npm config get registry
npm install -g @silvermoon-work/task-builder-cli@0.2.1 @silvermoon-work/ipfspawn@0.2.1
task-builder --version
ipfspawn --version
task-builder --help
ipfspawn --help
```

全局 npm bin 目录须在 PATH 中。scope registry
override 和 lockfile 下载 URL 也须符合环境策略。版本不可用时报阻塞，不用 workspace、tarball 或旧版本偷偷替代。保留实际解析版本，不能仅凭
`latest` 标签推定版本正确。当前 ipfspawn `0.2.1`
已通过发布后版本、dist-tag 与依赖元数据验证；该验证不等于独立 registry
consumer 完整运行验收。不要使用全局旧 Engine
CLI，也不把本地 tarball 结果称为 registry 安装验收。

## 1. Init → 安装项目依赖

在可写且已存在的父目录中：

```powershell
task-builder init task-engine-e2e
cd task-engine-e2e
npm install
```

init 不覆盖已有目录。模板是 private 项目，依赖兼容的已发布 Builder/CLI 和本仓库 SDK；不要执行
`npm publish`。无需另行安装旧 scope 的 SDK 或 CAR 工具。保留生成文件、package.json、安装 lockfile 和解析版本。当前源码模板默认选择 SDK
`0.2.0`，与 Protocol `0.2.0` 配套；旧 RC Builder 的模板可能仍选择
`rc.0`，故必须检查实际生成的 manifest，不能用 CLI 版本号推定模板已修正。正式版已验证默认 SDK
`0.2.0` 配对。

Builder 通过 esbuild 转译；平台二进制由 optional dependency 提供。esbuild
postinstall 可以禁用，但不要使用
`--omit=optional`。build 不会补跑安装脚本。pnpm 用户可对应使用
`pnpm install`、`pnpm build`
等，使用满足模板 packageManager 要求的版本，不必全局批准安装脚本或关闭供应链检查。

## 2. Build：默认已经包含 CAR

```powershell
npm run build
```

预期产物：

```text
dist/
  task-engine-e2e/
    task.yaml
    ...
  task-engine-e2e.car
```

一般默认路径为 `dist/<derived-package-name>/task.yaml` 和
`dist/<derived-package-name>.car`，不是 `dist/task.yaml`、`dist.car` 或
`bundle.car`。build 校验模块和 CAR，stdout 输出一个 `{ok:true,data}`；保存
`data.cid`、 `data.module.declaration` 和
`data.car.path`。实际输出路径以 JSON 为准。重复 build 只替换本次同名产物，不递归清空任意目录。

**build 只转译，不做 TypeScript 类型检查。** 当前模板提供独立的
`npm run typecheck`（`tsc --project tsconfig.json`，不发射文件），最终脚本为
`build/car/clean/typecheck`。必须在安装后先运行 `npm run typecheck`，再运行
`npm run build`，并确认两步都成功；不能把 build 成功当作类型正确。没有 Builder
`check` 子命令或生成项目 `check` 脚本；仓库自己的 `pnpm check`
仍是完整回归检查。

### 可选：独立 CAR 验证

独立 car 只消费已有声明与产物，不隐式 build，且**拒绝覆盖**。不要在默认 build 后直接运行
`npm run car`，因为两者默认目标相同。选择以下一种方式：

1. 在另一个新项目第一次构建时分开生成（已有 CAR 不会被 `--no-car` 删除）：

   ```powershell
   npm run build -- --no-car
   npm run car
   ```

2. 在当前已成功 build 的项目选择一个尚不存在的新输出：

   ```powershell
   task-builder car .\dist\task-engine-e2e\task.yaml --output .\dist\task-engine-e2e-copy.car
   ```

同一模块的 CID 应一致。完整参数见
[Builder CLI 文档](../packages/task-builder-cli/README.md)。

## 3. 显式启动 Server

选择专用数据目录和未占用端口。示例使用本项目的 `engine-data`
和 8787；如冲突，停止当前验证，选择新的端口，并给后续 run/task 命令加上匹配的
`--engine http://127.0.0.1:<port>`，不要停止不属于本次验证的实例。

```powershell
ipfspawn server start --data-dir .\engine-data --content-data-dir .\content-data
ipfspawn server status --data-dir .\engine-data
```

start 在后台 Server 就绪后返回，status 应报告 ready。Server 不会自动启动、不切换空闲端口、不复用其他实例。
`server start/status/stop` 与 `data prune` 按 data-dir 定位本地实例；run/task 按
`--engine` 或 `client.engine` 访问（默认
`http://127.0.0.1:8787`），它们不根据调用目录或 data-dir 自动推导端口。每次重启均须传相同的
`--content-data-dir`。`--data-dir`
只隔离运行数据库、实例身份和私有缓存，不隔离公共内容配置或共享内容目录。完全隔离验证还应把
`TASK_CONTENT_CONFIG` 指向本次自己的
`{"backend":"local","dataDir":"<本次绝对目录>"}` 配置文件；Windows 将
`LOCALAPPDATA` 指向本次私有目录，以免读取用户的 Engine 配置。不能删除用户的默认
`~/.silvermoon.work/content` 或连接共享 Kubo。

本地 CAR 不需要 Gateway、Kubo 或 Docker，但**必须有 Server**。这不是旧 CLI 的单次嵌入、自动退出即丢弃历史模式。只运行可信任务；本指南不证明生产认证、多租户隔离或 OS 沙箱。

## 4. Run → 查询、日志和等待

`--parameters` 必填；只有 `--parameters -`
才从 stdin 读取完整 JSON 对象直到 EOF。PowerShell 和 macOS/Linux
shell 都可使用此管道（调整路径分隔符）：

```powershell
echo '{"text":"world"}' | ipfspawn run --car .\dist\task-engine-e2e.car --parameters -
```

正常退出码为 0，单个 stdout JSON 的 `output.status` 应为 `succeeded`，
`output.result.data` 应包含 `{text:"Hello world",bytes:6,chunks:1}`，
`output.result.cidPaths` 为 `[]`。普通 JSON 对象在请求边界包装为
`{data: <对象>, cidPaths: []}`；引用输入必须显式提供完整 envelope，不要把 CID 文本当作自动识别的引用。记录返回的
`output.taskId`。业务结果和错误均是单个 stdout
JSON，stderr 仅日志；help/version 是文本。失败退出 1，已确认用户中断退出 130。同步 run 等待本次任务及子任务资源释放；不要求已移除的公开
`reclaimedAt` 字段。

将下文 `<task-id>` 替换为本次真实回执中的 ID，不要直接复制占位字符串：

```powershell
ipfspawn task query --id <task-id>
ipfspawn task logs <task-id> --limit 100
ipfspawn task await <task-id>
ipfspawn task query --status succeeded --limit 20
ipfspawn task query --since 2026-11-01T00:00:00Z --until 2026-12-01T00:00:00Z
```

命令是单数 `task query`，不是 `tasks query`。当前源码对错误路径（包括带
`--help`）返回失败并在有依据时建议正确拼写，绝不自动执行纠正。
`task query --help` 提供用途、选项和示例。

`--id` 与 `--status/--since/--until/--limit/--cursor`
全部互斥。status 可重复，枚举为 pending/running/succeeded/failed/timed_out/cancelled/rejected。时间须带时区 RFC
3339，按创建时间含 since、不含 until，since 必须早于 until。默认 limit=100、允许 1–1000，按创建时间、taskId 升序。用响应中的 nextCursor 请求下一页，保持相同 Server 和筛选；日志也使用不透明分页游标。无匹配返回空 items，不等于服务故障。

异步流程可另提交一次：

```powershell
echo '{"text":"async"}' | ipfspawn run --car .\dist\task-engine-e2e.car --parameters - --async
```

保存这次新的 taskId，用 task query/logs/await 查询它。`--async`
在持久受理后返回，不保证执行或准备已成功；终端退出不取消任务。 `task await`
中断只停止等待；同步 run 中断会取消本次任务并等待释放。受理或释放不确定时明确失败，不能自动重提。

### 可选 CID 模式与 Gateway

上面 CAR 受理产生的持久 CID 块可以被同一实例复用；将 build 的 `data.cid` 替换为
`<bundle-cid>`：

```powershell
echo '{"text":"cached"}' | ipfspawn run --cid <bundle-cid> --parameters -
```

ContentRef /
parameters 协议要求用配套 SDK/Builder 重新构建 Bundle；旧 SDK 构建的公开 Echo
CID 不能直接作为新版成功验收样例。在线验收须上传新构建的 CAR，并使用其新 CID。

需要获取缓存未命中的块时，必须在 **Server 启动时**配置受控 Gateway，例如：

```powershell
ipfspawn server stop --data-dir .\engine-data
ipfspawn server start --data-dir .\engine-data --content-data-dir .\content-data --ipfs-gateway http://127.0.0.1:8080
```

仅在你已启动并确认该 Gateway 能读取目标 Bundle 时使用这个地址；CLI 不启动 Kubo、不上传或 pin、不默认探测 8080 或公共 Gateway。也可以预先设置
`server.ipfsGateway`，但这会修改用户配置，验证时优先用启动参数。不再读取
`TASK_ENGINE_GATEWAY`、`IPFS_PATH` 或 Kubo 配置，不接受 run 的旧
`--gateway/--expected-cid/--max-runtime-ms`。子调用使用
`{key,bundle:<CID字符串>,path?,parameters,timeoutMs}`，不再使用 SpaceRef 或
`input`。

## 5. 停止 → 重启 → 验证历史

先等待上面所有任务完成。stop 默认拒绝在途任务，不把拒绝当成功：

```powershell
ipfspawn server stop --data-dir .\engine-data
ipfspawn server status --data-dir .\engine-data
ipfspawn server start --data-dir .\engine-data --content-data-dir .\content-data
ipfspawn task query --id <task-id>
ipfspawn task logs <task-id>
ipfspawn task await <task-id>
```

比较重启前后的 taskId、状态、结果和日志，已完成任务不应重跑。如需取消仍运行的本次验证任务，显式使用
`server stop --data-dir .\engine-data --cancel-running`，确认资源释放后再继续。非正常退出后前次未完整结束的记录会保留原 ID 并标记失败及重启原因，不自动重跑；普通停止/重启只验证已完成历史，不足以证明故障恢复。故障恢复、磁盘故障和身份未知需独立隔离的测试及证据，勿强杀共享环境进程。

内容持久化验收还须构建一个调用 `context.putContent(stream)` 的任务，用
`ContentRef.fromCID(cid)` 返回该文件，结果 schema 使用 `ContentRefSchema()`（从
`@silvermoon-work/task-protocol` 导入）。SDK 回调收到的是 typed ContentRef；对其
`.cid` 调用 `context.readContent()`，对 Bundle 路径使用
`context.resolveContent(context.bundle, "resources/greeting.txt")`。旧的
`context.space`、`context.output` 和 `bundle.root` 已移除。

例如有 `document: ContentRefSchema()` 的参数，CLI 输入为：

```json
{ "data": { "document": "<file-cid>" }, "cidPaths": ["$[\"document\"]"] }
```

输出引用位于 `output.result.data.document`， `output.result.cidPaths`
标记对应路径。重启后既查询任务，又实际读取文件；仅比较 CID 字符串不足以证明内容仍可读取。内容由所选内容后端保存，不会自动公开。

### 按 CID 读取目录、文件与输出（CLI rc.13）

```powershell
ipfspawn content read <bundle-cid>
ipfspawn content read <bundle-cid> --path resources/greeting.txt
ipfspawn content read <bundle-cid> --path resources/greeting.txt --output .\greeting-copy.txt
ipfspawn content read <result-file-cid>
```

目录返回
`{cid,kind:"directory",entries:[{name,kind,cid}]}`，只列一层。文件默认返回
`{cid,kind:"file",text,bytes}`，仅支持有效 UTF-8； `--output`
保存原始字节并返回路径及字节数，不覆盖已有文件，父目录必须存在。目录不支持
`--output`。`--path` 使用 `/` 分隔的相对路径，不接受 `.`、`..`、前后 `/`
或反斜杠。远程实例须加同一
`--engine`。此命令不自动启动 Server，也不需要启用 raw/CAR 公共 Gateway；与任务查询共享可信网络边界，不受 Gateway
token 保护。

### 后台故障诊断（当前源码新增）

后台进程没有终端。当前源码在实例目录预分配
`daemon-diagnostic.json`（4096 字节，JSON 后可有空白），保留最近一次 startup-failed/storage-failed/shutdown-failed/uncaught-exception 快照：

```powershell
Get-Content .\engine-data\daemon-diagnostic.json -Raw | ConvertFrom-Json
```

记录包含 time、pid、instanceId 和筛选后的系统/SQLite 错误码及原因链，不写业务输入/输出、令牌、URL、错误 message 或 stack。重启不清除上一次故障，要用 instanceId 区分所属进程；它不是任务日志或审计历史。预分配原地覆盖可缓解 ENOSPC，但同盘 EIO、只读文件系统、权限丢失或强杀时不能保证写入；stderr 也只是 best
effort，不能宣称无限可靠。此接口须以包含该增强的新制品验证，不能向已发布 canary 要求该文件。

## 6. 离线清理

完成比较后，先显式停服，再只清理本次 ID。根据实际创建的任务逐一选择，或重复
`--task` 传多个 ID：

```powershell
ipfspawn server stop --data-dir .\engine-data
ipfspawn data prune --data-dir .\engine-data --task <task-id> --cache
```

只删除已终结且释放确认的任务及日志；`--cache`
删除剩余历史不再引用的块，不是清空全部缓存。保留了其他根/子任务时，相关块必须保留。
`--before <带时区时间>` 是按**完成时间**选择历史，与 `--task`
互斥；无范围报错，不自动停服、不递归删除目录。可再次启动查询确认已清理 ID 返回空 items，最后停掉本次 Server。不得用清理命令处理别人的目录。

## 可选资源和错误变体

- 在另一个新项目第一次 build 前，将 greeting 改为大资源：

  ```powershell
  node -e "require('node:fs').writeFileSync(require('node:path').join('assets','greeting.txt'),'Hello\r\n'+' '.repeat(600000))"
  ```

  重复 build 和 CAR run。600,007 字节 CRLF →
  LF 后应为 600,006 字节，result.text 仍为 `Hello world`，chunks >
  1；未消费完流不能算完整验证。

- `{"text":42}`
  应失败且退出 1；另建损坏的 CAR 副本应明确拒绝，不覆盖原始构建产物。不再用旧嵌入 CLI 的退出码 2/3 验收受管 CLI。
- 类型检查增强的新模板：引入真实 TS 类型错误，确认 typecheck 失败而 build 仍只转译；恢复源码后两者通过。不要添加 Builder
  `check`。

## 发布前的开发验证与验收边界

未发布增强只能用明确标注的源码或本地 tarball 验证，不算 registry 安装验收。从仓库构建所需 workspace 后可运行各自
`dist/bin.js`；打包仅用禁用 lifecycle
hooks 的 pack，不发布、不推 tag、不改全局 CLI。新建项目如需本地依赖，由作者显式编辑 package.json 的
`file:` 依赖；pnpm 11 的传递依赖 overrides 写在
**pnpm-workspace.yaml**，不能仅写旧的
`package.json.pnpm.overrides`。覆盖整个内部运行依赖闭包，否则直接 CLI 虽为 tarball，Builder/SDK/Engine 仍可能来自 registry。不能请求不存在的正式版本，或隐瞒本地替代。本地包路径必须使用已存在的独立输出目录，Windows 不跨卷移动或递归清理含 pnpm 链接的目录。开发 lockfile 不能当作已发布包来源证明。

在隔离 checkout 使用 Node 24.11.1 / pnpm 11.22 的可重复步骤：

```powershell
$node24 = Join-Path $env:NVM_HOME 'v24.11.1\node.exe'
$env:PATH = "$(Split-Path $node24);$env:PATH"
node --version
pnpm --version
pnpm --filter '@silvermoon-work/task-builder-cli...' --filter '@silvermoon-work/ipfspawn...' build
# $artifacts 须为仓库外新建的本次专用目录；每个包只打包一次。
pnpm --dir packages\task-builder --config.ignore-scripts=true pack --pack-destination $artifacts
```

对
`ipfs-access/ipfs-payload/ipfs-store/task-protocol/task-sdk/task-builder/ task-builder-cli/task-engine/ipfspawn`
共九包执行相同 pack。pnpm 11.22 的 pack 不接受
`--ignore-scripts`，应使用上述配置参数。复用 `scripts/release.js` 的
`selectRelease`、`validateManifest`、 `validateArtifact` 校验 packed
manifest；**不运行发布入口或发布动作**。在仓库外建立 tools 项目，以本地 CLI
tarball 为依赖、九包 tarball 为 overrides， `pnpm install --ignore-scripts`
后调用其已安装 `dist/bin.js init`。生成 consumer 后先保存默认 manifest（验证 SDK
rc.3 配对），再把内部依赖固定到同一批 tarball 并添加相同 workspace
overrides；安装、typecheck、build/CAR、run/query/await、typed 引用的 put/read、content
read 的目录/文件/保存、重启读取及最终停服分别保留证据。检查 lockfile 的内部包均为本地 tarball，并确认实际模块路径没有返回祖先工作区。整个过程无需 Kubo，不启用共享 Gateway，也不修改全局 Node 或用户配置。

2026-11-16
Windows 隔离源码制品验证的范围为：默认模板、类型检查、CAR、执行/查询/等待、typed 参数与结果、文件写入/读取、目录/文件读取及保存、防覆盖、重启后查询/读取与专用实例停服。旧 HEAD
`5b131cd` 的回执曾是 `data.output.result`，不能拿它替代当前 `fabb095` 的
`output.result` 验证；两者都不是 Space 输出目录根。 `fabb095`
加本地准备修正的九包 tarball 已在全新仓库外 consumer 重复上述验证并通过：默认 SDK 为 rc.3，CLI 回执无外层
`data`，run/query/await 的直接 result
envelope 一致，引用文件保存及重启后逐字节内容一致；两个专用实例均确认 stopped。这验证当前修改后源码制品，不是 registry 的完整 Engine 安装验收。另以配套 SDK/Protocol
0.1.0 构建负向 CAR，新 Engine 返回 `unsupported_contract` / “rebuild this
Bundle”；仅安装新 SDK 后重跑旧 CAR 仍失败，实际重新 build/CAR 后同一源码成功。另一个无本地 overrides 的 consumer 使用环境当前 Tencent
registry 安装依赖并通过 typecheck/build；它只验证生成项目的 registry 依赖配对，不是修改后源码的 registry 发布验收，也未验证 registry
Engine 的完整运行。

每次实际验证单独保存：OS/Node/npm（或 pnpm）、包名和准确版本、registry、lockfile/integrity、来源（registry 或本地）、命令、退出码、JSON、taskId、重启前后比较和最终停服/清理结果。发布验收还需准确 publish
run 与制品一致性。一条教程或旧版本成功不能替代新版本测试。

[已有 Builder 发布验证](../.silvermoon/ideas/01M6ZAPC3GKWYMHYVT3186PP5A/outer/published-builder-verification.md)
等历史证据保持不变，仅适用于当时的精确制品和接口。本流程验证受管 CLI 的持久任务，不替代独立 HTTP/SQLite 包的认证、SSE、历史幂等或生产部署测试；这些仍应按各包契约单独验证。
