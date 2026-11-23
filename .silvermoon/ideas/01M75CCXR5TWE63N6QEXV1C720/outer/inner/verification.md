# 迭代 5：验证与回放

## 固定支持矩阵

测量前的选择器与数值门限见
[Implementation](Implementation.md#固定验证契约测量前冻结)。外部套件为
`ipfs/gateway-conformance v0.14.1`，commit
`011d20bd61c4736e3301d35e8fe388773e492511`；规范参考为
`ipfs/specs 3000be69497e47c399cdb719440d0809f085388b`。稳定版本的理由是包含现有 raw/CAR/partial 和 PBNode 两种字段顺序的完整测试，不使用可能增加新产品范围的 moving
main。

| 外部测试                                 | 范围与结果                                          |
| ---------------------------------------- | --------------------------------------------------- |
| TestTrustlessRaw                         | 根 raw 原字节、附件、自定义文件名、缓存头           |
| TestTrustlessRawRanges                   | Range 可合法返回完整 raw，不把片段当作 block        |
| TestTrustlessRawPBNodeFieldOrder         | 普通目录/HAMT 两种 PB 字段顺序的 byte-exact raw     |
| TestTrustlessCarPathing                  | UnixFS、HAMT、DAG-CBOR link 路径和不存在路径证明    |
| TestTrustlessCarDagScopeBlock/Entity/All | 所有 scope 和省略 scope 的默认 all                  |
| TestTrustlessCarEntityBytes              | 正/负/末尾范围、最小证明、缺失范围外 block          |
| TestTrustlessCarOrderAndDuplicates       | dfs、dups=n/y、identity、不约束顺序 unk、参数优先级 |
| TestTrustlessCarFormatPrecedence         | format 优先于 Accept                                |
| TestCors                                 | GET/OPTIONS 的跨源读取与暴露头                      |

以上全部运行：11 个顶层测试，503 个 pass 事件（包括组、请求案例与 header/body 检查，不把它们误称为 503 个独立请求），0
fail、0 skip。完整逐项结果及 fixture SHA256 见
[evidence.json](evidence.json)。不要求 deserialized 网站/UnixFS/JSON/CBOR/TAR、raw 子路径、Subdomain/Proxy、DNSLink/IPNS，理由在执行前确定；不是看见失败后新增排除项。CAR
v2 和未知 codec/hash 不在产品支持范围内。

首次执行没有通过：DAG-CBOR 路径被错误拒绝、`order=unk`
被当成另一种输出顺序、不存在路径的 parent
proof 被不必要地中断。这些实际兼容性问题已修复并增加回归。原始失败测试名保留在 evidence；不将其重分类为 skip。首次使用默认 128-block 配置还触及完整 HAMT
fixture 的预算，导致 EOF 与后续容量拒绝；完整 suite 使用产品已有的可配置 4096-block 上限，所有选中的测试重新运行。这不是把生产默认预算改成 4096，也不是放宽共载测量的 128-block 门限：小预算的 413、取消与恢复由独立预算测试证明。曾额外用
`-parallel 1`
复查，最终仍以原 runner 默认重跑全部选择器并通过，没有通过串行化隐藏原适用失败。最后的故障分类修正后，曾与完整
`pnpm check`
同时复查，触发1次预算内的429拒绝，该次适用测试仍记为失败；不调整选择器、并发2或超时1000ms，待仓库检查结束后同配置连续3轮各503
pass、0 fail/skip。三轮摘要与该次失败项均保留。

## 工具与 fixtures

Windows 原先没有 Go，Docker CLI 存在但 daemon 不可用。仅在操作自有目录下载 Go
`1.27.4 windows/amd64`：

- 归档：`https://go.dev/dl/go1.27.4.windows-amd64.zip`
- SHA256：`178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e`
- 官方 release 没有独立二进制资产，所以从固定 commit 构建 upstream
  runner；没有写全局 PATH、安装全局包、变更 registry 或使用替代 HTTP proxy。
- fixtures 直接来自固定 checkout 的内嵌 CAR；每份 SHA256 在 evidence。merged 提取文件 SHA256 亦保留，但回放直接用原 fixtures，避免依赖合并文件排序。

Go 构建缓存、模块缓存、测试工作目录和下载归档全部在操作自有项目目录，结束后删除。Suite 的运行目录由
`GATEWAY_CONFORMANCE_HOME`
指向固定 checkout；父级 Ubuntu 可以使用校验后的临时 Go
tarball，不能把工具不存在当作通过。

## Registry consumer 回放

把本目录的 `replay.mjs` 与 `browser.html`
复制到独立 consumer。consumer 必须安装父级批准的准确 CLI 版本；`--load yes`
还需要公开的 Builder、Builder
CLI 与 SDK 包。重用已经安装的发布版本，不使用 workspace
override 或源码导入。脚本只通过公开 package
exports、CLI、HTTP 和自有 fixture 缓存操作；编译真实 callback 任务，不以进程存活充当执行证明。不要对非自有数据目录运行。

Windows 仓库内等价命令（consumer 的依赖已存在）：

```powershell
node .silvermoon\ideas\01M75CCXR5TWE63N6QEXV1C720\outer\inner\replay.mjs --consumer packages\task-engine-cli --tree-root . --work .gateway-load-owned --load yes --report gateway-load-report.json
```

独立 consumer 内跨平台命令（`--work`
必须不存在，且应在项目内；脚本结束会删除它）：

```text
node replay.mjs --consumer . --work .gateway-load-owned --load yes --report gateway-load-report.json
node replay.mjs --consumer . --work .gateway-suite-owned --fixtures FIXED_CHECKOUT_FIXTURES --port 18785 --hold-ms 600000 --report gateway-fixtures-report.json
```

按用户明确批准的目的分离，Suite配置自动选并发16及4096 blocks；负载配置始终
并发2及128 blocks。没有并发override入口；`--fixtures`与`--load yes`组合明确拒绝，
不能借fixture参数放宽压力预算。其他block/CAR/timeout门限和原选择器均不变。
两类验证应使用不同自有实例。fixture
provisioning 对每块 SHA2-256 验证后写入自有实例缓存；实际被测服务器始终是真实 CLI 受管服务器，不存在 fixture
HTTP 代理。准备好后输出 `ready`；hold 期间监听和任务服务继续响应，600000
ms 后自动停止并清理。若需要提前结束，先用同一 HOME/LOCALAPPDATA 配置下的 CLI
`server stop`
停止，再终止脚本；不要只杀 shell 留下 daemon。如果 stop 无法确认释放，脚本保留自有实例身份和诊断文件并失败，不继续删数据或伪称清理完成。

固定 suite 命令：

```text
gateway-conformance test --gateway-url http://127.0.0.1:18785 --specs trustless-block-gateway,trustless-car-gateway,trustless-car-gateway-optional,path-unixfs-gateway --json report.json -- -run "^(TestTrustless.*|TestCors)$" -count=1 -timeout 5m
```

检验 report 中终止事件；必须 0 fail、0 skip，不允许改 selector。
`TestTrustlessRawPBNodeFieldOrder`
位于 UnixFS 测试文件中，不能只按 raw 文件名取测试。

## 真实浏览器

Windows integrated Chromium/Electron 已真实执行跨源 fetch（不是 Node
fetch 模拟）：origin `http://127.0.0.1:18786`，public `18785`，token
`18787`。实际 public/token GET 均取得精确
`hello\n`，JS 可读 ETag/附件/roots/URI；HEAD 200/空 body、条件 GET
304/空 body、CAR 空探测 200/26
bytes、编码 CID、UTF-8 附件名、Accept 权重/format 优先级通过。token 请求由浏览器执行 Authorization
preflight；缺少 token 的 401 可读； `credentials: include`
被浏览器 CORS 阻止。证据记录真实 userAgent。浏览器网络日志中的 HEAD/304
`ERR_ABORTED`
是 Chromium 的无实体请求记录；JS 已实际得到对应状态和空 body；不把日志忽略成任意网络错误通过。

父级可针对 registry 安装重放：

```text
node replay.mjs --consumer . --work .gateway-browser-public --port 18785 --hold-ms 600000
node replay.mjs --consumer . --work .gateway-browser-token --port 18787 --token bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --hold-ms 600000
```

上述 token 是独立测试实例的公开 fixture，不是生产凭证。经有界 SSH
tunnel 转发两个端口，另在浏览器可达的第三 origin 提供本目录
`browser.html`，不要使用同源页面。用 Playwright 调用：

```javascript
return await page.evaluate(
  async () =>
    await runGatewayChecks({
      publicUrl: "http://127.0.0.1:18785",
      tokenUrl: "http://127.0.0.1:18787",
      token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
);
```

函数会检查真实浏览器 body、状态和可见 headers，并在失败时抛错，不只是展示结果。fixture
`/ipfs/bafkqabtimvwgy3yk?format=raw` 是 identity，无需从外部注入数据。

## 协议容量分离的已批准修订与诊断

rc.6的外部并发2 suite在完整执行及一次原样复查都于format precedence产生429；
这两次仍是失败，未跳过或改为通过。用户随后明确批准协议suite专用并发16，
资源/内存压力专用并发2，不更改timeout、selector、runner并发或生产默认配置。
与既有fixture4096/压力128 blocks类似，两实例用途不同；只修订replay方法，
没有生产代码变更、版本提升或发布要求。协议16外部验证尚待父级实际执行，
本节不声称其通过，也不将已有rc.6九对压力、浏览器或TLS结果冒充协议16结果。

固定upstream `011d20bd61c4736e3301d35e8fe388773e492511`：

- `tests/trustless_gateway_car_test.go` 中OrderAndDuplicates末尾
  `?car-order=dfs`与`?car-dups=y`两个案例仅检查status/headers；紧接着进入
  FormatPrecedence。`tooling/test/test.go`是顺序t.Run，未t.Parallel，但仅在
  enclosing run结束才defer cancel。
- `tooling/test/validate.go`仅在`expected.Body_ != nil`时ReadAll/Close；
  header-only响应没有被消费或关闭，HTTP返回headers不代表服务端CAR遍历/发送完成。
- 产品`raw-gateway.ts`在整个CAR操作完成后的finally释放controller；
  `car-gateway.ts`先await writer.close和pump，再await response.end callback，
  没有昂贵的正常finish后清理。

本地使用真实DiskContent、原fixture `dir-with-duplicate-files.car`（1939 bytes，
SHA-256 `52ba43df5a78d92b9ca006832e8425085c00b4e268b16cf049e54ba9dbd1b0db`）
与并发2/1000ms/2 MiB block/8 MiB CAR/4096 blocks，三次发送相同两种header-only
请求后立即发第三CAR，结果均 **200/200/429**。第三请求到达时两个前序响应均无
finish事件，active=2；正常finish后约0.01–0.05ms内handler结束并active归零。
每轮随后10次完整消费CAR均200且active=0，合计30/30。该第三请求使用同fixture
root以单独重现容量，不冒充upstream FormatPrecedence的另一fixture root。
这是实际尚未完成的流式工作引起的瞬时3请求重叠，不是已完成响应长期占槽或容量泄漏。

因此不能在headers返回时提前释放slot以迎合suite，否则破坏压力并发预算。
用户已选择分离验证目的而非改变生产实现；未反复重试挑通过。原诊断fixture、
服务器与脚本已清理；本节保留精简结果，不新增临时工具或重复大份JSON。
内存采样生产源码与压力配置均未改变，既有v2本地九对证据仍适用，不重新运行压力。
新增focused回归验证purpose路由与组合拒绝，避免fixture路径静默提升压力并发。
本次验证：`node --check` replay与policy模块通过；
`pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test --test-name-pattern "replay purpose|paired replay" test\managed.test.ts`
为2/2通过；实际CLI组合`--fixtures .does-not-exist-owned --load yes`在任何
import解析、实例或负载启动前明确退出1，无fixture副作用；完整`pnpm check`
通过（40/40任务、测试类型检查与包检查）。没有重跑未变的九对压力，也没有
运行协议16的外部suite；后者由父级在本次修订同步和验收后独立执行。

## 固定预算下的实测

本节原 Windows RSS 数值属于历史有缺陷口径，不再作为 I-S03/I-AC03 的有效
内存证明；原始结果和 `evidence.json` 不改写。修订后的当前采样结果与阻塞见下一节。

最终 Windows
workload 的逐项结果见 evidence.load：热身后4个基线任务，随后8个真实 Worker 各执行4次1
MiB raw读取（总32次），同时校验全部返回 bytes，成功任务返回已校验
`{value:42}`。这样避免 HTTP 压力在 CLI 启动前就结束的伪共载。慢消费者使用7个1
MiB raw子块的7 MiB
CAR，暂停两个 HTTP 客户端，第三请求必须429。abort 后查询 active 归零并再次执行任务；在线 GC 被 DATA_IN_USE 拒绝；缺块、损坏缓存、删除必需 block 分别产生404、500、404，随后任务仍成功；带活跃消费者停止后做离线 GC，实际回收8块共7,340,312
bytes。

| 指标                  | 冻结门限                             | Windows 实测                               |
| --------------------- | ------------------------------------ | ------------------------------------------ |
| 网关 active 峰值      | ≤2                                   | 2                                          |
| 共载任务              | 8/8 成功                             | 8/8                                        |
| raw workload 过载     | 必须有429                            | 6次429，其余26次200                        |
| 共载最大延迟          | max(基线最大×5, 2000 ms)=4510.577 ms | 2780.2943 ms，通过                         |
| RSS 增长              | ≤134217728 bytes                     | 94818304 bytes                             |
| abort 后回收          | <3000 ms                             | 779.1579 ms                                |
| 活跃消费者下 shutdown | <3000 ms                             | 1084.0202 ms                               |
| 故障分类              | 缺块≠存储错误≠取消                   | misses=2，storageErrors=1，cancellations=2 |

第一个合法 workload 也通过（RSS增长124,063,744
bytes），后续把任务内客户端改成流式校验以减少临时整块副本（两轮分别89,059,328与94,818,304
bytes），未提高门限。最终测量在故障原因分类修正后的准确源码上重跑。早期 replay 脚本 authoring 错误（未声明 include、未编译 SDK
callback、workspace 目录树边界）不计为测量或通过，自有失败实例已停止并清理。
`outputBytes` 仅计 Node 响应流接受的 body
bytes，不是客户端确认交付量。宿主共享 listener/连接限制/事件循环；不承诺恶意客户端的硬 CPU/内存/网络隔离。精确的1000ms读取超时、413预算、断连、慢消费者 backpressure、缺块/损坏及逐块删除/GC 行为同时由 focused
regression 测试验证；外层公网TLS/HTTP2仍属部署。

## 历史v1当前内存实验：主线程仪器覆盖失败

协议先于测量同步到 primary：`3e99e433bbf693cd47ff8018157931877ddb54b1`；
两臂等量冷缓存预热补充同步到 `25a2a69`。没有修改 Ideal、128 MiB 数值、
50ms cadence、250ms 最大采样间隙或其他服务预算。不是给旧失败补写通过证据。

本地使用 Windows、Node `v26.13.0`、已构建 workspace CLI 的公开入口（不是
registry 发布包），脚本不导入产品私有模块；远程独立 registry/Linux 门禁尚未重跑。
新增认证 status 遥测只涉及 `@silvermoon-work/task-engine-cli`，父级需先审查并另发
新版本后才能在 consumer 使用；已发布 rc.5 不支持该字段，绝不能覆盖旧版本/tag。

执行命令（与上文相同公开入口，报告改为本目录 `memory-evidence.json`）：

```powershell
node .silvermoon\ideas\01M75CCXR5TWE63N6QEXV1C720\outer\inner\replay.mjs --consumer packages\task-engine-cli --tree-root . --work .gateway-memory-owned --load yes --report .silvermoon\ideas\01M75CCXR5TWE63N6QEXV1C720\outer\inner\memory-evidence.json
```

完整保留三次尝试，不挑最好结果：

1. `memory-warmup-failure.json`：初次8任务冷缓存预热遇 Windows 同 CID 文件
   并发替换 `EPERM`，未开始测量。两臂随后增加相同串行带/不带 gateway 预热，
   不修改生产存储代码，不减少测量负载。
2. `memory-coverage-failure.json`：等量预热后首次 control/load 采样覆盖失败，
   0 个有效波次；该版尚未在校验失败前保留窗口，不能重建缺失数据。
3. `memory-evidence.json`：为失败窗口增加有界诊断保存后原协议复查，仍在第一
   control/load 失败。原始四个边界快照完整保留；首个不合格间隙
   **356.2698ms**，该 load 最大间隙 **750.2986ms**，超过250ms；
   quiet/drain 最大间隙分别64.4599/64.1700ms。没有通过重试删去前两次失败。

第三次尚未进行 treatment，也没有任何有效匹配对，因此 **128 MiB 增量与成对延迟
均未判定**。不能把 control 当前RSS变化说成网关增量，不能宣称平台稳定、无泄漏、
RSS回到基线、故障演练或整体通过。当时I-S03/I-AC03保持未完成，D仍全部未完成，
该次未提交 submitInner，也未进入下一轮。主线程在此负载下的采样间隙是当时的仪器阻塞，不是产品内存超标的证明；
不通过提高覆盖阈值、RSS预算或减少8任务/32读取使其通过。

第三次诊断值（**覆盖无效，仅描述实际收到的样本，非阶段真实峰值或门禁证据**）。
quiet/load/drain 的样本数为30/102/28，边界时长为1804.62/10955.44/1776.57ms。
每格依次为 min / median / max / end，单位 bytes：

| 计数器 | quiet | load | drain |
| --- | --- | --- | --- |
| rss | 241258496 / 241258496 / 241258496 / 241258496 | 201093120 / 218411008 / 241295360 / 214396928 | 214532096 / 214601728 / 214601728 / 214601728 |
| heapUsed | 70472896 / 70485076 / 70495400 / 70495400 | 36427992 / 61415400 / 86836248 / 41384480 | 41727568 / 41742412 / 41752776 / 41752776 |
| heapTotal | 114184192 / 114184192 / 114184192 / 114184192 | 114184192 / 125456384 / 130699264 / 127815680 | 127815680 / 127815680 / 127815680 / 127815680 |
| external | 24121854 / 24121854 / 24121854 / 24121854 | 6067998 / 10237067 / 24122969 / 7196597 | 7198496 / 7198496 / 7198496 / 7198496 |
| arrayBuffers | 19466000 / 19466000 / 19466000 / 19466000 | 1412144 / 5580629 / 19467115 / 2540743 | 2542642 / 2542642 / 2542642 / 2542642 |

rss包括全部Worker；其他计数器仅为服务主线程，arrayBuffers属于external，不求和。
生命周期maxRSS只留诊断。未强制GC；短期下降可能来自GC/allocator，
不能据此作泄漏结论或归因。每次失败均在finally停止自有daemon、等待并发CLI结束、
移除源fixture/CAR/工作目录；第三次诊断增强保证写报告失败也不跳过停止清理。

## v2独立RSS采样与匹配实验

在父级明确批准独立RSS仪器修正后，先将v2源码/计数器/覆盖语义同步至primary
`3e08aef6d3975abe8711109fc8a0754ca9545f5b`，再测量；不是追溯将v1失败改为通过。
固定50ms、2048条、RSS最大间隙250ms、128 MiB增量、8任务/32读取及其他门限均未放宽。
独立采样Worker就绪后才开始两臂相同预热，status异步读取有界历史；RSS为全进程，
heap/external/arrayBuffers仅来自服务主isolate。main诊断间隙如实报告，不插值、
不借Worker的heap填补主isolate样本。所有自有daemon退出时等待采样Worker终止。

本地环境仍为Windows、Node `v26.13.0`；6个独立受管实例，顺序C/T、T/C、C/T，
每实例3个测量波，合计18波144个成功测量任务。三组全部使用同一个任务CAR：
`17809d6b4201279686774d0ad2dd75c2dc134990d4895dad155d947a5ad111d3`。
它们是workspace已构建公开入口测量，不冒充registry安装或独立Ubuntu部署证据；
只有CLI受影响，发布仍由父级另行决定，未改版本或tag。

```powershell
node .silvermoon\ideas\01M75CCXR5TWE63N6QEXV1C720\outer\inner\replay.mjs --consumer packages\task-engine-cli --tree-root . --work .gateway-rss-owned --load yes --report .silvermoon\ideas\01M75CCXR5TWE63N6QEXV1C720\outer\inner\independent-memory-evidence.json
```

完整描述性统计、scope/source、每阶段起止和故障结果见
[independent-memory-evidence.json](independent-memory-evidence.json)。
原始样本只保存一份在同名 `.samples.json.gz`（gzip/UTF-8 JSON，108个窗口，
其中54个RSS窗口共3946样本）；压缩文件105311 bytes，SHA-256：
`84a03bf97d16588160f88cab9e386f7ef98063517a69827f0fc2c30784b37bf2`。
可用Node内置`zlib.gunzipSync(readFileSync(path))`读取；无需额外工具或解压到临时目录。
报告与原始样本关联由 repetition/arm/wave/phase/stream 字段标识，不重复保存大份原始JSON。

所有RSS窗口均通过至少2样本、真实连续序号、边界/相邻最大250ms以及quiet/drain覆盖检查；
实际最坏间隙（含窗口边界）**65.377197265625ms**。main诊断无缺失/非法计数器，
但load间隙最高 **1141.34375ms**，说明不能用繁忙主事件循环定时器作RSS覆盖代理。
arrayBuffers已包含在external，不求和。lifetime maxRSS只留诊断，未参与预算计算。

以下保留全部9个配对（bytes；C/T增长是各自load/drain峰值减quiet中位数，不截零）。
全部差值≤134217728；全部延迟≤max(对应C最大延迟×5,2000ms)，没有挑最好轮次：

| 重复/波 | C增长 | T增长 | T−C | T最大延迟ms | 配对延迟门限ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0/0 | 372736 | 67227648 | 66854912 | 7713.259 | 47874.767 |
| 0/1 | 2842624 | 35360768 | 32518144 | 8624.851 | 46700.476 |
| 0/2 | 163840 | 53334016 | 53170176 | 8838.320 | 43407.323 |
| 1/0 | 688128 | 42778624 | 42090496 | 7574.913 | 46951.486 |
| 1/1 | 93609984 | 56004608 | -37605376 | 7679.230 | 49807.859 |
| 1/2 | 20746240 | 41504768 | 20758528 | 9491.397 | 51854.954 |
| 2/0 | 5914624 | 48025600 | 42110976 | 9091.378 | 46196.753 |
| 2/1 | 91189248 | 37507072 | -53682176 | 10096.109 | 56381.357 |
| 2/2 | 21635072 | 23625728 | 1990656 | 9801.131 | 45160.682 |

每臂三个波次的quiet RSS中位数及drain结束值如下（MiB；精确bytes见报告）：

| 重复/臂 | quiet 0/1/2 | drain end 0/1/2 |
| --- | --- | --- |
| 0/C | 241.31 / 229.20 / 222.18 | 229.12 / 222.04 / 202.61 |
| 0/T | 219.74 / 219.23 / 227.70 | 219.11 / 227.23 / 231.30 |
| 1/T | 222.01 / 224.37 / 228.71 | 224.20 / 228.57 / 238.42 |
| 1/C | 239.18 / 115.55 / 198.26 | 148.74 / 198.11 / 211.81 |
| 2/C | 220.99 / 113.01 / 190.75 | 218.92 / 192.31 / 203.38 |
| 2/T | 222.32 / 237.20 / 232.34 | 237.04 / 253.16 / 223.64 |

这些窗口有可观察的平台，也有GC/allocator阶跃与波间波动；不要求严格回到基线，
不以三波宣称“平台已稳定”或“无泄漏”。负差值原样保留，其本身不证明gateway节省内存。
顺序交替只能缓解而不能消除单机调度/GC顺序偏差。128 MiB只是本有限负载统计回归预算，
不是Node可强制执行的RSS天花板；OS/container硬限额仍在范围外。

两臂都增加相同1个采样Worker。6个实例启动前后观察RSS差为：
C0=9211904、T0=9256960、T1=9527296、C1=9216000、C2=9023488、
T2=9367552 bytes（约8.61–9.09 MiB）；该差值包括初始化期间其他进程分配波动，
不是采样Worker独占内存估算。仪器在quiet基线前已就绪，测量未强制GC。

9个T波均8/8任务成功且32次读取，200/429次数依次为：
24/8、27/5、25/7、28/4、24/8、26/6、27/5、25/7、26/6；
所有实例peakActive=2，C测量任务均0次读取（等量gateway预热不计入测量）。
6个实例abort恢复742.13–810.86ms、带活跃消费者shutdown1021.92–1069.40ms；
缺块/损坏分类、在线GC拒绝、故障后真实任务及离线回收8块/7340312 bytes全部通过。
所有自有工作目录、源fixture、daemon和监听已清理；既有历史v1/Ubuntu证据未删改。

## 仓库验证

本次修订新增内存采样生命周期、有界历史、旧高水位反例、配对数学、真实差值超预算、
缺失/不连续/非法采样覆盖测试，并在现有受管生命周期案例验证认证status能返回遥测、
未认证请求不能读取遥测。focused命令：

```powershell
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test --test-name-pattern "memory sampler|paired replay|independent process RSS|managed installed entry" test\managed.test.ts
```

结果10/10通过，0 fail/skip；包括独立RSS在主线程450ms忙等期间仍实际采样、
主isolate真实诊断间隙、就绪/幂等关闭和scope错误拒绝，不把历史失效采样判成通过。
曾在完整检查中发现Worker继承`--input-type=module`时CommonJS require失败，
改为兼容两种入口的动态import后，既有真实Worker清理失败/受控ENOSPC与独立采样
3项focused复查全部通过，未改测试预期。
最终完整`pnpm check`通过（40/40任务、测试类型检查、格式、包检查），两份replay模块
`node --check`通过；曾在新增认证测试的类型检查阶段发现`json()`为unknown，
补齐测试响应类型后重新运行，不忽略类型错误。

Node22.13 CI超时的有界跟进见
[node22-diagnosis.md](node22-diagnosis.md)：两个预期失败的证明断言保留条件并补齐消息，准确Node22下raw/CAR为19/19通过；完整Windows
Node22
CLI虽不再挂起，但既有诊断文件身份检查失败不计通过。默认Node26完整`pnpm check`重新通过；Linux准确main发布CI仍须父级独立验证。

raw/CAR focused regression：19/19 通过；测试类型检查通过。完整 `pnpm check`
通过（40/40 Turborepo tasks，测试类型检查及全部 package
lint通过）；仓库原有 Linux-only zombie 身份测试在 Windows 正常跳过，与外部套件0
skip区分记录。Silvermoon
worktree/staged 验证随同提交执行；若任何完整检查失败，本阶段不得提交为通过。
