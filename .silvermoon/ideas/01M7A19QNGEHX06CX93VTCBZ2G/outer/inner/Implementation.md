# Implementation

本文件是准备阶段的可调整实施种子；已确认大方向，具体设计在实施阶段细化，不在完整构想验收前开始实现。

## Steps

### I-S01: 依据确认契约实现引用往返

构想验收后，按[IPFS Payload 设计](IpfsPayload.md)建立 `@silvermoon-work/ipfs-payload` 工具包，以充分单测验证 JSONPath、判别分支及引用往返；将契约命名统一为 parameters/message/result，保持现有 Schema/API V1。细化 TypeBox 扩展、引用构造与路径验证，不重复实现转换。

### I-S02: 以不可变内容能力替代可写输出

按确认方案建立 ipfs-access 文件/目录 DU 契约及按需引入的 ipfs-tree 只读便利层，以 raw/UnixFS 范围内的 CID 读取、CID 加 path 解析及临时写入返回 CID 替代 Worker 对外 Space 接口，统一三个通道与内外部调用，移除旧 output 交换模型；实现运行/结果持有、错误及直接替换边界，不复制或全面重写存储实现。

## Acceptance criteria

### I-AC01: 引用与普通 JSON 无歧义往返

以工具包单测和集成验证覆盖 parameters/message/result、数组重组、混排及嵌套 discriminated union、父子引用传递；引用路径尽可能使用安全通配符或判别条件，普通 CID 字符串及同形对象保持业务原义。无效引用或判别信息按契约明确失败；直接依赖的调用方使用新命名，原有 Schema/API V1 不变。

### I-AC02: 内容写入与生命周期可验证

验证无需 Space 即可通过文件/目录 DU 流式访问 raw/UnixFS 内容、解析目标 CID、成功存储并返回新 CID，不支持的内容明确失败；存储失败、取消和引用目标保留遵循确认策略，直接替换边界有明确证据。验证未引入 ipfs-tree 的 Task 构建产物不包含其运行时模块，SDK 与 ipfs-payload 不形成对它的依赖。
