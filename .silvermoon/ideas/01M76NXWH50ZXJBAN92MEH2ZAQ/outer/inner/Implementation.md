# Implementation

## Steps

### I-S01: 明确 fetch 兼容契约

验证支持运行时的 fetch 扩展方式，定义地址、方法、状态、流和错误映射；不假设 Undici dispatcher 本身能启用自定义协议。

### I-S02: 接入 Worker 范围适配

在 Worker 内识别 IPFS 请求，通过宿主受控内容能力读取并构造 Response，复用授权、校验、容量和取消机制，保留 HTTP(S) 原路径。

### I-S03: 补齐验证与文档

添加流式读取、HEAD、错误映射、取消和隔离回归测试，说明首期支持范围及与模块执行权限的区别。

## Acceptance criteria

### I-AC01: IPFS 响应可按 fetch 方式消费

集成测试证明已授权文件的 GET、HEAD、文本/JSON/二进制读取和 Response 流语义符合声明契约，HEAD 不返回正文。

### I-AC02: 失败与流生命周期受控

测试覆盖非法路径、权限拒绝、缺失内容、校验失败、容量限制、慢消费者、取消和关闭，证明错误可见且不遗留读取工作。

### I-AC03: 原有协议与隔离行为保持

回归测试证明 HTTP(S) 请求行为保持、宿主全局 fetch/dispatcher 未变，不同 Run 或 Worker 不因共享缓存而串用权限。
