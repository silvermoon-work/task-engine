# @silvermoon-work/task-engine-cli

Task Engine 的本地后台 Server 与任务调用 CLI，要求 Node.js 22.13+。
当前源码实现已批准的 CLI Spec v1.0；这不表示新版本已发布或部署验收已通过。
已有 `0.1.0-canary-261110-1` 仍是旧的单次嵌入执行命令，不具有下列新接口。

```powershell
task-engine server start
'{"value":7}' | task-engine run --car .\bundle.car --input -
task-engine run --cid <bundle-cid> --input .\input.json --async
task-engine task query
task-engine task query --id <task-id>
task-engine task logs <task-id> --limit 100
task-engine task await <task-id>
task-engine server status
task-engine server stop
task-engine data prune --task <task-id> --cache
task-engine config list
task-engine config get client.engine
task-engine config set task.timeoutMs 120000
task-engine config reset task.timeoutMs
```

仓库内先 `pnpm build`，再使用 private launcher
`pnpm --filter task-engine-app start --help`，或
`node packages\task-engine-cli\dist\bin.js --help`。
所有层级支持 `--help`/`-h`；根入口支持 `--version`。
根或分组无子命令只显示帮助，不连接服务或创建数据。

## 命令和结果

12 个叶命令为 `server start/status/stop`、`run`、
`task query/logs/await`、`data prune`、`config list/get/set/reset`。
业务结果始终是 stdout 上的一个 JSON 对象及换行：

```json
{"ok":true,"data":{"taskId":"opaque-id","status":"succeeded","result":null}}
```

失败为 `{"ok":false,"error":{"code":"…","message":"…"}}`。
有可信任务结果或已完成的部分清理时，同一对象保留 `data`，不伪称回滚。
`error` 只有 `code/message`；stderr 仅用于实现 logging。
退出码为 0 成功、1 失败、130 已确认的用户中断。
业务成功不等于资源释放；不输出 `reclaimed`、`resultState` 或替代释放布尔字段。
启动成功可附 `warnings:[{code,message}]`；非 loopback 监听会警告可信环境边界。
没有 `--json`、`--quiet`、`--yes`、TUI、提示确认或独立 dry-run。

`run` 必须恰选 `--cid` 或调用端本地普通 `--car` 文件，并显式提供
`--input <JSON 文件|->`。只有 `--input -` 读取 stdin 至 EOF。
输入必须是单个完整 JSON 对象，允许 `{}`，不自动补入输入。
业务对象与内部请求信封分离，`requestId` 等业务字段不会覆盖执行身份或预算。
CAR 在调用端读取并传给 Server，不是远端文件路径，不能用 stdin 传 CAR。
任务包校验复用本 CLI 的 `openCarSource` 离线块源：
标准 `@ipld/car`、MemoryBlockstore、UnixFS importer/exporter 和 multiformats
验证唯一根、块 hash/codec、重复/缺失/不可达块和 canonical import profile，
再复用 Protocol 的完整 Task/Schema/资源校验。标准 CAR reader 本身不验证块 hash。
只读块源仅提供 cid、block.get、close；校验快照和临时块在准备后释放，
随后仅复用实例内的持久 CID 块，不将离线准备源变成跨任务内存内容缓存。
Builder 保留归档生产 API，不恢复已移除的独立 CAR 包。
消费端生产依赖不包含 Builder、编译器或 esbuild。

默认同步等待任务及其子任务完整释放后返回结果。
`--async` 在记录持久化后回执，不等拉包准备；准备失败也属于同一 taskId。
`--timeout-ms` 从 Worker 启动计时，不包含拉包、准备或排队。
同步 run 中断会取消本次任务并等待释放；`task await` 中断只停止等待。
异步回执后的终端退出不取消任务；任何受理或释放不确定都明确失败，不自动重提。

`task query` 支持重复 `--status`（并集）、`--since/--until`（与其他条件交集）；
时间使用带时区 RFC 3339，按创建时间含 since、不含 until。
固定按创建时间、taskId 升序。`--id` 与筛选、分页互斥，
保持 `items` 数组，未匹配为空数组；不返回日志或等待完成。
列表和日志 `--limit` 默认 100、范围 1–1000，`--cursor` 是绑定服务及筛选的不透明游标。
日志按持久化追加顺序分页，只有 time/level/message，不混入完整业务结果。

## 实例、持久化和清理

`server start` 后台运行，就绪才返回；冲突不改端口、不复用或重启其他实例。
`server start/status/stop` 和离线 `data prune` 按相同目录选择实例：
显式 `--data-dir` > `server.dataDir` > `~/.silvermoon.work/task-engine`。
它们不读取 `client.engine`，不接受远程 `--engine`。
实际目录的 SQLite 独占锁由 Server 全生命周期持有，路径别名也互斥；
运行随机身份、控制通道及进程出生证据核实归属，不只看 PID、端口或锁文件。
本地控制通道以随机挑战和 HMAC 请求/响应证明实例身份，不把实例密钥发送给监听端。
status 只读；未知身份返回错误，不把不可达当停止。
stop 默认拒绝在途任务；`--cancel-running` 明确取消并等待释放。
已确认停止时幂等 `changed:false`，不补造本次取消数量或释放证明。

任务及子任务记录、业务结果、全部收到的任务日志和可核实释放依据持久保存，
不按条数、期限或日志级别自动淘汰。再次启动将前次未完整结束记录标记失败，
保留原 taskId 和重启原因，不自动重跑；已完整终结记录不改写。
执行域复用现有 Engine/Worker；每个根执行独立，根并发及包准备预算由 Server 统一限制。

持久 CID 块缓存位于实例目录，不设应用容量配额，不做应用层内存内容缓存。
命中校验哈希；只有显式配置 `server.ipfsGateway`/`--ipfs-gateway` 才获取缺块，
不读 Kubo 环境、不隐式联网、上传或 pin。协议既有包/块/载荷限制仍有效。
实际磁盘不足是 Server 致命故障，停止接收任务、处理自有资源并以失败退出；
不能落盘或无法确认释放时如实报告，不把退出当释放证据。

`data prune` 必须离线取得同一实例锁，不自动停止服务或递归删除目录：

- `--task <id>` 可重复，或 `--before <带时区时间>`，只删已终结且释放确认的历史及日志。
  before 按完成时间，不是创建时间；精确指定任一任务无效时，变更前拒绝。
- `--cache` 可单独或与一类历史范围组合；组合先历史后缓存。
  以全部剩余任务和子任务登记根标记传递可达节点，只删未引用且不在用的块。
  缺块、损坏或不支持的引用图在缓存删除前失败，不联网补图。
- 没有显式范围就报错；未选 cache 不删块。返回实际已删除任务、日志条数，
  仅选择缓存时返回去重块及载荷字节计数，不保证等于物理磁盘回收空间。

## 独立用户配置

Windows：`%LOCALAPPDATA%\TaskEngine\config.json`；
其他平台：`~/.task-engine/config.json`，不随 data-dir 迁移。
仅有显式参数 > 用户配置 > 产品默认三层，无项目或环境变量业务配置。
缺文件为未设置；损坏、未知键或无效值报错，不静默回退。
单键 set/reset 在互斥下保留其他键，原子写入；不热更新已有 Server。

默认监听 `127.0.0.1:8787`，独立调用地址 `http://127.0.0.1:8787`，
Worker 执行预算 60000 ms。九项服务默认：
maxConcurrent=64、maxPreparing=1000、maxChildDepth=4、maxChildConcurrent=4、
maxChildTotal=64、maxPayloadBytes=65536、bundleConcurrency=4、
bundleMaxBytes=67108864、maxConnections=256。
`config list/get` 返回用户值、产品默认、有效值和来源；
没有历史数量、内存缓存或持久缓存配额键。

## 程序化兼容和发布

原 `runBundle()`、`ExecutionResult`、`exitCodes` 保留给已嵌入调用方，
继续具有旧的非持久、调用者管理内容源语义；不等于新的受管 CLI。
旧位置 CID 改为 `--cid`；旧 `--gateway` 改为 Server 的 `--ipfs-gateway`；
旧省略输入改为显式 `--input -`；不再使用 `--allow-children`、
`--expected-cid` 或 `--max-runtime-ms`。已提供的子任务能力直接按服务预算执行。

发布映射为 `task-engine-cli`。只发布已审查精确版本的单包 canary，
沿用上游候选 `0.1.0-canary-261110-2`，不是已发布事实，也不因 Builder 发布而自动发布。
父代理选定的准备顺序为 Protocol `0.1.0-canary-261110-1` →
SDK `0.1.0-canary-261110-1` → Engine `0.1.0-canary-261110-1` →
本 CLI `0.1.0-canary-261110-2`。每次只能发布一个映射包。
内部 runtime/peer 及当前发布守卫检查的 dev workspace 依赖必须已有匹配发布版本；
每步确认准确依赖可用后才进入下一步，不能因这组候选而自动发布其他依赖。
不批量、不自动发布依赖、不发布 stable，不移动 tag；
构想、实施检查或 manual dry-run 不等于真实发布和安装验收。
