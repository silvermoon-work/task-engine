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

Suite 配置自动选 4096 blocks；负载配置始终 128
blocks。两类验证应使用不同自有实例。fixture
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

## 固定预算下的实测

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

## 仓库验证

Node22.13 CI超时的有界跟进见
[node22-diagnosis.md](node22-diagnosis.md)：两个预期失败的证明断言保留条件并补齐消息，准确Node22下raw/CAR为19/19通过；完整Windows
Node22
CLI虽不再挂起，但既有诊断文件身份检查失败不计通过。默认Node26完整`pnpm check`重新通过；Linux准确main发布CI仍须父级独立验证。

raw/CAR focused regression：19/19 通过；测试类型检查通过。完整 `pnpm check`
通过（40/40 Turborepo tasks，测试类型检查及全部 package
lint通过）；仓库原有 Linux-only zombie 身份测试在 Windows 正常跳过，与外部套件0
skip区分记录。Silvermoon
worktree/staged 验证随同提交执行；若任何完整检查失败，本阶段不得提交为通过。
