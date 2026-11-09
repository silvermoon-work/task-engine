# Task Engine

Task Engine 的独立 monorepo，使用 pnpm workspaces 和 Turborepo。已从
[potential-guide 的固定提交](https://github.com/shazhou-ww/potential-guide/tree/3500086123d8b821b77958699ceeebfb2a518e0f)
提取 5 个通用核心包，并新增独立 Task Builder，统一使用 `@silvermoon-work/`
scope。原始 MIT 许可证随每个包保留，原协议 URI、Bundle 字节契约及持久数据格式不因包改名而改变。尚未发布 npm 包；根包
`task-engine` 保持 private。Silvermoon 配置候选已写入但尚未通过校验。

## 本次提取范围

| 包                                                                               | 职责                                   |
| -------------------------------------------------------------------------------- | -------------------------------------- |
| [@silvermoon-work/task-protocol](./packages/task-protocol/README.md)             | 任务事实、协议、投影及 Bundle 契约     |
| [@silvermoon-work/task-engine](./packages/task-engine/README.md)                 | 嵌入式引擎、任务协调及执行池           |
| [@silvermoon-work/task-engine-storage](./packages/task-engine-storage/README.md) | SQLite 持久化                          |
| [@silvermoon-work/task-engine-http](./packages/task-engine-http/README.md)       | 可挂载 HTTP API 与 SSE                 |
| [@silvermoon-work/task-engine-server](./packages/task-engine-server/README.md)   | Node HTTP/SSE 服务组装                 |
| [@silvermoon-work/task-builder](./packages/task-builder/README.md)               | 只读文件树转换、esbuild 构建与流式资源 |

SDK、Web UI、pguide
CLI 和 Check/Probe 包不在本次提取范围。新增 task-builder 不依赖 pguide 命令协议：模块通过抽象文件树解析，资源按需流式读取；提供独立
`task-builder`
CLI 写入新目录，不生成 CAR。输出资源依赖输入树生命周期，完整校验需消费全部流。详见
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

创建 idea 前，需先将初始化提交同步至
`origin/main`；迁移范围需先决策，本次初始化不创建 idea、不代表任何迁移方案已获批准。

当前 primary 尚无 `main`。此外，当前 Silvermoon CLI 的 snapshot 校验要求已跟踪的
`ideas/` 目录，却会将 `.gitkeep`
识别为无效 idea；Git 无法跟踪空目录，因此零 idea 的初始化也受此限制。在这两个前置条件得到解决前，不提交未经 Silvermoon 校验的配置。

## Structure

```text
packages/
  task-protocol/
  task-engine/
  task-engine-storage/
  task-engine-http/
  task-engine-server/
  task-builder/
pnpm-workspace.yaml
turbo.json
```

内部依赖使用
`workspace:*`。移除 preset 的示例工作区，保留 5 个核心包及新增的 task-builder。编译器和 Node 类型沿用来源项目的 TypeScript
5.9.3 与 Node 22 类型版本，避免在提取时同时升级编译基线。包使用 Biome 和 Node
test runner（tsx）；根目录及 release 脚本保留 preset 的 Prettier/ESLint 工具链。

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

The six libraries are mapped in `scripts/release-packages.js`; the root remains
private. No package is published by extraction, and there is no automatic batch
release or automatic version bumping. Artifact dependency discovery always reads
`packages/` and includes `apps/` only when present; library-only repositories
need no placeholder app directory.

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
