# Implementation

准备阶段初版；沿用迭代 1 固定的规范基线。现有任务专用 CAR 输入校验不能作为通用 gateway 的内容约束。

## Steps

### I-S01: 建立路径证明遍历

对声明支持的 UnixFS 路径收集根、必要中间节点与终点原始 blocks；URL 解码及路径语义遵循 gateway 规范，不套用 bundle 文件白名单。

### I-S02: 输出有界 CAR 流

支持 CARv1、显式 dag-scope=block 与 GET/HEAD；先声明一种顺序/去重策略，未知变体明确拒绝。补齐 Content-Type/version、attachment、ETag 和标准探测；普通 CAR roots 不作为客户端信任锚。

### I-S03: 覆盖流式错误并记录能力

根缺失在响应开始前返回适用错误；开始输出后遇到缺失子块则终止流。实现背压、取消与预算，更新支持矩阵，运行相关测试及 `pnpm check`。

## Acceptance criteria

### I-AC01: 证明不依赖服务端信任

用独立 CAR 读取器和路径验证器验证多层路径；删除中间 block、替换终点、篡改 bytes 时均失败，不仅检查 CAR 能否被解析。

### I-AC02: 表示契约准确

测试 Accept/format、显式 scope、HEAD、探测、版本和不支持变体；省略 scope 不得返回冒充默认 all 的 block 子集，原始 block bytes 保持一致。

### I-AC03: 流式故障有界

注入根缺失、输出后子块缺失、慢读取及断连；客户端识别检索失败，记录缓冲上限和资源回收，相关回归测试及 `pnpm check` 通过。
