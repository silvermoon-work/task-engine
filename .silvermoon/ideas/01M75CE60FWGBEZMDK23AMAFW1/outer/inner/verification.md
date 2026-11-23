# 迭代 6：受控递归实现验证

## 固定边界（先于测量）

只改 CLI 宿主；Engine 的任务 acquisition、ideal、IPNS、独立 RSS sampler 和产品 raw/CAR
默认值不变。新配置 `gatewayMode=local`；只有显式 recursive 与批准的上游才回源。
生产 acquisition 默认并发 2、累计接收 2097152 bytes、总时限 5000ms、单次 2000ms；
无排队，最多两个固定 origin，每个只尝试一次，递归四跳。原有 raw 请求默认并发仍为 4。

定向 runner 冻结：并发 2、累计接收 1024 bytes、总时限 400ms、单次 150ms
（独立总时限案例固定为 40ms，以证明先于单次截止）；
自身/A/B 最多三次 HTTP 请求、小于 1000ms。HTTP 测试 admission 16 只为同时验证等待者
和协议拒绝，不是产品默认或 acquisition slot 的变化。

公开回放冻结：HTTP admission 16、acquisition 并发 2、累计接收 1024 bytes、
总时限 2000ms、单次 1500ms；24 个不同 CID 故障请求，至多两个回源、
A/B 最多三次请求且小于 2500ms、真实任务小于 30000ms。
脚本内 `Object.freeze` 固定这些参数；结果只报告测量，不自动调整预算。

## 机制与限制

- `raw-gateway.ts` 在 access/auth 后决定 local 或 recursive capability；only-if-cached
  直接 local，包含 CAR 所有后代，绝不 wait/join。身份内联块无需回源。
- `recursive-gateway.ts` 只构造 allowlist origin + canonical CID + format=raw；
  不接受请求 URL/gateway hints，拒绝全部 redirect、凭证及非 raw/压缩响应。
  origin 的普通 DNS 解析由运维批准域名负责，不做 DNSLink/DHT/Bitswap/discovery。
- 既有 `createIpfsGatewayClient` 不能传递每实例 loop header，也不提供这组累计 bytes/
  concurrency 控制；因此不盲调 `block.get`。使用 Node 维护的 fetch/AbortSignal transport，
  复用既有 `verifyBlock`、`DiskContent.local/put`、原子写入以及 raw/CAR 路由。
- 先校验本地，只有 ENOENT 回源；接收跨尝试累计限额，SHA2-256 后校验，再检查取消，
  原子 rename 前再检查取消。无效 bytes 不缓存；存储失败原样暴露、不进行上游 fallback。
- CIDv1 规范键的有界在途 map 只保留 active acquisition。单个等待者取消不会取消其他人；
  最后一个离开才 abort。不同 hop 限制不 join；随机实例 ID 自身检测在 join 之前，
  invalid/重复/耗尽 header fail closed。攻击者最多限制自己的回源，不能扩展目标或预算。
- 关闭拒绝新 acquisition、abort 所属请求、等待 release；清理异常或一个 acquisition 总预算
  内仍无法确认释放则明确报错。不是任意文件系统或操作系统强制终止保证。
- `gateway.recursive` 与本地 storageErrors 分开。bytes 为成功获取/缓存 bytes；
  并发与限制也覆盖失败响应，但不是 RSS 硬上限。网络 chunk 检测可能持有一个额外 chunk。
- 上游 bearer 凭证、路径前缀、自动发现、任意 URL、IPNS 不在本轮范围。
  HTTP listener、事件循环、磁盘仍由宿主共享，不宣称恶意多租户隔离。

## 本地验证

```powershell
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test --test-concurrency=1 test\recursive-gateway.test.ts test\raw-gateway.test.ts test\car-gateway.test.ts
pnpm typecheck:tests
pnpm --filter @silvermoon-work/task-engine-cli typecheck
pnpm check
```

公开入口烟测（使用工作区链接的构建，不冒充已发布 RC 或独立 Ubuntu）：

```powershell
node .silvermoon\ideas\01M75CE60FWGBEZMDK23AMAFW1\outer\inner\replay.mjs --consumer packages\task-engine-cli --tree-root . --work .cache\recursive-replay-owned --report .cache\recursive-replay-report.json
```

Node v26.13.0 / Windows 源码构建烟测：cold/warm 合计回源 1；两个共享等待者与在途
only-if-cached 验证成功；持久重开且上游不可用后 bytes 一致。24 个 stall 请求为两个 502、
22 个 429，upstream 2、peak acquisition 2、结束 active 0；
真实 Builder 任务 succeeded/value=42，1555.24ms。A/B 为 3 次 HTTP 请求、23.28ms。
脚本 finally 已停止全部 owned managed 实例、关闭 Node listener 并删除任务源/工作目录。
最终定向 raw/CAR/recursive 共 29 个测试通过，CLI 与测试类型检查通过，`pnpm check`
退出 0（包含所有 workspace lint/typecheck/test/build、release tests 及 publint）。
正常取消持久化不会毒化 managed storage health；一次初始全量发现配置项数量断言需随六个新增
配置更新，修正为 28 后完整重跑通过。不把这些源码烟测称为外部发布验证。

本轮只需发布 `@silvermoon-work/task-engine-cli`，未改 manifest/version/lockfile。
其内部 runtime 依赖 `task-engine`、`task-protocol`，dev 依赖 `task-builder`、
`task-builder-cli`、`task-sdk` 均为 `0.2.0-rc.0`；五个 exact-version npm lookup 已确认可见。
第三方依赖不变，不需要为了本轮批量发布依赖。

## 独立已安装公共包回放（交父代理）

在仓库外新建自有 consumer；精确安装候选 CLI 与已经发布的 Builder（不要用 workspace、
源码替换或导入内部模块）。CLI 候选版本由父代理发布时确定；本轮预期 `0.2.0-rc.7`，
不可在未发布前把它当作可用版本。依赖包括公开 Builder、Builder CLI、SDK：

```powershell
npm init -y
npm install --save-exact @silvermoon-work/task-engine-cli@0.2.0-rc.7 @silvermoon-work/task-builder@0.2.0-rc.0 @silvermoon-work/task-builder-cli@0.2.0-rc.0 @silvermoon-work/task-sdk@0.2.0-rc.0
node D:\Code\task-engine\.silvermoon\ideas\01M75CE60FWGBEZMDK23AMAFW1\outer\inner\replay.mjs --consumer . --work .\recursive-proof --report .\recursive-report.json
```

本轮已用 npm exact-version lookup 确认三个 Builder/SDK `0.2.0-rc.0` 均已发布；
CLI `rc.7` 尚待父代理发布，不能使用 `latest`（当前 Builder/SDK latest 为 `0.1.0`）。
Ubuntu 同一脚本/参数，通过该主机的正常路径传递脚本。
`--work` 必须不存在，且是自有普通目录；脚本隔离 HOME/USERPROFILE/LOCALAPPDATA、数据目录、
端口，成功/失败均清理自有源文件和监听，清理失败明确报错并保留未释放实例目录。
report 应放在 work 外。已安装平铺 consumer 不需要 `--tree-root`；
该参数仅为 workspace 链接烟测扩大受控文件树边界，不应用于独立 RC 证明。

脚本不发布、不改版本、不接受 gate、不部署、不改变 RSS 测量方法；发布与 Ubuntu
冷暖、环路、真实任务以及独立内存/清理证据由 Outer 记录。
