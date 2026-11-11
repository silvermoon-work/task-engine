# @silvermoon-work/task-engine-cli

Task Engine 的本地后台 Server 与任务调用 CLI，要求 Node.js 22.13+。
已发布 `0.1.0-canary-261111-2` 提供受管 Server、持久任务和 Space 输出；
旧 `0.1.0-canary-261110-1` 是单次嵌入执行命令，不具有下列接口。
本文描述 **0.2.0 RC** 的接口，保留 0.1.0 的帮助纠错和后台故障诊断。
0.1.0 正式版已完成验收，见[发布记录](../../README.md#stable-010-2026-11-11)。
`0.2.0-rc.0` 已发布并完成 office-ubuntu 实测；
见[发布记录](../../README.md#release-candidate-channels)。CLI Spec v1.0 是规范版本，
不是 npm 包的 1.0.0 或已发布声明。

```powershell
npm install -g @silvermoon-work/task-engine-cli@0.2.0-rc.0
task-engine --version
```

完整的 npm 安装 Builder CLI、init、安装依赖和 build 流程见
[端到端指引](../../docs/end-to-end-verification.md)。默认 build 已交付
`dist/<derived-package-name>.car`；不要紧接独立 car 覆盖同一输出。
生成项目的 build 只转译，当前源码模板的类型检查使用独立 typecheck 脚本。
以下示例假定已构建 `my-task`，`<...>` 须替换为实际回执：

```powershell
task-engine server start
'{"text":"world"}' | task-engine run --car .\dist\my-task.car --input -
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
帮助文本写 stdout、退出 0，不产生业务副作用。错误路径即使加 `--help`
也返回失败 JSON/退出 1；例如 `tasks query --help` 会建议
`task-engine task query`，不会自动纠正执行，也没有复数 alias。
叶帮助允许省略尚未填写的必填参数，但不掩盖未知/重复选项、多余参数或互斥组合。

## 命令和结果

12 个叶命令为 `server start/status/stop`、`run`、
`task query/logs/await`、`data prune`、`config list/get/set/reset`。
业务结果始终是 stdout 上的一个 JSON 对象及换行：

```json
{"ok":true,"data":{"taskId":"opaque-id","status":"succeeded","output":{"cid":"bafy...","result":null}}}
```

成功完成的新版 Run 使用统一的 `output: {cid, result}`，`run`、`task await`
和 `task query --id` 均可取得；普通列表仅包含 `output.cid`，不展开业务结果。
顶层不再返回 `outputCid` 或 `result`，业务 `result` 本身不被改写。
输出文件块及保留根存入实例的 SQLite，
重启后仍可被后续任务通过 `context.space(cid)` 读取。离线 `data prune --cache`
同时标记文件缓存和 SQLite 输出块，只删除不再被保留任务引用的内容。
这是 breaking change；旧开发数据库不迁移，请使用新的数据目录，并重启新版 Server。
`output.cid` 是内容标识，不代表内容已上传或公开；本地输出不会自动发布到
Pinboard、Kubo 或公共 Gateway，其他实例不能仅凭 CID 保证读取到这些块。

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
status 枚举为 `pending/running/succeeded/failed/timed_out/cancelled/rejected`。
时间使用带时区 RFC 3339，按创建时间含 since、不含 until。
同时提供时 since 必须早于 until。固定按创建时间、taskId 升序。
`--id` 与 `--status/--since/--until/--limit/--cursor` 全部互斥，
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

### 本地 raw gateway（当前源码新增，默认禁用）

Engine 核心不提供 HTTP 分发；受管 CLI 宿主在同一监听地址提供可选
`GET/HEAD /ipfs/{cid}?format=raw`。仅从实例文件缓存及持久输出块读取，
**从不调用回源入口**；即使配置 `server.ipfsGateway`，该路由也不联网。
CID 只标识内容，不是访问凭证。开启 `public` 会允许所有可连接监听地址的
客户端读取全部已缓存块，包含其他任务的包和输出；不得在不可信网络直接开放。
任务 API 的现有可信网络边界不因此改变，raw token 不保护任务 API。

```powershell
task-engine config set server.rawGatewayAccess public
task-engine server start --data-dir .\engine-a --port 8787
# 改配置不会热更新已有 Server；重启后才生效。
# 可改为独立 bearer 访问策略（用随机 32–256 位 URL-safe token 替换占位符）：
task-engine config set server.rawGatewayToken <random-token>
task-engine config set server.rawGatewayAccess token
# 禁用：
task-engine config reset server.rawGatewayAccess
```

配置 `token` 但没有合法 token 时启动失败。请求使用
`Authorization: Bearer <random-token>`，未授权统一 401 且不读取存储；
禁用统一 404。token 响应为 private 缓存，公网模式为 public immutable。
token 存在用户配置，`config list/get` 会显示它，请按凭证保护配置和终端记录。
现有 Engine 上游客户端不支持配置 bearer header，双 Engine 演练应在隔离
loopback/可信网络使用显式 public，或由授权反向代理处理访问控制。

支持范围：CIDv0/v1（同 block 归一化为 CIDv1 缓存键）、SHA2-256 和
identity（包括空探测 `bafkqaaa`），不解释 codec、不重编码 block。
其他 hash 明确 501。只提供根 block，无 CAR、IPNS、UnixFS 路径解析、
上传、pin、递归回源、DAG 范围或局部读取。无 format 且无 Accept 为 400；
Accept 可选择 `application/vnd.ipld.raw` 或匹配通配符，质量值/排除项生效，
不支持表示为 406，`format=raw` 优先于 Accept。重复 format/filename、
非法 CID、路径、dag-scope/entity-bytes 为 400。Range 忽略并返回完整已验证
block（200，`Accept-Ranges: none`），不能将片段当 raw block。
普通缺块 404，`Cache-Control: only-if-cached` 缺块 412，损坏和存储错误
500，不伪装成未命中。所有错误无内容 body，HEAD 永远无 body。

成功响应含 raw Content-Type、attachment（可安全指定 filename）、
nosniff、Content-Length、Content-Location、Vary: Accept 和强 ETag
`"<canonical-cid>.raw"`。先校验本地 bytes，再处理 If-Match（失败 412）和
If-None-Match（含弱比较，命中 304），不对缺失或损坏块伪造 304。
HTTP 日期条件因没有稳定 Last-Modified 而忽略。

独立于任务执行/准备配额的配置默认：
`server.rawGatewayMaxConcurrent=4`（含慢客户端发送阶段，超限 429）、
`server.rawGatewayMaxBlockBytes=2097152`（读取前限额，超限 413）、
`server.rawGatewayTimeoutMs=10000`（读取与发送总时限，超时 504；
已发 headers 则断开）。客户端断开和 Server 停止取消本地读并释放 slot。
CID 文本最多 2048 字符，filename 最多 256 字符；这些为本 profile 上界。
单请求最多读取 block 上界加 1 字节用于检测并发增长，不建立后台队列。
HTTP listener、连接上限 `server.maxConnections` 和事件循环仍由宿主共享，
不是针对恶意租户的进程/网络隔离；可在独立实例/反向代理设置连接级预算。

完整规范固定版本、适用矩阵及双节点命令见
[本轮验证依据](../../.silvermoon/ideas/01M75C5K29RZDCXJEPDRADFAW3/outer/inner/verification.md)。

### 后台故障诊断（当前源码新增）

后台进程通常没有终端。实例目录下的 `daemon-diagnostic.json` 是预分配的
4096 字节单条 JSON 快照，末尾空白可直接由 JSON parser 忽略。
启动前验证创建/写入/同步能力，最近一次
`startup-failed/storage-failed/shutdown-failed/uncaught-exception`
覆盖同一槽位。它不是任务日志或审计历史，不自动扩展或无限追加。

```powershell
Get-Content .\engine-data\daemon-diagnostic.json -Raw | ConvertFrom-Json
```

记录包含 time、pid、instanceId，以及允许的系统错误码、SQLite 错误码和原因链，
不写 message/stack、URL、输入/输出或 token。重启不清除上一次失败，
排查时核对 instanceId，不能把旧故障当成本次状态；正常状态仍查询 `server status`。
预分配原地覆盖可缓解磁盘满，但同盘 EIO、只读文件系统、权限丢失和强杀
都可能阻止诊断落盘。诊断失败时 stderr 也只是 best effort，不能保证后台可见。
此新增通道不改变命令树、业务 stdout JSON 或退出码，尚未随上述 canary 发布。

### 显式离线清理

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

发布映射为 `task-engine-cli`。当前正式版为 `0.1.0`（npm `latest`），
本轮已发布 `0.2.0-rc.0`（npm `rc`），未修改 `latest` 或历史 `canary`；
每个包独立发布，不因 Builder 发布而自动发布。
每次只能发布一个明确授权的映射包。
内部 runtime/peer 及当前发布守卫检查的 dev workspace 依赖必须已有匹配发布版本；
每步确认准确依赖可用后才进入下一步，不自动发布其他依赖。
不批量、不自动发布依赖；未经明确授权不推发布 tag 或发布正式版，不移动 tag；
构想、实施检查或 manual dry-run 不等于真实发布和安装验收。
