# Implementation

准备阶段初版；实施前固定 IPNS record 与 gateway 规范基线。新鲜度只能基于有效期与已见记录，不声称离线可证明全局最新。

## Steps

### I-S01: 建立签名记录来源与存储

提供宿主拥有的显式记录输入/读取端口和独立存储，不增加公共上传入口；校验名称、公钥/签名、有效期及序列/选择规则，持久保存已见更新边界。来源回源如需启用须另受策略控制。

### I-S02: 实现 IPNS record HTTP 契约

提供 `/ipns/{key}` GET/HEAD、format=ipns-record 和 Accept 协商，原样返回签名记录；补齐 Content-Type、attachment、ETag 与不超过记录有效期的缓存策略，不把解析后的 CID 冒充记录证明。

### I-S03: 验证更新和兼容性

使用可控时间与签名 fixtures 覆盖更新、旧版本、重启及协商；扩展适用的一致性矩阵和文档，运行相关测试及 `pnpm check`。

## Acceptance criteria

### I-AC01: 独立验签与名称绑定成立

客户端用请求 IPNS key 独立验签并验证有效期；正确记录通过，错名、篡改和无效签名均失败，响应 bytes 与输入签名记录一致。

### I-AC02: 过期和回滚规则持久生效

可控时间测试过期与到期缓存失效；先见新序列后尝试旧记录及重启，旧记录不能覆盖已知新记录，同序列选择按固定规范处理。

### I-AC03: HTTP 能力与原网关兼容

GET/HEAD、协商、未命中、ETag 和缓存期限测试及适用 IPNS 一致性测试通过；原 raw/CAR 回归测试与 `pnpm check` 通过。
