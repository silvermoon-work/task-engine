# Implementation

本文件只是准备阶段的可调整种子，不授权实施。先完成构想讨论与明确验收。

## Steps

### I-S01: 依据确认契约实现引用往返

构想验收后，按[Content Payload 设计](ContentPayload.md)建立 `@silvermoon-work/content-payload` 工具包，以充分单测验证 JSONPath、判别分支及引用往返；将契约命名统一为 parameters/message/result，保持现有 Schema/API V1。TypeBox 扩展与传输信封按待决定项收敛，不重复实现转换。

### I-S02: 以不可变内容能力替代可写输出

按确认方案以 CID 读取、CID 加 path 解析及临时写入返回 CID 替代 Worker 对外 Space 接口，统一三个通道与内外部调用，移除旧 output 交换模型；实现运行/结果持有、错误及直接替换边界，不复制或全面重写存储实现。

## Acceptance criteria

### I-AC01: 引用与普通 JSON 无歧义往返

以工具包单测和集成验证覆盖 parameters/result、数组重组、混排及嵌套 discriminated union、父子引用传递；引用路径尽可能使用安全通配符或判别条件，普通 CID 字符串及同形对象保持业务原义。无效引用或判别信息按契约明确失败；直接依赖的调用方使用新命名，原有 Schema/API V1 不变。

### I-AC02: 内容写入与生命周期可验证

验证无需 ReadWriteSpace 即可读取已有内容、成功存储并返回新 CID；存储失败、取消和引用目标保留遵循确认策略，兼容或迁移边界有明确证据。
