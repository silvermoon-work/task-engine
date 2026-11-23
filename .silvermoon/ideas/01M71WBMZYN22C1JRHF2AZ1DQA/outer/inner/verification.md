# Task Engine CLI 实施验证

本文件是 Agent 的实现与检查证据，不是用户已审阅未来代码的声明。
父代理依用户 19:45 的明确委托审查准确 implementationRevision。
本轮只提交实施门限；未记录 acceptInner、acceptOuter，未推送发布 tag 或发布 npm。

已接受的 idealRevision 为 `e334755b71fa65e6ec169391ac37da6fe9cf435f`；
理想世界及两份规范副本保持不变。

## 已整合的上游

2026-11-10 串行整合 CAR 重构至 `a38c6f08e4acfdb1d755c31bde4cbfab67366634`，
随后再次保留候选并正常快进至 `8bfcf59db4756fa5df75df763473ea82643c4954`。
检查点首次 Silvermoon 检查发现本地 Builder 事件前缀落后于已刷新的 primary，
因此没有提交无效候选：先仅保存本任务在途文件，再 fetch、正常快进 main，
应用本任务变更；没有 rebase、force push 或丢弃未知提交。

内容冲突为 CLI README、CLI package.json、pnpm-lock.yaml，均逐段解决：

- 保留上游 Engine CLI 候选 `0.1.0-canary-261110-2` 及标准 IPFS/CAR 依赖图；
  不恢复 `task-bundle-car`、其发布映射或生产端依赖。
- 受管执行改用现有 `src/car.ts` 的 `openCarSource` 完整离线校验；
  编码和文件树 API 只从 Builder 的开发测试入口使用，Builder 生产 src、版本和 Idea 未改。
- README 合并新的受管接口与上游 CAR 归属/校验边界；锁文件最终与整合基线一致。
- 删除已确认没有跟踪源码、仅含本轮旧构建产物和安装链接的退休 workspace 残留。
  否则发布发现测试会将其当作缺失 package.json 的 workspace；没有修改发布脚本绕过检查。

第二次整合没有内容冲突，保留上游 CI 资源记录、Turbo 与 Engine/Storage 测试串行限制、
Storage 恢复按已提交生命周期观察的回归修正及 Builder 的新事件前缀。
没有回退这些修正，也没有修改其业务 deadline 或通过放宽轮询 cutoff 让测试通过。

## 版本化候选补充

在父代理已整合的 `da76b79f4055b6464da95bf25940693c4ae625a8` 上，
按其 22:29 明确选择准备 Protocol/SDK/Engine `0.1.0-canary-261110-1`，
CLI 保持 `0.1.0-canary-261110-2`。具体授权边界、单包顺序与实际 registry 观察见
[canary 候选组装](./canary-candidate.md)。

三个库 manifest 和四包相关 README 已对齐，workspace:* 保持不变；
执行 `pnpm install --ignore-scripts` 后锁文件无需变更。
唯一必要的相邻兼容测试为 `packages/task-builder/test/init.test.ts`：
固定验证已发布模板默认仍为 SDK `261109-2`，另验证显式候选 SDK 版本的既有 API。
这修正了测试对工作区候选清单的错误耦合，没有改 Builder 的默认行为或生产交付物。

候选版本尚未发布不是错误占用；但官方只读 CI **明确证实 Builder CLI 当日 1 缺失**，
是 Engine/CLI 后续发布的额外前置阻断，不得绕过 dev dependency verifier。
本轮继续只完成源候选组装与实施提交，不自动发布这个额外依赖。

## 交付文件

相对仓库根目录：

- `packages/task-engine-cli/src/entry.ts`、`usage.ts`、`commands.ts`：
  元信息、唯一命令/选项表、12 个叶命令与 stdout JSON、退出码、中断。
- 同目录 `config.ts`：独立配置位置、完整校验、三层来源、互斥原子单键读写。
- 同目录 `managed.ts`、`daemon.ts`：后台就绪、实际目录身份、进程出生证据、
  本地请求/响应证明、可信 status/stop、停止期间禁止新受理。
- 同目录 `data.ts`：SQLite 任务/事实/全部日志、游标、持久 CID 块、
  同锁离线历史与传递可达缓存清理、真实部分完成计数。
- 同目录 `execution.ts`：先落盘受理、独立执行域、业务输入信封、
  共享准备预算、完整释放及其持久证据、临时 CAR 副本释放。
- 同目录 `index.ts`、`bin.ts` 与 `apps/task-engine/src/main.ts`：
  薄入口；保留 `runBundle` 嵌入兼容，不把旧 helper 当作新 CLI 验证。
- `packages/task-engine/src/{bundle-engine,bundle,content,engine,logs,type-supervisor}.ts`：
  复用内核的受管宿主策略；默认嵌入语义保留。
- `packages/task-protocol/src/{json,projection}.ts`：
  可配置输入预算和已验证事实判等，避免把业务字段与元数据混合或降回固定输入预算。
- `packages/task-sdk/src/index.ts`：受管模式的日志逐条确认与终结等待。
- CLI 的 `test/{managed,data,dependencies,cli}.test.ts`、
  Engine 的 `test/identity.test.ts`、app 的 `test/main.test.js`；
  相关 CLI、Engine、SDK 与根 README。

上游 `src/car.ts` 和 `test/car.test.ts` 原样保留并参与校验。
原有 identity 原生加载测试在 Node 26 会因 `module.register` 弃用警告破坏 stderr 断言；
现按能力检测使用 `registerHooks`，旧 Node 仍保留原路径，不关闭 warnings。

## 准确代码快照

以下为已检查交付物的 Git tree/Blob OID，不是移动分支引用。
验收 primary 对应路径须与此表一致；任何交付物变更均须更新证据并重新提交实施门限。

| 路径 | 类型 | OID |
| --- | --- | --- |
| packages/task-engine-cli | tree | `5efb125a3890499d7c2f72d4a8753bc5c20cb936` |
| packages/task-engine | tree | `a3b0e9f427fd6216a82c8120f014ad2a20e39e28` |
| packages/task-protocol | tree | `f42369e70687e489d2563dadb99313b8f236d225` |
| packages/task-sdk | tree | `a13458a5508a51399750b3012b3c327c74294182` |
| apps/task-engine | tree | `06e609e56a04d8d46a8e74a0a08783205df531c4` |
| README.md | blob | `c4a12c5cb6d02702aeffdb5849ff8d27c7eeb623` |
| pnpm-lock.yaml | blob | `931cacacb0ed172d8a1a9c746d15b2559e0bd287` |
| packages/task-builder/test/init.test.ts | blob | `373bd9c9b55301ec77aa884cc603824ddf53eee5` |

例如用 `git rev-parse <primary>:packages/task-engine-cli` 核对 tree，
不把验证日志缓存或本文件外的可变链接当作交付身份。

## Spec→实现与实际测试

规范定位均为已接受的 [Spec v1.0](./ideal/task-engine-cli-spec.html)，下表不是第二套契约。

| 规范范围 | 实现位置 | 可复核证明 |
| --- | --- | --- |
| shared-io、shared-exits、shared-interaction；12 命令 | entry/usage/commands、两个 bin | managed.test：真实进程成功/无效/失败 JSON 与退出码、未知格式选项拒绝、帮助/版本、配置损坏时帮助仍可用；dependencies.test：原生进程禁止导入 SQLite 的元信息路径；app 薄入口测试 |
| shared-options；四个 config 动作 | config/commands | managed.test：15 个已知键排序、九项限制精确默认、Gateway unset、监听和调用地址独立、单键设置/重置及幂等、并发修改保留其他键、损坏/未知键/无效值不回退 |
| shared-local-server、server start/status/stop | data/managed/daemon | 两个真实并发 start 恰一成功；junction/symlink 同目录拒绝；真实状态/停止、启动中断与释放、默认拒绝在途任务、显式取消、旧 PID 不误停、未知身份拒绝、伪监听端不能证明实例且未收到实例密钥 |
| run、shared-execution、task await | execution、Engine Worker/组合内核 | 真 CAR 成功、业务失败、合法 null、含 requestId 等业务字段的对象及 70 KB 配置预算覆盖；真实父子任务；阻塞 Gateway 时 async 已返回且 query 可见，同 taskId 随后准备失败；准备耗时超过 3000 ms 执行预算仍成功；Worker 握手前预算到期不进入任务入口 |
| release-contract、shared-records | execution、durable domain、taskResult | 实际 Worker 业务 succeeded 且宿主释放延迟时 await 不提前返回；释放失败只返回 RESOURCE_RELEASE_UNCONFIRMED；同步 run 中断取消并等待释放，await 中断后任务继续 |
| server-restart-boundary | managed/repository | 实际结束 Server 进程后重新启动，遗留任务 failed/重启原因、同 taskId 不重跑；先前完整结果可再次取得，历史日志经过多次重启后仍报告 30 条实际删除 |
| task query、task logs | repository/managed/commands | ID 无匹配为空数组、按 ID 不分页；状态并集、时间含下界/不含上界、固定分页、游标绑定；30 条未 await 的日志完整保存，按追加顺序分页、不混入业务结果 |
| shared-ipfs-cache | DiskContent、persistentContent、openCarSource | Gateway 可选；缓存独立跨重启复用且没有额外网络请求；本地缺块拒绝隐式网络；完整 CID 校验；标准 CAR golden、坏 hash/codec、重复/缺失/不可达 DAG、Schema/文本和容量/取消跨消费者一致 |
| shared-cache-prune、data prune | directoryLock、pruneData | 共享根及子块保留、孤立块删除、空根清理、未知图删除前拒绝、组合先历史后缓存故障返回真实历史数量、历史单独不删缓存、before 按完成时间、清理中断保留真实已完成数量 |
| 实际磁盘耗尽 | Repository/DiskContent 的失败路径、managed shutdown | 独立真实 Server 的可控 ENOSPC 注入：异步受理后 Server 失败退出 1，stderr 报告原因，能确认的自有资源和状态落盘；没有填满本机磁盘 |
| 消费端边界、旧程序化兼容 | CAR 块源、runBundle | dependencies.test 遍历完整生产闭包排除 Builder/编译器/退休 CAR 包；cli.test 明确调用 legacyMain 兼容 helper，保留单次、多级子任务、异常和回收回归，不冒充安装后的新 CLI |

## 执行记录

2026-11-10，本机 Windows、Node `v26.13.0`、pnpm `11.22.0`：

1. manifest/工作区图变化后使用既有 Tencent registry 执行 `pnpm install --ignore-scripts`，
   没有覆盖 registry、回退官方源或添加测试工具。
2. 整合后定向构建：`pnpm --filter @silvermoon-work/task-engine-cli... build`，通过。
3. 整合后定向测试（在 `packages/task-engine-cli`）：
   `pnpm exec tsx --test test/car.test.ts test/managed.test.ts test/data.test.ts test/dependencies.test.ts`，
   初次整合检查 11/11 通过；随后完整 suite 又覆盖新增的原生元信息隔离断言。
4. 最终正常执行 `pnpm check`，退出 0，没有屏蔽 warnings 或绕过 hooks：
   包括格式、release lint/test、Turbo lint/typecheck/test/build、测试类型检查与 publint。
   CLI 33/33、Engine 234/234、Protocol 132/132、SDK 2/2 通过；
   app 入口、Builder、发布规则等其余工作区检查同样通过。
   publint 仅有既有 private app 的 main/测试文件建议，不作为错误或已修复声明。
5. Silvermoon worktree 检查通过；提交前还需 staged 检查，提交同步后为准确版本 append submitInner。
   本轮测试进程按其确切身份/PID 清理，生成数据目录均为本任务自有路径。

版本候选组装后另行实际执行：

- `pnpm install --ignore-scripts`：通过，锁文件未变。
- 在 Builder workspace 执行 `pnpm exec tsx --test test/init.test.ts`：4/4 通过。
- 再次正常执行根 `pnpm check`：退出 0，包含新清单和上述严格兼容断言，
  没有改变业务 deadline、跳过测试或屏蔽 warnings。
- 四个候选精确 tag 查询均为空；官方只读 registry 验证 run `42835231424`
  给出真实缺失依赖结果，未把该 failure 当作发布就绪。

## 剩余部署前置条件与风险

- 没有在本机执行 Linux/macOS 或 Node 22/24 的实际运行矩阵，不伪称已有跨平台外部验收；
  元信息原生加载守卫与旧 Node 兼容路径已保留，仍须查看精确提交 CI。
- 本轮没有发布。四个准确 canary 候选已由父代理选择，但仍须最终发布授权与逐包前置验证。
  Builder CLI `0.1.0-canary-261110-1` 的准确 dev 依赖缺失必须先另行协调；
  不自动发布依赖，不覆盖已存在版本。若清单或代码变化，本表及实施门限须重新对齐。
- 新 SDK 行为只进入新构建任务包，不能热更新不可变旧包；生产端报告日志丢失时，
  Engine 持久记录不完整错误，logs/最终结果不伪造完整成功。
- 本轮仅面向可信执行环境，不新增多租户隔离、远端生命周期管理或任意任务副作用回滚。
- canary 只能经授权单包 tag 触发 GitHub Actions Trusted Publishing；
  需要精确 main push CI、同一次 tarball 验证和真实安装 smoke。manual dry-run、源码测试、
  本文件以及 checkbox 均不替代这些外部证据，D 项继续未勾选。
