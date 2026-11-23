# Content-Addressable JS Bundle：统一 JS、Assets 与不可变依赖的构建和交付

## 问题

现有 Task Bundle 把公共内容封装与 Task 宿主契约耦合，无法直接复用于浏览器 Renderer。另起近似 Builder 又会复制已有文件树、归一、import 与 CAR 能力。

## 结果

抽取公共 JS Bundle 格式及构建/交付层，让 Task 与浏览器 JS 共用自包含 CAR，同时由各自宿主验证 runtime 和交互协议。

## 边界

- 允许 breaking change，但完整保留 Task 的契约、资源、子调用和运行约束；不改写历史 CAR/CID。
- 公共层不硬编码 Task/Renderer 联合协议，不冒充统一宿主 API；构建不等于上传、pin 或发布。
- [需求](requirements.md)与[能力映射](capability-map.md)约束交付；[协议候选](protocol-candidate.md)和[待决策项](decisions.md)不是已批准接口。

## 验收标准

- 同一公共构建/CAR 层交付真实 Engine 可调用的完整 Task，以及浏览器 JS/CSS/assets 样例。
- 声明驱动、文本/二进制、确定性和原 CID 依赖闭包均有正反例及离线证明。
- 工具链、示例、迁移说明和既有质量门限同步更新；[验证矩阵](migration-validation.md)逐项可追溯。
