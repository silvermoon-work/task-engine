# Implementation

本轮只实现显式受控递归，不改已接受的 ideal、不做 IPNS 或新内存遥测。
实现及固定预算/验证命令见 [verification.md](verification.md)；
公开入口回放见 [replay.mjs](replay.mjs)。Outer 的发布、独立 RC/Ubuntu 验证和验收归父代理负责。

## Steps

### I-S01: 提供显式递归与访问策略

`server.gatewayMode` 默认 `local`；递归另需 1–2 个固定批准 origin，与任务用
`server.ipfsGateway` 隔离。保留 disabled/public/token 与 raw/CAR/CORS 契约；
only-if-cached 的每个 block 始终直接读本地，不加入在途获取。
拒绝凭证、非 origin、转义/尾点主机、重复归一化目标及全部重定向。
递归单独限并发、累计接收字节、总时限及单次时限，无等待队列。

### I-S02: 合并验证获取并可靠落盘

仅真实 ENOENT 回源；本地损坏/存储错误不回退。按 CIDv1 singleflight，CID 验证和
bytes 检查完成后原子落盘；持久化故障不换上游掩盖。单个等待者取消不影响其余等待者，
全部取消则 abort 所属 transport。关闭封口并等待释放，未确认释放明确报错，不永远挂起。
每实例随机 hop ID、四跳上限及独立获取预算限制自身/A/B 环；header 只能限制，不扩权，
不同 hop 限制不共用在途获取；请求无法指定 URL、代理目标或自动发现来源。

### I-S03: 故障验证与文档更新

聚焦测试冷暖/持久重开、规范化多等待者取消、在途 only-if-cached、损坏本地与上游、
错类型、声明/流式超限、重定向、stall、超时/关闭、A/B、自身环及缺后代 CAR。
保留 raw/CAR 回归和独立 RSS sampler；更新 CLI README、固定预算、公开 CLI/Builder
真实任务回放、故障语义与证据。运行定向 runner、测试类型及 `pnpm check`。

## Acceptance criteria

### I-AC01: 冷暖读取与并发合并正确

定向测试与公开回放计数证明 CIDv0/v1 两等待者仅一个 upstream 请求；
取消其中之一后另一方得到正确 bytes，验证/落盘后重开实例、禁用可用上游仍读出一致 bytes。
错 CID/类型/超限及重定向不留下缓存。

### I-AC02: 禁止回源与循环边界生效

计数证明 disabled/未授权/默认 local、only-if-cached（含在途、HEAD、CAR 缺后代）
零回源，非法目标在配置阶段拒绝；redirect 目的端零访问。
固定定向 A/B/自身环最多三次请求且小于 1000ms；
公开回放 A/B 最多三次且小于 2500ms，不在失败后放宽预算。

### I-AC03: 取消和负载不破坏执行

全部等待者取消/close 后 active 归零且拒绝新读；故障流量不超过两个 acquisition slots、
无排队，累计 bytes/超时边界生效。公开 Builder 构造的真实任务在 stall 负载已进入两个
slots 后成功执行，固定 30000ms 上限；所有 owned 实例、监听、工作目录和任务源清理。
相关 raw/CAR、定向 runner、测试类型及 `pnpm check` 通过；独立 RC/Ubuntu/发布证据留给 Outer。
