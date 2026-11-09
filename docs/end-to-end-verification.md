# 跨平台验证：Init → Build → CAR → Run

Windows、macOS、Linux 使用相同的 pnpm scripts 和 Node.js 文件，不需要 pguide
CLI、Bash heredoc、PowerShell 环境变量、Docker 或 Kubo。

## 能力边界与版本

- `task-builder/init`：配置 → 只读项目模板树，不含 CLI 或 pnpm 配置。
- `task-builder`：只读项目树 → 只读 Bundle 树；模块由 esbuild 编译，资源流式读取。
- `task-builder/car`：Bundle 树 → CAR
  stream；也提供完整 CAR 读取/校验和只读块入口。
- `task-builder-cli`：Commander 命令解析、模板 CLI 组装、帮助/版本、JSON/文本交互。
- `task-builder-cli/node`：目录和文件流落盘适配；不覆盖已有输出。
- Engine、HTTP、SQLite、Server：使用本仓库的运行核心。
- **SDK 尚未迁移**：模板明确依赖
  `@potential-guide/task-sdk@0.1.0-rc.2`。不再需要旧 `pguide-task-bundle`
  的 build、CAR 或 artifact API。

**本轮核心新入口与独立 CLI 包尚未发布。** 已发布的
`task-builder@0.1.0-canary-261109-1`
仍是旧结构。下面使用 checkout 打出的两个本地 tarball，不虚构新 npm 版本，也不触发发布。正式发布后，可直接安装固定版本的 CLI 和核心，不需要这些开发用的
`file:` spec。

## 1. Setup 与初始化

安装 Node.js **24.11.1**（最低 22.13.0）、pnpm **11.22.0** 或更新版本：

```text
node --version
pnpm --version
```

在包含本轮代码的 task-engine checkout 中执行：

```text
pnpm install
pnpm --filter @silvermoon-work/task-builder-cli... build
pnpm --filter @silvermoon-work/task-builder --config.ignore-scripts=true pack --out "<absolute-path-to-builder.tgz>"
pnpm --filter @silvermoon-work/task-builder-cli --config.ignore-scripts=true pack --out "<absolute-path-to-cli.tgz>"
node packages/task-builder-cli/dist/bin.js init "<absolute-new-project-directory>" --name task-engine-e2e --cli-version "file:<absolute-path-to-cli.tgz>" --builder-version "file:<absolute-path-to-builder.tgz>"
```

把占位路径换成各平台实际的绝对路径；tarball 的父目录必须已存在，项目目录必须不存在。`pack`
不发布、不执行 package lifecycle hooks。pnpm 会把打包产物的 `workspace:*`
转成准确版本。CLI init 为显式的 core spec 写入 pnpm
override，确保 CLI 的内部依赖也使用这个本地核心，而不是 npm 上同版本的旧核心。override 位于
`pnpm-workspace.yaml`，不是 pnpm 11 已不再读取的 package.json 配置。
`--config.ignore-scripts=true` 是开发阶段的 pnpm
pack 参数，不是 CLI 配置；普通用户的 init/build/car/check 不需要它。

进入 CLI 返回的 `directory`：

```text
cd "<absolute-new-project-directory>"
pnpm install
```

核心模板经 CLI 装配后已经生成：

```text
package.json
pnpm-workspace.yaml
.gitignore
task.build.yaml
src/main.ts
src/helper.ts
src/contract.json
assets/greeting.txt
```

项目是 private，**不要执行 npm
publish**。模板只批准 esbuild 的安装脚本；发布年龄例外只针对明确选择的 builder 与兼容 SDK，不全局关闭供应链检查。如 registry 镜像缺少依赖，等待同步或在网络允许时使用官方 registry；不关闭 TLS 校验。

默认 Echo 任务使用 JSON contract，不执行 TypeBox
contract 模块：input/result 的 text 属性通过 `$ref` 共用具名 `schemas.text`
定义。作者入口显式调用 SDK `runTask`；`helper.js` import 解析到
`helper.ts`。任务通过字节流读取 greeting，返回 `{ text, bytes, chunks }`。

## 2. Build、CAR 与检查

在新项目中执行：

```text
pnpm build
pnpm car
pnpm check
```

可用 Commander 帮助查看各命令参数：

```text
pnpm exec task-builder --help
pnpm exec task-builder build --help
pnpm exec task-builder --version
pnpm exec task-builder check bundle.car --format text
```

结果和错误默认 JSON；`--format text`
为人类可读摘要。帮助与版本保持文本。用法错误退出码 2，操作失败 1；不把失败当成功继续执行。

这里项目的 `pnpm check` 是生成的
`task-builder check bundle.car`，不是 task-engine monorepo 的全量检查。

输出：

```text
dist/
  task.yaml
  worker.cjs
  schemas/input.json
  schemas/result.json
  schemas/message.json
  schemas/shared/text.json
  resources/greeting.txt
bundle.car
bundle.cid
```

`task.yaml` 的协议结构不变，`include` 精确列出实际文件； `binary: []`
显式声明无 binary 资源。CAR 编码不改写 Bundle 字节，检查会拒绝无效 UTF-8、CRLF、错误 manifest、缺失 Schema、损坏块、缺失/多余 DAG 块。Request 使用
`bundle.cid` 中的 **UnixFS 根 CID**，不是 CAR 路径或文件摘要。

CAR
v1 头部需要根 CID，所以编码先完整消费文件流、暂存**有界内存块**，再输出有背压的 CAR
stream；不聚合整个资源文件或整个 CAR。取消/消费到 EOF 会释放编码块；未消费的编码结果必须调用
`close()`。完整 CAR 读取/检查也暂存有界块，返回前验证所有资源，而不是延迟到第一次运行。

所有输出必须是新路径，重复 build/car 明确拒绝覆盖。重复验证请创建另一新项目，不使用任意路径的递归删除命令。

### 可选：验证多 chunk 与文本规范化

若要验证大资源流，在**第一次 build 前**，只修改新模板的 greeting 文件：

```text
node -e "require('node:fs').writeFileSync(require('node:path').join('assets','greeting.txt'),'Hello\r\n'+' '.repeat(600000))"
```

原始资源为 600,007 字节；builder 把 CRLF 转成 LF 后是 600,006 字节。任务仍返回
`Hello canary`，但 `chunks` 必须大于 1。如果已经生成
`dist`，请改用另一个新项目执行此变体。

## 3. 从 CAR 跑真实 HTTP / SQLite / Worker

添加固定的已发布运行包，不安装占位 `latest`：

```text
pnpm add @silvermoon-work/task-engine@0.1.0-canary-261109-1 @silvermoon-work/task-engine-http@0.1.0-canary-261109-1 @silvermoon-work/task-engine-server@0.1.0-canary-261109-1 @silvermoon-work/task-protocol@0.1.0-canary-261109-2
```

如 pnpm 提示发布年龄限制，只批准这些明确选择的版本。Server 使用自己的已发布 SQLite 依赖，不需要额外安装数据库或服务。

### `verify.mjs`

用编辑器保存下面的脚本到新项目根目录。它只读取 CAR 和 CID，不依赖 `dist`
或作者源码。CAR 的 `block`
是 caller-owned 本地验证内容源，不是生产 IPFS 节点、上传或 pin 服务。

```js
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { directoryTree } from "@silvermoon-work/task-builder-cli/node";
import { newId } from "@silvermoon-work/task-engine/identity";
import { TaskClient } from "@silvermoon-work/task-engine-http";
import { startTaskServer } from "@silvermoon-work/task-engine-server";
import { TaskError } from "@silvermoon-work/task-protocol";

const source = await directoryTree(".");
const expectedCid = (await readFile("bundle.cid", "utf8")).trim();
const bundle = await readTaskBundleCar(await source.read("bundle.car"), {
  expectedCid,
});
const resourceReader = (
  await bundle.tree.read("resources/greeting.txt")
).getReader();
let expectedBytes = 0;
try {
  for (;;) {
    const item = await resourceReader.read();
    if (item.done) break;
    expectedBytes += item.value.byteLength;
  }
} finally {
  resourceReader.releaseLock();
}
let blockReads = 0;
const ipfsClient = {
  block: {
    async get(cid, options) {
      blockReads++;
      return bundle.block.get(cid, options);
    },
  },
};
await mkdir(".verification", { recursive: true });
const database = join(".verification", `tasks-${randomUUID()}.sqlite`);
const authorization = ["Bearer", randomUUID()].join(" ");
const caller = { subject: "e2e", scope: "verification" };
const options = {
  host: "127.0.0.1",
  port: 0,
  database,
  ipfsClient,
  authorize: (subject, _operation, scope) =>
    subject.subject === caller.subject && subject.scope === scope,
  resolveCaller(request) {
    if (request.headers.get("authorization") !== authorization)
      throw new TaskError(
        "unauthenticated",
        "Verification authentication required.",
      );
    return caller;
  },
};
const signal = AbortSignal.timeout(60_000);
function clientFor(server) {
  return new TaskClient({
    url: server.url,
    headers: { Authorization: authorization },
    fetch: (input, init) => fetch(input, { ...init, signal }),
  });
}
async function decision(client, request) {
  let result = await client.submit(request);
  while (result.status === "preparing") {
    signal.throwIfAborted();
    result = await client.getRequestStatus(request.requestId, { waitMs: 1000 });
  }
  return result;
}

let server;
try {
  server = await startTaskServer(options);
  const client = clientFor(server);
  const unauthorized = await fetch(`${server.url}/tasks`, { signal });
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  const request = {
    requestId: newId(),
    bundle: bundle.cid,
    timeoutMs: 30_000,
    text: "canary",
  };
  const accepted = await decision(client, request);
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
  let task;
  let run;
  for (;;) {
    signal.throwIfAborted();
    task = await client.getTask(accepted.taskId);
    if (task.stage === "failed" || task.stage === "stopped")
      throw new Error(`Task did not complete: ${JSON.stringify(task)}`);
    if (task.stage === "completed") {
      assert.ok(task.run?.runId);
      run = await client.getRun(task.run.runId);
      if (run.reclaimedAt) break;
    }
    await sleep(20, undefined, { signal });
  }
  assert.equal(task.result.text, "Hello canary");
  assert.equal(task.result.bytes, expectedBytes);
  assert.ok(task.result.chunks >= 1);
  if (expectedBytes > 262_144) assert.ok(task.result.chunks > 1);
  const invalid = await decision(client, {
    ...request,
    requestId: newId(),
    text: 42,
  });
  assert.equal(invalid.status, "rejected", JSON.stringify(invalid));
  assert.ok(blockReads > 0);
  const readsBeforeRestart = blockReads;
  await server.close();
  server = undefined;
  await bundle.close();
  assert.equal(bundle.retainedBytes, 0);
  server = await startTaskServer(options);
  const restoredClient = clientFor(server);
  const restored = await restoredClient.getTask(accepted.taskId);
  assert.equal(restored.stage, "completed");
  assert.deepEqual(restored.result, task.result);
  assert.deepEqual(await restoredClient.submit(request), accepted);
  assert.equal(blockReads, readsBeforeRestart);
  await server.close();
  server = undefined;
  const result = {
    status: "ok",
    carValidated: true,
    authenticatedHttp: true,
    restoredWithoutContent: true,
    cid: bundle.cid,
    taskId: accepted.taskId,
    runId: run.runId,
    result: task.result,
    blockReads,
    database,
  };
  await writeFile(
    join(".verification", "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
} finally {
  try {
    await server?.close();
  } finally {
    await bundle.close();
  }
}
```

```text
node verify.mjs
```

默认模板应返回：

```json
{
  "status": "ok",
  "carValidated": true,
  "authenticatedHttp": true,
  "restoredWithoutContent": true,
  "result": { "text": "Hello canary", "bytes": 6, "chunks": 1 }
}
```

实际输出还包含 CID、Task/Run 身份、块读取次数和数据库路径。大资源变体的 `bytes`
应为 600,006，`chunks > 1`；具体切块数量不是协议契约。Node 22/24 的 SQLite
experimental
warning 不等于业务失败；非零退出码、rejection、超时和 cleanup 错误都不能忽略。

## 4. 验收清单

- [ ] init 生成只读模板并保存到新目录，没有执行 install 或编辑祖先项目。
- [ ] 使用本轮 core/CLI 两个 tarball 或新发布版本，不是旧 canary binary。
- [ ] 不安装旧 pguide-task-bundle；仅 SDK 仍来自旧 scope。
- [ ] 相对 TS import、SDK binding、具名公共 Schema 和 `$ref` 闭包通过。
- [ ] build、CAR 编码、完整检查都成功；根 CID 与期望一致。
- [ ] 未授权请求与错误类型输入明确失败。
- [ ] 新 HTTP/SQLite/Engine 驱动真实 SDK Worker，且 Run 物理回收完成。
- [ ] 大资源变体经历多 chunk，文本规范化后字节数准确。
- [ ] 关闭 CAR blockstore、重启 SQLite 后，历史和幂等查询不读取内容、不重跑。
- [ ] 服务已关闭，CAR 内存释放，结果保存到 `.verification/result.json`。

本流程不验证远程 Gateway、pin/GC、SSE、生产认证或 OS 沙箱。macOS/Linux 的脚本没有平台分支，但仍须在目标平台实际执行验收。

## 本轮执行记录

在 Windows / Node.js 24.11.1 / pnpm
11.22.0 的两个新项目中，用本轮本地 core/Commander
CLI 两个 tarball 和固定的已发布运行包完成了 init → install → build → CAR → check
→ HTTP Worker → SQLite 重启恢复。默认模板返回 6 字节 /
1 个 chunk；大资源变体返回规范化后的 600,006 字节 /
3 个 chunk，均以退出码 0 结束。两个项目都没有安装旧
`@potential-guide/pguide-task-bundle`。
