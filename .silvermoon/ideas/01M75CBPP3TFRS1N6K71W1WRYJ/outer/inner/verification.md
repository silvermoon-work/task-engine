# 局部 CAR 实现证据与独立复核输入

## 固定规范与实现边界

基线：[ipfs/specs 3000be69497e47c399cdb719440d0809f085388b](https://github.com/ipfs/specs/blob/3000be69497e47c399cdb719440d0809f085388b/src/http-gateways/trustless-gateway.md)。
`entity-bytes=from:to` 是闭区间；负值按终点文件总长度定位，末尾 `*` 等价 EOF，
隐含 entity，优先于传入的有效 dag-scope。非字节实体忽略范围；坏范围/重复 query
400，非法 scope 400，未知 CAR 变体或坏 Accept 406。范围数字最多 256 字符，
中间元数据、大小与偏移始终 BigInt，不经不安全 Number 转换。

根文件完全越界/反向空区间可提前确定，返回 400；路径流式发现的完全越界/反向空区间，
以及空文件，返回路径与终点 block 的有效 CAR。部分越界只选择交集。范围不是 CAR bytes
切片；每块保持原始 bytes 与 hash，仅选择必要路径、文件结构与覆盖范围的内容块。
UnixFS 数据由维护中的 ipfs-unixfs/DAG-PB 解码，路径复用 exporter/walkPath；显式验证
文件 links/blockSizes/声明 fileSize 一致，并验证实际选中子块的声明大小。

CARv1/dfs 支持 n/y：n 首次输出，y 每次真实 DFS 图出现都输出整个块并遍历子树，
两者都省略 identity 虚拟数据段。内部路径解析重复读取不重复输出；同一文件子树
在不同范围偏移出现仍选择各自必需叶子。Accept 按 specificity/参数/q 选择候选，
query car-* 覆盖同名 header 参数；省略 dups 默认 n。不支持 v2/其他 order。
响应 Content-Type/Content-Location 声明实际表示。ETag 包括请求根/路径、有效 scope、
请求范围、版本/顺序/dups，无范围与 `0:*` 不混用。HEAD/命中条件请求只预检所需集合，
不声称完整文件 DAG 可用；缺必需路径或叶子不能成功/304，缺非必需叶子不影响范围。
不引入 IPNS、递归、网络获取或合规范围扩展。

读/输出/访问次数、frontier、depth、总时限和每块上限继续受既有预算限制；
y 的重复输出同样计入次数与 framing bytes。只缓存当前块与有界遍历状态，不缓存整个
CAR；socket drain 保持 backpressure，abort/timeout 能释放读取与并发 slot。

## 测试与本地验证

`packages/task-engine-cli/test/car-gateway.test.ts` 新增：

- 八种不同载荷叶、两级文件结构、多级路径；独立原始布局计算最小 CID 集与 DFS 顺序，
  比较 LocalRead 实际序列（无多读）及恢复切片（无缺字节）。覆盖单字节、精确块边界、
  跨块/跨分支、负尾范围、负终点、双侧部分越界、整个文件、EOF 外、超大整数与反向空区间。
- 证明 oracle 仅信任请求根/路径/原始范围；修改 CAR roots 不改变正确结果，删除必需路径、
  删除必需叶子或篡改 bytes 都失败。尾范围输出小于完整文件四分之一。
- raw、空 UnixFS、identity、目录及一般 CBOR；`9007199254740993` 的精确元数据边界。
  malformed/duplicate 参数、Accept q/重复参数/合法候选回退/query 优先级。
- 共享 graph 和共享文件子树的 n/y 实际 DFS 序列、完整重复 bytes、identity 省略；
  共享子树不同偏移选择不同叶子的回归。范围/dups/scope ETag 不混用。
- 缺必需证明/叶子的 GET 传输失败及 HEAD/条件请求预检，未请求叶子缺失仍 304；
  block/byte 预算，范围慢客户端 backpressure、abort、timeout、slot 恢复。
- 既有 raw、显式 block、entity、all、default-all、HAMT、通用 DAG、身份与零上游回归保留。

执行命令（Windows）：

```powershell
pnpm exec tsx --test --test-concurrency=1 packages\task-engine-cli\test\car-gateway.test.ts packages\task-engine-cli\test\raw-gateway.test.ts
pnpm typecheck:tests
pnpm check
```

最终验证：Windows / Node.js 26.13.0 / pnpm 11.22.0，聚焦 CAR/raw 17/17 通过，
`pnpm typecheck:tests` 退出 0，`pnpm check` 退出 0；Turborepo 40/40 任务成功，
CLI suite 66 项中 65 通过、1 项既有 Linux-only 在 Windows 跳过、0 失败。
完整检查覆盖格式、发布守卫、所有 workspace lint/typecheck/test/build、测试类型及 publint。
只有既有 lint warnings/private app publint suggestions，无错误；不改变最低 Node 22.13。

本地 public-only fixture smoke 也检查替换 CAR roots 的正确响应及删叶负例，
随后使用产品 LocalRead gateway 对同一公共 fixture 实际响应独立验证三个范围，
实际读取序列与精确必要集合一致。完整文件 entity CAR 为 263291 bytes；
cross/branch/tail 分别为 66219/66449/33412 bytes，尾范围比完整响应减少约 87.31%。
只生成自有 `.cache/gateway04-proof-smoke`、`.cache/gateway04-public-smoke` 并在 finally
删除，不安装依赖、不保留 CAR、大文件或 listener。这些不是 Ubuntu/registry/Kubo 部署声明。
实际发布影响仅 `@silvermoon-work/task-engine-cli`，没有 manifest/依赖/版本变化。

## 精确的公共 fixture 与 oracle

[range-proof.mjs](range-proof.mjs) 只导入 Node 与 registry 公共库，不导入产品私有模块；
固定八个不同 32768-byte raw 叶，以两个四叶 UnixFS branch 组成文件，路径
`R/deep/file.bin`。原文件 262144 bytes，SHA256
`ee1fffa839f2221c15e87eeff7b1539370bbb63ec1452fc46cb3b365ded70a80`。
create 只接受尚不存在的目录；seed 只写调用方专用已停止 managed instance 的 blocks，
逐文件 `wx` 拒绝覆盖；脚本不会删除或接管已有目录。

| 标识 | 精确 CID |
| --- | --- |
| R | bafybeifmxa6bsjhxqlvd52sac2uaepwucdefjp2wiwzhtj663e7iahj57q |
| D | bafybeidfojv43uye5jaatjcwwxedgph7gd6xb3aea5nphgyn7ywzhhoxuy |
| F | bafybeib7molllmnonuswkzswns3dqdmkxzw7m7yadbiifiwglj7twywvki |
| B0 | bafybeifjjjcdfl3axb5jf2lvym3f5jbhugxpl44laxpsm4olugfi6aeyli |
| B1 | bafybeiec63ga4s7xd3qf5s23r5xfj2dquzpcknodfycxrxlpccgfnxh3cq |
| L0 | bafkreia4bxwmodvsyuxksvsjsscce2nfyl27djym6pzmozlwgz6kvkdz7a |
| L1 | bafkreibrn3cmqiqpuhpxsornhzpcus57morvc7tzdl2mljd2t4br3f4vf4 |
| L2 | bafkreidcoas6nnctdccbdcuq4x6lvmcevdpbrzgmvrmqoe4b2pbn5lnpii |
| L3 | bafkreiezp4gucrqkmqwun7yop2wae7ldsovxcuf2qoivasglwx6if7aiq4 |
| L4 | bafkreid2iijeyniue7javqbxm4wfnfjvudqhzwjaxtnyriah2m64jl2afm |
| L5 | bafkreiagm7azamkmrwa4r77veynqh5n2donxy45jpoguv4ieqbadmwd2qe |
| L6 | bafkreibwmcykkcxe5qn4gbfqdngsnsfns5zrvaelj6i2lsxyfnw3xok7sy |
| L7 | bafkreid23piv2m5mg7coqw6c55aagawqtwdnjigruda3egle3ukbpdkmmm |
| G | bafyreiatovar6sney27lgrxzmqnzrlyhjqsv52qx4twxdbfcqrtqdzrgqa |
| V（identity，不输出） | bafkqabtjnzwgs3tf |

| case | 闭区间 | 恢复 bytes | 精确最小 DFS 集合 | CARv1 bytes（根 R） | 恢复 SHA256 |
| --- | --- | --- | --- | --- | --- |
| cross | 32749:32805 | 57 | R,D,F,B0,L0,L1 | 66219 | fedf8cdde063f9b17712e5088ae8993827482852bfc0c119c31c0e23601b2c42 |
| branch | 131059:131095 | 37 | R,D,F,B0,L3,B1,L4 | 66449 | c0c3c24892c7e94a7b543d6988ce9ea16a06f12d2eb5ba3f42e331f3426c4814 |
| tail | -73:*（262071:262143） | 73 | R,D,F,B1,L7 | 33412 | 9774610059029f424fc3a08e8b0aa82c3f61ab7a520ef4dd14b04b8d98b9e2a6 |

完整文件最小 DFS 集为 R,D,F,B0,L0,L1,L2,L3,B1,L4,L5,L6,L7。
shared graph 是 `G=[L0,L1,L0,V,L1]`；n 精确输出 `G,L0,L1`，
y 精确输出 `G,L0,L1,L0,L1`，每次出现必须保留原始 bytes。
生成的 manifest.json 同时记录以上完整 CID 序列、长度、摘要与完整 fixture CAR 大小；
完整 fixture CAR 包含独立 shared graph，不应拿它的大小代替完整文件响应基线。
verify 重建可信 fixture，校验每块 hash、精确顺序及原始 bytes，
从已知叶布局恢复所请求切片并比较原始文件，完全不信任响应 CAR roots 或产品遍历。

## 父级 Ubuntu / registry / Kubo 独立回放

这是交给父级的实施支持，不表示本 Agent 已发布、SSH 或完成外部验收。
在父级创建的全新专用消费者中，仅安装 registry 包并复制本脚本：

```sh
set -eu
npm init -y
npm install --save-exact @silvermoon-work/task-engine-cli@<父级确定的精确RC>
npm install --save-exact @ipld/car@5.4.6 @ipld/dag-pb@4.2.0 @ipld/dag-cbor@10.0.2 ipfs-unixfs@13.1.2 multiformats@14.0.5
node range-proof.mjs create range-fixture
export ORIGINAL_HOME="$HOME"
export HOME="$PWD/owned-home"
mkdir "$HOME"
npx task-engine config set server.rawGatewayAccess public
npx task-engine server start --data-dir "$PWD/engine-data" --port 18787
npx task-engine server stop --data-dir "$PWD/engine-data"
node range-proof.mjs seed range-fixture "$PWD/engine-data"
npx task-engine server start --data-dir "$PWD/engine-data" --port 18787
ROOT=$(node -p "require('./range-fixture/manifest.json').root")
G=$(node -p "require('./range-fixture/manifest.json').sharedRoot")
URL="http://127.0.0.1:18787/ipfs/$ROOT/deep/file.bin?format=car"
curl --fail-with-body "$URL&entity-bytes=32749:32805" -o range-fixture/cross.car
curl --fail-with-body "$URL&entity-bytes=131059:131095" -o range-fixture/branch.car
curl --fail-with-body "$URL&entity-bytes=-73:*" -o range-fixture/tail.car
for CASE in cross branch tail; do node range-proof.mjs verify range-fixture "$CASE"; done
curl --fail-with-body "$URL&dag-scope=entity" -o range-fixture/full-file.car
for DUPS in n y; do
  curl --fail-with-body "http://127.0.0.1:18787/ipfs/$G?format=car&car-dups=$DUPS" -o "range-fixture/dups-$DUPS.car"
  node range-proof.mjs verify range-fixture "dups-$DUPS"
done
wc -c range-fixture/*.car
```

在**分别全新的隔离 Kubo repo** 中验证每个 partial CAR；禁止先导入 full.car/full-file.car，
禁止网络补块。Kubo 不启动 daemon，记录版本、命令、状态和摘要。下面即精确的 offset/length
恢复命令；部分 Kubo 版本若预读无关块而失败，要如实记录，不扩大 CAR 集合规避最小证明：

```sh
set -eu
for CASE in cross branch tail; do
  export IPFS_PATH="$PWD/kubo-$CASE"
  test ! -e "$IPFS_PATH" || exit 1
  ipfs init
  ipfs config --json Bootstrap '[]'
  ipfs --offline dag import --pin-roots=false "range-fixture/$CASE.car"
  FROM=$(node -p "require('./range-fixture/manifest.json').cases['$CASE'].from")
  LEN=$(node -p "require('./range-fixture/manifest.json').cases['$CASE'].length")
  ipfs --offline cat --offset "$FROM" --length "$LEN" "/ipfs/$ROOT/deep/file.bin" > "range-fixture/$CASE.recovered.bin"
  cmp "range-fixture/$CASE.expected.bin" "range-fixture/$CASE.recovered.bin"
  sha256sum "range-fixture/$CASE.recovered.bin"
done
```

父级还应保留简洁的 HEAD/条件请求/query 优先级、全范围/default-all 与 n/y headers、
最小集合、恢复 bytes/digest、完整文件对照大小、未请求叶缺失成功及必需叶缺失失败记录；
可复用前两迭代明确计数本地上游的维护方法，但不能配置实际网络回源。
脚本的 verify 对任何缺块都直接失败，不会通过 Kubo 补齐。

结束时先 `npx task-engine server stop --data-dir "$PWD/engine-data"`，
确认专用实例已停止（若启动过 Kubo daemon，也只停止自有实例），
还原 `HOME="$ORIGINAL_HOME"`，再按父级记录的精确 owned 路径删除消费者/配置/data-dir/
Kubo repos/CAR/原文件与 recovered 文件。脚本无常驻 listener，不执行清理通配符，
不接管共享工具、目录、端口或服务；只保留简洁非载荷证据。
