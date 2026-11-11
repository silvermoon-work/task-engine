# Implementation

依据 [Trustless Gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/) 及其引用的 Path Gateway 规范；实施时固定规范提交与适用要求矩阵。首版不声称完整 CAR/IPNS 支持。

## Steps

### I-S01: 建立本地只读出口

复用宿主内容存储的本地读取能力，不调用可回源的读取入口。明确 CIDv0/v1、支持的哈希和 identity CID 行为；原样返回 block，不重新编码。提供显式开关、访问策略、独立并发与输出预算。

### I-S02: 实现 raw HTTP 契约

实现 `/ipfs/{cid}` GET/HEAD、Accept/format 协商、attachment、Content-Type、ETag/条件请求及标准 bafkqaaa 探测。普通根缺失返回 404，only-if-cached 未命中返回 412；损坏内容和存储故障不伪装成未命中。

### I-S03: 验证节点互操作与隔离

增加现有测试体系内的协议及双节点集成测试，更新配置、支持矩阵与使用文档，运行相关测试和 `pnpm check`。

## Acceptance criteria

### I-AC01: 内容可独立验证

使用多 block 任务包逐块比较响应原始 bytes 与 CID；覆盖 CID 别名、损坏 block、探测 CID、不支持哈希及非法请求，HEAD 不含 body。

### I-AC02: 本地与访问边界成立

通过出站请求计数证明所有命中、未命中和 only-if-cached 请求均不回源；关闭及未授权访问不泄露内容，限额与取消测试证明资源被释放。

### I-AC03: 双节点执行保持兼容

Engine B 仅配置 Engine A 为来源，成功读取并执行 A 已缓存的 bundle；已有任务执行测试及 `pnpm check` 通过。
