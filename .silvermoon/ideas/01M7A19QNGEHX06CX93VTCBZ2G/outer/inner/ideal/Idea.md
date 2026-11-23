# Task 输入与结果的类型化内容引用

## 问题

当前 Task 将 JSON result 与可写文件树 output 分开表达，引用资源及历史详情缺少统一的交换和归档边界。需要在保留 SQLite 权威状态的同时简化内容引用与历史保留。

## 结果

让 parameters/message/result 通过自带 cidPaths 的载荷表达强引用，以受控 CID 访问替代 Worker Space；SQLite 保持业务状态与期限的权威，IPFS 辅助保存定稿 RunHistory。记录与详情可以分开保留，内容缺失明确可观察；已确认方向见[讨论记录](Discussion.md)，未决边界见[待决定项](OpenQuestions.md)。

## 边界

- Payload CID 是强依赖，完整归档须有可验证闭包；引用与普通数据无歧义，不附加 path，Task 不解释文档语义。
- 未执行/执行中的状态及过期判断以 SQLite 为准，不持续写入 IPFS；定稿历史以 RunHistory 为单位，允许记录存在而详情已释放或不可得，pin 不代替事务或权限。
- 文件资源首期 raw/UnixFS，结构化记录另有 DAG 编码；直接替换内部协议且不迭代已有 Schema/API 版本，不重写历史制品。可见性归 Store：builtin 不公开，Kubo 由节点管理者定义，Engine 不代管。

## 验收标准

- 三通道及父子引用在 JSON、逻辑值和归档 DAG 间往返，完整归档闭包可验证；普通字符串、同形对象及判别分支中的普通数据不误转换。
- SQLite 的 Task/Run、消息、幂等及期限在归档失败或详情丢失时保持正确；详情明确不可得，不回滚业务结果或重复执行。
- Worker 无需 Space 即可流式读取/解析/存储内容，按根保留不破坏共享执行；只读树形包按需引入，旧交换协议完整替换且已有版本号不递增。
