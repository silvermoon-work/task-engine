# Implementation

准备阶段初版；构想验收不批准具体接口。[能力映射](ideal/capability-map.md)作为抽取基线，
[待决策项](ideal/decisions.md)须在对应实现前明确确认。

## Steps

### I-S01: 确认协议并抽取公共内容层

确认 runtime/module、metadata 命名空间、文件命名及归一/profile 决策；从现有机制抽取公共格式、
只读树、构建和 compiler-free CAR 能力，不复制另一套 Task Builder。

### I-S02: 迁移 Task 并接入浏览器样例

Task Builder、Protocol、SDK、Engine、CLI、模板与测试改用公共格式；专属契约由宿主解释，
浏览器样例不依赖 Task，资源 URL 与生命周期由浏览器宿主实现。

### I-S03: 完成破坏性迁移与验证

按[迁移及验证矩阵](ideal/migration-validation.md)补齐黄金和失败测试，更新直接相关文档、
工作区及发布映射（若增加可发布库），运行 `pnpm check`，不改历史制品。

## Acceptance criteria

### I-AC01: 两种宿主共用公共层

真实 Engine 证明 Task 参数/结果/消息、资源、typed ContentRef、子调用及退出约束；
浏览器证明 JS/CSS/assets 和生命周期。测试证明公共解析器不导入 Task 协议。

### I-AC02: 内容身份和闭包可验证

磁盘/内存树等价、跨平台文本及二进制黄金测试、glob/冲突失败、原 CID import 离线闭包、
根 CID 与 CAR 字节的独立断言均通过，证明方法见验证矩阵。

### I-AC03: 门限及迁移完整

完整 `pnpm check` 通过且不降低既有门限；不支持的格式/runtime/协议在执行前失败；
取消、缺文件/块及清理失败测试通过。文档逐项解释旧能力映射和重建 CID。
