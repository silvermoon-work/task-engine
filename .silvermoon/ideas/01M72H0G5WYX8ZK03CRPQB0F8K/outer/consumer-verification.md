# Registry 独立消费者验证

## 结果与范围

2026-11-10，Windows x64、Node **v24.12.0**、pnpm **11.22.0**。
本轮用实际 registry 安装的 CLI 完成 init → 外部依赖安装 → 默认 build/CAR →
独立 car，以及重复构建、no-car、拒绝覆盖、输入/链接保护和真实 Engine 消费。
结果不是 workspace 调用、仅 pack、手动解压替代安装或预期示例。

- 独立安装宿主：
  `D:\Code\task-engine.worktrees\task-builder-cli-redesign-setup\.cache\builder-consumer`
- 主项目：该宿主的 `demo`；另有 `shim-demo` 验证 Windows 命令 shim 完整闭环。
- 目录位于仓库内仅为遵守操作目录边界，**不是 monorepo workspace**：
  宿主有自己的 package.json、packages:[] 的 pnpm-workspace、lockfile/node_modules，
  linkWorkspacePackages=false、preferWorkspacePackages=false；
  生成项目又有自己的独立配置/lockfile/node_modules。
- 此安装环境作为请求的可复查消费者保留，不在结束时作为 scratch 删除。
  审阅必需的结果、安装记录与锁文件另已持久化到本 Outer World。

## 普通安装、策略及文件证据

两次实际执行的依赖安装都是对应目录的普通 `pnpm install`：

| 安装 | 实际结果 | 证据 |
| --- | --- | --- |
| 宿主 | 成功，+197 packages；含 CLI1、Builder1、Engine `261109-3` | [安装日志](./consumer-host-install.log)、[manifest](./consumer-host.package.json)、[workspace 配置](./consumer-host.pnpm-workspace.yaml)、[完整 lockfile](./consumer-host.pnpm-lock.yaml) |
| init 生成的 demo | 成功，+92 packages；SDK2、CLI1、Builder1 | [安装日志](./consumer-project-install.log)、[manifest](./consumer-project.package.json)、[生成配置](./consumer-project.pnpm-workspace.yaml)、[完整 lockfile](./consumer-project.pnpm-lock.yaml) |

没有安装重试、local tarball/file:/link:/workspace:/URL 依赖或源码拷贝。
pnpm 合法复用内容寻址 store（宿主 reused192/downloaded5；项目 reused91/downloaded1），
不声称每个第三方依赖均重新下载；registry 精确版本与 integrity 仍由正常安装校验。

[环境实测](./consumer-environment.json) 记录宿主和生成项目的 npm/pnpm registry 均为
`https://mirrors.cloud.tencent.com/npm/`、strict-ssl=true。
未覆盖 registry、改 lock URL、关闭 TLS 或将 minimumReleaseAge 设为0。
仅对本轮已明确选择的内部包做窄发布年龄例外；esbuild postinstall 显式 false，
由正常安装的可选平台二进制完成真实构建，不开启未知安装脚本。

锁文件 SHA256：

```text
host:    b3a90dcc09445d2a3906c4496a146f0c43b0d252377eadfb4c914f06d1a21c68
project: 79606df1cba29e3057f35e751d3d7fef79ea0fd001018ce899ae5817d717226d
```

两份 lockfile 中 CLI 的完整 SRI 均等于 [registry metadata](./cli-registry-metadata.json)：

```text
sha512-5zu7KvdHQ0lptizpRoU3fIAF5plIb5/uPsn03lJpkjR+eCXyGO9Y4anuqEdt7sCVufsR20rhu1p3Zw9rKc+1GA==
```

## 安装 bin 来源与模板版本

实际 Windows 命令：
`<host>\node_modules\.bin\task-builder.cmd`，实际 --version 为
`0.1.0-canary-261110-1`。其 registry package manifest 的 bin 解析到：

```text
D:\Code\task-engine.worktrees\task-builder-cli-redesign-setup\.cache\builder-consumer\node_modules\.pnpm\@silvermoon-work+task-build_15819b8363533c1e5d95b8579f5be219\node_modules\@silvermoon-work\task-builder-cli\dist\bin.js
```

bin SHA256：
`7ae4763e353f189b53365f516db440aa9e2759f51bca03af2e588eeb5fe1f924`。
生成项目自身安装的 CLI bin 也返回同一版本，且文件 SHA256 相同。
这是 **node_modules 内的已发布 bin**，不是仓库 packages/*/dist。

init 的实际 JSON/stdout/stderr/退出码见 [初始化回执](./consumer-init.json)。
它只创建8个完整项目文件，目标内当时没有 node_modules，宿主 manifest/workspace/lockfile
快照不变；之后才执行外部 pnpm install。
生成项目依赖精确为 CLI/Builder `0.1.0-canary-261110-1`、SDK
`0.1.0-canary-261109-2`；Task 名称由 demo 身份推导，没有查询 moving tag 代替。

宿主完整已安装 production/optional/peer 依赖递归核查 **198** 个 manifest，
所有解析出的依赖位于该宿主 node_modules 内，无 task-bundle-car。
Engine 独立生产子图 **186** 个 manifest，无 Builder/Builder CLI/esbuild/enhanced-resolve。
完整包名集合、realpath、版本和锁文件进口信息均在 [原始结果](./consumer-results.json)。

## 实际闭环与防护结果

[可重跑验证器](./consumer-check.mjs) 只从已安装 package 的公开 exports 加载 API，
业务命令执行已安装 manifest.bin 对应的实际文件，捕获原始 stdout/stderr/退出码；
不导入本仓库的业务实现。每个 CLI 结果都是一个换行结尾的 JSON 对象，stderr 为空；
失败 error 仅有非空 code/message。完整11项记录见 [consumer-results.json](./consumer-results.json)。

| 场景 | 实际结果 |
| --- | --- |
| 默认 build | 0，完整有效模块 `<demo>\dist`、声明 `<demo>\dist\task.yaml`、默认 `<demo>\dist.car` |
| 独立 car | 0，生成 standalone.car；故意暂时损坏 task.build.yaml 仍成功且不改该输入，证明不重新 build；之后恢复作者文件 |
| 重复 build | 0，CID 与 CAR 字节不变；notes.txt（无效UTF8）、旧资源和空目录保留但不入 CAR |
| --no-car | 0，作者把 greeting 改为 `Hello again\n` 后模块 CID 改变，car:null，旧 dist.car 字节不变 |
| 独立封装新模块 | 0，changed.car 的 CID 对应更新后的模块 |
| 已有目标 | 1 / OUTPUT_EXISTS，standalone.car 字节不变 |
| build 覆盖输入 | 1 / UNSAFE_PATH，输入及旧输出不变 |
| CAR 写入模块内部 | 1 / UNSAFE_PATH，没有生成内部 CAR |
| 源码缺失 | 1 / SOURCE_NOT_FOUND，旧模块/CAR 不变；验证器恢复其临时改名的作者文件 |
| 模块 junction alias | 1 / UNSAFE_PATH，禁止写入真实输入目录，输入/输出快照不变 |
| 祖先 junction alias | 同上；仅清理本次创建的链接，未碰真实目标 |

此外直接调用 Windows 安装 shim 的 init → 普通 pnpm install → build → 独立 car
又完整成功一次，避免把 Node API 调用冒充命令执行：
[shim 命令/输出](./consumer-shim-results.json)、[普通安装日志](./consumer-shim-install.log)。
`shim-demo` 显式使用 package-name=demo，得到与主项目初始结果完全相同的 CID。
PowerShell shim 记录中的 stderr:null 表示读取到0字节文件；Node 直接 bin 捕获的 stderr
均为空字符串，两者都没有 CLI 诊断输出。

实际完整模块选择（两种 CAR 一致）：

```text
resources/greeting.txt
schemas/input.json
schemas/message.json
schemas/result.json
schemas/shared/text.json
task.yaml
worker.cjs
```

初始默认/独立 CAR 的完整 CID：

```text
bafybeihrumldid2zbwulodw7h6rpaue7vhbfbecj2ajq6p3mfywwgdbzzm
```

两份 CAR SHA256 均为：
`31eb4fa7093bc5960c5adc7edb382e14547bdfbcacb3a04d388b5d379515fcf2`。
作者修改资源后模块/changed.car 的完整 CID：

```text
bafybeifcjdxg4sg47j5hu3g6uxvgyilkyeo5xrg7f7vmnkzzg53rxssu4y
```

保留的 demo 当前模块是第二个 CID，dist.car/standalone.car 仍对应第一个；
这是 --no-car 的预期保留，不把旧 CAR 冒充新模块交付。

## 真实已发布 Engine 消费

先读取实际安装的 Engine `0.1.0-canary-261109-3` README 和 d.ts，确认公开
createTaskEngine/MemoryStore/newId/start/submit/drain/close API。
随后三个独立进程使用 **registry Builder CAR API + registry Engine3** 消费完整 CAR；
没有使用当前并发 Engine 工作区实现或任何未发布 Engine CLI。

| 归档 | 真实 Task result | Run reclaimedAt | 进程 |
| --- | --- | --- | --- |
| dist.car | `{text:"Hello world",bytes:6,chunks:1}` | `2026-11-10T14:51:29.353Z` | exit0，signal=null，自然退出 |
| standalone.car | 同上 | `2026-11-10T14:51:30.328Z` | 同上 |
| changed.car | `{text:"Hello again world",bytes:12,chunks:1}` | `2026-11-10T14:51:33.007Z` | 同上 |

三个不同 dataDomain 各有1个 completed Task、1个已回收 Run；
rejections/errors 为空、无 cleanupUnknown。全部资源预取验证，archive close 后 retainedBytes=0。
父进程90s watchdog 未触发，不把被杀退出当作自然回收成功。
原始请求/任务/Run/时间与命令记录保存在 JSON，不用手写结果代替真实输出。

## 可重跑命令

从本工作区执行，采用新目录，避免覆盖已验证消费者；本机 registry 必须仍为 Tencent。
复制的是本轮**普通安装的配置/锁文件证据**，不是源码或二进制制品：

```powershell
$env:PATH = 'C:\Users\Wei\AppData\Roaming\nvm\v24.12.0;' + $env:PATH
$outer = Join-Path (Get-Location) '.silvermoon\ideas\01M72H0G5WYX8ZK03CRPQB0F8K\outer'
$hostDir = Join-Path (Get-Location) ('.cache\bc-replay-' + (Get-Date -Format HHmmss))
New-Item -ItemType Directory $hostDir
Copy-Item (Join-Path $outer 'consumer-host.package.json') (Join-Path $hostDir 'package.json')
Copy-Item (Join-Path $outer 'consumer-host.pnpm-workspace.yaml') (Join-Path $hostDir 'pnpm-workspace.yaml')
Copy-Item (Join-Path $outer 'consumer-host.pnpm-lock.yaml') (Join-Path $hostDir 'pnpm-lock.yaml')
Push-Location $hostDir
npm config get registry
pnpm config get registry
npm config get strict-ssl
pnpm install --frozen-lockfile
Pop-Location
$project = Join-Path $hostDir 'demo'
$checker = Join-Path $outer 'consumer-check.mjs'
node $checker init $hostDir $project (Join-Path $hostDir 'init-result.json')
Copy-Item (Join-Path $outer 'consumer-project.pnpm-lock.yaml') (Join-Path $project 'pnpm-lock.yaml')
Push-Location $project
npm config get registry
pnpm config get registry
pnpm install --frozen-lockfile
Pop-Location
node $checker verify $hostDir $project (Join-Path $hostDir 'consumer-results.json')
```

registry/TLS 不符或任一命令非零时停止，不用回退源、修改锁 URL 或业务代码继续求绿。
验证器对报告文件采用独占创建，重复执行应使用新目录/新报告。
本轮脚本 SHA256：
`c22f12917ca0ca7b317f100cd72822e90852c8426b70205213e59896a6c1ddc1`。
Outer 的局部 gitattributes 仅保护原始脚本/机器证据字节，并让 Git 正确认识 Windows
CRLF；普通尾随空格/空行检查仍启用。实际检查确认原 diff 警告均只是 CRLF，不是内容空白。

## 已知边界

本轮真实 registry 安装在 Windows/Node24；不声称已执行 macOS registry smoke。
Task 代码是可信作者代码，不是 OS 沙箱。此生产者闭环不验证 HTTP 认证、持久数据库、
并发 Engine Idea 的新生命周期功能或其未发布候选。
工作区后续 Engine/Protocol/SDK 版本变化不会被当成上述已发布字节；
本段仅发布明确批准的 Builder/Builder CLI，所有验证 API/版本均来自独立安装。
