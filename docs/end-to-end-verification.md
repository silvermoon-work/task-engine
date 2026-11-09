# 跨平台验证：Init → Build → CAR → Run

主流程只验证作者工具、Bundle 和真实 Worker 执行，不再手写 task
service、认证、SQLite 数据库或任务轮询。Windows、macOS、Linux 使用相同的 pnpm 命令与 Node.js 脚本。HTTP/SQLite 的专项验证见最后一节，不因新增 CLI 而取消。

## 版本与前置条件

- Node.js 24.11.1（最低 22.13.0），pnpm 11.22.0 或更新版本。
- `@silvermoon-work/task-builder` 与独立 `task-builder-cli`
  提供 init/build/car/check。
- `@silvermoon-work/task-engine-cli` 提供命令和可复用的 `runBundle`；它依赖包含
  `drain`、公开 `MemoryStore` 与 Gateway `close` 的新版 engine。
- SDK 已迁入本仓库，当前源码模板使用
  `@silvermoon-work/task-sdk@0.1.0-canary-261109-1`；该候选尚未发布。下文已发布 CLI/core 的历史版本仍生成
  `@potential-guide/task-sdk@0.1.0-rc.2`，不能用其成功安装证明新 SDK 模板已部署。两条路径都不需要旧
  `pguide-task-bundle` 的 build、CAR 或 artifact API。

builder 核心 `0.1.0-canary-261109-2` 和独立 builder CLI `0.1.0-canary-261109-1`
已发布。不能安装旧核心 canary 1 或占位 `latest` 冒充本轮能力。

新 SDK 的本地验证使用 workspace 构建与测试；验证独立项目时先构建 protocol、SDK、builder 和 CLI，再用各自的本地 tarball。通过
`createCliTaskProject` 的 `sdkVersion`、`builderVersion`、`cliVersion` 指定
`file:` 包，并在生成项目的 pnpm
overrides 中将 SDK 的 protocol 依赖指向对应的本地 protocol
tarball；不从镜像安装不存在的候选版本。发布时先单独发布 SDK 所依赖的精确 protocol 版本，再发布 SDK，最后更新并发布 builder/CLI。此处不授权任何发布或 tag 推送。

**新 engine / engine CLI 不属于本轮发布。**
第 3 节的新运行宿主路径仍须等待对应的真实发布版本，不能执行
`<published-engine-cli-version>` 占位命令。engine 候选 `0.1.0-canary-261109-2`
必须先于依赖它的 engine
CLI 发布。本轮只用已发布 Engine 验证 builder 兼容性，结果见最后一节。本地 tarball 只算开发验证，不算已发布包 smoke
test；不要在本流程里发包或推送 tag。

包 metadata 和下载只使用 Tencent mirror。每次安装前确认：

```text
npm config get registry
pnpm config get registry
```

有效值须为 `https://mirrors.cloud.tencent.com/npm/`；同时检查 scope
override 和已有 lockfile
URL。镜像缺包时等待同步或报告阻塞，不回退官方 registry、不关闭 TLS 校验。

## 1. Init

已发布版本可直接初始化一个不存在、且父目录已存在的新项目：

```text
pnpm dlx --allow-build=esbuild @silvermoon-work/task-builder-cli@0.1.0-canary-261109-1 init "<absolute-new-project-directory>" --name task-engine-e2e
cd "<absolute-new-project-directory>"
pnpm install
```

默认模板固定使用已安装 CLI 的版本 1 和核心版本 2，无本地 override。
`--allow-build=esbuild` 是 pnpm dlx 的安装审批，不是 builder
CLI 配置。若选择第 3 节的新执行 CLI 路径，在对应版本确实发布后另行安装：

```text
pnpm add --save-dev @silvermoon-work/task-engine-cli@<published-engine-cli-version>
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

### 已有 Gateway：直接 CLI

如果 Bundle 已经能从受控 Gateway 读取，把 `<bundle-root-cid>` 替换为
`bundle.cid` 的内容，保存 `input.json` 为 `{"text":"canary"}`，然后运行：

```text
pnpm exec task-engine run <bundle-root-cid> --input input.json --gateway <gateway-base-origin> --timeout-ms 30000 --max-runtime-ms 60000
```

不启动 task-engine HTTP
service。CLI 自己等待 preparation、任务和 Run 物理回收，输出单行 JSON 后自动退出。通过条件是退出码 0、`status: "succeeded"`、根结果为
`Hello canary`，且所有 Run 都有 `reclaimedAt`、无
`cleanupUnknown`。仅看到根任务结果或被 watchdog 杀掉，不算成功退出。

多层子任务 Bundle 需要显式
`--allow-children`；默认仍拒绝子调用，既有身份、父子关联、期限和预算不放宽。普通 Echo 模板不需要该开关。内容源仍需独立可用；CLI 不导入 CAR、不上传、不 pin，也不管理 Gateway 节点。输入/授权/失败/超时/中断/清理的退出码见
[engine CLI 文档](https://github.com/silvermoon-work/task-engine/blob/40563b992c07e194dd5f04c2804e18c2520105fd/packages/task-engine-cli/README.md)。

### 只有本地 CAR：使用同一个 CLI 包的运行宿主

离线验证不需要 Docker、Kubo 或自己启动 Gateway。保存下面的 `verify.mjs`
到新项目根目录，再执行 `node verify.mjs`。它只读 CAR/CID，不从 `dist`
或源码执行任务。 `runBundle`
复用命令的执行与耗尽流程，但这条路径不冒充 bin 参数解析或 Gateway 验证。

```js
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { directoryTree } from "@silvermoon-work/task-builder-cli/node";
import { runBundle } from "@silvermoon-work/task-engine-cli";

const source = await directoryTree(".");
const expectedCid = (await readFile("bundle.cid", "utf8")).trim();
const bundle = await readTaskBundleCar(await source.read("bundle.car"), {
  expectedCid,
});
try {
  let expectedBytes = 0;
  for await (const chunk of await bundle.tree.read("resources/greeting.txt"))
    expectedBytes += chunk.byteLength;
  const options = {
    cid: bundle.cid,
    ipfsClient: bundle,
    timeoutMs: 30_000,
    maxRuntimeMs: 60_000,
  };
  const execution = await runBundle({
    ...options,
    input: { text: "canary" },
  });
  assert.equal(execution.exitCode, 0, JSON.stringify(execution));
  assert.equal(execution.status, "succeeded");
  const task = execution.execution.tasks.find(
    (item) => item.taskId === execution.rootTaskId,
  );
  assert.ok(task);
  assert.equal(task.result.text, "Hello canary");
  assert.equal(task.result.bytes, expectedBytes);
  assert.ok(task.result.chunks >= 1);
  if (expectedBytes > 262_144) assert.ok(task.result.chunks > 1);
  assert.ok(execution.execution.runs.length > 0);
  assert.ok(
    execution.execution.runs.every(
      (run) => run.reclaimedAt && !run.cleanupUnknown,
    ),
  );
  const invalid = await runBundle({ ...options, input: { text: 42 } });
  assert.equal(invalid.exitCode, 3, JSON.stringify(invalid));
  assert.equal(invalid.status, "rejected");
  await bundle.close();
  assert.equal(bundle.retainedBytes, 0);
  const result = {
    status: "ok",
    carValidated: true,
    cliHost: true,
    cid: bundle.cid,
    taskId: task.taskId,
    result: task.result,
  };
  await mkdir(".verification", { recursive: true });
  await writeFile(
    ".verification/result.json",
    JSON.stringify(result, null, 2),
    {
      flag: "wx",
    },
  );
  console.log(JSON.stringify(result));
} finally {
  await bundle.close();
}
```

默认模板结果为
`{text: "Hello canary", bytes: 6, chunks: 1}`；具体切块数量不是协议契约。断言失败、非零退出码或清理错误都不能忽略。每次
`runBundle`
使用独立非持久域，错误类型输入测试不会复用上次任务；调用者仍负责最后关闭 CAR 内容源。

### 大资源变体

在另一新项目的第一次 build 前，只修改 greeting：

```text
node -e "require('node:fs').writeFileSync(require('node:path').join('assets','greeting.txt'),'Hello\r\n'+' '.repeat(600000))"
```

重复步骤 2 和离线 Run。原始 600,007 字节经 CRLF → LF 后是 600,006 字节，结果仍为
`Hello canary`，`chunks > 1`。未消费完流不算内容已完整验证。

## 发布前的开发替代

此路径要求 checkout 同时包含本轮 builder 与 engine
CLI 实现。只想复现已发布包 smoke test 时，不使用此节，不用本地依赖兜底。

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
override 确保 CLI 的 packed 精确依赖也使用新版 engine，而不是试图下载未发布版本。若出现发布年龄限制，只为明确选择的包添加例外。之后复用步骤 2 和步骤 3，不再维护第二份运行脚本。

## 验收范围与历史证据

主流程通过条件：

- init/build/CAR/完整 check 均成功，使用准确的新包版本或明确标记的开发制品。
- 真实 SDK Worker 的根结果和资源字节正确；Run 已物理回收，进程自然退出。
- 离线脚本验证错误类型输入明确拒绝、CAR 内存释放，并保存结果。
- 大资源变体经历多 chunk，规范化后字节数准确。
- 发布验收必须另保留 registry 安装来源、准确版本、integrity 和真实 publish
  run；本地 tarball、仓库 dist 或开发脚本通过不能替代它。

**CLI 的非持久运行不能验证 HTTP 认证、SQLite 持久化、重启恢复或历史幂等。**
需要这些专项证明时，继续使用
[原 HTTP/SQLite 验证脚本](https://github.com/silvermoon-work/task-engine/blob/2597d79a4ab778e9288675eaba0dfa230a406491/docs/end-to-end-verification.md#3-从-car-跑真实-http--sqlite--worker)
的独立路径；保留 401、Schema 拒绝、物理回收、关闭内容源后重启、历史/幂等查询不再读取块或重跑 Worker 的断言。仓库 engine/HTTP/storage/server 回归属于补充证据，不冒充已发布包的这些专项验证。

原流程已在 Windows / Node.js 24.11.1 / pnpm
11.22.0 的两个新项目中完成：本地 builder/core CLI 制品 → HTTP Worker →
SQLite 重启恢复；默认为 6 字节 / 1 chunk，大资源为 600,006 字节 / 3
chunks，退出码均为 0。这是原脚本的历史记录，不是本文新 CLI 路径或新版本发包已经完成的声明。本流程不证明生产认证、pin/GC、SSE 或 OS 沙箱；macOS/Linux 仍须实际执行目标平台验证。

## 本轮 builder 发布验证

2026-11-09 在 Windows / Node.js 24.11.1 / pnpm 11.22.0 上，从
`https://mirrors.cloud.tencent.com/npm/` 安装实际发布包，未使用本地 tarball、
`file:` 依赖或 pnpm override：

| 包                                    | 精确版本                |
| ------------------------------------- | ----------------------- |
| `@silvermoon-work/task-builder`       | `0.1.0-canary-261109-2` |
| `@silvermoon-work/task-builder-cli`   | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-engine`        | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-engine-http`   | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-engine-server` | `0.1.0-canary-261109-1` |
| `@silvermoon-work/task-protocol`      | `0.1.0-canary-261109-2` |

从新目录执行上面的 init/install/build/car/check，然后使用
[原 HTTP/SQLite 专项验证脚本](https://github.com/silvermoon-work/task-engine/blob/2597d79a4ab778e9288675eaba0dfa230a406491/docs/end-to-end-verification.md#3-从-car-跑真实-http--sqlite--worker)，在验证项目中添加固定运行包：

```text
pnpm add --save-exact @silvermoon-work/task-engine@0.1.0-canary-261109-1 @silvermoon-work/task-engine-http@0.1.0-canary-261109-1 @silvermoon-work/task-engine-server@0.1.0-canary-261109-1 @silvermoon-work/task-protocol@0.1.0-canary-261109-2
```

保留脚本的所有断言：401、错误类型输入拒绝、真实 Worker、Run 物理回收、关闭内容源后的 SQLite 重启、历史结果与同 Request 幂等查询，以及不再读取块。本轮仅调整了验证用数据库的位置，原因见下面的路径限制。

| 变体             | 返回 text      | bytes  | chunks | 内容块读取 | 退出码 |
| ---------------- | -------------- | ------ | ------ | ---------- | ------ |
| 默认模板         | `Hello canary` | 6      | 1      | 11         | 0      |
| 大资源 CRLF 变体 | `Hello canary` | 600006 | 3      | 16         | 0      |

两种变体均通过 CAR 完整检查、授权 HTTP、Worker 和重启恢复；JSON/文本输出及 CLI 版本也经实际安装验证。它们证明 builder 发布产物兼容已发布 Engine，
**不证明新 engine CLI 已完成部署**。

安装 lockfile 中记录的实际 npm artifact integrity：

```text
@silvermoon-work/task-builder@0.1.0-canary-261109-2
sha512-I/CJy6bPpev2cIfR6Yh97TbuYKzzXmQp86STNskOeXAInZzaNAyODJWhuGL0N2LU9LlTVSu1pe8Kp7+vHodFqQ==

@silvermoon-work/task-builder-cli@0.1.0-canary-261109-1
sha512-pfSdEhcsLevEM7fe0EdNo14reFsiNLhj6kbwNb1K2SKgaguSGYvbDb+JKXcATHk+rkH04+PLM7V0wpgmMtiI0w==
```

发布证据：[核心 Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/42577672894)、
[CLI Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/42577838042)、
[两个包的官方 registry 版本/dist-tag/依赖验证](https://github.com/silvermoon-work/task-engine/actions/runs/42578343710)。两者使用
`canary`，未更新 `latest`。

### Windows SQLite 路径限制

已发布 storage canary 1 的重启 preflight 会复制数据库到
`<database>.inspect-<UUID>`。最初把数据库放进很长的 agent
session 路径时，复制后的路径使 SQLite 报
`unable to open database file`，因此该次尝试没有算成功。

改为独立、较短的验证数据库目录后，两种变体都完整通过；没有修改 storage 或放宽恢复断言。Windows 上应选择短路径，并为
`.inspect-UUID` 及 sidecar 留出余量。可将原验证脚本的 `database`
指向该目录；短路径通过不代表长路径已受支持。此限制不是本轮 builder 发布的修复项。
