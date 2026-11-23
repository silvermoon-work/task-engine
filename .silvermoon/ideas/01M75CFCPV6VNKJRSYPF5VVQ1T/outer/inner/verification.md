# IPNS record 实施验证

## 固定基线与边界

- [IPNS record specification](https://github.com/ipfs/specs/blob/3000be69497e47c399cdb719440d0809f085388b/src/ipns/ipns-record.md)：SignatureV2、请求名称/公钥绑定、EOL、uint64、10 KiB，任一 Value/SignatureV1 出现时检查 legacy copies。
- [gateway-conformance trustless IPNS](https://github.com/ipfs/gateway-conformance/blob/eaca278518dc977db10bfec4acd79c92c4ee11ac/tests/trustless_gateway_ipns_test.go)：5 个适用 case（V1+V2/V2 × format/Accept，加自定义 Unicode filename）。源码测试保留 max-age=1800 期待；另测临近 EOL clipping。不宣称运行完整动态 IPNS/DNSLink suite。
- [公开 V2 vector](https://github.com/ipfs/gateway-conformance/blob/eaca278518dc977db10bfec4acd79c92c4ee11ac/fixtures/ipns_records/k51qzi5uqu5dit2ku9mutlfgwyz8u730on38kd10m97m36bjt66my99hb6103f_v2.ipns-record)：测试仅保存公开签名 bytes，无 fixture 私钥。
- [Boxo selector](https://github.com/ipfs/boxo/blob/3d6ac39a0f76c824ffbb90e3a729e78f62bc2d12/ipns/validation.go)：sequence 最大，其次 EOL 最晚，完全同序列/到期时原始 bytes 字典序最大。纳秒比较避免 js-ipns selector 的毫秒截断；不对过期 winner 丢失高水位。
- 依赖固定 `ipns@11.0.1`、`@libp2p/crypto@5.2.0`、`@libp2p/peer-id@6.0.18`、`multiformats@14.0.5`；签名与名称算法由这些维护库执行。Protons decode-only adapter 来自 ipns 同版本 generated codec，保留 MIT notice，仅补齐库对部分 legacy fields 的 spec 检查，不自创签名或 wire parser。

只有宿主显式导入/读取；默认 disabled。无公共上传、DNSLink、DHT、IPNS 网络 acquisition、发布或内容解析；递归 block 模式也不改变此边界。离线状态无法证明全局最新，更新不立即撤销客户端仍在有效期内的缓存。

## 数据与资源契约

- 输入：单个非软/硬链接 regular file，1–10240 bytes；先限制再解析/验签。`--key` 是调用方信任锚，不从 record 的 value 反推。Ed25519 必需，RSA 与 libp2p 支持的 secp256k1 可用；CIDv1 libp2p-key 的 base36/base32（含 uppercase）、base58btc 及 legacy base58 peer ID 归一到 base36。
- 实例需先 start/stop，确认释放并持有 `instance.lock` 才能 CLI import。拒绝正在运行的实例；不增加认证上传接口。返回一条标准 stdout JSON 和既有退出码。
- 独立 `ipns.sqlite` schema 1、application_id `0x49504e53`（IPNS），WAL + synchronous FULL；新库的 schema/identity 在一个事务内创建。创建时验证 database/sidecars 为独占 regular files，拒绝未知 schema/identity、有内容的 schema 0 或缺失表，不把其他 SQLite 库当空 store。现有 `tasks.sqlite` schema 不变，无现有 task DB 迁移；旧 CLI 不提供此功能，但不能清除此新库。`data prune --cache` 不删除 IPNS 边界。宿主负责可信目录与备份；替换/恢复整个旧数据库不是可检测的网络回滚。
- 最多 1024 名称、每条 10 KiB，不主动删除过期 winner；这是逻辑记录预算，不是 SQLite 文件/RSS 硬上限。满额拒绝新名称，仍允许更新现有名称。无任意历史堆积或可绕过高水位的自动驱逐。
- 验证完成后才进入同步事务；比较数据库当前 bytes 与验证快照，变化则最多重试 32 次。默认 import 一次最多候选验签 1 次、旧 winner 验签每次重试 1 次；CLI 锁串行化导入。低序列、较差同序列、无效或损坏内容不覆盖。
- HTTP 复用既有 `server.rawGatewayMaxConcurrent`/`server.rawGatewayTimeoutMs`，不新建请求队列。宿主 store 与 HTTP 每次各验签一次，10 KiB 输入内最多两次 SignatureV2 verification；不读 IPFS blocks。已有 gateway hits/misses 仍是 block 指标，不冒充 IPNS freshness。
- max-age 是 `floor(min(TTL, EOL-now)/1s)`，public 或 private，加 must-revalidate；不足一秒为 0。过期/未知为 404（only-if-cached 未命中为 412），无 ETag 和 no-store；失效条件不产生 304。错误格式 406、错误 key/path/query 400，损坏 store 500，不回退旧 winner。
- 未鉴权和 disabled 不读取 store，不泄漏 bytes/ETag。公开 CORS 与 token preflight 沿用原策略；实际 token read 必须鉴权，Cookie credentials 不开放。

## 已执行的源码证据

Windows，Node `v26.13.0`、pnpm `11.22.0`。本节不代表 registry RC 或 Ubuntu 结果。

```powershell
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test --test-concurrency=1 test\ipns.test.ts test\help.test.ts test\raw-gateway.test.ts test\car-gateway.test.ts test\recursive-gateway.test.ts
pnpm --filter @silvermoon-work/task-engine-cli typecheck
pnpm --filter @silvermoon-work/task-engine-cli build
pnpm check
```

聚焦 runner 38 项通过；完整 `pnpm check` 通过，非重写合并 concurrent main 后再次全部通过（Turbo 40/40、CLI 90 项中 89 pass/0 fail/1 已有 Linux-only zombie skip，测试类型检查与 package lint 通过；合并前 CLI 为 87 项）。IPNS 覆盖字段/签名/名称、RSA、公有 V2、全排序与纳秒 tie、逆序并发更新、重开、过期高水位、配额和损坏。Linux-only 软链接用例需由父任务 Ubuntu runner 执行，未计作 Windows 已测。测试时间依赖注入，不修改 Date.now，也不等待到期。

本地源码回放：

```powershell
pnpm --filter @silvermoon-work/task-engine-cli exec node ..\..\.silvermoon\ideas\01M75CFCPV6VNKJRSYPF5VVQ1T\outer\inner\replay.mjs --expected-version 0.2.0-rc.7 --source --kubo D:\Code\task-engine\.cache\ipns-kubo-verifier-7\kubo\ipfs.exe
```

结果 `ok:true, mode:source-local`；Kubo `0.43.1` 的 5 项检查通过：原记录、错名、签名篡改、HTTP 原始响应和真实过期。Kubo 实验性 inspect 的 exit 0 **不代表**有效，脚本必须断言 JSON `Validation.Valid`。工具来自该版本官方 GitHub release，先核对 SHA-512；仅 inspect，不 init、不联网发布，无私钥落盘。此命令中的独立工具已在完成后移除，重新回放须自行提供 Kubo 路径。

`replay.mjs` 冻结：命令 45000 ms、HTTP 5000 ms、gateway 并发 2/时限 5000 ms、真实短寿命 15000 ms、到期等候最多 20000 ms。测试错名/篡改/低序列拒绝、运行中 import 拒绝、默认禁用、原始 bytes、GET/HEAD/Accept/304/CORS、更新、restart、期限 clipping、到期不返回 200/304、过期新版仍阻止旧版、再导入更高序列恢复。生成的私钥只在进程内；只写公共 record 文件。finally 经 CLI stop 释放独立实例，再删除全部自有目录；停止失败时保留目录并失败，不误报清理成功。

## 父任务的公开 registry / Ubuntu 回放

发布候选版本由父任务决定。下面 `0.2.0-rc.8` 是本轮预期独立 CLI RC，**仅在父任务实际发布该准确版本后**执行；不是发布授权或已经发布的声明。不需要发布其他 workspace：新增依赖为外部 catalog，现有 runtime Engine/Protocol 和 dev Builder/Builder CLI/SDK 的已发布版本仍受 release verifier 检查。

本轮只修改 publishable `task-engine-cli`，不改版本。按所有 dependency 字段计算前置顺序：`task-protocol → task-sdk → task-builder → task-builder-cli → task-engine → task-engine-cli`；前五者均为 `0.2.0-rc.0`，CLI 源码 manifest 保持 `0.2.0-rc.7`。CLI 的 runtime 是 Engine/Protocol，dev 是 Builder/Builder CLI/SDK；Engine 的 dev edge 也要求 Builder CLI 先可用。父任务只需验证这些准确前置版本已在 registry，不能自动重发它们。

Ubuntu consumer（在新建的自有目录运行；Kubo 路径替换为已核实的 `0.43.1` executable）：

```sh
REPLAY="$PWD/.silvermoon/ideas/01M75CFCPV6VNKJRSYPF5VVQ1T/outer/inner/replay.mjs"
mkdir -p .cache/gateway07-consumer
cd .cache/gateway07-consumer
npm init -y
npm install --ignore-scripts --save-exact @silvermoon-work/task-engine-cli@0.2.0-rc.8 ipns@11.0.1 @libp2p/crypto@5.2.0 @libp2p/peer-id@6.0.18 multiformats@14.0.5
node "$REPLAY" --expected-version 0.2.0-rc.8 --kubo /absolute/path/to/ipfs
```

不得加 `--source`；脚本核对准确 CLI 版本，且 CLI 必须来自 consumer 的 node_modules，独立 verifier 依赖也从该 consumer 解析，不偷用 monorepo 路径。需要保存的仅是输出 JSON；不要保存私钥、实例 token、完整实例目录或临时工具。父任务单独验收 registry 依赖图、Ubuntu、token/CORS、原 raw/CAR/recursive、外层 TLS/浏览器与清理，不在本轮 Inner 中冒认这些结果。
