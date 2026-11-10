# @silvermoon-work/task-engine

按 Bundle 根 CID 字符串或 `{cid, hint}` 受理 Request，协调独立 Task 与可共享的完整 Run。
没有类型注册、当前版本选择或 `discoverTypes`。名称只展示，CID 确定内容。

只需要生成 Request/Run 身份的 Worker 使用轻量公开入口：

```ts
import { newId } from "@silvermoon-work/task-engine/identity";
```

该入口只依赖 Node 内置代码，不初始化 Engine、Gateway 或 Helia 依赖图。
根入口的 `newId` 继续导出同一函数，保留 ULID 格式、指定时间与随机身份语义。
避免为身份生成导入整个宿主入口，使类型守护启动不承担无关内容后端的初始化成本。

```ts
const engine = createTaskEngine({
  store,
  ipfsClient, // caller 创建的通用 IPFS client，连接独立本地 Kubo endpoint
  authorize: (caller, _operation, scope) => caller.scope === scope,
});
await engine.start();
const submitted = await engine.submit(request, caller);
const result = submitted.status === "preparing"
  ? await engine.getRequestStatus(request.requestId, {waitMs: 1000}, caller)
  : submitted;
if (result.status === "accepted") {
  const task = engine.getTask(result.taskId, caller);
}
```

`preparing` 不是 Task。返回前保存原 Request、窗口资格与恢复依据；
accepted 与 Task 创建原子持久化，rejected 也保留幂等依据。
共享获取按规范化根 CID，不共享逐 Request 的输入校验或结果；hint 不参与匹配。
准备没有整体截止；停止观察不取消处理，Task 时间只在最终创建时锚定。
`getRequest` 读取原始意图，`getRequestStatus` 独立读取处理结果。

每 Run 以内存 CommonJS source 启动已验证 `worker.cjs`，不加载作者 factory，也不启动历史业务复验 Worker。
`context.bundle.read(path, {signal?})` 返回背压/取消友好的 `ReadableStream<Uint8Array>`，
不提供宿主路径或平行的整文件 API。需要完整字节时由调用方聚合。
SDK 延迟到 Run 命令后才求值作者模块。宿主确认物理退出后裁决终态，回收是另一事实。
历史查询使用持久事实，不要求缓存仍在，也不重演旧 Run。

Facts/SQLite v5 明确拒绝 v4 等旧格式；操作者必须显式选择新域。
常驻模式的 `collectRequestResults()` 只清理终态跟踪可见性，不删除 Task；
drain 开始后该方法与 `collect()` 一样返回明确的 `engine_draining` 错误，
避免最终汇总前清理拒绝证据。
`collect()` 继续管理 Task/Run 历史的受保护保留边界。

宿主可配置 `bundleLimits`、`bundleConcurrency`（默认 4）及通用 Engine limits。
`maxPreparing` 默认 1000，`maxWaitMs` 默认 30,000ms，
`requestResultRetentionMs` 默认 86,400,000ms。队列等待不构成 preparation 超时。
目录、精确清单、声明、Schema 闭包、路径和文件尺寸校验在 Task 创建前完成；
文件容量、便携路径、严格 YAML 与 Bundle 文件/Schema 结构读取来自
`@silvermoon-work/task-protocol` 的独立实现，与作者工具共用。
Node runtime 版本比较直接使用 `semver`；
生产依赖闭包不包含 `artifact-files`、Check 制品或运行时包，
缓存保留/hint/DAG 预算仍由 Engine 管理。
默认文本资源在准入前完整验证 UTF-8/LF；最终 manifest 必须包含准确的 `binary` 清单，
空清单也显式为 `[]`。只有显式 binary 资源的后继块默认按需读取，
`bundlePrefetch: true` 在准入时同时验证完整 binary 内容。旧声明和不规范文本不被改写或兼容。
因此 Gateway 后续不可用可使已受理 Run 的首次资源读取失败；已缓存的块仍可复用。
内部内存复用使用有界 verified blocks 及租约保护在途准备/运行，不提供公开缓存管理 API；
Engine 不维护额外的 Bundle 文件缓存目录，持久内容、pin 与 GC 由独立 IPFS 节点管理。
`bundleLimits.retainedBytes` 默认 256 MiB，是所有内存保留块的总量预算；超限明确拒绝。
Helia 验证块，官方 UnixFS 解析路径及提供字节流；本地只保留 Task 准入、容量与租约边界。
每次拉取使用至多 256 KiB 的 UnixFS 范围，避免官方 exporter 的整文件预读队列。
旧 `protectedBytes` 已改名为 `retainedBytes`，内存保留/租约不是持久 IPFS pin。
Engine 入口只重导出 `createIpfsGatewayClient`，不再暴露 RPC 工厂；
作者只离线生成 CAR；上传、导入、pin 交由用户选择的外部工具，ipfs-content 不再发布。
Engine 不启动/停止节点、不关闭共享 client，也不删除共享或发布者 pin。
配置的 Gateway 可直接读取；Request hint 默认禁止，宿主通过 `allowGateway(url)` 明确授权候选。
客户端只使用官方 HTTP-only Helia，无 delegated routing、libp2p、公共 fallback 或重定向。
Gateway URL 必须是根 origin，拒绝旧路径前缀；详见[缓存与迁移语义](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-bundle-cache.md)。

原 Input 判等包含合法额外字段；实际提前退出可使 terminates 匹配失效，
纯 now 回拨及 recovery stopped 不触发该例外。失效和后续匹配沿源 revision 观察。
冻结分页、订阅补读、完整集合封装和 scope 授权保持不变。

根入口提供非持久 `MemoryStore`，用于显式的隔离单次宿主；`testing` 继续重导出同一
MemoryStore，并提供 VirtualClock；旧协调器资源 fixtures
只是内部回归测试，不是生产注册 API。`pool` 保留业务资源协调工具。
Worker 不是 OS 安全沙箱。
关闭和退休共享同一个 Worker 终止 Promise，等待实际退出，不重复请求终止。

## 单次耗尽与关闭

```ts
const store = new MemoryStore();
const engine = createTaskEngine({ store, ipfsClient, authorize });
await engine.start();
await engine.submit(request, caller);
const execution = await engine.drain({ signal });
store.close();
```

`drain()` 是终结性操作：同步封闭外部 `submit`、`collect` 和 `collectRequestResults`，
已有准备/准入继续执行，
有效父 Run 的结构化 `invokeTask` 继续遵守默认拒绝或显式授权、身份、关联与预算。
核心生命周期通知同时观察 preparing Request、在途准入/子调用、所有未完成 Task
（含未来 eligibility）、Run、分配和物理回收，不依赖分页或重复静默轮询。
耗尽后才调用原 `close()`，等待守护和资源结束，返回
`{dataDomain, tasks, runs, rejections, errors}`；失败 Task 也是可汇总终态，
不能把 `drain` 完成直接等同于全体成功。
cleanup unknown 或基础设施失败会拒绝并尝试正常关闭；AbortSignal 中断同样先关闭。
重复 `drain` 共享第一次 Promise/Signal。耗尽后不再接受新工作；常驻宿主不调用它，
空闲后仍可提交。`close()` 仍是主动取消流程，不是自然耗尽的替代。

drain 自己持有且最终清除一个存活句柄，保证只有 preparation 或未来等待时进程也不会
提前自然退出；常驻 tick 的原有 unref 行为不变。独立命令与退出码见
[Task Engine CLI](../task-engine-cli/README.md)。

`createIpfsGatewayClient()` 返回的 client 新增 `close()`：创建方可封闭读取、
取消在途获取，并等待临时 Helia 节点实际停止，清理不确认则拒绝。
Engine 本身仍不关闭调用者拥有的 client、独立节点或 pin。

完整接口与边界见 [Task Engine](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-engine.md)、
[Worker 协议](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-bundle-worker.md)。
`EngineOptions.logs` configures bounded diagnostic storage independently from
lifecycle facts. `getRunLogs` and pull-based `subscribeRunLogs` authorize Run
reads and expose capacity, expiry, gaps and completeness. Existing v1 bundles
use the sole evolving v1 protocol; unsupported stored URL/Digest submissions are
explicitly rejected without migration. See
[Run Logs](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-run-logs.md).

## 受管 CLI 的宿主策略

本轮源码候选为 `0.1.0-canary-261110-1`，使用同日 1 的 Protocol/SDK；
这里只准备版本化交付物，未因此发布。实际发布前须验证 runtime/peer 以及发布守卫
涵盖的内部 dev workspace 依赖均已有准确 npm 版本，不自动发布依赖。

受管 CLI 在独立执行域复用同一内核，不改变嵌入调用方的默认策略。
`executionBudgetFromWorker` 将执行预算锚定到 Worker 创建（包含握手启动），
准备和排队不计时；`requestInputEnvelope` 分离业务对象与内部请求元数据。
`persistentContent` 让内容复用只依赖宿主磁盘块源，已无活跃租约的准备对象立即释放，
不在 BundleCache 留存内存内容块。`durableLogs` 关闭宿主日志容量/期限淘汰，
由受管仓库持久化；新 SDK 的对应模式在终结前等日志确认，生产端报告丢失则明确失败。
跨执行域的 `bundlePreparation`、`preparingCapacity` 由同一 Server 提供共享预算。
这些是可信宿主组合接口，不是新 CLI 选项、授权开关或生命周期成功证明。
