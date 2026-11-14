# 讨论记录：类型化强引用与 RunHistory 归档

## 来源与当前决定

2026-11-13，用户提出将 result 与 output 结合的 Blob 模型。此后方向从类型化 CID 弱引用调整为强引用，并一度讨论 DAG 事实源与 SQLite 索引。2026-11-14 最新订正撤回 DAG 事实源：SQLite 仍是真正权威，IPFS Store 辅助保存定稿 RunHistory，允许记录存在而详情已不可得。强引用编码本身继续有效。

在本次评估过程中，用户进一步纠正术语：记录单位应是 Run 的 History，而不是 Task 的 History。当前模型据此统一为 RunHistory；Task 为请求及匹配/观察投影，不拥有独立执行历史。

Blob 模型已被本方向取代，不再作为待实施方案。2026-11-14，用户授权改名为更合适的名称：标题为“Task 输入与结果的类型化内容引用”，别名为 `typed-content-refs`，原 Idea ID 保持不变。旧别名 `structured-output-blobs` 不再是导航入口。当前授权仅为文档调整，不代表完整构想验收，不开始实施或发布。

## 触发问题

- Check 已将问题参考文档直接交付在 output space 中，消费方不应二次查询原始 Check 包。
- 多个问题可能引用同一份参考文档；参考文档还可能引用其他文档、图片或示例。
- 父 Check 可以调用其他 Check；仅交付父包自己的 references 不足以覆盖跨包及嵌套引用。
- 将子 output 挂载为目录是一种方案，但文件树不一定适合作为所有 Task 输出的基础模型。

## 本次收敛方向

- parameters、message 与 result 均可包含类型化内容引用；不要求整个输入或结果只传一个根 CID，也不把大内容嵌入 JSON。
- 通用引用只包含目标 CID，不附加 path，不假定目标节点是文件树。CID 加 path 须先解析得到目标 CID，不能直接使用根 CID 冒充子节点。
- 编码时把作者侧真实内容引用转换为可识别 CID；解码时恢复轻量引用身份，内容访问由 context 提供，不再以 SpaceRef 表达引用。
- 父任务可组合子任务返回的引用并再次编码；这是业务结果组合，不是合并输出目录或复制全部资源。
- Worker 不再直接维护 ReadWriteSpace。保留只读资源访问，并提供受控的新内容存储能力：先成功写入 IPFS Store，再返回稳定引用，而不是只计算哈希。
- 归档 Payload 的 CID 转为真正 IPLD 强链接，声称完整归档前必须验证闭包。来源仍须授权；后来释放保留或丢失块意味着详情不可得，不把链接改成弱引用，也不改写 SQLite 的业务事实。

## 2026-11-14 已确认的关键设计

以下是局部设计决定，不是完整构想验收。详细契约示例、实现边界和测试要求集中记录在主体世界的[IPFS Payload 设计](../IpfsPayload.md)，不把它作为第二份构想契约。

- 契约使用 `parameters / message / result`，类型命名为 `Parameters / Message / Result`。parameters 表达启动参数集合，message 表达可追加的单条运行中消息，result 表达最终业务结果。
- 单个内容引用称为 `ContentRef`，包含业务数据与引用语义的传输载荷称为 `IpfsPayload<T>`；信封不是单个引用。
- 2026-11-14 用户确认方案 A：载荷自带引用路径，脱离原 Task 契约仍可识别引用语义；路径相对于业务数据求值，不自动授予内容访问权限或替代完整业务校验。
- 2026-11-14 用户将引用路径字段定名为 `cidPaths`，并同意全部切换：parameters/message/result 及内外部调用统一 IpfsPayload，不保留旧交换协议。
- 引用位置采用从类型定义推导的 JSONPath。数组尽可能使用通配符，不把每次运行的具体下标清单作为默认模型。
- 允许包含 ContentRef 的 discriminated union：依据实际 discriminator 选择分支，再定位引用。禁止无判别信息的直接 `ContentRef | String`，不一概禁止外层 union。
- 数组中的分支可以混排；只在符合引用分支的元素上转换，不将普通 CID 字符串或同形业务对象误解码。
- JSON 与 ContentRef 的转换独立成 `@silvermoon-work/ipfs-payload` 工具包，并进行充分单测；工具包不承担内容存储和 Task 生命周期。
- 用户确认系列使用 IPFS 命名：ipfs-access 拥有 IpfsAccess/IpfsNode/IpfsEntry 契约，ipfs-payload 提供载荷转换，ipfs-tree 提供独立只读便利封装，ipfs-store 保留实际存储职责。
- 文件读取采用流；文件树便利层由 Task 按需引入，SDK 和 ipfs-payload 不依赖或重新导出 ipfs-tree，避免不用此功能的 Task 包被动变大。
- 2026-11-14 用户确认文件/目录 DU：文件携带字节流，目录携带包含 name、kind 和 CID 的条目流，不额外增加第四个目录枚举操作。
- 2026-11-14 用户确认首期支持 raw 与 UnixFS 文件/目录，不承诺任意 DAG codec 的文件树读取或路径解析，不支持时明确失败。
- 定稿 RunHistory 需要结构化 DAG 编码，不能伪装成 raw 文件或 UnixFS 目录。活动状态继续在 SQLite，文件访问 DU 与宿主归档编解码分层。
- 2026-11-14 用户确认引用访问方案 A：ContentRef 只表示不可变 CID 身份，由 context 提供受控读取及新内容写入能力；引用对象不绑定读取方法或原运行的权限。
- context 内容能力收敛为按 CID 读取、CID 加 path 解析目标 CID、临时存储内容并返回 CID；Task/Worker 对外 Space 接口由这三种能力替代，内部 Builder 文件树和存储实现不因此全面删除。
- SQLite 决定 Task/记录是否过期及详情保留，允许记录仍在而 IPFS 已 unpin 或内容不可得；pin 不决定业务状态，unpin 也不证明物理删除。
- RunHistory 是定稿后的辅助历史归档，Task 共享/关联 Run，不另存一套 TaskHistory；尚未执行及正在执行的状态不持续写入 IPFS。
- 先前 R-01 的可重建查询库方案被订正：SQLite 保存真正权威信息，不只是少量 head 协调元数据；运行前请求、全域资格和幂等事实继续由它持久保存，不能从 IPFS 重建整个业务系统。
- 运行中的 CID 资源访问和临时写入与活动历史归档不同。本次未推导禁止一切运行中 IPFS I/O，仍需保护正在使用或归档尚需的资源。
- 2026-11-14 用户明确数据可见性归属 Store 而非 Engine：builtin IPFS Store 不公开，复用 Kubo 时由节点管理者决定是否公开。Engine 不代管网络/网关或另设内容可见性策略，既有 Task API 授权及资源预算不因此取消。R-04 已解决。
- 当前处于内部开发阶段，本次 breaking change 直接调整现有 Schema/API V1，不迭代版本号。同步更新直接依赖的定义与调用方。

先前的 JSON Pointer 具体下标清单不再作为主要方向；`input` 或候选 `params` 由 `parameters` 取代。强引用不回退为弱引用；无效或尚未取得依赖的申请可作为 SQLite 事实记录，不需为了耐久保存请求先生成完整 DAG。

## 文档弱引用图：关联议题

文档之间可能循环引用，不能直接构造循环的 Merkle 链接；把相互依赖的 CID 改成普通字符串也不能消除内容哈希的循环依赖。文档层仍需相对名称、逻辑 ID 或索引等间接表达，这不要求通用 Task 引用增加 path。

构建时分析文档引用并记录资源索引/弱引用图，是后续候选。提取引用表达式依赖内容和解析规则；解析到实际目标还依赖文档位置与资源上下文。消费者可从若干入口遍历闭包并处理环，引用索引可随 CAR 交付，但索引存在不证明目标块已包含。

文档内部的相对名称、逻辑 ID 与循环关联仍不是 ContentRef 的结构性强链接；是否分析并转化为独立资源索引属于后续议题。不让 Engine 自动解释 Markdown；本次必须遍历的是已编码的 IPLD 强链接闭包。

## 待确认细节

新架构的严重缺口与选择集中维护在[待决定项](OpenQuestions.md)，证据与建议见[架构评估](../ArchitectureReview.md)，迭代顺序见[分阶段计划](../RefactorPlan.md)。它们是本次要求的规划产物，不是已完成的代码或已接受的全部设计。

## 候选验证场景

调用方传入包含真实内容引用及普通 CID 字符串、同形对象的 parameters。子 Check 读取资源并返回问题的 CID 引用；父 Check 重组数组后再次返回。验证引用往返而普通数据保持原义，父任务不创建输出目录或复制子资源。

另验证 Worker 写入返回真实存储的 CID、完整归档闭包和失败恢复；解除详情保留并回收后，SQLite 记录及期限判断仍正确，详情明确不可得且不重执行。文档循环语义不自动解析，完整导出须验证当前闭包与授权。

该场景用于后续比较方案，不是已批准的 API 或实施任务。是否移除 Objective Probe 是另一个架构议题，不在本 Idea 中顺带决定。
