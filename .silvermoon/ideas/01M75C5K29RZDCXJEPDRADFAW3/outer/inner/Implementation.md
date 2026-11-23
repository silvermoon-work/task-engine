# Implementation

依据 ipfs/specs `3000be69497e47c399cdb719440d0809f085388b` 的 Trustless Gateway 及 Path Gateway 规范；[适用矩阵、测试证明与安装后复核输入](verification.md)。首版仅为有限 raw profile，不声称完整 CAR/IPNS 支持；Ideal World 保持原样。

## Steps

### I-S01: 建立本地只读出口

复用宿主内容存储的本地读取能力，不调用可回源的读取入口。明确 CIDv0/v1、支持的哈希和 identity CID 行为；原样返回 block，不重新编码。提供显式开关、访问策略、独立并发与输出预算。

已在 CLI 宿主增加 `raw-gateway.ts`，仅注入 `DiskContent.local` 能力；文件与 SQLite 持久输出均先限制字节数再验证。SHA2-256 和 identity 之外的 hash 显式拒绝，CIDv0/v1 归一化。默认 disabled；public 为显式共享实例全部块，token 为独立 bearer 策略，不把 CID 当授权。并发、block 字节和总时限独立配置；HTTP listener/连接与事件循环仍共享，严格隔离需独立实例或代理。

### I-S02: 实现 raw HTTP 契约

实现 `/ipfs/{cid}` GET/HEAD、Accept/format 协商、attachment、Content-Type、ETag/条件请求及标准 bafkqaaa 探测。普通根缺失返回 404，only-if-cached 未命中返回 412；损坏内容和存储故障不伪装成未命中。

已提供格式优先级、带质量值的媒体协商、强 ETag、If-Match/If-None-Match、HEAD 空 body、探测和安全 filename；错误不发送内容。范围请求不截断 raw block，CAR/DAG 参数和 IPNS 明确不支持。

### I-S03: 验证节点互操作与隔离

增加现有测试体系内的协议及双节点集成测试，更新配置、支持矩阵与使用文档，运行相关测试和 `pnpm check`。

测试集中在 `raw-gateway.test.ts` 与现有 `managed.test.ts`；复用真实 Builder、多进程受管 Server、DiskContent、上游计数器，不新增测试框架。配置和命令见 CLI README 及 verification.md；本轮仅改变 CLI 包，不变更发布版本、release 配置或外部环境。

## Acceptance criteria

### I-AC01: 内容可独立验证

使用多 block 任务包逐块比较响应原始 bytes 与 CID；覆盖 CID 别名、损坏 block、探测 CID、不支持哈希及非法请求，HEAD 不含 body。

证据：raw 协议测试覆盖二进制、别名、非空 identity、bafkqaaa、HEAD、协商及条件；真实文件损坏/目录替换返回 500。双节点测试逐块比较 A 响应与 B 已独立校验的落盘 bytes，并独立校验 SQLite 输出根 multihash。

### I-AC02: 本地与访问边界成立

通过出站请求计数证明所有命中、未命中和 only-if-cached 请求均不回源；关闭及未授权访问不泄露内容，限额与取消测试证明资源被释放。

证据：配置了真实 HTTP 计数上游的 DiskContent 在命中、普通/only-if-cached GET/HEAD 缺失及失败路径出站计数均为零，停止上游后命中仍成功；disabled/未授权未读本地存储。预算测试证明 413、429、504、断开/shutdown 取消及 slot 复用。

### I-AC03: 双节点执行保持兼容

Engine B 仅配置 Engine A 为来源，成功读取并执行 A 已缓存的 bundle；已有任务执行测试及 `pnpm check` 通过。

证据：两独立受管 Server，A 经 CAR 执行并缓存后断开其上游；B 仅经 A raw 取得多 block bundle 并执行得到 `{echo:"independent"}`。`pnpm check` 已完整通过（40/40 Turbo tasks；CLI 51 passed、1 个 Linux 专用测试在 Windows 跳过），包括原有持久任务、准备/执行预算、取消、重启、故障诊断和清理测试。仓库已有非阻断 lint/publint 建议未作无关修改；无 npm 发布或部署验收声明。
