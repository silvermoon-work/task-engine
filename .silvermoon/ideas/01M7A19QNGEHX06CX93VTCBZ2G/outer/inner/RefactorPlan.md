# IPFS DAG 事实源重构：分阶段迭代计划

本文件支持 [Implementation](Implementation.md)。按用户术语纠正，执行历史以 RunHistory 为单位，不建立独立 TaskHistory。范围包括强引用 Payload、RunHistory/交付 DAG、请求与全域恢复事实、受管理根提交、可重建查询索引、Worker CID 能力以及按需文件树。风险与需确认的前置决策见[架构评估](ArchitectureReview.md)。这是执行计划，不是已完成证据。

## 迭代原则

1. 先证明持久化/恢复，再切换业务流量；不从“先改 input 字段再慢慢补存储”开始。
2. 每阶段产出可独立验证的小提交，依赖按下表推进；不用双写两套权威事实，不并行维护两套公开 V1 协议。
3. P1/P2 可添加尚未接入生产的能力；只有 P4 才切换现有协议。测试 fixture/独立实验数据域不是生产兼容层。
4. 新旧存储使用显式隔离的目录/域，保留旧数据只读，不自动迁移或删除；已接纳新业务后不得用回滚代码恢复旧数据库继续服务。
5. 构想验收前不实施。P0 里的同步和验收是进入实施的条件，确认某条局部设计不代替它。

## 依赖与里程碑

| 阶段 | 前置 | 主要产物 | 退出门槛 | 对应契约 |
| --- | --- | --- | --- | --- |
| P0 冻结严重取舍 | 无 | R-01 至 R-04 决定、权威边界、历史与隐私范围 | 同步后的准确构想修订验收 | 准备阶段 |
| P1 引用/codec 与访问基础 | P0 | ipfs-access、ipfs-payload、Store 结构化 DAG 支持 | 规范向量、强闭包及 file/directory DU 测试 | I-S01、I-AC01 |
| P2 根提交与 pin 内核 | P1 | registry、单 writer、staging/head 提交与恢复 | 全故障矩阵，local 与 Kubo 一致 | I-S02、I-AC02 |
| P3 DAG 核心事实与查询投影 | P2 | RunHistory/Delivery/请求事实、checkpoint、可重建 SQLite | 删除查询索引后等价重建，不重执行 | I-S02、I-AC02 |
| P4 一次性纵向协议切换 | P1、P3 | Builder/SDK/Engine/HTTP/CLI 三通道新协议，移除 Space | 当前行为回归、完整接纳/交付与新域启动 | I-S03、I-AC03 |
| P5 按需只读树形工具 | P1 | 独立 ipfs-tree，不注入 SDK 依赖 | read/list/resolve 和未使用时的包体隔离 | I-S03、I-AC03 |
| P6 集成压力与交付候选 | P4、P5 | 冷启动、故障、共享执行、索引恢复证据 | 所有验收及 pnpm check 通过，才提交实施验收 | I-AC01 至 I-AC03 |

P5 不依赖 P2/P3/P4，可在 P1 完成后独立实现；主路径仍是 P0 → P1 → P2 → P3 → P4 → P6。阶段编号不是人为依赖。

## P0: 冻结重大选择，不写生产代码

- R-01 已确认方案 A：Store 的耐久 SQLite 协调元数据属于必要备份，查询 SQLite 为高效可重建索引；P2 按此实施，不自建另一套文件日志。
- RunHistory 单位已经确认；只需确认 Run 前/跨 Run 事实的根集合及关闭 Run 的历史保留/回收语义。
- 确认不完整入站申请如何持久化，与正式强 Payload 的准入边界。
- 确认核心 DAG 的私有存储/公开分发范围。
- 将已确认 DAG-first 要求与已被取代的弱引用文本彻底分开，不残留“外部缺失引用仍可成功交付”的双重规范。

只有这些决定及准确构想验收就绪后才进入 P1。公开方法名、内部文件划分等细节由实施者按现有模式收敛。

## P1: 先建立可验证的底层能力

### 改动范围

- 新增 ipfs-access 的轻量接口与 file/directory DU，树形读取仍限 raw/UnixFS。
- 新增 ipfs-payload 的 ContentRef、TypeBox 扩展、data/cidPaths 验证与双向转换，提供纯 DAG-CBOR 编解码入口。SDK 的普通 JSON 转换路径不因此强制引入 Store 或文件树。
- 扩展 ipfs-store 的块写入、codec 遍历、闭包 prepare、暂存、CAR 导入导出等路径，覆盖 DAG-CBOR → DAG-CBOR/DAG-PB/raw 混合图。
- 固定规范编码向量和受限 JSONPath profile，所有运行时共享同一逻辑，不在 HTTP/Worker 各写一套。
- 新包进入 workspace/catalog 和 release-packages 映射；不发布、不推 release tag。

### 验证与停止条件

- 数据、引用与 DAG 字节/CID 往返；普通 CID 字符串及同形对象不变；嵌套/混排 DU、空数组、可选字段、特殊键和无效 Schema 有定向用例。
- 路径漏标/多标/超预算、非法 CID、未知 codec、错误哈希、深度/块数/字节超限均明确失败。
- 对真实链接做闭包遍历；仅把 CID 字符串存进 CBOR 的假实现必须被测试识别。
- 不需要 Engine 就能运行包级测试；相同规范输入在新进程得到相同输出字节/CID。
- 块解析器和文件读取器职责分离；把结构化块当文件/目录的路径明确报 unsupported。

未通过时不做持久化权威切换。现有生产路径保持原行为。

## P2: 用合成事实证明“提交已生效”可恢复

### 改动范围

- 在独立耐久 SQLite 中实现已确认的 Store registry，支持 expected-head/sequence、commitId、排他 writer 与耐久恢复；与可重建查询库隔离，完整业务内容保留在 DAG。
- 复用现有多 owner、外部 pin、staging 和未完成意图保护；改为管理结构化逻辑根，不绕开 Retention 的 fail-safe sweep。
- 提交顺序：保护依赖与候选 → 校验完整闭包 → 确认递归 pin → 提交权威 head → 投影追赶 → 释放已不需要的保护。
- 为异步存储定义 awaitable 的提交接口和串行队列，不伪装成当前同步 append。

### 验证与停止条件

- 在架构评估的每个边界进行可重复故障注入与真实子进程终止；恢复只能得到旧提交或新提交，不能出现半个批次。
- 两个 writer 从相同 head 提交，只允许有排他权且前置版本匹配者生效；迟到的 RPC 不得激活过期 writer。
- pin RPC 已成功但响应失败可幂等查证；清理不移除其他 Engine/外部应用仍持有的根。
- Kubo GC 与正在导入的混合 DAG 并发时，未发布块受 staging 保护；测试仅使用隔离临时 daemon，不操作共享运行中的 GC。
- 记录闭包验证、pin RPC、写块与提交延迟，固定支持的预算和超限行为。

P2 不依赖真实 Task 运行即可验证；不能以“成功 pin 一次”代替该门槛。

## P3: 将核心事实放入 DAG，SQLite 变成投影

### 改动范围

- 以 RunHistory 聚合不可变执行记录及有序事件，Task 只是请求/匹配/观察投影，不复制一套 TaskHistory。保留资格观测、准入下界、消息路由及状态、结果/退出/清理证明和请求幂等身份。
- 权威数据域根覆盖全部必须恢复的记录，而非只含已创建 Task。观察 DTO 的当前查询 timestamp 不进入事实哈希。
- 按 R-02 实现 RunHistory 有界段、全域 checkpoint 与受管理根集合；保留期内不截断必要执行历史，不逐事件复制全部历史数组，也不让域级 previous 强链使过期 Run 永久可达。
- SQLite 保存 CID、状态、时间等可重建索引与校验边界。投影携带 head/sequence，重建后原子切换；不可用时明确拒绝依赖当前投影的查询，不假装返回完整空列表。
- 异步 commit 贯穿事实路径。核心 replay 不做网络副作用，不触发 Worker；有事实后再由恢复策略决定新的动作。

### 验证与停止条件

- 在关闭 Engine 后移除测试专用查询 SQLite，从保留的权威根/registry 与 DAG 重建；Task/Run 查询、匹配、消息状态、幂等重试、清理资格一致。
- 两个 Task 共享一个 RunHistory、Task 取消、历史 Run 暂无当前 Task、父进程退出后子任务取消均可冷恢复；不能因 Task 数量改变而复制执行事实。
- 索引陈旧/损坏不能成为新事实来源；缺失权威根或块必须失败，不能用 checkpoint 缓存掩盖。
- commit 成功而索引/响应失败后，相同幂等请求不重复生成 Run 或副作用；已派发但结果未知保持不确定。
- 达到保留边界后，解除旧根确实使无其他持有者的数据不可达；共享/外部 pin 的数据仍可达。

此阶段新存储只在独立 fixture/数据域中验证，不双写生产旧 SQLite 与新 DAG 来比较“谁是真的”。

## P4: 纵向切换所有直接调用方

### 改动范围

- 在同一可构建集成候选中更新 task-protocol、Builder、SDK、Engine、HTTP、CLI/server 和直接测试 fixture。
- parameters/message/result 全部采用 IpfsPayload。控制信封、幂等身份、message accept/reject、子任务 key/deadline 等语义保留，不混入业务 data。
- Worker 只取得宿主授权的 CID 读取/解析/写入能力，移除公开 Space、sid、output 根目录协议和旧 input 别名；Bundle 与子调用目标以 CID 表达。
- 正式参数、消息和结果在闭包验证及对应提交完成后才投递或可见；按 R-03 实现准备/拒绝态，不把不完整 Payload 暴露为成功。
- 生产配置显式选择新数据域，旧文件原样保留。Schema/API 版本不递增，不引入 V2 路由或长期兼容层。

### 验证与停止条件

- 真实 HTTP/CLI → Engine → Worker → 子任务 → Result 全链路用包含共享资源的强引用样例通过，消息通道不能遗漏。
- 原有启动、资格、准入、退出、资源清理、幂等和订阅语义的针对性测试保留或适配，不仅测新 happy path。
- 替换同步 commit 后，消息与启动不会在 durable commit 前执行，关闭会等待必要提交/恢复工作。
- 清除旧公开协议后全部 workspace 类型检查及构建通过；不在提交中留下半数调用方使用 input 的破碎状态。

多个局部提交可以在重构分支中完成，但不把中途半切换候选部署给实际调用方。无需 bump V1 不代表新布局可以读取旧数据。

## P5: 保持文件树便利能力按需

- 实现 ipfs-tree 的只读 read/list/resolve，只依赖 ipfs-access 只读接口；不依赖 Task SDK、Engine 或完整 Store。
- 文件返回流，目录返回带 CID 的条目；非法路径、越界、文件当目录、取消与预算错误按共享规则处理。
- SDK、ipfs-payload 不依赖或重新导出 ipfs-tree。
- 用两个最小 Task 构建样例检查打包依赖图：不 import ipfs-tree 的产物不含其运行时模块；import 的样例实际完成读取/列举。记录两者大小，但不伪设“零字节差”或仅依赖 tree-shaking 证明隔离。

P5 只依赖 P1，可与 P2/P3 并行安排；不扩大 Worker 的基础能力面。

## P6: 整体验证与实施验收候选

- local 与隔离 Kubo 各执行冷重启、块缺失/损坏、GC 竞态、pin 结果不确定、查询库重建及多 owner 用例。
- 以 100、1,000、10,000 条记录/消息的受控 fixture 测量写块数、重建读取量、DAG 深度、pin RPC 与内存；用配置预算及 limit/limit+1 用例验证失败边界。不能每次新增事件重写整个累计数据域。
- 重建索引与共享 Run 的结果对照固定事件轨迹；确认没有隐式恢复执行。普通诊断日志不可用不伪装成生命周期事实丢失。
- 确认授权不能被直接 CID 读取绕过；未授权根不公开、不导出，错误响应不返回私有完整输入。
- 执行所有涉及包的 targeted tests，再运行 pnpm check；失败不得标成已通过。记录确定的原有问题，不用扩大重构范围掩盖它。
- 更新 README/包使用说明、部署备份范围、清理与恢复操作、发布依赖映射；核对 runtime/peer/devDependencies 的实际发布顺序。

本次规划未执行这些新架构测试，P6 也不授权真实发布。

## 交付与中断规则

- 每阶段失败停止其下游阶段；保留已验证基础能力，不为了赶进度降低闭包、提交、权限或恢复保证。
- P4 前生产仍可使用旧路径；P4 后新域存在写入时，只能恢复同一新域的完整已提交根，不允许回退到旧 SQLite 丢弃新事实。
- 独立环境验证属于 Deployment：复制约定的 Store 元数据及完整 DAG，重建查询 SQLite。仅拷贝所有块而没有权威根，不能称为可恢复备份。
- 核心 RunHistory DAG 不是默认可公开的交付物；只按已确认授权导出选定 Delivery 子图。
- npm 新包和版本必须经既有独立包发布流程，显式授权后再执行；本计划不批量发布依赖，不移动历史 tag。

## 本次规划的完成定义

评估、决策入口、分阶段依赖和验证门槛已形成文档；严重未决项明确标记，未冒充确认。代码实施、故障演练、迁移与发布全部仍待后续生命周期推进。
