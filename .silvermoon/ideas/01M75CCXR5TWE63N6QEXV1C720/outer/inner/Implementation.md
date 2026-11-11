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
  RSS 相对热身后基线增长不超过 **128 MiB**；断开、超时或 shutdown 后
  **3000 ms** 内 active 归零并可继续执行任务/读取（shutdown 本身除外）。
  不在失败后放宽门限；真实浏览器由父级使用同一 fixture 独立验证。
- HTTP listener、连接总额和事件循环仍共享；此预算不是恶意租户的硬隔离。

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

达到契约中预先固定的数值负载后，任务延迟退化、RSS、并发上限和结束回收时限均达标；故障指标可区分缺块与存储错误，`pnpm check` 通过。

结果：8个真实 Worker 与32次1MiB读取共载成功；peakActive=2，6次429，
最大任务延迟2780.2943ms（门限4510.577ms），RSS增长94818304 bytes，abort回收779.1579ms，
活跃消费者下停止1084.0202ms。故障快照分开记录misses/storageErrors/cancellations，
在线GC拒绝、离线GC实际回收8块；19项focused回归、测试类型检查与完整`pnpm check`
通过。详细数值、共享资源局限及公开包回放命令见同目录验证文件。
