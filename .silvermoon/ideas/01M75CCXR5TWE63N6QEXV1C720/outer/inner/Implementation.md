# Implementation

本阶段验证已有承诺，不引入递归回源、IPNS 或网站托管。

## 固定验证契约（测量前冻结）

- 外部套件：`ipfs/gateway-conformance v0.14.1`，commit
  `011d20bd61c4736e3301d35e8fe388773e492511`；该稳定版本覆盖 PBNode 两种字段顺序、
  raw、CAR scope、范围与表示协商。规范参考固定为 `ipfs/specs`
  `3000be69497e47c399cdb719440d0809f085388b`。
- 选择器固定为 `--specs trustless-block-gateway,trustless-car-gateway,trustless-car-gateway-optional,path-unixfs-gateway`
  和 `-run '^(TestTrustless.*|TestCors)$'`；不使用 `-skip`。
  全部 trustless raw（含 Range 的合法完整响应）、PBNode 原字节和 CAR/partial
  测试均适用。CORS 属于所有 HTTP 表示，额外纳入独立测试。
- 排除 deserialized UnixFS/JSON/CBOR/TAR 网站表示、raw 子路径解析、网站跳转、
  subdomain、proxy、DNSLink 和 IPNS：当前产品只承诺根 raw 与 CAR 路径证明，
  不承诺这些表示或命名系统。未知 codec/hash 和 CAR v2 明确不支持。
  此理由在执行前确定；不能因失败改选测试或将适用失败归为跳过。
- fixtures 取同一 commit 内嵌 CAR，不用外部可变内容；校验清单和逐项结果写入
  [verification.md](verification.md)。测试工具只放操作自有目录，结束后删除。
- 固定共载预算：网关并发上限 **2**，块上限 **2 MiB**，CAR 上限 **8 MiB**，
  遍历上限 **128 blocks**，请求时限 **1000 ms**；**8 个**并发客户端，
  **32 次**读取同一个 **1 MiB** raw block，同时执行 **8 个**真实任务；
  另测 **2 个暂停读取的消费者**、主动断开、shutdown、缺块、损坏缓存与 GC。
- 数值门限：观测活跃网关请求不超过 **2**；过载必须出现 **429**；
  负载期间所有 **8 个任务成功**且返回验证过的结果；
  共载任务最大延迟不超过 **max(基线最大延迟 × 5, 2000 ms)**；
  成对采样阶段增长差不超过 **128 MiB**（有限工作负载实验预算，不是 RSS 硬上限）；断开、超时或 shutdown 后
  **3000 ms** 内 active 归零并可继续执行任务/读取（shutdown 本身除外）。
  不在失败后放宽门限；真实浏览器由父级使用同一 fixture 独立验证。
- HTTP listener、连接总额和事件循环仍共享；此预算不是恶意租户的硬隔离。

### 修订后的内存实验协议（执行前冻结）

旧 `lifetime maxRSS - phase current RSS` 混合不同时间范围，也包含 Worker 启动，
历史通过和 Ubuntu 两次失败均保留，但不能证明网关增量或内存泄漏，I-S03/I-AC03
重开。理想世界、128 MiB 数值与其他预算不变。不优化产品或提高阈值来迎合测量。

固定 3 个独立匹配重复，每对新建 task-only control 与 task+gateway treatment
受管进程，顺序 C/T、T/C、C/T。Node、配置、fixture、任务代码/CAR、8 并发、
输入 value/headers、文件预热与 Worker 预热相同；唯一测量负载差异是 input.gateway
启用32次读取。两臂均先读取同一1 MiB文件，串行执行1个带网关读取任务使包/输出
文件缓存就绪，再串行执行1个无网关读取任务、运行一波8个带网关读取的任务作等量预热，
不计为测量。每臂此后固定3波，均为8个真实任务，treatment 每波32次读取；
control 每波0次。每波 quiet 1000ms、load 到8任务释放、drain 1000ms，
由已有身份校验的 managed status 确认 phase 边界，禁止强制 GC。

当前协议v2：独立、明确就绪且unref的1个采样Worker每50ms实际调用
`process.memoryUsage.rss()`，与工作负载主事件循环独立；两臂均额外使用相同采样Worker，
初始化完成后才预热/测量。服务主线程另每50ms采集heapUsed/heapTotal/external/
arrayBuffers作为main-isolate诊断，不把采样Worker自身heap误称主线程heap。
两流各最多保留2048条（约102秒）；每阶段通过现有认证status异步复制有界历史，
无高频CLI采样进程、无新未认证路由。RSS每个窗口至少2样本，quiet/drain至少1000ms，
样本覆盖至少750ms；任意相邻/边界间隙不得超过250ms，序号连续，数值有限正整数；
缺失、覆盖不足或截断必须失败。main流保留真实时间/间隙/缺失和非法样本诊断，
不以主线程定时器的250ms覆盖作为RSS代理；不插值、不补造或借邻近数值填充。
原始窗口样本与每计数器 min/median/max/end 均留存。
RSS是进程（含全部Worker）指标，其余是调用主线程指标；arrayBuffers已包含在external，
禁止叠加，lifetime maxRSS仅诊断。

每波增长 = max(load RSS峰值, drain RSS峰值) - 本波quiet RSS中位数，保留负值，
不截零、不挑最好一轮。按重复/波次逐项匹配，全部9个 treatment增长-control增长
必须 ≤134217728 bytes；延迟逐波按对应control最大值判定原5倍/2000ms门限。
报告所有配对值、quiet/drain平台与线程计数器；短期3波不是无泄漏证明，不要求
RSS严格回到基线，GC/allocator及单机顺序偏差须明确。OS/container硬内存上限不在范围。
采样Worker明确异步关闭并等待终止；报告初始化前后RSS和差值以描述其观察开销，
该差值不是隔离归因。此v2在重测前同步；旧主线程RSS采样v1及其两次覆盖失败保留，
它们是仪器与繁忙主线程耦合造成的测量阻塞，不是已证明的产品内存阻塞，不追溯改判。

## Node 22.13 发布检查补充

父级在准确提交 `676e2bdd7011b455bc016f541df66e26abce4ecc` 发现两次15分钟CI超时，
Node24通过。仅补齐两个故意失败的证明断言消息，避免Node22在tsx映射调用位置提取
隐式断言消息时递归卡住；保持原断言、全部测试、CI时限、资源门限与生产代码不变。
诊断与复核边界见 [node22-diagnosis.md](node22-diagnosis.md)。
准确Windows Node22的raw/CAR为19/19通过；完整CLI不再挂起，但暴露未改动的旧诊断文件
身份检查失败，不声称其全绿或绕过该失败。Linux准确main CI仍由父级独立验证后决定发布。

## Steps

### I-S01: 固定规范与一致性测试矩阵

固定 ipfs/specs 和 gateway-conformance 提交、fixtures 与适用测试选择；为每个排除项说明协议范围理由，避免通过改选择器隐藏已声明能力的失败。

### I-S02: 补齐 HTTP 及客户端兼容性

按矩阵修复 raw/CAR 的协商、ETag/缓存、HEAD、状态码、路径转义、Content-Disposition 和浏览器 CORS/暴露头；保持原始 block bytes 和流式失败语义。

### I-S03: 验证资源隔离与运维契约

完善命中/缺块/输出量/失败/活跃请求指标；对慢客户端、断连、磁盘故障和 GC 并发建立故障测试。压测前固定并发、内存、回收时限及任务延迟退化的数值阈值，更新文档并运行 `pnpm check`。

## Acceptance criteria

### I-AC01: 声明能力通过外部一致性测试

适用的固定版本测试全部通过；报告保存版本、测试清单、结果及排除原因，原本适用的失败不得重分类成跳过。

结果：固定选择器的11个顶层测试、503个报告 pass 节点均通过，0 fail/skip。
全部逐项检查、30份内嵌 CAR 的 SHA256、原始失败项和复查过程见
[verification.md](verification.md) 与 [evidence.json](evidence.json)。
完整 HAMT fixture 使用已有可配置的4096-block预算；默认/共载128-block门限未提高。

### I-AC02: HTTP 与浏览器行为可重现

独立 HTTP 客户端及真实浏览器验证缓存再验证、特殊路径、CORS、HEAD 和失败行为；测试同时校验 headers 与实际内容。

结果：独立 Node/Go HTTP 客户端与真实 integrated Chromium/Electron 已验证 public/token
跨源原字节、HEAD/304、编码 CID/文件名、Accept 优先级、CAR 和凭证隔离。
`browser.html` 提供带断言的同 fixture 重放；父级仍可针对 registry 安装/部署独立复核，
本阶段不代替外层门禁或发布。

### I-AC03: 网关压力不破坏任务服务

达到契约中预先固定的数值负载后，成对延迟和当前RSS阶段增长差、采样覆盖、并发上限和结束回收时限均达标；故障指标可区分缺块与存储错误，`pnpm check` 通过。

历史旧口径结果（不能作为修订后内存标准的通过证据）：8个真实 Worker 与32次1MiB读取共载成功；peakActive=2，6次429，
最大任务延迟2780.2943ms（门限4510.577ms），RSS增长94818304 bytes，abort回收779.1579ms，
活跃消费者下停止1084.0202ms。故障快照分开记录misses/storageErrors/cancellations，
在线GC拒绝、离线GC实际回收8块；19项focused回归、测试类型检查与完整`pnpm check`
通过。详细数值、共享资源局限及公开包回放命令见同目录验证文件。

当前v2结果：固定3个匹配重复、每臂3波共18波均完成，9个配对差值全部≤128 MiB，
最大差值66,854,912 bytes；3946个独立RSS样本的最大间隙65.3772ms，
主线程诊断间隙最大1141.3438ms如实保留而不作为RSS代理。
全部共载波8任务成功、32次读取且有429、peakActive≤2；全部成对延迟与
abort/shutdown 3000ms门限通过。采样Worker在两臂均计入RSS和相同预热，
启动前后RSS差观察范围9,023,488–9,527,296 bytes，不能视为精确独占开销。
原v1失败保留，不追溯改判；本次短期实验不是无泄漏或RSS硬上限证明，外层仍未验收。
全部配对、quiet/drain和主isolate诊断、压缩原始样本与检查见
[verification.md](verification.md#v2独立rss采样与匹配实验)。
