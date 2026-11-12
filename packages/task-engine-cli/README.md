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
认证 status 的 `memory.rss` 由一个独立、启动就绪后unref的Worker每50ms采样
`process.memoryUsage.rss()`，包含全进程及所有Worker；`memory.main` 的
`heapUsed/heapTotal/external/arrayBuffers` 则由主线程50ms定时采样，仅描述主isolate。
两流分别保留最多2048条真实时间/连续序号的样本，认证status异步复制有界历史；
主线程阻塞可造成main流诊断间隙，不能伪装成RSS间隙或插值补齐。
arrayBuffers包含在external内，不能求和。采样Worker随daemon关闭明确终止；
`instrumentation`报告1个额外Worker及启动前后RSS差（诊断观察，不是精确独占开销）。
`peakRssBytes` 是生命周期高水位，仅供诊断，不可减去阶段当前RSS来归因网关增长，
也不是Node可强制执行的内存上限。采样缺口须由消费者验证，不能推断两采样点间峰值。
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

### 本地 raw/CAR gateway（当前源码新增，默认禁用）

Engine 核心不提供 HTTP 分发；受管 CLI 宿主在同一监听地址提供可选
`GET/HEAD /ipfs/{cid}?format=raw` 和下述 CAR 路径路由。仅从实例文件缓存及持久输出块读取，
**从不调用回源入口**；即使配置 `server.ipfsGateway`，该路由也不联网。
CID 只标识内容，不是访问凭证。开启 `public` 会允许所有可连接监听地址的
客户端读取全部已缓存块，包含其他任务的包和输出；不得在不可信网络直接开放。
任务 API 的现有可信网络边界不因此改变，gateway token 不保护任务 API。
为兼容已有配置，`server.rawGatewayAccess/Token` 同时控制 raw 与 CAR。

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
其他 hash 明确 501。raw 表示只提供根 block，不解析 UnixFS 路径，
不支持上传、pin、递归回源或局部读取。无 format 且无 Accept 为 400；
Accept 可选择 `application/vnd.ipld.raw` 或匹配通配符，质量值/排除项生效，
不支持表示为 406，`format=raw` 优先于 Accept。重复 format/filename、
非法 CID、raw 路径、raw 的 dag-scope/entity-bytes 为 400。Range 忽略并返回完整已验证
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

### 本地 CAR 路径、字节范围与表示协商（迭代 4）

```powershell
curl.exe --fail -o proof.car -H "Accept: application/vnd.ipld.car;version=1;order=dfs;dups=n" "http://127.0.0.1:8787/ipfs/<bundle-cid>/resources/nested/proof.txt?format=car&dag-scope=block"
curl.exe -I "http://127.0.0.1:8787/ipfs/<bundle-cid>/resources/nested/proof.txt?format=car&dag-scope=block"
curl.exe --fail -o range.car "http://127.0.0.1:8787/ipfs/<file-cid>?format=car&entity-bytes=-1024:*"
```

三种 `dag-scope` 均包含请求根到终点的必要路径证明：

| scope | 终点范围 |
| --- | --- |
| `block` | 仅终点 block，不读取载荷或列举目录 |
| `entity` | UnixFS 多层文件的完整内容 DAG；普通目录仅目录块；HAMT 目录包含枚举所需的全部子分片，不读子文件/子目录内容；非 UnixFS 等同 block |
| `all`（省略时默认） | 终点的完整连续子 DAG，按 DFS 遍历；默认首次访问去重 |

支持 raw `0x55`、DAG-PB `0x70`（不要求 Task bundle 或 UnixFS）、
DAG-CBOR `0x71`；通用 DAG-PB 按 Links 顺序、DAG-CBOR 按规范编码的 map key
顺序和 array 顺序遍历 links。UnixFS entity 支持 file/raw、普通目录和 fanout=256、
murmur3-128 的 HAMT；symlink/metadata 只作为自身 entity，不跟随 symlink。
复用维护中的 DAG-PB/DAG-CBOR/UnixFS codecs 与 exporter/walkPath，
保留原始 bytes。支持 CIDv0/v1、SHA2-256/identity；identity 的 links 仍被校验与遍历，
但虚拟 block 不写入 CAR 数据段。未知 codec/hash 明确 501，不跳过缺块。
不支持 IPNS、上传、pin 或回源。
UnixFS 路径中间节点必须是目录，不把文件后的多余路径悄悄忽略；
DAG-CBOR 可以经 map/array 内的 IPLD link 解析 CAR 路径。
损坏 codec 数据或 hash 失败；非 UnixFS DAG-PB Data 可作为通用 IPLD 数据。

`entity-bytes=from:to` 是闭区间，负偏移从文件末尾计数，`to=*` 表示文件末尾。
它优先隐含 `dag-scope=entity`，通过 BigInt UnixFS 元数据仅选择必要结构及载荷 blocks，
不切割 CAR 序列化字节，也不下载无关叶子。目录、一般 DAG 等非字节实体忽略范围，
按 entity 返回；语法错误、重复参数为 400。根文件可提前判断的完全越界或反向空区间为
400；沿路径流式发现的完全越界/空区间及空文件返回等价 block 的结构证明。
部分越界返回范围内 blocks。原始块中包含额外未请求 bytes 是块级证明的必然结果，
客户端应验证后从完整原始 blocks 恢复切片，而非直接拼接 CAR bytes。

只输出 `application/vnd.ipld.car; version=1; order=dfs; dups=n|y`。
`format=car` 选择 CAR 表示；无 format 时按 Accept 权重选择 raw/CAR，
相同权重优先显式 CAR，纯通配符保持既有 raw 默认。
Accept 的 CAR 参数及 `car-version/car-order/car-dups` 必须能满足，
查询参数优先；支持 `1/dfs/n|y`，`order=unk` 表示客户端不约束顺序，
服务端仍输出显式 `order=dfs`。其他变体 406，重复参数 400。
Accept 按媒体范围 specificity、参数及 q 值选择可满足的变体；省略 dups 默认 n。
dups=y 按真实 DFS 每次图出现发送完整 block（包括重复子树），不是重复输出路径解析器
的内部读取；identity 虚拟块在两种策略下均不写入 CAR。
未知 scope 返回 400；无 entity-bytes 时省略与显式 all 的 bytes、ETag 完全相同。
`/ipfs/bafkqaaa?format=car` 返回根为 `bafkqaaa` 的有效空 CAR；HEAD 无 body。

路径逐段 percent-decode 一次，`%2F` 是路径分隔符，然后合并重复斜线并处理
`.`/`..`（不能越过请求根）；`%252F` 是文字 `%2F`，`+` 不是空格。
路径最多 64 段、原始 pathname 最多 16384 字符；控制字符和反斜线明确 400。
IPFS URI 使用规范 CID 和逐段编码，保留尾斜线，避免非 ASCII 响应头。

GET 逐 block 校验 CID 后发送原始 bytes，不重新编码内容。
含 attachment、nosniff、Vary、Content-Location（明确实际 CAR 参数）、
IPFS 路径/URI、Accept-Ranges: none 和绑定根/规范路径/有效 scope/请求范围/版本/顺序/dups 的强 ETag。
HEAD 与命中 If-None-Match 在发 headers 前验证所选范围的必要集合，不要求文件完整 DAG；不发送 body 或虚构
Content-Length。If-Match 使用强比较，If-None-Match 可弱比较。
根缺失普通 404、only-if-cached 412；损坏 500、预算超限 413。
GET 发 headers 后遇到缺失路径 link，可正常结束包含父节点的有效部分 CAR，
用于证明该路径不存在；HEAD/条件请求仍在 headers 前返回 404。
缺失必要后代 block、损坏、预算或超时则直接断开传输，不伪装成完整成功。
**CAR 可解析不代表范围完整**：客户端必须检查 HTTP 完整结束，并从请求根验证路径和
所选范围内所有必要 links；UnixFS 文件还应验证恢复的全部 bytes。
CAR roots 和服务端提供的终点都不是信任锚。

raw/CAR 共用既有 access、并发、每 block 上限和总时限，不消耗任务执行配额。
`server.carGatewayMaxBlocks=128` 限制读取次数、访问次数（含 identity）、输出 block 次数
和待遍历 frontier（含重复 links）；很宽的 DAG 也可能需调高预算，
`server.carGatewayMaxBytes=67108864` 分别限制累计读取 bytes 与完整 CAR 输出
（含 framing）。超限不建立队列；修改后重启生效。
发送等待 socket drain，取消/超时会打断等待并释放 slot。
终点子 DAG 非递归遍历，深度最多 64 条边；DAG-CBOR 嵌套容器最多 64 层。
不缓存整份 CAR；只保留当前块、有界 frontier/CID 集和库的路径遍历状态。
HAMT 路径证明的父分片/解码状态仍可能存活到路径解析完成，受累计读取预算约束，
不是恒定一块内存或恶意租户隔离承诺。详见
[迭代 4 实现证据及独立范围复核输入](../../.silvermoon/ideas/01M75CBPP3TFRS1N6K71W1WRYJ/outer/inner/verification.md)。

读取一致性采用逐块、非快照语义：已校验的当前块可继续发出，后续必需块被并发
prune 删除时检索失败，不重新回源、不静默省略。已读取块之后被删除不影响该响应；
HEAD/304 仅证明本次检查时完整，不保证下一次 GET 或本地 pin。

### HTTP、浏览器与运行观测（迭代 5）

启用的 gateway 对 GET/HEAD/OPTIONS 返回 `Access-Control-Allow-Origin: *`，
不允许 credentials/cookies；浏览器请使用 `credentials: "omit"`。
token 模式允许不携带 token 的 OPTIONS preflight，但实际读取仍要求
`Authorization: Bearer ...`。只允许 GET/HEAD 及显式列出的读取请求头，
非法方法或 Cookie/未知请求头的 preflight 为 403。
ETag、Content-Disposition、Content-Location、IPFS 路径/roots/URI、范围与重试头可由
浏览器读取；不暴露 token、实例身份或管理接口。禁用模式不开放 CORS。
raw 与 CAR 均提供 `X-Ipfs-Roots`。

`server status --data-dir ...` 通过既有实例身份验证通道返回 `gateway` 快照：
`requests`、本地块读取 `hits/misses`、`outputBytes`、`failures`、
`storageErrors`、`cancellations`、`timeouts`、`rejected`、`active/peakActive`。
计数随进程重启清零；hits 是实际本地块读取次数（identity 不读盘），
misses 包含缺块和不可解析的路径 link；损坏/磁盘读错误不当作 miss，
取消/超时不当作 storageErrors。failures 包括 HTTP 错误、断开的传输和路径缺失证明，
不是仅统计 5xx。outputBytes 是交给 Node 响应流的 body 字节，不含 headers，
不是客户端确认收到的网络字节；HEAD/304 不增加它。
`rssBytes/peakRssBytes` 是整个宿主进程（含 Worker）的当前/历史峰值 RSS。
没有新增公开 metrics URL；不要将受管状态端点透传到公网。

固定外部套件 `gateway-conformance v0.14.1` 的支持矩阵、全部逐项结果、
负载数值门限、Windows 测量和 registry consumer/浏览器回放命令见
[迭代 5 验证](../../.silvermoon/ideas/01M75CCXR5TWE63N6QEXV1C720/outer/inner/verification.md)。
默认 128-block 预算不是无限 DAG 的 conformance 承诺；外部 suite 的完整 HAMT fixture
需要显式 4096-block 验证配置，而 128-block 超限行为另有固定预算测试。
共享 listener/连接总额/事件循环仍不是多租户硬隔离；外层 TLS、连接限额与进程隔离由部署负责。

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
