# 实现 CLI 执行与工作耗尽生命周期

行为依据为已接受的
[执行语义与边界](ideal/execution-semantics.md)，不修改理想世界。实现选择为 Bundle
engine 的终结性 `drain({signal?})`、公共 `@silvermoon-work/task-engine-cli` 的
`runBundle`/`main`，以及 private `apps/task-engine`
launcher。公开包携带薄 bin，满足真实 registry 安装后的命令入口，但没有第二套 engine、HTTP
service 或后台调度协议。

新增本地 `run --car <file> --input <file|->`
入口，完整校验后将唯一根 CID 与 CAR 只读块源交给同一个
`runBundle`；不另起 Gateway，不需要用户编写宿主脚本。复用 builder 的 `./car`
入口并可选检查
`--expected-cid`，不改变 Gateway/CID 的既有执行协议。文件、内存、取消和整次预算均由 CLI 管理。

准入、生命周期与资源证明见
[完成性证明](completion-proof.md)；使用参数、输出和所有权见
[CLI 文档](../../../../../packages/task-engine-cli/README.md)。

省略 `--input` 默认从 stdin 读取 JSON 到 EOF，等同显式 `--input -`；
`--input <file>`
保持文件输入优先，两种内容源使用同一路径。空输入、无效 JSON 和超出容量仍明确拒绝，终端等待可通过现有信号处理器取消。

## Steps

CID 模式仅在 CLI 中增加 Gateway 默认选择：显式 `--gateway` 优先，未传时取
`TASK_ENGINE_GATEWAY`，未设置时读取 `IPFS_PATH/config`，或默认 `~/.ipfs/config`
的 `Addresses.Gateway`，不猜测端口、不使用管理 API。只接受支持的 IP/TCP
listener，wildcard 转为同端口 loopback；缺失、损坏、禁用或不支持的配置明确拒绝，不打印配置内容。空或非法环境变量明确拒绝，获取失败包含源诊断且无公共 fallback；CAR 忽略这些变量且不读 Kubo 配置，程序化 engine/runBundle 的 caller-owned
client 契约保持不变。

### I-S01: 明确运行域与耗尽判定

每次 CLI 创建独立非持久 `MemoryStore` 域，不读取历史或开放外部提交入口。 `drain`
同步封闭外部准入和历史收集；核心生命周期通知同时检查 preparing
Request、未完成 Task（包括未来资格）、Run/分配、在途准入及结构化子调用和回收证明。最后一步才主动关闭守护及缓存并释放 Store；不使用静默窗口或队列长度替代事实。默认常驻
`start`/`submit`/`close` 的行为、已有取消与期限规则保持不变。

### I-S02: 组装 CLI 与退出流程

命令接受 Bundle 根 CID + 显式 Gateway，或本地 CAR 普通文件，并接受 JSON 对象；两种内容源互斥，配置和输入无效先拒绝。CAR 的哈希、精确 DAG、Bundle/Schema/资源完整校验和可选 expected
CID 检查在启动 Worker 前完成，不做网络 fallback。子任务默认拒绝，`--allow-children`
明确授权已验证父 Bundle 子树，保留继承身份及深度/并发/总量/时间预算，不允许任意 detached
CID 工作。stdout 单行 JSON 汇总全体 Task、Run 回收事实及拒绝；stderr 诊断；退出码 0/2/3/4/5/6/7/130/143 区分成功、无效、拒绝、失败/停止、超时、基础设施错误、清理未知和两种信号。提供根期限与可选整次预算。CLI 拥有并关闭其临时 Gateway
client；共享节点、源 client 与 pin 不归 engine 所有。新增公开包映射
`task-engine-cli`；先发布新版 engine 才能发布依赖它的 CLI。本实施不创建 release
tag 或进行 npm 发布，现实世界证明留给 Deployment。

### I-S03: 验证耗尽与兼容行为

使用人为 preparation 门、父 Worker 末尾提交、VirtualClock 未来资格、宿主回收证明门及清理拒绝进行确定性测试；真实子进程执行 1/3/7 个 Task，只将未触发 watchdog 的自动退出视为成功。覆盖错误、信号处理和 source/pin 所有权。先运行针对性 runner，再执行
`pnpm check`（含常驻 engine/server、类型和包守卫回归）。Windows 原生进程信号投递不冒充 POSIX 证据，处理器在真实子进程以信号事件验证，原生目标环境 signal
smoke 属于现实世界验证。

## Acceptance criteria

### I-AC01: 本次工作完整执行

`drain.test.ts`
证明根 preparation、队列末尾子 preparation、两层并行派生和未来资格均阻止提前完成；`cli.test.ts`
证明 Gateway 下 1/3/7 个 Task、本地 CAR 下 1/7 个 Task 全部成功、所有 Run 已回收，进程在 watchdog 前自动退出并返回 0。CAR 路径不产生 Gateway 请求。证明对应代码及精确 runner 见完成性证明。

### I-AC02: 结果与清理可信

`drain.test.ts` 的逻辑完成/回收门和清理未知、`multi-gateway.test.ts`
的源关闭，以及 CLI 失败/拒绝/期限/整次预算/中断/硬退出测试，证明清理不确定不会报告成功。正常流程仅设置
`process.exitCode` 并释放自有句柄，不用 `process.exit(0)` 隐藏泄漏。

### I-AC03: 既有能力兼容

`drain.test.ts` 中常驻空闲后第二次提交，以及 composition、engine/server 回归和
`pnpm check`，证明默认常驻行为、Bundle、授权、父子取消、预算与存储协议不变。所有新工作区具有标准 turbo 脚本；内部运行依赖为
`workspace:*`，不引入新运行时第三方依赖。
