# Implementation

规范基线沿用 ipfs/specs `3000be69497e47c399cdb719440d0809f085388b`。
范围及协商语义、独立证明 oracle、精确 fixture 与复核命令见 [verification.md](verification.md)。
保持 Ideal World 原样；本阶段不接受门禁、不发布、不部署。

## Steps

### I-S01: 选择字节范围与证明 blocks

实现 entity-bytes 的闭区间、负偏移及末尾星号，优先隐含 entity scope；复用维护中的
UnixFS/DAG-PB codecs 与 exporter/walkPath，通过 BigInt 元数据选择必要文件块和路径证明，
不以 Number 转换大偏移。目录/非字节实体忽略范围并遵循 entity。提前已知的完全越界
返回 400；路径流式发现的完全越界/空区间及空文件保留 block 结构证明，部分越界取交集。

### I-S02: 补齐 CAR 参数协商

处理 Accept specificity、偏好及 q 值、format 和 car-version/order/dups query 参数优先级；
仅声明 CARv1/dfs，支持真实每次图出现的 dups=y 与首次输出去重的 n，始终省略 identity
虚拟块。路径解析内部重复读取不产生重复输出，范围下共享子树不同偏移仍必须访问。
未知变体 406，重复 query 或坏范围 400，坏 Accept 参数/q 显式 406。
ETag 绑定有效 scope、请求范围、版本、顺序及 dups；Content-Location 声明实际参数。

### I-S03: 验证边界与传输效率

增加至少八个不同数据块、多层文件/目录、跨块/跨分支/尾范围的独立预期集合与字节恢复测试；
比较实际输出、读取序列与大小，证明未读取无关载荷。HEAD/条件请求仅预检必要集合，
但不能在缺必需证明/叶子时返回成功或 304。保留 raw/block/entity/all/default 回归，
验证重复图、identity、预算、取消、超时与 backpressure。提供仅依赖 registry 公共库的
[range-proof.mjs](range-proof.mjs) 供父级独立消费者复核，更新 CLI README，
执行聚焦 runner、标准测试类型检查与 `pnpm check`。

## Acceptance criteria

### I-AC01: 局部读取确实减少传输

以八个不同 32768-byte 叶子的多层文件查询跨块、跨分支及末尾范围，CAR CID 集合/DFS
顺序与手工布局计算的最小必要集合完全相同，读取序列无重复路径读取或无关叶子。
恢复 bytes 与原始切片完全一致，尾范围 CAR 小于完整文件 CAR 的四分之一；
错误 CAR roots 不影响以请求根为锚的证明，删必需证明/载荷或篡改均被独立 oracle 拒绝。

### I-AC02: 范围边界符合规范

测试首尾、负偏移、星号、部分/完全越界、反向空区间、空文件、raw/identity、
目录/一般 DAG；符合可提前判定的 400 或带足够结构证明的 CAR 语义。
超过安全整数的元数据/偏移仍精确选中正确叶子，不粗暴截断 CAR。

### I-AC03: 协商声明与实际输出一致

含共享 block/子树和 identity 的 fixture 验证 dfs 与 dups=y/n 的逐次顺序及数据；
测试 q 值、冲突优先级、不支持/畸形变体及 ETag、HEAD/条件请求必需集合。
范围取消/超时/backpressure 与预算不退化；聚焦测试、标准测试类型检查及 `pnpm check`
通过。只影响 CLI 源码/测试/README，无依赖、版本或其他发布包变化。
