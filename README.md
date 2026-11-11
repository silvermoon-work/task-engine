# Task Engine

Task Engine 的独立 monorepo，使用 pnpm workspaces 和 Turborepo。已从
[potential-guide 的固定提交](https://github.com/shazhou-ww/potential-guide/tree/3500086123d8b821b77958699ceeebfb2a518e0f)
提取 5 个通用核心包，并新增独立 Task Builder 与 CLI 库，统一使用
`@silvermoon-work/`
scope。原始 MIT 许可证随每个包保留，原协议 URI、Bundle 字节契约及持久数据格式不因包改名而改变。已发布首轮 canary；根包
`task-engine` 保持 private。Silvermoon 项目元数据已初始化。

## 安装试用

使用 Node.js 22.13 或更新版本（建议 Node.js 24），安装两个已编译的 CLI。以下是
**0.1.0 / latest**
已发布并完成真实 registry 安装验证。命令失败时先排查，不继续使用旧产物：

```powershell
npm install -g @silvermoon-work/task-builder-cli@0.1.0 @silvermoon-work/task-engine-cli@0.1.0
task-builder --help
task-engine --help
task-builder init my-task
cd my-task
npm install
npm run typecheck
npm run build
task-engine server start --data-dir .\engine-data
'{"text":"world"}' | task-engine run --car .\dist\my-task.car --input -
task-engine task query --status succeeded
task-engine server stop --data-dir .\engine-data
```

无需克隆本仓库、安装 TypeScript 或编译 CLI。发布时先编译再打包
`dist`，全局命令直接执行该产物。项目名从目标目录名派生；上例输出为
`dist/my-task/task.yaml` 和 `dist/my-task.car`，不是 `dist/task.yaml` 或
`bundle.car`。一般形式为 `dist/<derived-package-name>/task.yaml` 和
`dist/<derived-package-name>.car`。

**build 已默认生成并校验 CAR，不要紧接着执行
`npm run car`**：独立 car 拒绝覆盖已有文件。需要分别验证时，在新项目第一次构建中使用：

```powershell
npm run build -- --no-car
npm run car
```

已有默认 build 产物时可改为新输出：

```powershell
task-builder car .\dist\my-task\task.yaml --output .\dist\my-task-copy.car
```

build 只转译 TypeScript，不负责类型检查；0.1.0 模板提供独立
`npm run typecheck`，最终脚本为
`build/car/clean/typecheck`。构建和类型检查必须分别通过，没有 Builder `check`
子命令。

Builder 在执行 build 时调用 esbuild；npm 通过 optional
dependency 安装当前 OS/CPU 对应的预编译二进制，跳过 esbuild
postinstall 仍可构建，不要同时使用
`--omit=optional`。build 不会补跑安装脚本。Engine 必须显式启动 Server，不会自动启动；仅
`--input -`
读取 stdin。本地 CAR 无需 Gateway 或 Kubo，但仍通过 Server 执行并持久保存任务。结果应为
`Hello world`、
`status: "succeeded"`、退出码 0。CID 的缺块获取仅由 Server 启动参数
`--ipfs-gateway` 或 `server.ipfsGateway`
配置；不读取旧 Kubo 环境变量。只执行可信任务代码，全局 npm 的 bin 目录须在 PATH 中。

完整配置、持久化、离线清理与旧接口迁移见
[Engine CLI README](packages/task-engine-cli/README.md)；重启后按 taskId 查询和离线清理的完整操作见[端到端验证指引](docs/end-to-end-verification.md)。源码打包制品已在 Linux
x64 / Node
24 验证安装、在线 CID、持久日志与重启；正式版本仍须通过发布后真实 registry 安装验证。

### 0.1.0 发布范围与兼容边界

本轮逐包发布 Protocol、SDK、Builder、Builder CLI、Engine、Engine
CLI；Storage、HTTP、Server 保留其原有 canary 版本，不在本轮发布范围。模板的 SDK、Builder 和 Builder
CLI 均固定为 0.1.0，内部 `workspace:*` 在打包时转换为精确版本，不隐式追踪
`latest`。

0.1.0 是可安装的非预发布版本，不代表 1.0 的长期兼容承诺。后续不兼容变更须明确说明；不把旧数据静默迁移、清空或当作新格式读取。升级前停服并备份实例目录，不支持的格式须使用新目录。Windows
x64 和 Linux x64 已有验证；macOS、ARM 和生产多租户隔离未在本轮验证。

本轮包含 Space context breaking change：旧的 `context.bundle.read()`、
`context.generation` 和 `context.checkpoint` 已移除；改用
`context.bundle.root.resolve(path).read()` 和
`context.output`。旧 SDK 编译的 Bundle 必须用配套 SDK/Builder 重新构建，不能继续使用旧 CAR/CID 作为新版成功验收样例。最终结果新增
`outputCid`，它不是业务 `result` 的字段。详见
[SDK Space 契约](packages/task-sdk/README.md#spaces-breaking-contract)。

## 本次提取范围

当前源码已取消独立 CAR 发布单元：Builder 自有 `/tree`
构建 IO 端口与不加载编译器的 `/car` 生产/校验入口；Engine
CLI 通过标准 CAR/UnixFS 库实现离线只读块源，生产安装不依赖 Builder/esbuild。Task 规则复用既有 Protocol/Engine 校验，CID 与 CAR 字节契约不变。当前已发布基线见上方；后续源码变更仍须分别发布和真实 registry 安装验证。旧 CAR 首次发布失败的不可变 tag 仅保留历史，不重试、不移动。

| 包                                                                               | 职责                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------ |
| [@silvermoon-work/task-protocol](./packages/task-protocol/README.md)             | 任务事实、协议、投影及 Bundle 契约         |
| [@silvermoon-work/task-sdk](./packages/task-sdk/README.md)                       | Worker 运行时与作者回调、上下文类型        |
| [@silvermoon-work/task-engine](./packages/task-engine/README.md)                 | 嵌入式引擎、任务协调及执行池               |
| [@silvermoon-work/task-engine-storage](./packages/task-engine-storage/README.md) | SQLite 持久化                              |
| [@silvermoon-work/task-engine-http](./packages/task-engine-http/README.md)       | 可挂载 HTTP API 与 SSE                     |
| [@silvermoon-work/task-engine-server](./packages/task-engine-server/README.md)   | Node HTTP/SSE 服务组装                     |
| [@silvermoon-work/task-builder](./packages/task-builder/README.md)               | 只读文件树转换、esbuild 构建与流式资源     |
| [@silvermoon-work/task-builder-cli](./packages/task-builder-cli/README.md)       | Commander 命令交互、本地文件适配与模板组装 |
| [@silvermoon-work/task-engine-cli](./packages/task-engine-cli/README.md)         | 显式后台 Server、持久任务查询与离线清理    |

Web UI、pguide CLI 和 Check/Probe 包不在本次提取范围。Task
SDK 已迁入，保留原 Worker 运行时与 API，仅依赖本仓库 task-protocol；init 模板与作者入口使用
`@silvermoon-work/task-sdk`。当前已发布基线见「安装试用」，下方发布记录只代表各自精确的历史版本与验证边界。新增 task-builder 不依赖 pguide 命令协议：模块通过抽象文件树解析，资源按需流式读取；提供独立
`init` / `car` export 提供模板文件树及有界流式 CAR 编码/检查。核心不含 CLI
binary 或宿主文件系统适配；独立 task-builder-cli 库提供 `task-builder`
命令、Commander 交互及本地写入。构建输出资源依赖输入树生命周期，完整校验需消费全部流。详见
[Task Builder](./packages/task-builder/README.md)。SDK、引擎、CLI、HTTP、存储和 Server 测试全部使用本仓库的 SDK、builder 和 protocol；不再依赖旧 scope 的 Bundle 工具或 SDK/protocol，也不维护旧 CAR 字节兼容测试。
`ipfs-content` 不作为依赖，离线测试复用引擎的 `testing`
支持。包内完整设计文档链接固定到来源提交，后续文档迁移不在本次范围。

## Git lineage

本仓库通过 Git lineage 继承
[`preset-pnpm-monorepo`](https://github.com/shazhou-ww/preset-pnpm-monorepo) 的
`main`，保留完整 Git 历史。[.git-lineage.yaml](./.git-lineage.yaml)
记录直接父仓库；potential-guide 是计划中的代码来源，不是 lineage 父仓库。在工作区干净时运行
`git-lineage update`，以普通 merge 单向合入父仓库更新。

## Silvermoon

[.silvermoon/config.yaml](./.silvermoon/config.yaml) 使用 v2，primary 为本仓库的
`main`，内容语言为
`zh-CN`。Silvermoon 使用设备级 CLI 和个人 skill，不作为工作区依赖安装。

```sh
silvermoon check --worktree --audience agent
silvermoon whats-next --audience agent
```

构想候选及其提交事件需通过 Silvermoon 校验并同步至
`origin/main`，再请求对应 revision 的构想验收；创建 idea 不代表实现方案已获批准。

Silvermoon 元数据现已初始化，使用 `origin/main`
作为 primary。首次初始化的空目录用 `.silvermoon/ideas/.gitkeep`
保留；设备上的修复版 Silvermoon 允许这个空的普通文件，不将其视为 idea。使用尚未包含此修复的旧 CLI 时需要先更新运行时。
`.silvermoon/ideas/`
不进入通用 Prettier 格式化，以免改变已提交/验收的世界 revision；这些记录使用
`silvermoon check --worktree --audience agent` 独立校验。

## Structure

```text
apps/
  task-engine/
packages/
  task-protocol/
  task-sdk/
  task-engine/
  task-engine-storage/
  task-engine-http/
  task-engine-server/
  task-builder/
  task-builder-cli/
  task-engine-cli/
pnpm-workspace.yaml
turbo.json
```

内部依赖使用
`workspace:*`。移除 preset 的示例工作区，保留核心包及新增的 task-sdk、task-builder、task-builder-cli。CLI 可被程序化调用，因此作为可复用库放在 packages，而非 private
app。编译器和 Node 类型沿用来源项目的 TypeScript 5.9.3 与 Node
22 类型版本，避免在提取时同时升级编译基线。包使用 Biome 和 Node test
runner（tsx）；根目录及 release 脚本保留 preset 的 Prettier/ESLint 工具链。

## Workspace conventions

- Executable and deployable projects belong in `apps/`.
- Reusable code belongs in `packages/`.
- Shared third-party versions belong in the pnpm catalog in
  `pnpm-workspace.yaml`.
- Internal dependencies use `workspace:*`.
- Each workspace owns its build, lint, test, and typecheck scripts.
- Root commands use Turborepo to respect dependency order and cache outputs.

Add a dependency from the repository root:

```sh
pnpm --filter @silvermoon-work/task-engine add some-package
pnpm --filter @silvermoon-work/task-protocol add --save-dev some-dev-tool
```

Run a command for one workspace:

```sh
pnpm --filter @silvermoon-work/task-protocol test
```

## Commands

从新建项目到 Task 构建、CAR 和真实运行的跨平台验证，见
[端到端验证指引](./docs/end-to-end-verification.md)。当前已发布版本见「安装试用」；模板使用本仓库的
`@silvermoon-work/task-sdk`，Engine
CLI 使用受管 Server。下方各轮发布记录仅代表当时精确版本，不作为当前源码或未来正式版验收结论。

| Command          | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `pnpm build`     | Build every workspace in dependency order              |
| `pnpm lint`      | Lint release scripts and every workspace               |
| `pnpm typecheck` | Type-check every workspace                             |
| `pnpm test`      | Test release guards and all core workspaces            |
| `pnpm check`     | Run formatting, lint, types, tests, builds and publint |
| `pnpm clean`     | Remove workspace outputs and Turborepo state           |

`pnpm check` and `pnpm test` limit Turborepo to one workspace task at a time.
Engine, Engine CLI and SQLite storage also run one test file at a time: these
integration suites launch real Workers/child processes, so multiplying workspace
and test-file concurrency can starve the same short business deadlines under
test. This changes execution scheduling, not test selection, Task concurrency,
deadlines or assertions. CI reports its actual CPU/memory resources and still
runs the complete check on both required Node versions.

## Adding a workspace

Every direct child of `apps/` or `packages/` is discovered automatically. Give
it a unique package name and the standard scripts consumed by `turbo.json`. Keep
application packages private. Add publishable libraries to the package-specific
tag release mapping below.

## Publish one package

### Release candidate channels

New releases use only `latest` (stable versions) and `rc` (`<base>-rc.N`). The
`0.2.0-rc.0` candidate replaces the dated-canary naming convention without
changing the 0.2.0 output contract. Existing canary package versions, immutable
Git tags and npm dist-tags are preserved as historical records. The verifier
rejects new dated canaries and other prerelease channels. Publish every package
separately after its exact workspace dependencies are available.

### Unified output canary (0.2.0)

The `0.2.0-canary-261111-1` release groups the final Space CID and business
result as `output: {cid, result}` across Task/Run facts, HTTP and CLI responses.
Top-level `result` and `outputCid` are removed. Collection summaries include
only `output.cid`, not business results. Failure evidence may contain
`output.result` without a CID; running or failed executions do not fabricate a
finalized Space. Worker callback return values, result schemas and child
invocation results remain business JSON; existing Space-aware Bundles need not
be rebuilt. Development databases using the old envelope are rejected without
migration: select a fresh Engine data directory.

All nine packages were published separately from
`95174d751f40065a66e33af571a4d162bc3c3940`, after successful
[exact-commit Node 22/24 CI](https://github.com/silvermoon-work/task-engine/actions/runs/43016025825).
Their `canary` tags select `0.2.0-canary-261111-1`; existing `latest` tags were
not changed. The 0.1.0 CLI help, diagnostics and typed-template improvements
remain included.

| Package                                | Trusted publication                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `@silvermoon-work/task-protocol`       | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43017398539) |
| `@silvermoon-work/task-sdk`            | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43017885056) |
| `@silvermoon-work/task-builder`        | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43018255472) |
| `@silvermoon-work/task-builder-cli`    | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43018703462) |
| `@silvermoon-work/task-engine`         | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43019008930) |
| `@silvermoon-work/task-engine-storage` | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43019533873) |
| `@silvermoon-work/task-engine-http`    | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43019907915) |
| `@silvermoon-work/task-engine-cli`     | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43020286592) |
| `@silvermoon-work/task-engine-server`  | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43020808203) |

Full `pnpm check` passed on Windows and `office-ubuntu`. A fresh consumer
installed all nine exact registry versions, verified tarball integrities and
dist-tags, and ran real Worker/HTTP/SQLite/offline-Kubo tests. Task and Run
responses, CLI `run`, `task await` and `task query --id` all returned the same
`output` envelope without old sibling fields; collection summaries contained
only the CID. Both HTTP and CLI preserved an explicit `output.result: null`. The
2 MiB file checksum, cancellation recovery, same-Space links, retained output
after restart, and history with content acquisition disabled also passed.
Temporary services were stopped after verification.

### Stable 0.1.0 (2026-11-11)

The six selected packages were individually published from
`bf64d0be1d470aef3a5d7870bfccee6a4da60a17`, after successful
[exact-commit Node 22/24 CI](https://github.com/silvermoon-work/task-engine/actions/runs/43010547776).
All six `latest` tags select `0.1.0`; Storage, HTTP and Server were not
republished. The next breaking change is reserved for 0.2.0.

| Package                             | Trusted publication                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `@silvermoon-work/task-protocol`    | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43011623454) |
| `@silvermoon-work/task-sdk`         | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43012003134) |
| `@silvermoon-work/task-builder`     | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43012492771) |
| `@silvermoon-work/task-builder-cli` | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43012883373) |
| `@silvermoon-work/task-engine`      | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43013322963) |
| `@silvermoon-work/task-engine-cli`  | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/43013900253) |

[Read-only registry verification](https://github.com/silvermoon-work/task-engine/actions/runs/43014356188)
confirmed exact versions, dist-tags and internal dependencies. Its initial
attempt saw the stale Engine CLI catalog; the retry passed after propagation. No
release tag was moved and no successful publication was repeated.

On office-ubuntu (Linux x64, Node 24.22.2), a fresh isolated npm installation of
both 0.1.0 CLIs and an unmodified generated project's dependencies passed 48
acceptance commands without workspace/tarball overrides. Checks covered
typecheck (positive and negative), build, standalone CAR/overwrite refusal,
clean, help/error behavior, local CAR, uncached CID through an isolated HTTP
raw-block gateway, async/await, query pagination, durable logs, restart and
offline prune. A second task read and compared every byte of a 2 MiB output
after restart and cache-only pruning, with no gateway configured. This stable
CID check used a local HTTP fixture, not the older public Pinboard Echo CID. Old
pre-Space Bundles must still be rebuilt.

Validation daemons and the fixture gateway were stopped. Existing global CLI
installations and user projects were not changed.

### Space context canary (2026-11-11)

All nine packages are published as `0.1.0-canary-261111-2` from
`13e3b9901b8e49eca6c457dc71b7fffbf1432ffe`, after successful
[exact-commit Node 22/24 CI](https://github.com/silvermoon-work/task-engine/actions/runs/42994187062).
Each package used its own immutable tag and Trusted Publishing workflow;
`canary` selects the new version and `latest` remains `0.0.0`.

| Package                                | Publication                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `@silvermoon-work/task-protocol`       | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42995586541) |
| `@silvermoon-work/task-sdk`            | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42995737405) |
| `@silvermoon-work/task-builder`        | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42996645793) |
| `@silvermoon-work/task-builder-cli`    | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42997226103) |
| `@silvermoon-work/task-engine`         | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42995773125) |
| `@silvermoon-work/task-engine-storage` | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42995773432) |
| `@silvermoon-work/task-engine-http`    | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42995773562) |
| `@silvermoon-work/task-engine-cli`     | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42998761369) |
| `@silvermoon-work/task-engine-server`  | [Actions](https://github.com/silvermoon-work/task-engine/actions/runs/42999348356) |

This is a breaking Space/Ref context change: rebuild older canary Bundles. The
artifact verifier includes workspace development dependencies when checking
published prerequisites. Initial dependency-visibility failures were retried
with unchanged tags, without bypassing the verifier or publishing locally.

Full `pnpm check` passed on Windows and Linux. A fresh project on
`office-ubuntu` used the published Builder CLI and installed all nine exact
registry versions with recorded tarball integrities, without source overrides.
Real Workers ran through HTTP and SQLite against an isolated offline Kubo:
Bundle reads, directory enumeration, atomic cancellation followed by a
successful write, finite same-output links, and a streamed 2 MiB file all
passed. After restart, a second Run consumed the persisted output and retained
the same root CID. Another restart with content acquisition disabled still
returned completed history and its output CID. Both Runs were physically
reclaimed.

### Published canaries (2026-11-09, first round)

All six packages were published through Trusted Publishing from the verified
main commit `02014a5fd7b29d5a5d562535d0ff06139e22cdc8`. The npm `canary`
dist-tag points to the versions below; `latest` remains the placeholder `0.0.0`.

| Package                                | Version                 |
| -------------------------------------- | ----------------------- |
| `@silvermoon-work/task-protocol`       | `0.1.0-canary-261109-2` |
| `@silvermoon-work/task-builder`        | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-engine`         | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-engine-storage` | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-engine-http`    | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-engine-server`  | `0.1.0-canary-261109-1` |

Protocol index 1 stopped before publication because the old artifact verifier
required an absent `apps/` directory. Its tag remains immutable; index 2
includes the corrected verifier. The server's original tag was retried without
moving it after dependency metadata became visible. All final versions,
dist-tags and internal dependencies passed the
[authoritative registry verification](https://github.com/silvermoon-work/task-engine/actions/runs/42558542157).

### Builder library / CLI release (2026-11-09)

Published from `85161c8a7211080e7f15f2f71dc8e9e96b21b80e`, after exact-commit
Node 22/24 CI and the versioned release aggregate succeeded:

| Package                             | Version                 | Publication                                                                                |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `@silvermoon-work/task-builder`     | `0.1.0-canary-261109-2` | [Trusted publish](https://github.com/silvermoon-work/task-engine/actions/runs/42577672894) |
| `@silvermoon-work/task-builder-cli` | `0.1.0-canary-261109-1` | [Trusted publish](https://github.com/silvermoon-work/task-engine/actions/runs/42577838042) |

Both `canary` tags and runtime dependencies passed
[targeted authoritative registry verification](https://github.com/silvermoon-work/task-engine/actions/runs/42578343710).
The CLI's first attempt stopped before publication while dependency metadata
propagated; the same immutable tag was retried. `latest` remains `0.0.0`. This
round did not publish `task-engine@0.1.0-canary-261109-2` or `task-engine-cli`.
Actual published-package install and HTTP/SQLite compatibility smoke results,
including the Windows database-path limitation, are recorded in the
[end-to-end guide](./docs/end-to-end-verification.md#本轮-builder-发布验证).

### Global Engine CLI release (2026-11-10)

`@silvermoon-work/task-engine-cli@0.1.0-canary-261110-1` was published through
[Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/42741820766)
from `1751a60122c55d89a03ab2a06597e921b9670fcd`, after successful
[exact-commit Node 22/24 CI](https://github.com/silvermoon-work/task-engine/actions/runs/42741236966).
The initial publication attempt lacked the package's Trusted Publisher; after
the user configured it, the same immutable tag and workflow were retried
successfully. No other package was republished for this CLI release.

The actual commands
`npm install -g @silvermoon-work/task-builder-cli@canary @silvermoon-work/task-engine-cli@canary`
were exercised using an isolated global prefix, without changing the existing
global installation. They selected builder CLI `0.1.0-canary-261109-3` and
Engine CLI `0.1.0-canary-261110-1`. The installed Engine CLI's bin was
`dist/bin.js`, its package had no `src` directory and no
preinstall/install/postinstall/prepare compilation hooks. No repository clone,
local pack or consumer-side CLI build was used.

The installed global builder bin created a new project; `npm install`,
`npm run build`, `npm run car` and `npm run check` succeeded. The installed
global engine bin consumed `{"text":"world"}` from stdin and ran that local CAR
without a Gateway or HTTP service. Assertions confirmed `status: "succeeded"`,
exit code 0, `Hello world`, one Run with `reclaimedAt` and no cleanup
uncertainty. The global installed dependency graph contained no old-scope
project package. The package registry's initial propagation delay was resolved
by retrying the same canary installation, not by using local artifacts or
weakening installation safeguards.

### SDK release (2026-11-09)

`@silvermoon-work/task-sdk@0.1.0-canary-261109-1` was published alone from
`d699c270e379d8cc70737b40a4d33b358770ee95`, after the exact-commit
[Node 22/24 CI and release aggregate](https://github.com/silvermoon-work/task-engine/actions/runs/42587558871)
succeeded. The
[Trusted Publishing run](https://github.com/silvermoon-work/task-engine/actions/runs/42588331015)
published the verified tarball with signed provenance; its exact runtime
dependency is the already published
`@silvermoon-work/task-protocol@0.1.0-canary-261109-2`. Registry metadata
confirms `canary` points to this SDK version and `latest` remains the
placeholder `0.0.0`.

The migrated workspace init generated a fresh private project, which installed
the published SDK, builder `0.1.0-canary-261109-2` and builder CLI
`0.1.0-canary-261109-1` with a frozen lockfile and no local package overrides.
Its installed builder completed Build/CAR/Check; the current workspace Engine
CLI's `runBundle` executed the checked CAR in a real Worker. The root returned
`{text: "Hello canary", bytes: 6, chunks: 1}`, exit code 0, one reclaimed Run
and no cleanup uncertainty. The checked root was
`bafybeiefphyqt2wuttkuzfac32tkmspq7ojmd2naulejjlusolp3vj5cem`.

This proves the published SDK against the migrated init source, not a newly
published init CLI or Engine. No builder, CLI, Engine or protocol package was
published in this SDK release. Previously published builder/CLI versions still
generate the old-scope SDK template; shipping the new default template requires
a separately authorized builder/CLI release.

Subsequent workspace cleanup removed all old-scope development dependencies and
converted integration fixtures to the workspace builder/protocol/CAR APIs. It
also restored the SDK's `invokeTask` author context and child-result ACK
handling, which the earlier source import had omitted. This addition is not in
the initial SDK canary above; it shipped in the separately authorized SDK canary
2 release recorded below.

The subsequent dependency audit also checked the old project's scoped packages
and its unscoped `pguide` / `potential-guide` names against all eleven workspace
manifests and the installed dependency graph: no source/development/runtime
dependency remains. CI and release validation reject those names and npm aliases
in runtime, optional, peer and development dependencies. Published package
verification applies the same guard to the registry artifact manifest, not only
to the current source manifest. Original protocol URI strings and MIT
provenance/specification links remain identities, not package dependencies.

Before the legacy-free rollout, published canary metadata contained these
historical development declarations; none were production dependency edges:

| Published package                      | Canary                  | Old development dependencies |
| -------------------------------------- | ----------------------- | ---------------------------- |
| `@silvermoon-work/task-builder`        | `0.1.0-canary-261109-2` | old SDK and Bundle tool      |
| `@silvermoon-work/task-builder-cli`    | `0.1.0-canary-261109-1` | old SDK                      |
| `@silvermoon-work/task-engine`         | `0.1.0-canary-261109-1` | old SDK and Bundle tool      |
| `@silvermoon-work/task-engine-http`    | `0.1.0-canary-261109-1` | old SDK and Bundle tool      |
| `@silvermoon-work/task-engine-storage` | `0.1.0-canary-261109-1` | old SDK and Bundle tool      |
| `@silvermoon-work/task-engine-server`  | `0.1.0-canary-261109-1` | old SDK and Bundle tool      |

The old declarations name `@potential-guide/task-sdk` and
`@potential-guide/pguide-task-bundle`. The published protocol and SDK canaries
are already independent of them. No Engine CLI package metadata was available in
that audit, so its publication state was not verified there. The preceding
builder/CLI init path also created a new project's production dependency and
author import on the old `@potential-guide/task-sdk@0.1.0-rc.2`. This was
confirmed from the actual builder canary 2 tarball after checking its published
SHA-512 integrity. The rollout below replaces that default with SDK canary 2.
Historical versions and tags remain immutable; their dependency declarations are
not rewritten.

### Legacy-free final canaries (2026-11-09)

Each package below was separately authorized, tagged and published through
Trusted Publishing, after successful exact-commit Node 22/24 main CI:

| Package                                | Version                 | Publication                                                                        |
| -------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `@silvermoon-work/task-sdk`            | `0.1.0-canary-261109-2` | [SDK](https://github.com/silvermoon-work/task-engine/actions/runs/42601746924)     |
| `@silvermoon-work/task-builder`        | `0.1.0-canary-261109-3` | [Builder](https://github.com/silvermoon-work/task-engine/actions/runs/42604138859) |
| `@silvermoon-work/task-builder-cli`    | `0.1.0-canary-261109-3` | [CLI](https://github.com/silvermoon-work/task-engine/actions/runs/42612402889)     |
| `@silvermoon-work/task-engine`         | `0.1.0-canary-261109-3` | [Engine](https://github.com/silvermoon-work/task-engine/actions/runs/42644208304)  |
| `@silvermoon-work/task-engine-http`    | `0.1.0-canary-261109-3` | [HTTP](https://github.com/silvermoon-work/task-engine/actions/runs/42644961011)    |
| `@silvermoon-work/task-engine-storage` | `0.1.0-canary-261109-3` | [Storage](https://github.com/silvermoon-work/task-engine/actions/runs/42646060642) |
| `@silvermoon-work/task-engine-server`  | `0.1.0-canary-261109-3` | [Server](https://github.com/silvermoon-work/task-engine/actions/runs/42646644141)  |

Protocol remains the already published `0.1.0-canary-261109-2`; Engine CLI was
not published. SDK2 came from `e610ced64c5aca017d36db223c489ad115c0dcb7`;
builder3 from `77680e84a5f8331d6f0c7971d0ec716b5daafbb4`; CLI3 from
`db937db95e022b692db4a294acb55a3a789cf9c4`; the final four canary3 libraries
from `e002f29a57cb91bfaf8cca7f76392af2895375bb`. The latter commit passed
[exact main CI](https://github.com/silvermoon-work/task-engine/actions/runs/42643404329).

CLI2's immutable tag was retained after three pre-publication attempts could not
see builder3 in the runner's cached registry catalog. CLI3 uses strict exact
version records instead. The initial engine/HTTP/storage/server2 publications
still declared unpublished CLI2 development references; separately authorized
canary3 versions correct those references to CLI3. The release guard now checks
internal **development** dependencies as well as runtime, optional and peer
dependencies, so that gap cannot silently recur.

Exact registry version records for all seven final packages plus protocol2
passed identity, old-project scope/unscoped-name/alias and all-section internal
dependency-existence checks: **zero legacy dependency declarations, zero
unpublished internal references**. Full workspace `pnpm check` and all 40 Turbo
tasks passed without skipping assertions.

Actual published CLI3 init generated an SDK2 project, which resolved and
installed through a frozen lockfile without overrides, then completed
Build/CAR/Check. Its CAR root was
`bafybeibwtyytwbyyfbbo7bijmwnhe6w2amxdqlyfxy3xulwyhdxj6czx2a`. Installed
published SDK2/core3/CLI3/engine2/HTTP2/storage2/server2/protocol2 executed HTTP
Echo (`Hello canary`, 6 bytes, 1 chunk), parent/child invocation (`{value: 7}`),
actual file-backed SQLite close/reopen and three confirmed reclaimed Runs. The
host used a fixed local caller, not an external identity provider.

Final engine/HTTP/storage/server3 changed metadata, not runtime/type code:
SHA-512-verified real tarballs were compared against the exercised canary2
artifacts, and all 40 `dist/*.js` / `dist/*.d.ts` files were byte-identical. The
installed eight-package artifacts' lockfile integrity hashes were also checked
against exact published records. No local workspace/tarball substitute, disabled
TLS or disabled exotic-transitive-dependency guard was used.

**Historical verification limitation:** The configured registry's package-wide
catalogs intermittently returned older versions and HTTP 525, even while exact
version records and verified tarballs were available. The final canary3 cohort's
fresh ordinary installation could not be completed against that cached catalog;
do not describe it as a successful fresh final-cohort install. The earlier
runtime smoke and final artifact byte-equivalence/metadata checks are distinct
evidence. The standalone audit host initially selected the exact published CLI3
URL as its direct dependency; the generated init project's normal SemVer
installation subsequently succeeded.

The nine libraries are mapped in `scripts/release-packages.js`; the root and
executable app remain private. No package is published by extraction, and there
is no automatic batch release or automatic version bumping. Artifact dependency
discovery always reads `packages/` and includes `apps/` only when present;
library-only repositories need no placeholder app directory.

Dependency installation follows the environment's registry configuration; the
repository does not impose a device-specific mirror. Release metadata checks and
Trusted Publishing target npm's official registry. Missing or unavailable
metadata blocks release; existing versions remain immutable and npm rejects
republishing them.

Registry audits request full JSON metadata to include development dependencies.
Published version checks enforce exact identity and dependency guards without
requiring packing-only fields that registries can omit. Source and tarball
checks still require public npm `publishConfig`; publishing verifies and uses
that same fully checked tarball.

Exact internal dependency versions are verified through the registry's
version-specific record, including its exact name/version and dependency guards;
a missing record still blocks release. This avoids treating an older
package-wide catalog cache as proof that a known version is absent. SemVer
ranges continue to require a satisfying version in the package catalog. CLI
canary index 2's tag remains immutable after its pre-publication registry
catalog failures; the corrected release uses CLI index 3.

### Configure a derived repository

1. Verify each package ID, npm name, directory and version in
   `scripts/release-packages.js` and its manifest. For example, `task-protocol`
   maps to `@silvermoon-work/task-protocol`.
2. The extracted libraries already include `dist`, README and LICENSE in their
   public package configuration. Configure apps separately and keep them
   private.
3. Configure an `npm` GitHub environment and an npm Trusted Publisher for each
   package, using the exact owner, repository, `publish-npm.yaml` workflow, and
   `npm` environment. Do not configure an `NPM_TOKEN`.
4. Keep each library's `build` script aligned with Turborepo. Publishing builds
   the selected library and its workspace dependencies, then packs only that
   library with lifecycle hooks disabled. Put required generation in `build`,
   not in `prepack`, `prepare`, or publishing hooks.

### Release a version

Manually update the selected library's version and any affected internal
dependency versions. Commit these changes to main and wait for that exact
commit's main push CI, including **Release verification (v1)**, to succeed. Then
explicitly create and push its package-specific tag:

```sh
git tag task-protocol-v1.2.3 <verified-main-commit>
git push origin task-protocol-v1.2.3
```

The tag publishes only the mapped package. Both the tagged manifest and the
tarball must match its exact name and version; the root version is irrelevant.
Unknown package IDs, private/placeholder names, invalid versions, mismatches,
unresolved local dependencies, and already-published versions block release.
Only canonical stable and RC SemVer versions are supported (without build
metadata). Stable versions publish to `latest`; candidates use
`<base-version>-rc.N`, for example `0.2.0-rc.0`, and publish to `rc`. Start at
`rc.0` and increment the numeric index for that base version. The verifier
rejects canary/next/alpha/beta prereleases, leading-zero indices, additional
prerelease identifiers and unsafe integer indices. Historical versions and
legacy npm dist-tags remain unchanged; an RC publication never updates `latest`.
Check npm versions and existing immutable Git tags before choosing the next
index; never reuse an existing published version or move a tag. All packages in
a release round may share a version, but each still requires its own explicitly
authorized package tag and publication. Publish internal dependencies first;
`workspace:*` packs to their exact package versions. Use matching
package-specific Git tags, for example `task-protocol-v1.2.3-rc.0`.

The pinned `github-ci-verify` CLI requires the latest `ci.yaml` main push run
for the exact checked-out SHA and its successful versioned aggregate job and
step. Missing, pending, skipped, failed, or inaccessible evidence blocks
publication. Changing the validation contract requires updating both the CI
aggregate and the publish verifier arguments. Publishing does not rerun
`pnpm check`.

`pnpm pack` converts `workspace:*` to registry versions. Internal runtime,
optional, peer, and development dependency ranges must already resolve to
published npm versions. Missing dependencies must be released with their own
tags first; building dependencies never publishes them. The workflow packs once,
verifies the tarball's manifest and dependencies, runs publint on it, and
publishes that same artifact through npm OIDC.

### Validate without publishing

After publication, the read-only `verify-npm.yaml` workflow checks every mapped
package's current manifest version and expected dist-tag against the official
npm registry, including published internal dependencies. It never publishes:

```sh
gh workflow run verify-npm.yaml --ref main
```

For a partial release, pass explicit package IDs so unrelated unpublished
candidates are not mistaken for this release's deliverables:

```sh
gh workflow run verify-npm.yaml --ref main -f packages=task-builder,task-builder-cli
```

Unknown IDs fail verification; omitting the input still checks every mapping.

After the configured commit's main push CI succeeds:

```sh
gh workflow run publish-npm.yaml --ref main -f package=task-protocol
```

Manual runs only perform an npm dry run, never an actual publish or dist-tag
update. All metadata, CI, artifact, and dependency checks still apply; only the
already-published-version rejection is omitted. A dry run is not proof of a
successful real OIDC publication.

Release tags are immutable. If CI has not completed, wait and retry the failed
workflow without moving the tag. Do not retry an already-successful publication;
an existing npm version is rejected. Automatic rollback, batch publishing,
version management, and dependency publication are deliberately out of scope.

## License

MIT
