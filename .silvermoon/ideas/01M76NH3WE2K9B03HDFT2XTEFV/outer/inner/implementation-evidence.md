# 实施设计与证据

以下至“门限与剩余边界”的记录属于旧实现的历史证据，不能替代本轮新增 IpfsStore 对象要求的验证。本轮候选见末尾“对象重构候选”，尚未提交前不以历史 acceptInner 或通过数推断门限。

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

## 并发模块加载集成与耦合修复

上述完整验证后，primary 再推进到 `9730efa894663dbe16b69492b14fc4601a7e5164`，包含已验收的 IPFS CJS module hook 实现。再次完整 stash 自有候选、fast-forward、apply；仅合并 runtime semver/imports 和 README 两处冲突，同时保留 Node 22.15+ 宿主要求、bundleModuleURL、独立 bootstrap 和 verified-source hook，不回退并发功能。合并时先将 I-AC* 重置为未完成，不把旧结果冒充新集成证据；下节记录重新完成的真实全仓结果。理想世界保持不变，主 Agent 负责实施门限。

合并后 `pnpm build`、`pnpm typecheck:tests`、`silvermoon check --worktree --audience agent` 均已通过；从 task-engine workspace 执行 `composition.test.ts`、`bundle-module.test.ts`、`bundle-contract-host.test.ts`、`drain.test.ts` 的组合选择器，**64/64 通过**。真实 imports、断源、独立调用与新 module hook 的内置模块、拒绝路径、模块身份/缓存和物理退出契约同时保留。

检查共享端口所有权时补充了“两个 reader 共用一次获取，只取消其中一个”的精确用例；它在修复前实际失败，因为首个请求的 signal 错误地拥有共享获取。现改为客户端 lifetime 拥有获取，各 reader 仅取消自己的等待；宿主仍可通过 close 终止自己拥有的获取。`pnpm --filter @silvermoon-work/task-content test` **5/5 通过**，保留跨进程原子发布、无自动删除与超时/取消用例；该耦合修复已纳入下列最终全仓结果。

## 最新集成候选的最终全仓验证

冻结代码提交 `e56556c30c965caff6f47acaa30c4552262cb5f5` 上执行 `pnpm check`，**实际退出 0**：44/44 Turborepo tasks successful，8 个缓存命中，用时 **24m6.671s**；最后的完整测试类型检查与所有工作区 publint 也通过。

共 **679** 个测试条目，**678 通过、1 个既有 Linux-only 用例在 Windows 按平台跳过、0 失败**。分组数为 release 21、protocol 132、SDK 9、content 5、Builder 54、Builder CLI 23、Engine 256、storage 53、Engine CLI 91、HTTP 19、Server 15、private app 1。没有新增 skip，没有放宽既有测试超时。

原始输出为本工作区 `.cache/dependency-check-candidate-final.log`，SHA-256 `806cad5c5846cec0479d67da68111e0c56912ec25da94c012a812daeb3fdfc80`。这次检查同时覆盖最终共享 reader 取消修复与并发 module hook，而不是只沿用 7e10001 基线的早期结果。

之后普通 merge 提交 `3265e18cb0b28cd007692597b7529e54c48d7bd1` 保留 primary `b6044673239005bd219494972e9ca5822d31dd05` 的并发部署文件和四个包的 RC 版本元数据。差异已逐路径核对：没有改动本次运行代码或测试；这些是并发 idea 准备的版本，不是本 idea 自行调整或发布的 RC。后续只完善本阶段证据、镜像 checklist 与文档的未发布提示。

合并元数据及文档后，`pnpm format:check`、`pnpm test:release`（21/21）、`pnpm typecheck:tests`、`pnpm lint:package`、`git diff --check HEAD`、`silvermoon check --worktree --audience agent` 均再次退出 0。

## 门限与剩余边界

上述旧候选曾完成当时的 I-* 实施与验证，不表示新增对象要求已完成。准确 candidate 的 primary 可达性及 submitInner 以普通 Git 同步、事件日志和新鲜 Silvermoon 观测为准，不以 ledger 勾选代替验收。

本轮保留现有受支持内容 profile：SHA-256 raw / DAG-PB 的普通文件和非空 UnixFS 目录；不悄悄规范化不支持的内容。共享目录没有自动 GC 或跨进程下载去重承诺，Worker 也不是通用 OS 权限沙箱。

部署、精确 RC 版本调整、tag、真实 npm 发布和 office-ubuntu SSH smoke 均未开始。后续须先审阅逐包 RC 与依赖顺序，新 `task-content` 的 Trusted Publisher 绑定需在真实发布前具备；本地通过不替代外部部署证据。

## 对象重构候选

本轮以 `e0e4f0043fe9f77ff1335b41d9db3774001fcb20` 为基线；不改 Ideal、不自批、不真实发布、不 SSH，也不修复其他 Silvermoon 源码。

### 实际边界

- 按用户最终命名将未发布 `task-content` 更名为 `@silvermoon-work/ipfs-store`，不保留兼容包。新增 `IpfsStore` 负责经过验证的节点读取、完整准备、唯一块预算、存储、来源去重、取消与生命周期；`read()` 不默认聚合整个文件。`scope()` 是同一 backing store 的独立 reader，不拥有父对象，预算不能抬高父级容量。Engine close 只关闭自身 scope；同一个 store 可供 Builder 和两个 Engine 并发消费。
- `ipfs-store` 移除对 task-protocol 的依赖；不再导出任务路径展开和 `linkContent`。原子存储位于 `storage.ts`，配置读取仅保留为 `node` 的显式宿主 helper，导入与构造均不读配置。内存和磁盘后端都将共享获取的取消权留给自身 lifetime，单 reader 仅取消自己的等待。并发 close 共用 Promise，等待本对象发布收尾，不删除既有共享块、不关闭调用者源。
- Builder 的路径政策与展开位于 `content.ts`，packaging graft 位于 `dag.ts`；只重建祖先，保留原始 CID、元数据与分块。Engine BundleCache 不再维护另一套 retained blocks／下载／DAG 函数拼装，改为对象的 `prepare/read/block`。受管 CLI 的 DiskContent 不再自行下载或写第二套缓存，借用对象并保留 raw gateway 的只读、本地／SQLite 资源域边界。
- 曾尝试让 Engine CLI 引用 Builder 的 graft；release closure 测试真实拒绝了引入编译器的生产依赖。已撤回该依赖，改为只校验规范补集和 import 原根：核对非 import 文件 CID、目录规范字节／元数据、链接名称与 Tsize，不构造替换后的 DAG。后续 21/21 release 测试与 5/5 双离线 reader 用例已通过，未放宽 closure 断言。
- 包名、目录、内部依赖及 release mapping 已一致更新为 `ipfs-store`；不改 manifest 版本或选定新的 RC 计划。schema 标识和原任务调用契约不改；deprecated 低层 ipfsClient 只是宿主适配，实际应用统一使用 IpfsStore，不恢复旧格式双协议。

### 本轮精确验证

用户随后提供了 `@silvermoon-work/ipfs-store@0.0.0-stage` 占位与 Trusted Publisher 绑定成功的配置证据；由此旧 task-content 首发初始化阻塞不再是当前阻塞。本 Agent 未创建占位、未发布、未改任何历史版本或 dist-tags；也未把该占位写入运行依赖。当前 manifest 版本只保留实施基线，不代表新发布计划已审。真实 RC 的版本／tag、工作流、npm environment 直接 publish 权限与 exact-commit CI 须在新实施门限和父 Agent 的新逐包计划审阅后重新核对。

包目录迁移后的首次 build 如实报缺少依赖；pnpm 的旧工作区安装状态和 optimistic-repeat 检查错误地将空 payload 判为已安装。普通 install、单独 force 和关闭 optimistic-repeat 各自不足，最终 `pnpm install --no-optimistic-repeat-install --force --prefer-offline` 从本地 store 复用 432 包、下载 0，重建 payload 后恢复。未手改依赖文件或 registry；随后 `pnpm build`、`pnpm typecheck:tests`、新名 `@silvermoon-work/ipfs-store` 的 11/11 对象测试，以及 CLI data 6/6 均实际通过，包含流取消、普通目录取消、不合作来源的并发 close、宿主 SQLite 只读来源适配与资源所有权。

依赖 manifest 移除 task-content → task-protocol 后才执行 `pnpm install`；此前实际确认 Node `v24.11.1`、pnpm `11.22.0` 与 npm/pnpm registry 均为 `https://mirrors.cloud.tencent.com/npm/`。未传 `--registry`，未修改 SSH 或 CI registry。

已实际通过：`pnpm build`、`pnpm typecheck:tests`、内容对象测试及 Builder imports（9/9 与 3/3）；Engine 对象、composition、multi-gateway、bundle、module hook、drain 组合中，49 项既有回归通过，新共享对象测试初次因 fixture 缺 `binary: []` 失败，补齐显式字段后该测试单独通过；并未改生产 schema。CLI 的 CAR／data／raw gateway 14/14、Builder CLI imports 1/1，以及上述最终离线 reader 5/5 与 release 21/21 均通过。后续追加的流取消／关闭用例及最终全仓结果另行补记，尚不以这些局部结果勾选 I-AC02/I-AC03。

| 当前证明入口 | 观察边界 |
| --- | --- |
| `packages/ipfs-store/test/{node,store}.test.ts` | 公共配置默认／覆盖、跨进程原子发布、冷缺失验证缓存、本地命中零联网、无 gateway 缺块、通用非任务名称、文件流／目录取消、共享获取去重、不合作来源 close 与独立 reader 所有权 |
| `packages/task-engine/test/ipfs-store.test.ts` | Builder 和两个 Engine 真正接收同一 IpfsStore 实例，两个 Engine 完成独立 Run 后仍可读取原对象；另一个本地实例完整准备同目录内容 |
| `packages/task-builder/test/imports.test.ts`、`packages/task-builder-cli/test/imports.test.ts` | 无原工程／缓存的完整任务目录搬运，原 CID／分块／mode／mtime 保真，侧车完整性、修改和额外文件拒绝，以及 portable path／graft 属于 Builder |
| `packages/task-engine-cli/test/car.test.ts`、`scripts/release.test.js` | 双离线 reader 原根保真、规范非 import 补集、错误目录元数据／Tsize 拒绝、唯一块 CAR，Engine 生产闭包仍无 Builder／编译器 |
| `packages/task-engine/test/{composition,bundle,multi-gateway,drain,bundle-module}.test.ts` | 完整静态准备后断源、嵌套／共享子任务、动态完整准备、固定身份恢复、取消／超时／预算、hint 来源诊断与并发模块 hook 不退化 |
| `packages/task-engine-cli/test/data.test.ts` | 宿主将已保留 output 暴露为通用只读源，store 不认识 SQLite；本地命中不访问上游，close 不转移调用者源所有权 |

静态检查确认 `packages/ipfs-store/src` 没有 task-protocol、TaskError、task bundle 路径规则、graft、CAR 编解码或 SQLite 的依赖／业务处理逻辑；源码／manifest／lockfile／release mapping 中没有旧 task-content 包引用。公共配置仍使用既有 content namespace，不是兼容包。只读查看确认 `publish-npm.yaml` 的 `*-v*` 路由和 `npm` environment 可容纳新映射，无需改工作流；这不是对远端绑定权限或未来发布可成功的独立认证。

第一次全仓运行在审查中发现 Engine 的低层资源读边界需要将独立 `ContentError` 翻译为原有 `TaskError` 容量事实，因而主动停止，不登记为通过。该翻译与 bundle 准入边界保持一致，不让 store 重新依赖任务协议；新增独立回归验证 `cache.block.get()` 超限仍为 `capacity_exceeded`。随后同实例双 Engine 与容量回归 2/2、既有 gateway-resources 3/3、`pnpm build` 和测试类型检查通过，重新启动最终完整 `pnpm check`，结果以其单独日志为准。

随后一次完整尝试真实失败于既有 `bundle-special.test.ts`：高层 store 提前拒绝 UnixFS symlink 后，被 Engine 误归为 `bundle_fetch_failed` 而不是原 `invalid_bundle`。store 现提供无任务依赖的 `unsupported_content` 分类，Engine 在任务准入边界将其翻译为 `invalid_bundle`；没有放宽原测试或接受 symlink。修复后 bundle-special／bundle／同实例 store／composition／multi-gateway／gateway-resources 组合 **43/43**，store **11/11**，`pnpm build` 和测试类型检查均实际通过。上述失败日志不作为通过证据；最后的完整命令单独记录。

更后的全仓尝试如实通过 Engine **258/258**，但 CLI 暴露两处问题，未登记通过：

- 旧 DiskContent 可以保留经过 SHA-256 验证的 DAG-CBOR 块，原 store 的 raw／DAG-PB 高层 profile 错误地限制了通用低层块 `put`。现在将哈希完整性与 UnixFS profile 分开：低层按 CID 验证任意 codec 的 SHA-256 块；`read`／完整 UnixFS prepare 仍明确拒绝不支持的内容图，不新增隐式 DAG-CBOR 准备或 CAR 处理。新增对象回归及原 recursive gateway 的“缺后继／only-if-cached 不联网”用例通过。
- 已有执行中断用例以模块初始化后 400ms 发送 SIGINT，重构后落入尚未收到提交 ACK 的窗口，真实输出是正确的 `SUBMISSION_UNKNOWN`，不能伪改为取消成功。测试现在在真实 `/cli/run` 成功 ACK 后才启动原有 400ms 计时，以验证其本来声称的“执行取消”；不放宽时限、不改变生产未知提交语义。等待命令和启动取消仍使用原计时方式。

修复后 store **12/12**、recursive gateway + 双离线 CAR **18/18**、`pnpm build` 和测试类型检查实际通过；从 CLI workspace 以 `tsx --test --test-name-pattern="managed installed entry: lifecycle" test\managed.test.ts` 执行既有完整 lifecycle 选择器，六个阶段与父用例共 **7/7** 通过（231.084s），包含实际执行取消、进程退出、重启恢复、离线清理和配置，不跳过失败阶段。最终全仓仍须重新完成。

下一次全仓在既有、未修改的 `domain-contract.test.ts` 的 forced-exit 观测等待超时而失败；其 Engine 协调器与测试均无本轮 diff。原选择器隔离复跑 **1/1** 通过（用例 1.442s），未放宽时间阈值、未跳过或修改该测试，也不以隔离结果替代全仓；相同候选重新执行完整命令，保留前次失败日志以供复核。

### 本轮最终完整验证

相同代码候选的最后一次 `pnpm check` **实际退出 0**：Turborepo **44/44 tasks successful**，其中 **27** 个缓存命中，Turborepo 用时 **24m47.065s**，完整命令墙钟 **26m16.491s**。格式、release lint 与 **21/21** release 测试、全部工作区 lint／typecheck／test／build、最终测试类型检查与所有工作区 publint 均通过；private app 既有 publint suggestions 未被当作失败或额外修复。

共 **690** 个测试条目，**689 通过、1 个既有 Linux-only 用例在 Windows 按平台跳过、0 失败**。分组数为 release 21、Protocol 132、SDK 9、IpfsStore 12、Builder 55、Builder CLI 23、Engine 258、storage 53、Engine CLI 92、HTTP 19、Server 15、private app 1。没有新增 skip，没有放宽既有测试或生产超时阈值；执行取消用例仅改为等待真实提交 ACK 后开始原计时。

成功命令的真实输出为本工作区忽略目录 `.cache/ipfs-store-check-complete.log`，SHA-256 为 `ed78508f62081095c17a0f5f0e6dcea0d73192b3587c69b5b649988fa3096a6e`。其他 attempt 日志只是失败／停止记录，不能替代这次成功结果。该输出是本机复核便利；受版本控制的代码、测试及完整命令才是可重现证明。

全部 I-* 实施与证据现在完成，ledger 已镜像更新；Ideal World 没有 diff，历史 CID、旧事实、占位版本及 dist-tags 未修改。普通提交、primary 可达性和准确 submitInner 仍以 Git 与新鲜 Silvermoon 观测为准；本 Agent 不记录 accept，不恢复 RC、SSH 或真实发布。剩余外部门限为父 Agent 对新实现及新逐包计划的审阅，以及未来发布时对精确版本／tag、CI 和 Trusted Publisher 直接权限的独立核对。磁盘无自动 GC、无跨进程下载去重承诺、UnixFS profile 限制和旧低层注入适配边界保持文档所述。

同步准备时 primary 已并发推进到 `f8ae6ed39f95f0003edd9dfb7c6b161aaac43546`，仅新增另一个 idea 的六个元数据／设计文件，没有运行代码、manifest、lockfile 或测试变化。Silvermoon 最初如实拒绝缺少该已集成 idea 的旧 snapshot；完整 stash 自有候选、刷新 primary、普通 fast-forward 后 apply，未发生冲突、未重写历史、未删除其他工作。恢复后的 `silvermoon check --worktree --audience agent` 已退出 0；本 idea Ideal 仍无 diff。这不是新代码验证的替代：上述完整检查覆盖的运行代码与测试保持原样，后续仅补本节同步证据。
