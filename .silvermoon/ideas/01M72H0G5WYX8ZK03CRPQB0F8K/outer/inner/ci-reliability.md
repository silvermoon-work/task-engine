# CI 可靠性修复

## 问题证据与归因边界

发布前置失败历史见 [Builder 发布证据](../builder-release.md)：
exact SHA `9b4e31b809b290cd204dbe19cdd1769dec6d108d` 的
[CI 42821471205](https://github.com/silvermoon-work/task-engine/actions/runs/42821471205)
两次运行均未满足 required gate。storage startup `starts` 为 0 而预期 1；
Node22 的正常 parent/child/grandchild 场景报 `child_timeout`。
没有据此推发布 tag，也没有把本地绿灯代替 CI。

本地实测：Node v24.12.0，Windows x64，availableParallelism=32、logicalCpus=32、
约 48 GiB 内存。旧 root check 同时调度多 workspace 的 lint/typecheck/test/build，
而 Node test runner 默认又并行测试文件；Engine/Storage 文件内部还启动真实 Workers、
SQLite crash child 等进程。并发层级相乘不是业务 Task 并发测试本身。
CI 新增只读资源报告，以实际 runner 的 os.availableParallelism/cpus/memory 为证据，
不猜测 hosted runner 的 CPU 数。

### 受控复现：不是业务 1000ms deadline

startup fixture 的请求 timeoutMs=1000，由 VirtualClock 驱动；恢复时只 advance(10)。
旧测试却以 200 次 sleep(5ms) 的次数决定何时断言，并未确认生命周期已完成。
在 Windows 上名义 1s 并不等于实际 1s：最初 1500ms effect 延迟探针在约 1844ms 已完成，
所以该探针没有复现失败；随后使用明确尚未完成的 5000ms effect 延迟隔离此错误假设。

旧等待逻辑的实际诊断：

```text
effectDelayMs=5000
recoveryWallMs=3264
stage=running, starts=0
virtualNow=1800000000010
deadlineAt=2027-01-15T08:00:01.000Z
AssertionError: 0 !== 1
```

逻辑时钟距 deadline 仍有 990ms，墙钟等待结束却不意味着 effect/Worker 已完成；
这直接复现了 CI 的断言形态，不需要增加机器负载或修改生产逻辑。

## 最小修复与不削弱断言的原因

1. storage startup 成功恢复分支改用既有 `engine.waitForIdle` 的实际终结/回收观察，
   由提交事实触发完成；使用独立 10s 观察失败期限和测试取消 signal，不驱动 VirtualClock。
   原 requestId、deadlineAt、启动次数、completed/stopped、error 断言保留。
2. before 分支新增 Run exit/reclaimedAt 且无 cleanupUnknown 的断言。
   after 分支本就代表进程崩溃后的不确定资源状态：明确断言
   `reclamation_unknown`、Run exit/cleanupUnknown、无 reclaimedAt、starts=0，
   不将未知回收伪造为成功，也不重启工作。
3. 保留 5000ms 受控延迟回归；修复后实测约 5326ms，stage=completed、starts=1，
   VirtualClock/deadline 与上述 red 结果完全相同。
4. root `check`/`test` 对 Turbo 采用 `--concurrency=1`；Engine/Storage 的 Node test
   仅增加 `--test-concurrency=1`，避免独立文件和 workspace 争用 CPU。
   所有原 glob、测试及 assertions 保留；文件内刻意的并发 Task 场景不改变。
5. CI 仍执行原 `pnpm check`，Node22/Node24 matrix、Release verification (v1) 和
   Confirm required checks succeeded 不变；新增步骤仅输出实际硬件信息。

没有修改 composition.test.ts 的普通子任务 2000ms、显式超时 100ms、根请求 deadline，
也没有修改 crash-child.mjs 的 1000ms 请求期限。没有修改任何生产 Engine/Protocol/SDK
源码、发布 guard 或包版本，没有 skip、错误抑制、重试循环或日志关闭。

## 已执行的最小验证

```powershell
pnpm --filter @silvermoon-work/task-engine-storage exec tsx --test --test-name-pattern 'delayed effect' test\startup.test.ts
pnpm --filter @silvermoon-work/task-engine-storage exec tsx --test --test-concurrency=1 test\startup.test.ts
pnpm --filter @silvermoon-work/task-engine exec tsx --test --test-concurrency=1 test\composition.test.ts
```

- 第一条使用旧等待逻辑及 5000ms effect 时退出 1，明确 starts=0/stage=running。
- 修复后 startup **3/3** 通过：正常恢复、uncertain 恢复、延迟恢复。
- composition **20/20** 通过，包括 capacity-one 三层 Task（本地约 538ms）、
  原 100ms timeout、取消、配额和物理回收；没有放大其业务 deadline。
- 本地 `pnpm check` 已实际成功：Turborepo **40/40**，16 项有效缓存；
  Engine **234/234**、Storage **49/49**（新增延迟恢复一例），以及所有格式/lint/
  测试类型/build/publint 均通过。串行受控调度耗时 **6m19.679s**，不是裁剪测试换取绿灯。
- 新准确代码候选的 hosted CI 已完成，见下节；I-AC05 在取得真实结果后才勾选。

验证过程中的边界：一次从 root 合并运行两个 fixture 的尝试因其 workspace-relative
SDK 解析路径失败，后续使用上列各 workspace 的真实标准命令，没有给 root 添加依赖
掩盖问题。初版统一等待成功 idle 正确拒绝 after-crash 的 unknown 回收，因此最终明确
区分成功回收与不确定恢复，并增加对应事实断言，未修改 Engine 来伪造其成功。

## 新准确提交的真实 CI

代码候选：`64ba0de593c91d40926345a80f25bb8786639501`，已同步且可从 main 到达。
[CI 42827001474 / attempt 1](https://github.com/silvermoon-work/task-engine/actions/runs/42827001474/attempts/1)
是该 exact SHA 的 `ci.yaml` / `push` / `main` 运行，**第一次运行即全部成功**，
没有重跑这个新候选。

| 检查 | 结果 | 实测 |
| --- | --- | --- |
| Node.js 22.13.0 | success | 7m57s；40/40 workspace checks |
| Node.js 24.11.1 | success | 7m01s；40/40 workspace checks |
| Release verification (v1) | success | 3s |
| Confirm required checks succeeded | success | 未修改门禁条件或名称 |

资源步骤实际输出：两个 runner 的 availableParallelism=4、logicalCpus=4；
Node22 memoryBytes=16759431168，Node24 memoryBytes=16759439360。
这与本地32逻辑CPU不同，原嵌套 workspace/test-file 并行会在较小CPU预算上竞争。
受限调度后的真实时序：

| 场景 | Node22 | Node24 |
| --- | --- | --- |
| before 恢复、无注入延迟 | 463ms，completed，starts=1 | 423ms，completed，starts=1 |
| after 恢复 | 214ms，stopped，starts=0 | 188ms，stopped，starts=0 |
| before 恢复、5000ms effect | 5477ms，completed，starts=1 | 5407ms，completed，starts=1 |
| capacity-one 三层 Task（原2000ms子期限） | 1083.001353ms，通过 | 921.811769ms，通过 |

全部恢复诊断仍为 virtualNow=1800000000010、
deadlineAt=2027-01-15T08:00:01.000Z；对比旧 fixed-poll red，业务时钟/期限没有增加。
证明实际等待/资源隔离消除了观察假设和饥饿，而非延长业务期限或放松结果断言。
原有超时、取消、配额、身份、不可确认回收分支继续实际执行。
没有增加 CI job 的15分钟期限，也没有改变 Node matrix 或发布校验规则。

本文件与 ledger 的后续证据提交仅记录已发生的结果，不改变上述已验证代码。
证据候选同步后也须取得该准确 SHA 的完整 CI 才重新 submitInner；不发布任何包或 tag。
