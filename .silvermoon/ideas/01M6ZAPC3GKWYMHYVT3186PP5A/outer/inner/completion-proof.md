# CLI 工作耗尽的实现证明

本文支撑 [Implementation](Implementation.md)，不是第二份契约或部署结果。

## 生命周期不变量

1. [Bundle engine](../../../../../packages/task-engine/src/bundle-engine.ts) 的
   `drain` 在首个异步边界前设置 sealed。外部 `submit`、`collect` 和
   `collectRequestResults`
   此后明确拒绝；Request 结果清理不能在最终汇总前抹去拒绝证据。根 preparation 门测试同时断言常驻时结果清理仍可调用、drain 中返回
   `engine_draining`。已开始的外部准入使用计数器，子准入由活跃父 Run、invocations 和 preparing持久关联保护。没有“发现空闲后仍能提交新外部工作”的窗口。
2. [Coordinator](../../../../../packages/task-engine/src/engine.ts)
   从同一 StoreView 检查全部 Task、Run 和 preparing
   Request，以及自己的 ticking/allocations。Task 无取消、无已退出匹配 Run 且未过截止时间便仍算工作；未来 eligibility 不被当前不可运行掩盖。commit、tick 完成、分配释放和外围操作完成均唤醒观察；没有通过分页、连续静默或额外 polling 调度器推断耗尽。
3. Run 必须既有实际 exit 又有 reclaimedAt，cleanupUnknown 直接拒绝。逻辑结果提交或 Task 完成不足以释放分配；已有 supervisor 的物理退出、在途资源操作与宿主回收证明规则不变。所有有效父 Run 已退出且外围操作为零时，受支持的子调用已不可能继续产生工作，随后正常 close 完成基础设施清理。
4. resident
   tick 继续 unref；只有 drain 自己持有并最终清除一个存活句柄，因此 preparation-only 和未来资格等待不会使 Node 提前自然退出。CLI 只设置退出码，正常成功不强制退出。
5. [Gateway client](../../../../../packages/task-engine/src/content.ts)
   跟踪真实 source Promise，包括每次拉取的 Helia
   stop，而不只跟踪被超时 race 提前结束的观察 Promise。CLI 在输出前封闭源读取并等待这些自有资源；获取失败与清理未知不混为成功。程序化
   `runBundle` 不关闭调用者的 client，也不触碰独立节点或 pin。

## 可重复证明

| 测试                           | 受控条件                                                                | 可观察结论                                                      |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `drain.test.ts` 根 preparation | 首次根 CID 读取被 Promise 门阻塞                                        | 没有 Task 时 drain 仍等待；外部准入拒绝；释放后执行             |
| 同文件末尾并行派生             | 唯一根 Run 在 drain 后才释放提交门，子 CID 再被阻塞                     | preparing 子 Request 不丢失，最终 7 个 Task 和两层派生完整成功  |
| 同文件未来资格/常驻兼容        | VirtualClock 推进 999/1000 ms                                           | 未来 Task 仍算工作；空闲常驻引擎仍能受理下一次提交              |
| 同文件宿主回收门               | Task 完成后 confirmResourceRelease 被阻塞或拒绝                         | 阻塞时不 idle；拒绝时明确 reclamation unknown，Store 不被伪释放 |
| 同文件中断                     | 活跃 Worker 的 drain Signal 被取消                                      | 原错误保留，实际 Run 退出和回收后关闭                           |
| 同文件 falsy Signal            | `AbortController.abort(false)`                                          | reason 为 falsy 仍拒绝 drain，不宣告成功耗尽                    |
| `multi-gateway.test.ts`        | HTTP 响应保持在途，调用 owned client.close                              | 新读被封闭，旧读取消；等待真正源资源 Promise                    |
| `cli.test.ts`                  | 真实 Node 子进程及本地 raw-block Gateway                                | 1/3/7 个 Task 自动退出 0，回收字段存在且没有 cleanup unknown    |
| 同文件错误矩阵                 | 默认子权限拒绝、业务失败、Schema 拒绝、期限与整次预算、Worker 硬退出    | 返回 4/3/5/7 和 stdout JSON、stderr 诊断；没有强制成功          |
| 同文件信号/所有权              | Windows 子进程 emit SIGINT/SIGTERM，另有 stdin 等待；共享 memory source | 130/143 自动退出；stdin 不悬挂；共享源及 pin 保留               |
| private app launcher           | 真实应用子进程 `--help`                                                 | 与公开 bin 复用相同入口并正常退出                               |

成功子进程测试有 watchdog 作为失败保护，并断言 watchdog 未触发；用强制杀进程取得的退出不算完成。Windows
`child.kill(SIGTERM)` 是强制终止，因此没有拿它伪造原生 POSIX 信号证据。

## 验证命令与边界

针对性验证使用：

```powershell
pnpm --filter @silvermoon-work/task-engine exec tsx --test test\drain.test.ts test\composition.test.ts test\multi-gateway.test.ts
pnpm exec tsc -b packages\task-engine-cli apps\task-engine --pretty false
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test test\cli.test.ts
pnpm --filter task-engine-app test
pnpm exec turbo run lint typecheck test build --concurrency=2
pnpm check
```

最终针对性生命周期 runner 为 34/34 通过；CLI 13/13 和 private app
1/1 通过。最近针对性 CLI 单/并行/两层派生子进程分别约 3.63/4.30/5.23 秒自动退出，不把这些耗时作为调度正确性的阈值。结果清理封闭补充前的
`pnpm check` 退出码为 0：32/32 turbo 任务通过，完整测试共 502 项通过（release
14、protocol 132、builder 26、private app 1、HTTP 19、server 15、engine 234、CLI
13、storage
48），全体类型检查与 publint 通过。早先完整默认并发检查通过；复查时既有 HTTP
Worker 启动在共享负载下超时，孤立 HTTP
runner 的 8/8 随即通过，未放宽期限或修改既有测试。随后使用 `--concurrency=2`
完成同一完整 turbo 集合（约 3 分 4 秒），最终 `pnpm check`
使用相同代码哈希的 32/32 缓存结果并完成 release、类型与包检查。没有用针对性通过替代完整检查。首次检查发现已接受 ideal 与 schema 元数据的既有 Prettier 格式差异，因此格式工具排除 revisioned
`.silvermoon/`，避免改写已接受内容；代码与工作区格式仍完整检查，`.cache`
中测试生成物不作为待格式化源码；生命周期校验由父 Agent 的 Silvermoon
gate 负责。ledger 的 I-* 已按这些验证勾选，不代表提交、同步或验收决定。已先确认 npm/pnpm 生效 registry 均为 Tencent；依赖链接恢复使用现有包，没有访问官方 npm
registry，也没有发布、tag、生命周期事件或验收决定。

候选公开版本为 engine `0.1.0-canary-261109-2` 与新 CLI
`0.1.0-canary-261109-1`；候选不是已发布事实。CLI 打包依赖新版 engine 与现有 protocol
`0.1.0-canary-261109-2`，不能只发布 CLI 或把旧 engine 的存在当作新 API 的可用证据。真实 npm 安装、Trusted
Publisher 设置和目标环境原生 signal
smoke 留给现实世界，不能用本地 dist、tarball 或本文件替代。

## 主 Agent 复核

主 Agent 按用户委托承担门限审查，直接审阅了生命周期、CLI、内容资源所有权、公开导出、工作区与发布映射、测试和相关文档。复核发现
`collectRequestResults` 仍可能在 drain 中移除拒绝证据；实现 Agent 已补齐同样的
`engine_draining` 封闭，并增加 drain 拒绝与常驻调用仍可用的回归断言。

补正后的独立 drain runner
8/8 通过，engine 类型检查、全仓测试类型检查和相关 Biome 检查无错误。主 Agent 随后重新运行最终
`pnpm check`，退出码为 0：32/32
turbo 任务成功，其中仅 8 项缓存，耗时约 2 分 15 秒；完整集合仍为 502 项测试，CLI
13/13，类型与全部包 publint 通过。这次默认并发的完整验证不是依靠补正前的全体缓存结果。

项目 `.npmrc` 已固定 Tencent
mirror，避免依赖下载回退至默认官方 registry。已接受的 Ideal
World 未修改；尚未接受的 Implementation、Deployment 与 supporting
documents 已格式化。I-* 勾选表示已完成实现证据，不自行构成生命周期审批；主 Agent 后续以准确同步 revision 的提交和验收事件记录审批。

## 本地 CAR 补充实现

本轮按用户明确需求增加 `run --car <file> --input <file|->`，可选
`--expected-cid`；与 CID/Gateway 互斥。不引入另一套校验器，动态加载
`task-builder/car`，通过完整有界校验得到唯一根 CID 和只读块源，再调用现有
`runBundle`/`drain`。文件句柄、CAR 内存和整个校验/执行预算由 CLI 负责。未开始读流前检查取消，避免动态加载期间预算已耗尽仍创建带预取消 Signal 的文件流。

真实子进程 runner 16/16 通过，增加本地 CAR 的单任务与 7
Task 两层派生，明确断言 Gateway 请求数不变、watchdog 未触发且 Run 已回收；退出后 CAR 文件可重命名，损坏内容的失败路径也可重命名。覆盖末尾块损坏、expected
CID 不符、缺文件、目录、重复参数、混用源和 CAR
stdin 的明确拒绝，以及默认子权限拒绝、业务失败、校验阶段整次预算和两种 signal。CID/Gateway 原有场景仍通过。

此外直接用已发布 builder 两个变体生成的 CAR 执行本地新 CLI 命令：默认返回
`Hello canary` / 6 字节 / 1 chunk，大资源返回 `Hello canary` / 600,006 字节 / 3
chunks，两者自动退出 0 且 Run 已回收。这是本地 CLI 实现验证，不冒充新 CLI 已发布证明。

最终 `pnpm check` 退出 0，36/36 turbo 任务通过，完整集合为 528 项测试，CLI
16/16，类型检查和包守卫全部通过。CLI 仅新增内部 runtime 依赖 builder 已发布的
`./car` 能力，没有新的第三方依赖。

审阅后的结果清理封闭补充，仅增加 sealed 检查及同一根 preparation 测试中的常驻调用/耗尽中拒绝断言，没有改变常驻保留语义。补充验证命令为
`pnpm --filter @silvermoon-work/task-engine exec tsx --test test\drain.test.ts`
（8/8 通过）、`pnpm --filter @silvermoon-work/task-engine typecheck`、
`pnpm typecheck:tests`，以及
`pnpm exec biome check packages\task-engine\src\bundle-engine.ts packages\task-engine\test\drain.test.ts --reporter=summary`。全部退出码为 0；Biome 仅报告原有 22 项 warning、无 error；`git diff --check`
通过。本次按审阅要求仅运行这些针对性检查，不将先前完整检查冒充补充后的重新执行。
