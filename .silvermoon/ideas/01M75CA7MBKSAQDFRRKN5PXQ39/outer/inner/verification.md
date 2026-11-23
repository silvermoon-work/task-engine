# DAG scope 实现证据与独立消费者输入

## 支持矩阵与一致性

规范基线保持 ipfs/specs `3000be69497e47c399cdb719440d0809f085388b`。
所有范围包含请求根与必要路径证明，终点 `block` 只包含自身；
缺省与 `all` 相同，完整遍历连续终点 DAG。`entity` 的 UnixFS file/raw
遍历完整文件内容 DAG，普通目录停止于目录本身，HAMT 只遍历枚举所需子分片，
非 UnixFS 停止于终点 block。普通 IPFS 数据不套用 Task bundle schema。

| codec / hash | 行为 |
| --- | --- |
| raw `0x55` | 无 links；三种 scope 的终点集合相同 |
| DAG-PB `0x70` | all 遍历完整 Links，按原顺序；一般 Data 不要求 UnixFS |
| DAG-CBOR `0x71` | all 遍历 CID 值；array 顺序、canonical map key 编码顺序（避免 JS 整数字段枚举顺序干扰）；entity 等同 block |
| UnixFS | 维护中的 ipfs-unixfs 解析元数据，exporter/walkPath 解析路径；entity 文件递归包含内容块，HAMT 支持 fanout=256/hash=0x22；symlink/metadata 不跟随、只返回自身 |
| SHA2-256 / identity，CIDv0/v1 | 验证原始 bytes；identity 虚拟块不查本地、不输出，但 all 中的 links 仍需遍历 |
| 未声明 codec/hash | 明确 501，不跳过；坏 hash 或损坏编码失败；entity-bytes/未知 scope 400 |

子 DAG 非递归 DFS，首次访问去重；深度最多 64 条边，CBOR 容器嵌套最多 64 层。
既有 MaxBlocks 同时限制读取次数、唯一访问（含 identity）、输出 CID 集和 frontier
（含重复 links）；MaxBytes 分别限制累计读取与含 framing 的 CAR 输出。
宽 DAG 可先于唯一块数达到 frontier 上限，需显式调高预算。内存包括当前 bytes、
codec 解码对象、有界 frontier/CID 集、socket/writer 缓冲，以及 exporter 的路径状态；
不是逐字节 RSS 限额或多租户隔离承诺。不缓存整份响应、不预取 payload。

一致性是逐块、非 pin/非快照：已验证并发出的块随后被 GC 删除不影响该响应；
任何尚未读取的必需后代被删除则失败。GET headers 后的失败销毁 HTTP，不能正常结束
部分 CAR；HEAD/If-None-Match 在 headers 前完成整个 scope 的存在性/hash/预算预检，
不得为不完整集合返回成功/304。检查成功不保证后续 GET 或本地 pin。
客户端必须同时要求 HTTP 完整结束及请求根/路径/scope 的完整性，
不能只因部分 CAR 可解析就接受。没有回源能力，only-if-cached 缺块仍为 412。

## 测试与证据索引

`packages/task-engine-cli/test/car-gateway.test.ts` 与 raw 回归：

- 手工创建多层 UnixFS 文件（共享 raw 叶）；固定顺序为 root/file/branch/a/b，
  独立 exporter 只使用返回 CAR 恢复完整 bytes。block/entity/all/default 分别比对
  手工 CID 序列、读取次数、ETag；普通目录 entity 不读任何子文件。
- importer 创建 500 个文件的真实 HAMT；独立 exporter 枚举实际读出的全部 shards
  为预期集合，并只使用 entity CAR 再次枚举所有名称。all 包含完整 fixture 集合。
- 独立构造一般 DAG-CBOR 与非 UnixFS DAG-PB、共享 leaf、内联 identity-CBOR
  后代、整数字段名称；手工预期顺序并比较原始 bytes。不使用产品遍历函数作 oracle。
- 未知 codec/hash 及 identity 后的未知 codec：HEAD 为 501，GET body 传输失败。
- 读取分支时删除尚未读取叶子模拟并发 prune；GET 拒绝，条件请求及 HEAD 不成功，
  only-if-cached 仍为 412。真实 DiskContent 仅放证明块，entity/all 缺载荷时
  计数 HTTP 上游仍为零。原有可解析删块/错根/篡改路径负例保留。
- scope all 下取消、超时、shutdown、慢接收 backpressure、并发 slot 释放，
  累计 bytes、framing、block/frontier、深度预算；raw 与显式 block 回归保留。

验证环境 Windows / Node.js 26.13.0 / pnpm 11.22.0；不改变最低 Node 22.13。
执行：

```powershell
pnpm exec tsx --test --test-concurrency=1 packages\task-engine-cli\test\car-gateway.test.ts packages\task-engine-cli\test\raw-gateway.test.ts
pnpm typecheck:tests
pnpm check
```

聚焦 CAR/raw 13/13 通过，标准测试类型检查通过，`pnpm check` 退出 0：
全 workspace lint/typecheck/test/build、发布守卫、测试类型检查与 publint 成功；
CLI suite 62 项，61 通过、1 项 Linux-only 在 Windows 跳过、0 失败。
仅有既有 lint warning/private app publint suggestion，无错误。
fixture/seed 工具本地 smoke 通过：16384 bytes 多层文件、500 项 HAMT/146 shards、
746 个经过 hash 校验的缓存块；该 smoke 不冒充 registry/Ubuntu/Kubo 验证。
所有测试目录、载荷、listener、受管子进程由测试 teardown 或 owned-path finally 清理，
不保留大 CAR/逐次日志。根目录与包内未残留本轮 fixture 目录。

新增直接 catalog 依赖 `@ipld/dag-cbor@10.0.2`、`ipfs-unixfs@13.1.2`
（原 lock 已有传递依赖）；仅影响发布包 `@silvermoon-work/task-engine-cli`。
Engine/Protocol/Builder 没有源码或 manifest 变化，不需为本轮单独发布。
不改版本、不创建 release tag、不发布、不 SSH、不接受门禁。

## Registry 安装消费者与 Kubo 复核输入

这是交给父级的独立复核输入，不代表已完成 Ubuntu 部署。先按父级 Deployment
选择的新 RC 安装；不得把仓库 dist/源码或本轮测试产物当作安装消费者。

在专用、可删除的消费者目录执行（以下为 Ubuntu shell 示例）：

```sh
npm init -y
npm install --save-exact @silvermoon-work/task-engine-cli@<父级确定的新RC>
npm install --save-exact @ipld/car@5.4.6 @ipld/dag-cbor@10.0.2 multiformats@14.0.5 ipfs-unixfs-importer@17.1.1 ipfs-unixfs-exporter@16.2.3
```

将本目录的 `fixtures.mjs`、`seed-cache.mjs` 复制到该消费者目录（它们仅依赖
registry 公共包，不导入产品内部模块）。`node fixtures.mjs` 创建
`scope-fixture/fixture.car`、完整文件 bytes 和 manifest：
多层文件、真实 500 项 HAMT、一般 CBOR + identity + 共享 leaf。
manifest 中 fileSha256/fileBytes、hamtShards/names 与 genericAll 是独立预期。

使用独立配置根、端口和 data-dir；按 CLI help 选择 `--data-dir` 等全局选项：

```sh
npx task-engine config set server.rawGatewayAccess public
npx task-engine config set server.carGatewayMaxBlocks 4096
npx task-engine server start --data-dir "$PWD/engine-data" --port 18787
npx task-engine server stop --data-dir "$PWD/engine-data"
node seed-cache.mjs "$PWD/engine-data"
npx task-engine server start --data-dir "$PWD/engine-data" --port 18787
```

seed-cache 是明确的**离线 fixture 维护操作**，不是产品导入接口；只向已经停止、
新建的专用 managed 实例 `blocks/<CIDv1>` 写入逐块 SHA2-256 校验的数据。
无需通过任务接口导入非 Task DAG，也不配置公共回源。只使用此次自有目录；
若父级使用显式计数 HTTP 上游，其命中/缺块/only-if-cached 总计必须为零。

读取 manifest 取得 `$FILE/$HAMT/$GENERIC` 后，对每个根请求
`?format=car&dag-scope=block|entity|all` 以及省略 scope：

```sh
curl --fail-with-body "http://127.0.0.1:18787/ipfs/$FILE?format=car&dag-scope=entity" -o file.car
curl --fail-with-body "http://127.0.0.1:18787/ipfs/$HAMT?format=car&dag-scope=entity" -o hamt.car
curl --fail-with-body "http://127.0.0.1:18787/ipfs/$GENERIC?format=car" -o generic.car
```

**分别**初始化空的隔离 Kubo repo，禁止网络补块（不启动 daemon，
`ipfs --offline`；配置 `Bootstrap=[]`），不要先导入完整 fixture 再验证子集：

```sh
export IPFS_PATH="$PWD/kubo-file"
ipfs init
ipfs config --json Bootstrap '[]'
ipfs --offline dag import file.car
ipfs --offline cat "$FILE" > recovered.bin
cmp scope-fixture/expected-file.bin recovered.bin
sha256sum recovered.bin
```

对 `hamt.car` 使用另一个空 repo：`ipfs --offline dag import --pin-roots=false hamt.car`
（entity 不含文件 payload，不能要求 pin 完整 DAG），
`ipfs --offline ls "$HAMT"` 比较 500 个名称与 manifest，文件 cat 应缺 payload。
对 HAMT all 再使用另一个空 repo import，遍历/读取所有文件应成功。
对 generic CAR 新建 repo import，`ipfs --offline dag get "$GENERIC"`；
从根的 `left/child`（identity）及 `right` links 使用 `ipfs --offline dag resolve`
并 block get 校验最终 leaf。用独立 CarReader 检查输出集合恰为 genericAll、
不存在 genericVirtual 数据段，entity/block 恰一块。缺省/all CAR bytes 与 ETag 相同；
三种 scope ETag 不应互相混用。文件 block CAR 不应能恢复完整文件。

缺块复核：从专用缓存删除 manifest 指定的必要 shard/leaf，再分别 GET/HEAD/
If-None-Match/only-if-cached；已开始的 GET 必须为 curl 非零或 body 拒绝，
HEAD/条件请求不能成功/304，完整性验证器也必须拒绝删块 CAR。
并发 prune/取消可结合测试的 LocalRead 故障注入位置；不要把 Kubo 自动补块算作成功。
结束后停止专用 managed Server/Kubo（若启动过），删除此次消费者、配置、
data-dir、Kubo repos、CAR 与 recovered.bin，只保存精简 headers/CID/hash/退出结果。
