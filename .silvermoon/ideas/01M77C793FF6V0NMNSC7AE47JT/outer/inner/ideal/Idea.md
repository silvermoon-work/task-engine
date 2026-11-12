# 支持可选 Kubo IPFS Store 后端

## 问题

已有 Kubo 的宿主若仍使用自有磁盘块目录，会重复持久化相同内容。只把 Kubo 当作 Gateway 上游不能消除这份副本。

## 结果

调用方通过统一 Store 显式选择默认 local 或可选 Kubo 后端；Kubo 直接承担块读写，Builder / Engine 不强制依赖 Kubo。

## 边界

- 保持 DAG 字节、CID、UnixFS 校验及资源边界；允许有界内存缓冲。pin 是可被外部操作破坏的保留提示，不保证内容永久可用。
- 配置由宿主读取并注入；借用外部 daemon，不接管其进程、联网策略或磁盘 GC，不静默回退 local。
- 本次只准备构想和下游初版，不实现产品代码，不代表生命周期验收。

## 验收标准

1. 无 Kubo 时现有默认 local 行为可用，由兼容回归证明。
2. Kubo 模式保持相同块与根 CID，读写不产生自有磁盘块副本，由真实 daemon 对照证明。
3. Store 提供 pin/unpin，为持久化 Task/Run 的 bundle 与 IPFS output 设置具名保留提示；prune 后按引用标记清除本系统标记的无引用 pin。外部清理后缺块或 RPC 不可达时依赖请求显式失败，关闭 Store 不停止 daemon。

已确认行为、剩余技术风险与验证方向见同世界 [设计讨论](./backend-design.md)；设计确认不等于生命周期验收。
