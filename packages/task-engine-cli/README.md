# @silvermoon-work/task-engine-cli

单次执行宿主及 `task-engine` 命令。Node.js 22.13+；无需预先启动 task-engine
HTTP service。可选择 Bundle 根 CID + 独立 IPFS Gateway，或直接运行本地 CAR；
不接受源码目录、任务名称或旧 URL/Digest 身份。CAR 校验后的根 CID 仍是 engine 内容身份。

```powershell
task-engine run <bundle-cid> --input .\input.json --gateway https://your-gateway.example --allow-children
# 或从 stdin 读取一个 JSON 对象
'{"value":7}' | task-engine run <bundle-cid>
task-engine --help
# 本地 CAR：无需 Gateway 或用户编写宿主脚本
task-engine run --car .\bundle.car --input .\input.json
task-engine run --car .\bundle.car --expected-cid <bundle-cid> --input .\input.json --allow-children
'{"value":7}' | task-engine run --car .\bundle.car
```

仓库内先 `pnpm build`，再执行
`pnpm --filter task-engine-app start run <bundle-cid> --input .\input.json --gateway <base-url>`。
`apps/task-engine` 是 private launcher；本公共库携带极薄的 npm bin，以便安装已发布包
后得到相同命令，复用 `main()` 而不维护第二套调度规则。当前 CLI 为待发布候选；
仅本地 dist 验证不代表 npm 安装或现实世界验收已完成。

## 工作集合与所有权

每次调用创建新的非持久 `MemoryStore` 域，没有历史恢复、外部生产者或 HTTP 监听器。
输入限制为 65,536 字节 JSON 对象，不能覆盖 Request envelope 字段。
省略 `--input` 等同于 `--input -`，从 stdin 读到 EOF；`--input <file>` 显式读取文件。
空输入、无效 JSON 或超出容量明确失败，不默认替换为 `{}`。交互终端同样等待输入与 EOF，
SIGINT/SIGTERM 可中断等待。
根提交的 preparation 可能异步返回；`drain()` 封闭外部准入，但保留结构化子调用，
直到所有准备、准入、未来执行资格、未终结 Task、Run、子调用和回收均耗尽。
Worker 物理退出、资源释放证明、守护关闭和 Store 释放完成后才输出结果；
不会以队列空、根 Task 终态或观察静默代替完整耗尽，也不调用 `process.exit(0)`。
`execution.runs[*].reclaimedAt` 是已确认的 Run 回收证据，不删除历史事实来制造空队列。

CLI 创建的 Gateway client 最终封闭读取、取消在途获取并等待其临时 Helia 节点清理；
清理超出 Gateway 获取预算（默认 30 秒）或无法确认时返回 7，而不是成功。
共享 IPFS 节点、调用者提供的 client 和 pin 不归 `runBundle()` 所有，不会关闭或删除。
文件系统持久化、恢复与独立内容节点管理不在单次命令的范围内。

`--car <file>` 复用 `task-builder/car` 的完整校验器，流式读取并验证 CAR v1 唯一根、
块哈希、精确 DAG、canonical Bundle、Schema 和全部资源；通过后以只读块源复用
`runBundle`/`drain`。默认有界 CAR/块/文件容量，不另起 Gateway 或网络 fallback。
`--expected-cid` 可选且仅用于 CAR，根不符在 Worker 启动前拒绝。
CAR 与位置 CID、`--gateway` 互斥；必须是普通文件，不接受 `--car -`，
但 JSON 输入仍可来自 stdin。文件句柄与 CAR 内存由 CLI 释放；损坏内容返回 2，
业务错误沿用执行退出码。仅读取 CAR，不上传、pin 或持久导入内容节点。

## 授权与预算

默认保留 engine 的 `authorizeChild` 拒绝策略。需要派生时显式传
`--allow-children`：只准许当前活跃父 Run 的已验证 Bundle 子树，并继承 CLI 域内的
caller 身份；不能通过 Worker 自报身份或任意 CID 绕过关联校验。
仍使用 engine 默认深度 4、每父并发 4、总量 64、子调用最长 30 秒等有限预算，
以及父截止时间、取消和回收规则。宿主授权不是安全沙箱；必须信任 Bundle 代码。
仅支持现有 `invokeTask`，没有 detached/fire-and-forget scheduling。

CID 模式选择 Gateway 的优先级为：

1. 显式 `--gateway <base-url>`，可重复，按配置顺序使用，替换全部默认值。
2. 未传该选项时使用 `TASK_ENGINE_GATEWAY`，仅一个根 origin。
3. 环境变量未设置时，只尝试 Kubo 默认本地 Gateway `http://127.0.0.1:8080`。

```powershell
$env:TASK_ENGINE_GATEWAY = "http://127.0.0.1:8080"
'{"value":7}' | task-engine run <bundle-cid>
```

不会启动 Kubo 或发现节点；所选内容源必须已运行且能读取目标 CID。
空或非法环境变量明确报配置错误，不静默回退到本地 Gateway。
源连接/获取失败返回非零退出码，诊断包含选定 Gateway，不再自动切换公共源。
不启用 Request hint、公共 fallback、路由发现、凭证或重定向。
CAR 模式忽略这个环境变量，仍拒绝显式 `--gateway`。
这些默认值仅属于 CLI；程序化 `runBundle` 仍要求调用者注入内容 client。

`--timeout-ms <ms>` 控制根 Task 时间预算（默认 60,000；从最终 Task 创建时锚定）。
`--max-runtime-ms <ms>` 是可选整次预算，涵盖本地 CAR 校验、准入、准备与 drain，
不涵盖读取 JSON 输入文件。
超时会请求正常关闭，并继续等待清理；因此不是“预算到点立即杀进程”。
既有 engine 的 Run wall 时间上限仍为 60 秒，到达该上限同样报告超时。
无限工作或永久等待没有自然完成承诺，应显式配置整次预算。

## 结果

stdout 只有一行 JSON；stderr 在非成功时输出诊断。稳定字段为
`status`、`exitCode`；提交后通常包含 `requestId`；已确认耗尽的结果包含
`rootTaskId` 和 `execution: {dataDomain, tasks, runs, rejections, errors}`。
失败 Task 保留协议错误和结果；尚未运行便过期的 Task 可保持 `stage: "initial"`，
其截止时间仍使整次结果为超时。中断或清理不确定时不伪造成功的完整执行汇总。

| 退出码 | status | 含义 |
| --- | --- | --- |
| 0 | `succeeded` | 全体 Task 成功且清理确认 |
| 2 | `invalid` | 参数、CID、输入或配置无效 |
| 3 | `rejected` | 根准入拒绝，例如输入 Schema 不符或内容不可用 |
| 4 | `failed` | Task/子调用失败、停止或取消 |
| 5 | `timed_out` | 根截止时间、子调用或整次预算超时 |
| 6 | `error` | engine 基础设施失败 |
| 7 | `cleanup_failed` | Worker、资源或 Gateway 清理无法确认 |
| 130 / 143 | `interrupted` / `terminated` | SIGINT / SIGTERM，已请求正常关闭 |

```ts
import { createIpfsGatewayClient } from "@silvermoon-work/task-engine";
import { runBundle } from "@silvermoon-work/task-engine-cli";

const source = createIpfsGatewayClient("http://127.0.0.1:8080");
try {
  const result = await runBundle({
    cid,
    input: { value: 7 },
    ipfsClient: source,
    allowChildren: true,
    maxRuntimeMs: 120_000,
  });
  process.exitCode = result.exitCode;
} finally {
  await source.close(); // 创建方管理内容 client；runBundle 不关闭共享资源
}
```

## 发布依赖

候选映射为 `task-engine-cli`；须先发布包含 `drain`、`MemoryStore` 与 Gateway
关闭能力的新 `task-engine` 版本，再发布 CLI。`workspace:*` 打包后解析为工作区
manifest 的精确版本，不能让 CLI 依赖已经发布但没有这些 API 的旧 engine。
候选版本不是已发布事实；需要按仓库发布守卫单包检查、Trusted Publisher 设置和
真实 registry 安装后 smoke 验证。本任务没有发布或 release tag 授权。

CLI 的本地 CAR 能力依赖已发布 builder `0.1.0-canary-261109-2` 的 `./car` 入口，
不是 builder CLI；不增加另一套 CAR 格式或校验实现。发布时核对该精确 runtime 依赖。
