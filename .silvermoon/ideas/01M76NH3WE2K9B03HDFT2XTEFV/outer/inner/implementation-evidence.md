# 实施设计与证据

## 计划与验证顺序

1. I-S02 / I-AC02 优先：提取无 Engine 生命周期依赖的公共内容能力；使用现有 UnixFS importer/exporter，验证非默认分块文件及携带元数据的目录。task folder 携带路径到 CID 的绑定和原始块，离线 CAR 编码复用原 DAG；逐字节核对展开文件，拒绝修改与缺块。以复制完整目录后不提供内容端口的测试证明自包含。
2. I-S02 / I-AC02：接入通用 imports、冲突拒绝和精确文件清单；统一完整获取、哈希验证、唯一块计量和逻辑路径预算。公共内容配置与原子块发布不混入 Engine 数据库，验证默认共享、覆盖、并发写和关闭不删块。
3. I-S01 / I-AC01：SDK 仅接受本 Context 的 SpaceRef，并转换协议引用；Engine 解析静态目标并固定实际 CID。检查持久化事实格式，派发前原子保存 parentRunId + key 的意图、目标 CID、子 requestId 和 deadline；响应丢失和崩溃重试沿用身份。
4. I-S01 / I-AC03：移除 authorizeChild，保留具体资源入口约束及独立子 Run；明确拒绝 output，测试取消、超时、预算、内外部引用及断源执行。
5. I-S03：更新 schema、调用示例、迁移与不兼容数据域说明；运行精确测试和 pnpm check，只登记真实输出。所有 I-* 完成后执行 Silvermoon 检查、普通提交和 primary 同步，再记录准确 submitInner，等待主 Agent 审批。

## 已实现的数据与调用边界

- `task-content` 独立于 Engine，提供显式内容端口、验证、完整遍历、取消/超时和共享内容目录。Builder 不依赖 Engine。配置为 Windows `%LOCALAPPDATA%\TaskContent\config.json` 或其他平台 `~/.config/task-content/config.json`，仅含 gateway / dataDir，可由 `TASK_CONTENT_CONFIG` 选择；默认内容目录 `~/.silvermoon.work/content` 不含 Engine 数据库。
- 目录产物保留 `.task-imports.car` 原始块，task.yaml 的 imports 记录路径到精确 CID；include 仍为完整文件清单。展开文件不经文本规范化，离线 car 比较每个文件并校验原始闭包，再仅重建父目录的 DAG 链接。原节点元数据与分块不改写；侧车不进入最终任务 DAG，最终 CAR 按唯一 CID 遍历。
- 共享块以唯一 pending 文件完整写入并 fsync，再硬链接原子发布；同 CID 并发发布只验证既有内容。没有跨进程下载去重的虚假承诺，没有自动共享块 GC。一个客户端关闭不删除已发布块或关闭调用者注入的来源。
- SDK 仅转换当前 Context 产生的真实 SpaceRef，Engine 接受规范化静态 SID/path，拒绝 output。父 DAG 内与完全外部的引用同入口；资源入口约束及 Task 准入/预算保留，不再设置 authorizeChild。
- 子调用在 submission.preparing 原子事实中保存 invocationVersion、来源、targetCid、原意图、稳定 requestId 与 deadline；该事实写入后才开始准备和派发。已有记录只重用固定 CID，不再解析来源路径。旧 composition 事实没有新身份标记时明确要求新数据域，projection / SQLite 主版本校验未放宽。
- Engine 全静态 DAG 先验证全部块，再进行独立逻辑路径/文件/字节校验；内存保留按唯一 CID 共享。失败、释放或元数据 eviction 不自动删除共享块；动态目标在调用时完整准备，不保留 prefetch/lazy 双语义。
- 既有离线私有缓存清理通过实例记录的 contentDataDir 只读遍历共享内容，从而验证保留根，但删除范围仍仅限该 Engine 的私有文件/数据库，不把共享目录纳入旧 GC。保留了原有保守标记失败边界。

## 已执行的精确验证

环境为 Windows、Node v24.11.1、pnpm 11.22.0。恢复依赖前实际检查 `pnpm config get registry` 与 `npm config get registry`，二者均为 `https://mirrors.cloud.tencent.com/npm/`；安装未传 --registry。首次 chosen validation 发现缺少工作区依赖，之后新增/调整 manifest 才再次安装；未修改远端 registry。

| 命令 / 证据入口 | 实际结果 |
| --- | --- |
| `pnpm --filter @silvermoon-work/task-content... build` 及最早 DAG proof | 通过；777 字节分块、非 raw leaves 文件与目录的 mode / mtime 和 CRLF 原字节，在新无来源 store 中均保真 |
| `pnpm --filter @silvermoon-work/task-content test` | 4/4 通过；包括不合作注入端口的超时/取消、默认/独立配置、4 个独立进程并发发布及关闭不删共享内容 |
| `packages/task-builder/test/imports.test.ts` 初次物理搬运验证 | 通过；复制完整目录后清空来源，不提供内容端口仍可生成并读取 CAR，原始文件/目录 CID 相等，共享文件块只计一次，修改与缺失侧车明确失败 |
| `packages/task-builder-cli/test/imports.test.ts` | 1/1 通过；CLI 默认公共配置构建、搬运完整目录并删除原工程与内容目录，配置故意改坏后 car 仍纯离线成功；import 内额外新增文件被拒绝 |
| `packages/task-builder/test/imports.test.ts` 最终精确回归 | 2/2 通过；补充 include 冲突、目标重叠、缺少内容来源，以及同一 CID 两次展开仍分别消耗逻辑字节预算的拒绝证明 |
| `packages/task-engine-cli/test/car.test.ts` | 5/5 通过；Builder reader 与 Engine CLI offline source 均接受保留原始 777 字节分块文件/目录 CID 的 CAR，并保留 mode / mtime；其他损坏、闭包与容量拒绝用例保留 |
| `packages/task-engine/test/{composition,bundle,gateway-resources}.test.ts`（从 task-engine workspace 执行） | 34/34 通过；包括真实 imports 的嵌套/共享静态闭包断源执行、完全外部 SpaceRef、实际丢失 IPC ACK 后重试、恢复身份、旧调用/伪造/可写引用拒绝、取消/超时/配额及原资源网关限制 |
| `packages/task-engine/test/{drain,multi-gateway}.test.ts` | 14/14 通过；完整准备后 drain 仍可派发并耗尽最后父 Run 的并行嵌套子调用；多来源和 hint 继续共用 CID 身份，冷读取保留逐来源失败诊断，元数据 eviction 不删除完整内容 |
| `pnpm typecheck:tests` | 已通过；最终全仓校验仍须再次覆盖最终候选 |

验证过程中修复了新测试将 sibling 子测试排到正在等待的父测试中造成的调度死锁，未用放宽超时或跳过测试掩盖。此前 `pnpm check` 的格式、发布映射断言和新增 lint 错误均按真实失败处理并修正；它们不作为通过证据。最终全仓命令的结果补记于下节。

旧懒加载测试曾等待“已准备父 DAG 中的子根再次下载”，以及把元数据 eviction 当作删除内容；本轮完整准备/无自动 GC 下这些前提不再成立。改为通过独立 preparation 端口延迟子目标准备，并使用真正冷缓存验证来源错误；没有关闭完整获取或放宽容量。受管 CLI 的旧缓存位置断言、默认拒绝子调用断言和新增配置项计数也随契约迁移；共享目录不能等同 Engine 数据库目录，并增加启动拒绝回归。

实施期间 primary 并发推进到 `7e100016a51a9364e8824b0ce89c0dc0fb4b9e3c`（IPNS 功能与其他 idea 事件）。陈旧分支的 Silvermoon 历史检查曾如实拒绝；先 stash 完整自有候选、fast-forward primary、apply 保留候选，再合并 package/lock 两处冲突，同时保留全部 IPNS 依赖及 CLI `0.2.0-rc.8` 版本，没有改写历史。合并后的 `silvermoon check --worktree --audience agent` 已通过，理想世界无 diff。

## 7e10001 基线的完整全仓验证

`pnpm check` 已实际退出 0：Turborepo **44/44 tasks successful**，其中 8 个缓存命中；用时 **25m52.618s**。随后完整测试类型检查与所有工作区 publint 均通过。汇总 671 个测试条目，670 通过、1 个既有 Linux-only 用例在 Windows 按平台跳过，0 失败；没有新增跳过或放宽既有测试超时。

| 验证组 | 实际测试条目数 |
| --- | --- |
| release scripts | 21 |
| protocol / SDK / content | 132 / 9 / 4 |
| Builder / Builder CLI | 54 / 23 |
| Engine / storage | 249 / 53 |
| Engine CLI / HTTP / Server / private app | 91 / 19 / 15 / 1 |

该次真实输出位于本工作区忽略目录 `.cache/dependency-check-verified.log`，SHA-256 为 `c186e02ed9e8b2707326c328ea6f2701661403253a518326f6b8a5c0739fe8d2`。原始日志是本机复核便利，不是新的验收权威；上述受版本控制的测试与命令可重现结果。全仓输出同时包含非默认 UnixFS 原根离线消费证明、完整准备后的多来源/断源证明，以及受管 Server 配置、独立目录、离线清理和数据库/内容同目录拒绝回归。

全仓结束后再次执行 `pnpm format:check`、`pnpm typecheck:tests`、`git diff --check HEAD` 均退出 0。publint 对既有 private app 的 suggestions 未被当作失败或擅自修复。

## 门限与剩余边界

上述完整验证后，primary 再推进到 `9730efa894663dbe16b69492b14fc4601a7e5164`，包含已验收的 IPFS CJS module hook 实现。再次完整 stash 自有候选、fast-forward、apply；仅合并 runtime semver/imports 和 README 两处冲突，同时保留 Node 22.15+ 宿主要求、bundleModuleURL、独立 bootstrap 和 verified-source hook，不回退并发功能。I-AC* 已重新置为未完成，须以该集成候选重新通过测试和 `pnpm check` 才提交；此前通过结果不冒充本次集成证据。理想世界保持不变，主 Agent 负责实施门限。

合并后 `pnpm build`、`pnpm typecheck:tests`、`silvermoon check --worktree --audience agent` 均已通过；从 task-engine workspace 执行 `composition.test.ts`、`bundle-module.test.ts`、`bundle-contract-host.test.ts`、`drain.test.ts` 的组合选择器，**64/64 通过**。真实 imports、断源、独立调用与新 module hook 的内置模块、拒绝路径、模块身份/缓存和物理退出契约同时保留。完整集成检查仍须完成后才同步门限候选。

本轮保留现有受支持内容 profile：SHA-256 raw / DAG-PB 的普通文件和非空 UnixFS 目录；不悄悄规范化不支持的内容。共享目录没有自动 GC 或跨进程下载去重承诺，Worker 也不是通用 OS 权限沙箱。

部署、精确 RC 版本调整、tag、真实 npm 发布和 office-ubuntu SSH smoke 均未开始。后续须先审阅逐包 RC 与依赖顺序，新 `task-content` 的 Trusted Publisher 绑定需在真实发布前具备；本地通过不替代外部部署证据。
