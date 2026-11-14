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
const ipfsStore = new IpfsStore({ dataDir: contentDirectory, gateway });
const engine = createTaskEngine({
  store,
  ipfsStore, // 与 Builder 的 content 使用同一对象类型，可共享实例
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

每 Run 由引擎随包分发的本地 bootstrap 启动 Worker，在 Worker 内安装同步模块 hook，
再以 `ipfs://<canonical-cid>/worker.cjs` 加载已验证的内存 CommonJS source。
最低 Node 为 22.15.0；23.x 需至少 23.5.0，精确范围为 `^22.15.0 || >=23.5.0`。
宿主仍负责内容读取、校验和授权，hook 只读当前入口，
不联网、不将 bundle 源码落盘、不使用 eval 或加载时源码改写。
不加载作者 factory，也不启动历史业务复验 Worker。
`context.bundle` 是带固定 `cid` 的只读 Space；
`context.bundle.root.resolve(path).read({signal?})` 返回文件／目录联合类型。
文件的 `content` 是背压友好的字节流，目录的 `entries` 是按需消费的异步迭代。
`signal` 覆盖节点解析和后续内容消费，所有 I/O 同时响应 Run 取消。
不提供宿主路径或平行的整文件 API。需要完整字节时由调用方聚合。
SDK 延迟到 Run 命令后才求值作者模块。宿主确认物理退出后裁决终态，回收是另一事实。
历史查询使用持久事实，不要求缓存仍在，也不重演旧 Run。

Facts/SQLite v5 明确拒绝 v4 等旧格式；操作者必须显式选择新域。
常驻模式的 `collectRequestResults()` 只清理终态跟踪可见性，不删除 Task；
drain 开始后该方法与 `collect()` 一样返回明确的 `engine_draining` 错误，
避免最终汇总前清理拒绝证据。
`collect()` 继续管理 Task/Run 历史的受保护保留边界。

`MemoryStore.runHistory` also offers the optional finalized-history metadata
capability, with the same finalization, archive lease, retention/release and
recovery transitions as SQLite, but without durability. When a retention-capable
`archiveStore` (or the host `ipfsStore`) is injected, Engine finalizes a completed
Run and publishes a RunHistory DAG with native CID links; list/status stay on
SQLite and detail reads hit IPFS on demand. Messages are stored as DAG-CBOR
pages (default 256) rather than one unbounded array. Archive I/O is queued off
the tick stack and never delays `waitForIdle`. Archive errors never revoke a
completed result or trigger Worker execution. Close settles in-flight archive
I/O without re-running Workers.

`readRunHistoryArchive(runId, caller)` uses the existing `history` authorization
and verifies DAG closure before returning details. It does not invent a second
visibility policy: builtin local Store is not a public distribution endpoint;
a Kubo adapter never changes the daemon's network, bootstrap or gateway
configuration. API authorization does not control another Store ingress.

SQLite remains the backup for run state and idempotency. Restoring a database
copy without its IPFS blocks keeps Tasks/Runs/requests and reports missing
archive details; IPFS is never used to recreate those records. See the
[durable management contract](../task-engine-storage/README.md#finalized-runhistory-management-metadata-only).

宿主可配置 `bundleLimits`、`bundleConcurrency`（默认 4）及通用 Engine limits。
`maxPreparing` 默认 1000，`maxWaitMs` 默认 30,000ms，
`requestResultRetentionMs` 默认 86,400,000ms。队列等待不构成 preparation 超时。
目录、精确清单、声明、Schema 闭包、路径和文件尺寸校验在 Task 创建前完成；
文件容量、便携路径、严格 YAML 与 Bundle 文件/Schema 结构读取来自
`@silvermoon-work/task-protocol` 的独立实现，与作者工具共用。
Node runtime 版本比较直接使用 `semver`；
生产依赖闭包不包含 `artifact-files`、Check 制品或运行时包，
任务逻辑路径、文件与执行预算仍由 Engine 管理。
默认文本资源在准入前完整验证 UTF-8/LF；最终 manifest 必须包含准确的 `binary` 清单，
空清单也显式为 `[]`。所有静态 DAG 块（包括 binary 后继块及通用 imports）
在准入前完整获取并验证；缺块或超限明确失败，不降级懒加载。
`bundlePrefetch` 已移除；准备后的静态闭包可在断源后执行。
task.yaml 的 imports 路径必须解析到声明的精确原始 CID。旧声明和不规范文本不被改写或兼容。
内部内存复用使用有界 verified blocks 及租约保护在途准备/运行，不提供公开缓存管理 API；
库通过 `ipfsStore: IpfsStore` 注入内容对象，不隐式加载配置。Builder 的 `content`
接收同一类型，允许共享对象或分别创建指向同一／不同目录的对象。
Engine 只借用对象并创建独立有界 reader scope，close 不关闭调用者的 store。
旧低层 `ipfsClient` 注入保留为 deprecated 宿主适配入口，内部一次性转换为同一
`IpfsStore`，不再由 Engine 拼装下载、缓存和 DAG 读取函数；不能同时传两个入口。
`@silvermoon-work/ipfs-store` 的 `read()` 返回文件流／目录节点，`prepare()`
完成有界静态闭包。公共配置仍由 CLI／宿主显式解析，默认及覆盖见该包说明。
输出内容由所选 IpfsStore 和持久化 Run 引用管理；具备保留能力的 Store
可设置和清理本系统具名 pin 提示，不接管外部 daemon 的进程或全局 GC。
`bundleLimits.retainedBytes` 默认 256 MiB，是所有内存保留块的总量预算；超限明确拒绝。
IpfsStore 验证并复用块，官方 UnixFS 解析路径及提供字节流；Engine 只保留 Task 准入、
逻辑容量与租约边界，不承担打包的 graft 或任务之外的内容路径策略。
每次拉取使用至多 256 KiB 的 UnixFS 范围，避免官方 exporter 的整文件预读队列。
旧 `protectedBytes` 已改名为 `retainedBytes`，内存保留/租约不是持久 IPFS pin。
Engine 入口只重导出 `createIpfsGatewayClient`，不再暴露 RPC 工厂；
Builder build 可从显式内容来源获取 imports，car 则始终离线；上传、导入、pin 交由用户选择的外部工具。
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

## IPFS 模块地址与重建

首期仅支持已验证 bundle 的单文件 CJS 入口及 Node 内置模块。其他 CID、资源路径、
路径穿越、编码路径、凭据、查询和片段明确拒绝；不开放本地模块、node_modules、
其他协议或运行时模块图。CIDv0 别名规范化到相同 CIDv1 入口及 CJS cache 身份。
hook 是每 Worker 的加载适配，不是安全沙箱，不改变内置模块已有能力，
也不为任务创建的子 Worker 自动安装 hook。宿主的模块加载行为不变。

新版 Builder 使 `import.meta.url` 等于规范 IPFS 入口；`__filename` 为该完整 URL，
`__dirname` 为 `ipfs://<canonical-cid>`，二者不是宿主文件路径。
不要对其调用 `fileURLToPath`、`pathToFileURL`、`createRequire` 或依赖磁盘路径拼接。
bootstrap 自己以本地 URL 创建 require，再加载 IPFS 入口；作者不需要新增启动 API。
原生 `require.cache`、`require.resolve`、`require.resolve.paths` 及内置模块保留；
Node 22.15.0 与 24.11.1 的 `require.resolve(ipfsURL)` 不走 hook，仍报
`MODULE_NOT_FOUND`，不承诺通用 IPFS require/resolve API。

需要正确模块地址的旧产物须用新版 Builder 重新构建、重新生成 CAR/CID，再提交新 CID。
这只是地址生成修正：不改变 `task.yaml`、`taskSchemaUri`、SDK 握手、Space protocol
或业务 schema，不新增 loaderVersion，不根据 Builder 版本拒绝旧产物。
旧产物不保证自动获得修正后的 `import.meta.url`，也没有兼容 eval 分支。
运行时仍同时要求引擎最低版本及声明中的 `runtime.minVersion`；已有低版本声明
不会因此单独被拒绝。初始化模板默认声明 22.15.0，协议/SDK 的独立 API 本身未改变。

## Run 文件空间（breaking change）

`context.space(cid)` 同步创建静态只读视图，不承诺内容已经获取。
静态 SID 为 `ipfs:<canonical-cid>`，唯一可写 output 的 SID 为
`run:<run-id>:output`。SID 不是访问凭证；动态 SID 默认仅在所属 Run 有效。
Ref 在运行时持有 Space 和路径，`resolve()` 只计算路径；`toJSON()` 输出
`{sid,path}`，不提供任意 SID 的公开恢复接口或跨 Run 引用承诺。

`context.output.write(path, stream, {signal?})` 完整导入后原子替换文件；
`link(path, ref, {signal?})` 在完整获取并校验源子 DAG 后原子替换目标。
缺失的父目录自动创建；已有文件不能充当父目录。目录替换不合并，
`link("/", ref)` 要求源为目录并整体替换根，保留导入的空目录。
同 output 的 link 固定修改前的源内容，而非建立可变对象或符号链接。
操作有确定顺序，失败或提交前取消不改变目标。

`getCid()` 按需获取当前已提交版本，不承诺该中间版本永久保存或外部可达。
正常完成时宿主收束写入、固化并保留完整最终 DAG，再记录 outcome 的
`output: {cid, result}`；Run 和 Task 查询均可取得该对象，业务 result 不被改写。
Task/Run 列表摘要仅带 `output.cid`，不展开业务结果。
该输出封装是 breaking change，旧开发数据不迁移；Worker 的业务返回值和 Bundle 无需改动。
读取及导入的静态 Space 入口另记录为 Run 的 `contentAccess`，不等同于永久 pin。
失败／取消暂不发布部分产物 CID。第一版不自动回收内容块或 Run 保留根；
只读源适配路径的业务块仍由 `MemoryStore`／SQLite Store 按原生命周期保留；
注入具备保留能力的 IpfsStore 时，块生命周期由所选后端承担，业务 Store 保存引用。
无论 local 还是 Kubo，人工删除缓存或块后都不承诺内容绝对可用。
自定义 Store 必须实现内容块写入和 Run 保留能力，不能默默退回非持久内存。

公开 Context 移除 `generation` 和 `checkpoint`；内部代际隔离不变。
旧 canary Bundle 需要重新构建，不具备新 Space 协议握手的 Worker 明确拒绝。

## 单次耗尽与关闭

```ts
const store = new MemoryStore();
const engine = createTaskEngine({ store, ipfsStore, authorize });
await engine.start();
await engine.submit(request, caller);
const execution = await engine.drain({ signal });
store.close();
```

`drain()` 是终结性操作：同步封闭外部 `submit`、`collect` 和 `collectRequestResults`，
已有准备/准入继续执行，
有效父 Run 的结构化 `invokeTask` 继续遵守固定身份、关联及预算，不设置 authorizeChild 启动授权。
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
## IPFS retention hints

An injected retention-capable `IpfsStore` can use either local storage or optional Kubo.
Engine preserves its persistent Store identity in the content reference
coordinator. Retained Tasks and **all** retained Runs (historical Runs and child
tasks included) contribute their bundle roots and actual output CIDs; JSON
result values are never interpreted as CID references.

Output/import blocks go directly to that injected backend. Kubo does not
duplicate them in Engine's business block tables or application cache
directories. `IpfsStore.fromClient` borrows a read-only source but can write its own
memory/local backend; it does not forward writes or close to that source.
Its `supportsRetention` is false, independently of `writable`. Engine checks
retention capability, so source adapters and deprecated `ipfsClient` retain
their source ownership and legacy business-storage behavior.

`await engine.collect()` commits ordinary record collection first, then
reconciles all participating content owners. `await engine.reconcileContent()`
retries retention recovery/cleanup independently. A cleanup error does not
roll back already collected business records. Closing Engine borrows/closes
only its scopes; it does not unpin persisted roots or stop the user's daemon.

Pins are named best-effort hints, not absolute availability guarantees.
All participating Engines must share one durable `coordinationDir`; the
[Store documentation](../ipfs-store/README.md) defines names, limits, recovery,
external intervention and custom-host `retentionOwner`/`retentionRoots`.
