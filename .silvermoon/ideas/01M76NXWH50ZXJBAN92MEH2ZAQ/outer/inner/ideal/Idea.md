# 支持通过 fetch 读取 IPFS 内容

## 问题

任务资源已有 IPFS 内容读取能力，但尚未为引擎管理的 Worker 提供统一的 fetch("ipfs://...") 访问方式，开发者需要处理不同内容来源的接口差异。

## 结果

让 Worker 使用 fetch 兼容接口流式读取已授权的 IPFS 内容，沿用内容校验、取消和容量约束，并保持既有 HTTP(S) 行为。详细要求见 [需求说明](requirements.md)。

## 边界

- 仅在引擎管理的 Worker 内提供适配，不修改宿主全局 fetch 或 dispatcher。
- 复用现有 IPFS 内容基础能力；读取权限不等于代码执行权限，不借协议扩展放开任意 CID。
- 与 IPFS 模块加载分别推进；首期只读，不包含模块 hook、内容写入或 IPNS。

## 验收标准

- 已授权 IPFS 文件可通过 fetch Response 读取，支持流式消费、GET、HEAD 和取消。
- 非法地址、授权拒绝、损坏内容与超限均有明确结果；中止或关闭后及时释放读取资源。
- 非 IPFS 请求保持既有 HTTP(S) 行为，宿主和其他 Worker 不受适配影响。
