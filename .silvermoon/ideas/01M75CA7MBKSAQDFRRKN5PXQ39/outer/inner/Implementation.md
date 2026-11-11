# Implementation

继承 raw 与路径 CAR 能力；规范基线沿用 ipfs/specs
`3000be69497e47c399cdb719440d0809f085388b` 的 Trustless/Path Gateway。
支持矩阵、读取一致性、验证结果及独立安装消费者输入见 [verification.md](verification.md)。

## Steps

### I-S01: 补齐范围遍历语义

实现 dag-scope=entity/all 及省略时的 all；UnixFS entity 文件包含恢复文件所需 blocks，目录包含枚举所需 blocks，非 UnixFS entity 按 block 处理。保持路径证明。
GET 保留原始 bytes、DFS 首次访问去重；HEAD/304 完整预检所选 scope，
ETag 绑定 scope，缺省与 all 相同。identity 虚拟块参与校验/遍历但不输出。

### I-S02: 支持复杂 DAG 并限制资源

覆盖 UnixFS 多层文件、HAMT、共享子图和 identity links；为声明的通用 IPLD codec 提供解析与遍历，未知 codec 明确报错。制定并发 GC 下的读取一致性策略和深度/block/输出预算。
使用维护中的 DAG-PB、DAG-CBOR、UnixFS codecs 与 exporter/walkPath；
终点子 DAG 使用显式栈，深度 64，块数/累计读取/输出/frontier 共同有界。
读取采用逐块而非快照：已读块可继续发出，后续必需块被 prune 删除即失败，
headers 后销毁 HTTP，不能正常结束部分结果；不锁定 pin、不回源。

### I-S03: 建立范围回归与支持矩阵

维护有独立预期集合的 fixtures，更新使用文档和 scope 相关 ETag，运行相关测试及 `pnpm check`。

## Acceptance criteria

### I-AC01: 三种 scope 集合准确

比较实际 CAR CID 集合与手工审定/独立工具生成的预期集合；缺省等于 all，entity 目录不包含子文件内容，多层文件可重建并比较完整 bytes。

### I-AC02: 复杂结构和 codec 可验证

独立客户端验证 HAMT 枚举、共享子图及声明支持的非 UnixFS DAG；证明 identity 虚拟 blocks 不被错误输出，未知 codec 不被静默跳过。

### I-AC03: 缺块和预算不会隐瞒失败

故障注入覆盖 GC 竞争、缺失后代和遍历超限；客户端拒绝不完整结果，服务端资源有界且回收，相关回归测试及 `pnpm check` 通过。
