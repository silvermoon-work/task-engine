# Task Engine

Task Engine 的独立 monorepo，使用 pnpm workspaces 和 Turborepo。已从
[potential-guide 的固定提交](https://github.com/shazhou-ww/potential-guide/tree/3500086123d8b821b77958699ceeebfb2a518e0f)
提取 5 个通用核心包，并新增独立 Task Builder 与 CLI 库，统一使用
`@silvermoon-work/`
scope。原始 MIT 许可证随每个包保留，原协议 URI、Bundle 字节契约及持久数据格式不因包改名而改变。已发布首轮 canary；根包
`task-engine` 保持 private。Silvermoon 项目元数据已初始化。

## 本次提取范围

| 包                                                                               | 职责                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------ |
| [@silvermoon-work/task-protocol](./packages/task-protocol/README.md)             | 任务事实、协议、投影及 Bundle 契约         |
| [@silvermoon-work/task-engine](./packages/task-engine/README.md)                 | 嵌入式引擎、任务协调及执行池               |
| [@silvermoon-work/task-engine-storage](./packages/task-engine-storage/README.md) | SQLite 持久化                              |
| [@silvermoon-work/task-engine-http](./packages/task-engine-http/README.md)       | 可挂载 HTTP API 与 SSE                     |
| [@silvermoon-work/task-engine-server](./packages/task-engine-server/README.md)   | Node HTTP/SSE 服务组装                     |
| [@silvermoon-work/task-builder](./packages/task-builder/README.md)               | 只读文件树转换、esbuild 构建与流式资源     |
| [@silvermoon-work/task-builder-cli](./packages/task-builder-cli/README.md)       | Commander 命令交互、本地文件适配与模板组装 |
| [@silvermoon-work/task-engine-cli](./packages/task-engine-cli/README.md)         | 隔离域内嵌运行、全体耗尽与自动退出         |

SDK、Web UI、pguide
CLI 和 Check/Probe 包不在本次提取范围。新增 task-builder 不依赖 pguide 命令协议：模块通过抽象文件树解析，资源按需流式读取；提供独立
`init` / `car` export 提供模板文件树及有界流式 CAR 编码/检查。核心不含 CLI
binary 或宿主文件系统适配；独立 task-builder-cli 库提供 `task-builder`
命令、Commander 交互及本地写入。构建输出资源依赖输入树生命周期，完整校验需消费全部流。详见
[Task Builder](./packages/task-builder/README.md)。现有引擎回归测试暂用已发布的
`@potential-guide/task-sdk@0.1.0-rc.2` 和
`@potential-guide/pguide-task-bundle@0.1.0-rc.2`
生成 Worker 与 Bundle；它们仅为开发依赖，不进入核心包的生产依赖闭包。
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
`workspace:*`。移除 preset 的示例工作区，保留 5 个核心包及新增的 task-builder、task-builder-cli。CLI 可被程序化调用，因此作为可复用库放在 packages，而非 private
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
[端到端验证指引](./docs/end-to-end-verification.md)。builder 核心 canary
2 与独立 builder CLI canary
1 已发布并通过真实 npm 安装验证；SDK 仍使用明确的外部兼容包。新 Engine/执行 CLI 的代码已合入但不属于本轮发布，部署验证固定使用已发布 Engine。

| Command          | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `pnpm build`     | Build every workspace in dependency order              |
| `pnpm lint`      | Lint release scripts and every workspace               |
| `pnpm typecheck` | Type-check every workspace                             |
| `pnpm test`      | Test release guards and all core workspaces            |
| `pnpm check`     | Run formatting, lint, types, tests, builds and publint |
| `pnpm clean`     | Remove workspace outputs and Turborepo state           |

## Adding a workspace

Every direct child of `apps/` or `packages/` is discovered automatically. Give
it a unique package name and the standard scripts consumed by `turbo.json`. Keep
application packages private. Add publishable libraries to the package-specific
tag release mapping below.

## Publish one package

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
Actual Tencent-registry install and HTTP/SQLite compatibility smoke results,
including the Windows database-path limitation, are recorded in the
[end-to-end guide](./docs/end-to-end-verification.md#本轮-builder-发布验证).

The eight libraries are mapped in `scripts/release-packages.js`; the root and
executable app remain private. No package is published by extraction, and there
is no automatic batch release or automatic version bumping. Artifact dependency
discovery always reads `packages/` and includes `apps/` only when present;
library-only repositories need no placeholder app directory.

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
Canonical stable and prerelease SemVer versions are supported (without build
metadata); stable versions use npm's `latest` tag, canaries use `canary`, and
other prereleases use `next`. Canaries follow
`<base-version>-canary-YYMMDD-INDEX`, for example `0.1.0-canary-261109-1`. Use
the release date in the team's local calendar and increment `INDEX`
independently for each package on that date, starting at 1. Check npm versions
and existing immutable Git tags before choosing the next index; never reuse an
existing published version or move a tag. The verifier rejects malformed dates,
zero/leading-zero indices and unsafe integer indices. All packages in a release
round may share a version, but each still requires its own explicitly authorized
package tag and publication. Publish internal dependencies first; `workspace:*`
packs to their exact canary versions.

The pinned `github-ci-verify` CLI requires the latest `ci.yaml` main push run
for the exact checked-out SHA and its successful versioned aggregate job and
step. Missing, pending, skipped, failed, or inaccessible evidence blocks
publication. Changing the validation contract requires updating both the CI
aggregate and the publish verifier arguments. Publishing does not rerun
`pnpm check`.

`pnpm pack` converts `workspace:*` to registry versions. Internal runtime,
optional, and peer dependency ranges must already resolve to published npm
versions. Missing dependencies must be released with their own tags first;
building dependencies never publishes them. The workflow packs once, verifies
the tarball's manifest and dependencies, runs publint on it, and publishes that
same artifact through npm OIDC.

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
