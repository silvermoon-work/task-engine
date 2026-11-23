# 实施验证证据

## 实现与边界

- `packages/task-engine/src/bundle-worker.ts` 是随包分发的本地 ESM bootstrap；先安装 hook，再通过本地 createRequire 加载 IPFS CJS 入口，source 从 workerData 移入闭包后删除传输字段。不写 bundle 文件、不 eval、不在加载时修改已验证 source。
- `bundle-module.ts` 只依赖 Node 内置模块与已有 multiformats，避免在每个 Worker 引入 Protocol 宿主依赖图。CID 仅允许既有 dag-pb/raw 与 sha2-256，统一为 CIDv1；resolve 先检查原始地址，仅支持规范入口形态，不用 URL 归一化吞掉编码、dot-segment、查询或片段。其他 IPFS 地址、宿主文件、未打包包与外部协议拒绝执行。内置模块保留。
- `type-supervisor.ts` 保留每 Run 一个 Worker、原有环境隔离、启动错误、消息、日志、取消、物理退出与清理证明路径。新增工作只有同步内存加载，没有 hook 网络请求或额外 loader 线程；宿主仍通过 BundleCache 验证内容、授权、缓存和容量。
- Builder 的新 banner 对 IPFS `__filename` 直接使用逻辑 URL；本地文件执行仍使用 pathToFileURL。既有 `task.yaml`、taskSchemaUri、SDK/Space 握手和业务 schema 不变；不识别或拒绝旧 Builder 版本，没有兼容回退。

## Node 与 CJS 实验

本机全局 Node 仍为 24.11.1，没有切换 NVM；22.15.0 的官方 win-x64/node.exe 下载到当前项目 `.cache/ipfs-node-22.15`，SHA-256 对照官方同版本 SHASUMS256.txt 校验后显式调用，不安装全局运行时。二进制 SHA-256 为 `77bdff912b1c569b3e693fe126f619337c3e9d73dafbc4d0bf1d4f1f6a145761`。临时 probe 与下载仅用于本次验证，不作为仓库交付物。Silvermoon 原 global junction 未改变，原 checkout 的 dist 被共享环境恢复后正式 CLI 可用；未直接运行源码 bin 或修改设备注册。

精确最低版本采用 22.15.0：同步 API 引入版本在已批准设计中有官方文档依据，本次在此版本实际运行 bootstrap、真实 Builder/SDK 与生命周期测试。旧 Node 22.13.0 调用 Bundle inspection 返回 `unsupported_runtime`，没有异步 hook 或 eval fallback。CI matrix 与直接消费 Engine/Builder 的包声明、初始化模板及文档同步到 22.15.0；Protocol/SDK 独立 API 没有新增 Node 能力要求，保留其原声明。

[Node 24.11.1 官方文档](https://nodejs.org/download/release/v24.11.1/docs/api/module.html#moduleregisterhooksoptions) 明示该 API 同时自 v23.5.0、v22.15.0 引入。因此 Engine 及其直接运行时消费者 CLI/Server、根项目与生成模板使用精确范围 `^22.15.0 || >=23.5.0`，准入也使用相同范围，避免 `>=22.15` 误包含尚无该 API 的 23.0–23.4。Builder/Builder CLI 自身仅构建而不安装 hook，构建宿主保持 `>=22.15.0`；Protocol/SDK/Storage/HTTP 的独立运行时不安装 hook，保留其原声明。本机另在 Node 23.7.0 跑过原生同步 CJS 探针，cache、内置模块解析与拒绝通过；这不是 23.x 的全生命周期验收。

原生 require、require.cache、require.resolve、require.resolve.paths 都存在；内置模块解析与使用正常，模块缓存以规范 IPFS URL 为键。require 同入口、CIDv0 别名及 import 已加载 CJS 入口均复用状态、只求值一次。不同 Run 的模块状态仍独立。

明确限制：Node 22.15.0 与 24.11.1 的 `require.resolve(ipfsURL)` 均返回 `MODULE_NOT_FOUND`，该原生 API 不经过同步 hook。不承诺通用作者 IPFS require/resolve API，不修改 Module 私有方法或全局 URL API。本地路径转换不能用于 IPFS `__filename`、`__dirname` 或 import.meta.url。

## 可重放测试

以下命令从仓库根执行；进入 package 后运行测试以保持现有 fixture 的 cwd 约定。
首次复现须先将 [官方二进制](https://nodejs.org/dist/v22.15.0/win-x64/node.exe)
置于 `.cache\ipfs-node-22.15\node.exe` 并用
[官方 SHASUMS256.txt](https://nodejs.org/dist/v22.15.0/SHASUMS256.txt) 校验。

```powershell
pnpm --filter @silvermoon-work/task-engine... build
$node = (Resolve-Path .cache\ipfs-node-22.15\node.exe).Path
Set-Location packages\task-engine
& $node ..\..\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 --test-name-pattern="IPFS" test\bundle-module.test.ts test\bundle-contract-host.test.ts
```

2026-11-12，最终新增 IPFS 测试在 Node 22.15.0、24.11.1 均为 7/7 通过；22.15.0 另加 `contains and unevaluatedItems` 原有完整边界场景复跑，合计 8/8 通过。覆盖真实 Builder 地址生成、SDK ready/complete、CJS API、并发 Run 状态隔离、16 类 require 拒绝、动态 import 拒绝、CID 别名/cache、同入口 import 单次求值、启动异常的模块地址与退出，以及日志、进度、合作取消和阻塞 Worker 强制退出。下载的 Node 二进制、校验文件和临时 probe 已删除，未进入 Git；没有改变全局 Node 选择。

强制终止测试故意不提供独立宿主清理证明，因此验证实际退出与路由撤销，并保留 `reclamation_unknown`，而不是把物理退出当成全部副作用已清理。合作取消正常回报结果、物理退出后释放；测试均在 finally 关闭 supervisor 或终止 Worker。

## 标准与回归索引

| 标准 | 代码与证据 |
| --- | --- |
| I-AC01 | [bundle-contract-host.test.ts](../../../../../packages/task-engine/test/bundle-contract-host.test.ts)：新增 IPFS 入口/CJS/cache/并发 Run 与日志取消测试；既有真实 Engine 输入、结果、消息、错误结果和退出回归。 |
| I-AC02 | [bundle-module.test.ts](../../../../../packages/task-engine/test/bundle-module.test.ts)：别名、动态 import、原始 URL 拒绝及启动错误；[bundle.test.ts](../../../../../packages/task-engine/test/bundle.test.ts) 与 [bundle-admission.test.ts](../../../../../packages/task-engine/test/bundle-admission.test.ts)：真实 CID 获取、完整性、容量、网关策略、取消及恢复。 |
| I-AC03 | [type-supervisor.test.ts](../../../../../packages/task-engine/test/type-supervisor.test.ts)、[drain.test.ts](../../../../../packages/task-engine/test/drain.test.ts)、[space-worker.test.ts](../../../../../packages/task-engine/test/space-worker.test.ts)：独立 Worker、物理退出、关闭、资源回收与不伪造清理证明；新增 IPFS 测试同时验证宿主加载器未改变。 |

并发 main 的 IPNS 实现与 rc.8 准备已通过普通 fast-forward 保留；只对两个重叠文件暂存本操作自己的修改，合并后原样应用并删除该操作 stash，没有改写或丢弃其他历史。因新 manifest/lockfile 已变化，执行 `pnpm install --frozen-lockfile` 恢复依赖，退出 0，registry 仍为既有配置。同步前的全量试跑未作为最终结果；最终验证针对合并后的实现。

## 全量检查与非绿色结果

已按项目要求在 Node 24.11.1 执行两次合并后的 `pnpm check`，均退出 1，不能称为全量绿色：

- 第一次 18m44：Engine 252/252、Builder 52/52、Builder CLI 22/22、Protocol 132/132、SDK 9/9 及 release scripts 21/21 通过。CLI 唯一实际失败为 managed 组固定 400ms SIGINT 断言：信号发生在持久 acceptance 前，命令按既有协议返回 `SUBMISSION_UNKNOWN` / 1，而测试期望已接受后的取消 / 130。错误同时计入子项与父项，不是两个独立功能失败。其余测试包含两引擎真实 Gateway 执行通过。
- 不修改任何 watchdog、CLI 行为或 managed 测试，单独复跑 `--test-name-pattern="managed installed entry"`，7/7 通过，涵盖预算、取消、关停、重启恢复、日志及清理。
- 第二次 21m48：上述 managed 组在全量中也全部通过；CLI 共 90 项，88 通过、1 失败、1 个 Linux 专属场景在 Windows 跳过。唯一失败为两引擎场景的 Windows 进程身份查询：原有 PowerShell `Get-Process` 得到进程对象，但退出竞争使 StartTime 为 null，调用 ToUniversalTime 失败。该脚本不在本次修改范围，未借机修复。
- 单独复跑 `--test-name-pattern="two independent managed Engines"`，1/1 通过，实际经过两个独立受管 Engine、真实本地 raw/CAR Gateway、多块 bundle、SDK 结果与关闭；不是仅内存源码模拟。

相关完整日志保留在项目忽略的 `.cache/ipfs-check-node24-final.log`、`.cache/ipfs-check-node24-retry.log`、`.cache/ipfs-managed-rerun.log` 与 `.cache/ipfs-two-engines-rerun.log`。这些失败没有被豁免，也不复用此前旧 full check 的两个 legacy 15s watchdog 结果。精确 main commit 的远端 CI 仍必须由父 agent 独立确认；未通过前禁止发布。

由于 Turbo 在 CLI 失败后中止后续队列，另以一次 runner 组合补齐 HTTP、Storage、Server 与 app 的 lint/typecheck/test/build，22/22 tasks 通过，其中 HTTP 19/19、Storage 53/53、Server 15/15、app 1/1 测试通过。最终 `pnpm typecheck:tests`、`pnpm lint:package`、`pnpm format:check` 均退出 0；未新增测试工具或更改旧测试时间限额。日志为 `.cache/ipfs-downstream-check.log`。

之后普通 fast-forward 集成 `7e10001` 的其他 idea 部署文档与事件；该同步没有产品源码变化。所有本次源代码和测试改动均保留，已批准 Ideal World 内容未改动。

## 剩余部署条件

Windows 验证不能替代 Ubuntu 独立安装与真实网关外部 smoke。部署、RC 发布、远端故障演练与精确 main commit CI 成功仍是下一阶段条件，未在此宣称完成。[发布顺序与版本](release-plan.md) 已明确列出但尚未发布或修改包版本。
