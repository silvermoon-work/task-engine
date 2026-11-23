# Implementation

本轮只交付签名 IPNS record，不解析或发布其指向内容。[验证与回放](verification.md) 固定规范、预算、测试、独立验签和公开 registry consumer 命令。新鲜度只能基于有效期与已见记录；不保证全局最新，也不能立即撤销客户端已缓存且尚未到期的记录。

## Steps

### I-S01: 建立签名记录来源与存储

提供宿主拥有的 `IpnsRecords.import/read` 与 `IpnsRecordSource` 端口；standalone CLI 使用 `data import-ipns --key --record --data-dir`，只接受一个显式本地文件，实例须停止且释放确认，并持有同一实例锁。无公共 HTTP 上传、DHT、自动发现、IPNS 网络来源、DNSLink 或发布。

名称由 libp2p/multiformats 库规范化；`ipns@11.0.1` 负责 SignatureV2、公钥和请求名称绑定。DAG-CBOR 库与 upstream Protons codec 补充必填字段、uint64、RFC3339 和任一 legacy copy 出现时的一致性检查。单条最多 10 KiB，最多 1024 名称；超限不驱逐回滚边界。独立 `ipns.sqlite` schema 1 保存原始 bytes，不进入 IPFS blockstore，也不改变现有 task DB。拒绝未知格式、损坏、软/硬链接文件；验证后用 SQLite 事务与快照比较原子选择 winner。按 sequence、纳秒 EOL、原始 bytes 字典序择优；过期 winner 仍保留并验签，重启不能用旧序列覆盖。

### I-S02: 实现 IPNS record HTTP 契约

提供精确 `/ipns/{key}` GET/HEAD、`format=ipns-record` 和 `Accept: application/vnd.ipfs.ipns-record` 协商，查询 format 优先。返回验证后的原始 bytes、attachment、强 ETag、Content-Length、条件请求和规范名称头，不把解析 CID 冒充证明。HEAD 不含 body。Cache-Control 的 max-age 为 TTL 与剩余 EOL 较小值的向下取整秒数，并带 must-revalidate；过期或未命中不返回 200/304。未知名称/格式/路径变体明确失败。

复用默认禁用、public/token、CORS、请求并发和超时策略；鉴权在任何记录读取之前。递归 IPFS block 模式不授予 IPNS acquisition 能力。记录读取端口返回 bytes 后 HTTP 层再次验签和检查到期，不信任外部 adapter 的元数据。

### I-S03: 验证更新和兼容性

测试使用注入时间推进到期，不修改全局时钟或依赖 sleep；签名私钥只在内存生成。覆盖错名/篡改/恶意已签字段、RSA、标准 key aliases、相同序列全部排序规则、并发导入、持久重启、过期更新边界、文件/库损坏和配额。适配 upstream trustless IPNS 的 5 个适用 HTTP case，加入 public V2 vector、GET/HEAD/304/cache/CORS/token/disabled 及 raw/CAR/recursive 回归，执行测试类型检查与 `pnpm check`。

独立回放只使用 CLI 离线导入与 HTTP：published IPNS 库从请求 key 验证响应，Kubo `name inspect --verify` 单独检验正确、错名、篡改和过期；固定真实 15 秒短寿命、最多 20 秒等候，不修改服务端时钟。源码本地证据与后续 registry/Ubuntu 验收严格分开。

## Acceptance criteria

### I-AC01: 独立验签与名称绑定成立

客户端使用请求的 IPNS key，而不是服务端解析结果，独立验签、名称绑定和有效期；正确记录通过，错名、篡改和无效签名失败，响应 bytes 与输入完全相同。通过 `test/ipns.test.ts` 与 [固定独立回放](verification.md) 证明；不得将未执行的 registry/Ubuntu 验收算作本轮源码结果。

### I-AC02: 过期和回滚规则持久生效

可控时间测试到期、TTL/EOL clipping 和过期条件请求；真实短寿命回放验证同一行为。先见新序列后，旧记录及较差的同序列记录不能覆盖；重启及较新记录过期后边界仍在，并发导入保持最高 winner。以签名输入、数据库重开及 CLI restart/rollback 测试证明。

### I-AC03: HTTP 能力与原网关兼容

GET/HEAD、格式协商、attachment/ETag、未命中、期限、CORS、token/禁用策略与 5 个适用 trustless IPNS case 通过；原 raw/CAR/recursive 测试、测试类型检查和 `pnpm check` 通过。验证说明列出准确命令、冻结预算、局限与清理结果；外层发布和 Ubuntu 部署仍由父任务独立验收。
