# IPFS Payload：已确认设计与实施边界

本文件支持 [Implementation](Implementation.md)，记录 2026-11-14 已讨论确定的设计及其必要验证。当前仍为准备阶段，局部设计确认不代表完整构想验收或发布授权。标为候选的字段与 API 不代表已确认。

## 最新范围变更

用户保留 Payload CID 强引用及 RunHistory 单位，并进一步订正：SQLite 是真正的权威信息源，IPFS Store 只辅助保存定稿 RunHistory，不持续保存尚未执行或执行中的 Task/Run 状态。允许 SQLite 记录仍在而历史详情已 unpin 或无法取得；是否过期以 SQLite 为准。此前“DAG 事实源、SQLite 只是可重建索引”的设计撤回，当前边界见[架构评估](ArchitectureReview.md)，实施安排见[分阶段计划](RefactorPlan.md)。

## 契约命名

契约字段统一使用 `parameters / message / result`，对应类型为 `Parameters / Message / Result`：

- parameters：启动 Task 时的业务参数集合，不包含整个提交请求的身份、超时等控制信息。
- message：运行期间可以追加的单条业务消息，不改名为暗示特定处理语义的 Signal 或 Update。
- result：最终业务结果。

parameters、message 和 result 均支持内容引用往返，使用同一 IpfsPayload 交换规则。消息身份、接受/拒绝等控制信息位于业务载荷外层。

以下示例中的 `ContentRef()` 表达已确认的类型方向，具体导出 API 尚待确认：

```ts
import { Type } from "@sinclair/typebox";

export default {
  parameters: Type.Object({
    document: ContentRef(),
    baseline: Type.Optional(ContentRef()),
    label: Type.String(),
  }),
  message: Type.Object({
    instruction: Type.String(),
    document: Type.Optional(ContentRef()),
  }),
  result: Type.Object({
    issues: Type.Array(
      Type.Object({
        message: Type.String(),
        references: Type.Array(ContentRef()),
      }),
    ),
  }),
};
```

普通 CID 字符串不因内容形状而成为引用；例如 label 始终保持业务字符串语义。ContentRef 表达真实内容引用，JSON 编码定位目标 CID，不附加 path。若资源来自根 CID 加 path，先解析得到目标节点 CID，再构造引用，不能用根 CID 冒充目标。

## 载荷与引用不是同一类型

- 单个引用类型：`ContentRef`。
- 包含业务数据及内容引用语义的载荷类型：`IpfsPayload<T>`。
- 工具包：`@silvermoon-work/ipfs-payload`，放在 `packages/`。

2026-11-14，用户确认这一系列直接使用 IPFS 命名，与现有 ipfs-store 保持一致。此前的 ContentPayload/content-payload 命名由 IpfsPayload/ipfs-payload 取代；ContentRef 仍保留，表示契约中的内容引用角色，传输字段 cidPaths 不变。

2026-11-14，用户确认方案 A：每个载荷自带引用路径，可脱离原 Task 契约识别引用语义。parameters/result 使用同一信封原则；不以仅传业务 JSON、依赖外部契约恢复引用的方案 B 为默认协议。

2026-11-14，用户将引用路径字段定名为 `cidPaths`，取代较长的 contentRefPaths；信封示例统一使用 `data + cidPaths`。路径相对于 data 求值，不相对于整个信封。此前 `value + references` 和 `data + contentRefPaths` 不再作为引用字段命名方案。

路径提供引用语义，不替代完整业务 Schema 校验，不授予内容访问权限，也不证明内容已经到达 Store。Engine 必须核对路径与契约及实际判别分支一致，再恢复 CID 类型并存为真正强链接。独立解码不要求找回原 Task 契约，但仍需验证载荷与定位表达式；正式接纳/交付还必须验证并保留完整依赖闭包。

JSON 信封只是交换表示，不是已存储节点。定稿历史归档时，逻辑值经规范 DAG 编码得到 payloadCID，RunHistory 聚合相应的参数、消息、执行及交付节点。DAG-CBOR 是结构化编码方案；运行期间的 SQLite 状态提交不要求先产生或 pin 一份活动历史 DAG。不能把 CID 当普通字符串存储后声称它是强链接。

## JSONPath 与判别分支

引用定位由契约类型推导，结合实际数据的 discriminator 选择分支；不依赖调用方手工标注位置或根据 CID 字符串猜测类型。

同质引用数组尽可能使用通配符，例如：

```text
$['issues'][*]['references'][*]
```

允许包含引用的 discriminated union：

```ts
Type.Union([
  Type.Object({
    kind: Type.Literal("reference"),
    value: ContentRef(),
  }),
  Type.Object({
    kind: Type.Literal("text"),
    value: Type.String(),
  }),
]);
```

kind 必须可靠地区分分支；缺失、非法或无法唯一选择分支时失败，不尝试猜测。直接 `ContentRef | String` 没有可保留到传输侧的判别信息，禁止这种混用。不以此为理由禁止所有含引用的外层 union。

若 items 数组混排上述分支，可以由类型推导带判别条件的定位表达式：

```text
$['items'][?@['kind'] == 'reference']['value']
```

不能退化为 `$['items'][*]['value']`，否则文本分支会被误转换。采用[架构评估 D-02](ArchitectureReview.md#d-02-cidpaths-是受约束的定位规则不是可执行查询脚本)的受限生成/验证规则；复杂条件可回退具体位置，不能为压缩路径扩大引用集合。

构建时预编译定位规则、运行时按 discriminator 求值是可行候选，不意味着已决定编译产物格式。重组父子结果后重新按当前契约及数据求值，不复用旧具体位置。

## 引用身份与宿主访问能力

2026-11-14，用户确认引用访问方案 A：ContentRef 只表示不可变的 CID 身份，读取通过 context 提供的受控内容能力进行。不采用在解码引用对象上绑定 readBytes 等读取方法的方案 B。

以下调用形式是接口示意，不代表最终方法名：

```ts
const node = await context.readContent(parameters.document.cid);
const reportCid = await context.putContent(reportBytes);
return { report: ContentRef.fromCID(reportCid) };
```

构造或解码引用不授予访问权限，纯编解码也不进行网络 I/O；正式接纳与发布前，由宿主通过授权来源取得并验证闭包。读取权限、取消和预算由宿主负责；跨 Task 传递引用不传递原运行的能力。工具包不依赖 Engine Store，也不把读取能力绑定到 ContentRef 上。

2026-11-14，用户进一步收敛宿主内容能力为按 CID 读取内容、用 CID 加 path 解析目标 CID、临时存入内容并返回 CID。此处 path 只用于解析，不附加到通用 ContentRef 上；新内容返回 CID 后，仍需按契约表达其引用语义，普通 CID 字符串不自动成为 ContentRef。

新内容由宿主的受控写入能力存储，成功后返回 CID；失败、取消或超过预算明确失败，不能只计算 CID 后声称内容已存储。文件读取采用流，不默认将完整内容缓冲为字节数组；具体方法和流式写入签名在主体世界细化。

上述 ContentRef.fromCID 只是引用构造示意；作者侧如何构造 ContentRef 或在声明为引用的字段使用原生 CID 类型，需在工具包接口设计中明确，不能猜测普通字符串类型。

## 节点返回形状与首期内容范围

2026-11-14，用户确认读取采用文件/目录 discriminated union，沿用文件携带内容流、目录携带条目流的分流结构。共享节点与条目契约归属 ipfs-access；以下 DU 示意不提前决定 CID 参数的最终 TypeScript 表示：

```ts
type IpfsNode =
  | { kind: "file"; content: ReadableStream<Uint8Array> }
  | { kind: "directory"; entries: AsyncIterable<IpfsEntry> };
```

IpfsEntry 包含 name、kind 和目标 CID，不返回 SpaceRef。文件流和目录枚举都遵守宿主取消、预算及访问控制。此结构满足 ipfs-tree 的 read/list/resolve，不额外引入第四个目录枚举操作。

用户确认首期覆盖 raw 及 UnixFS 文件/目录。CID 加 path 按受支持的目录语义解析，写入采用明确、固定的编码规则；流式输入与现有编码实现的具体签名在实施设计中确定，不引入未确认的动态 codec 选择。

不承诺任意 DAG codec 都可按文件树读取或解析，不支持时明确失败。新增结构化节点由宿主 DAG 编解码/块接口处理，不能扩成第三种伪文件节点。合法 CID 也必须符合宿主允许的 codec/hash 与完整性策略，才能进入正式强引用闭包；编码一个 CID 不代表目标已经到位。

## 全量协议替换与 Space 边界

2026-11-14，用户同意全部切换：parameters/message/result、父子调用、SDK、HTTP 和 CLI 共用 IpfsPayload 编解码，不保留旧 input 命名或旧 output 交换格式的兼容别名。保持已有 Schema/API V1，不重写历史制品或承诺旧制品继续运行。

Worker 内容访问改为三种 CID 能力，不再暴露 context.output、context.space(cid) 或作为 ReadonlySpace 的 context.bundle，也不再以 SpaceRef/SpaceRefJSON 表达传输引用。Bundle 身份及子任务目标通过 CID 表达，具体字段和签名在实施设计中收敛。

废弃的是 Task/Worker 对外的 Space 接口及其直接依赖的宿主桥接协议，不是删除一切内部树形实现。Builder 的 ReadonlyFileTree 和底层 UnixFS 可以保留；新增的是归档 DAG 转换、遍历、pin 与详情读取，不迁走 SQLite 运行事实或改变调度语义。只读资源经 CID 读取或经 CID 加 path 解析，不需要保留只读 Space 门面。

运行中资源读写不等于活动状态归档；本次不据“活动 Task 不存 IPFS”推导取消 CID 资源访问或临时存储。“临时”也不表示可以在使用中或归档尚需时提前释放内容。

## 内容保留原则

2026-11-14 最新订正：SQLite 决定记录及详情保留策略，IPFS RunHistory 是允许失去详情的辅助归档。强链接仍然有效，但它不承诺记录存在期间内容永远可得。

- 新内容写入后受运行/staging 保护；定稿归档声称成功前必须验证强闭包并确认相应保留，不需为每个资源单独建永久 owner。
- Task 不独占 RunHistory，多个 Task 可关联同一 Run。记录保留期可以长于详情保留期，不预先规定固定天数。
- 子结果、父运行、父结果及其他 Task 可共享同一内容；根或 owner 仍有保留关系时不能回收，不复制资源实现组合。
- 需要保留的资源交接先取得新持有，再释放旧持有；必要保留未建立不能宣称归档成功。归档失败与业务完成确认的关系见 R-03，不从 pin 失败倒推运行失败。
- 写入后取消、崩溃或未发布结果的临时持有须可恢复地清理，避免泄漏。
- 外部依赖必须通过授权来源取得并验证；不完整闭包不能声称归档完整。未验证申请及失败可由 SQLite 耐久记录，不要求先变成正式 DAG。
- 递归保留遍历真正的 IPLD 链接；文档中的普通字符串、逻辑 ID 和相对名称不会自动升级为强链接。
- SQLite 允许记录仍在但已发出 unpin。unpin 不等于物理删除，历史不可得也不等于 Task 已过期；详情缺失明确失败，不返回空历史伪装成功。

业务提交、期限与归档管理以 SQLite 为准，pin 不是业务权威。Store 的多 owner/意图恢复仍保留，但不另造一套活动运行 head；SQLite 是必要备份，不能从残余归档重建完整运行系统。

## IPFS 包职责与依赖边界

统一使用 `@silvermoon-work` 下的以下包名。现有 ipfs-store 保持原名，其余包在构想验收后的实施中建立，不因本次文档更新开始创建或发布：

| 包 | 职责 | 主要类型 |
| --- | --- | --- |
| `@silvermoon-work/ipfs-access` | CID 内容访问与节点契约，不含宿主实现 | `IpfsAccess`、`IpfsNode`、`IpfsEntry` |
| `@silvermoon-work/ipfs-payload` | 引用类型、JSON/逻辑值/DAG 编解码及 cidPaths 验证 | `IpfsPayload<T>`、`ContentRef` |
| `@silvermoon-work/ipfs-tree` | 按需引入的 CID 只读文件树便利层 | `ReadonlyIpfsTree` |
| `@silvermoon-work/ipfs-store` | 实际存储、读取及保留实现 | 沿用并协调既有类型 |

IpfsAccess 归属轻量的 ipfs-access 契约包；由宿主提供实现，Task SDK 提供受控访问适配，ipfs-tree 组合读取与解析能力。文件树便利封装不是 Task 专有能力，不放进 SDK 或 ipfs-payload。

ipfs-tree 仅要求 IpfsAccess 的只读子集，不强制注入写入权限；不新增 Space 身份、挂载、写入或保留管理。取消、预算和权限由宿主访问能力控制，文件树操作只用于支持目录语义的内容，不把任意 codec 当成文件树。

SDK 与 ipfs-payload 不依赖或重新导出 ipfs-tree。使用树形 read/list/resolve 便利功能的 Task 显式引入 ipfs-tree，未使用的 Task 不应携带其运行时模块，不仅依赖 tree-shaking 消除多余代码。共享接口使用 import type，不为接口引入 Engine、Store 或不必要的 codec 实现。

命名绑定 IPFS 不等于依赖绑定完整 Store。ipfs-access 不依赖 Task SDK、ipfs-tree 或具体 Store 实现；ipfs-payload 不依赖内容 I/O。既有 Store 节点类型与共享契约须协调，不建立同名但不一致的节点模型。

目录列表由底层文件/目录 DU 中的目录条目流提供，不能从任意文件字节流或仅解析指定 path 的能力推断出来。只读便利层组合已确认的读取与解析操作，不另建 Space 或独立枚举协议。

## 工具包职责

提供可共享的 ContentRef JSON 编解码能力，避免 Engine、SDK 和消费者重复实现：

- 支持作者侧引用类型、可序列化的契约语义以及引用定位。
- 在真实引用与传输 JSON 之间转换，根据判别分支保持引用语义。
- 纯编码/解码结构化 Payload 节点，把真实 CID 作为 IPLD 强链接；不把块已编码等同于已提交或依赖完整。
- 明确处理无效 CID、非法数据和错误的引用元数据。
- 不把存储失败包装成成功引用，不根据普通 JSON 对象形状恢复引用。

工具包不负责 Task 调度、内容下载、pin 或 CAR 打包。实际 I/O 与闭包验证由宿主/Store 执行；不能把 DAG 序列化能力当成获取宿主完整 Store 权限的入口。SQLite 保持任务事实权威，归档 schema 归属任务协议层，通用 Store 不解释 Task 调度。

当前 Builder 只接受受支持的 TypeBox kind，并拒绝未被 Engine 强制校验的 format 等注释。不能把 `Type.String({ format: "cid" })`、未支持的 Transform 或验证器忽略的自定义注释当成完整方案。TypeBox 扩展必须兼顾作者类型推导、Schema 序列化及运行时校验。

## 单测要求

工具包必须有充分单测，围绕以下可观察行为，而不是仅测试构造器常量：

- 引用往返，普通 CID 字符串和同形业务对象不被误转换。
- 可选字段、空数组、嵌套数组与 tuple 的正确定位。
- 混排及嵌套 discriminated union，只转换实际引用分支。
- 缺失、无效或有歧义的 discriminator，以及无效 CID。
- 若协议接收路径元数据，覆盖缺失、非法、过宽及伪造路径，不让元数据绕过契约。
- 父任务重组数组后重新编码，引用保持语义，原始业务数据不被意外修改。
- 正常转换与失败行为在作者侧、传输侧和解码侧保持一致。
- DAG-CBOR 真链接与普通字符串的区别、规范字节/CID 向量、混合 codec 强闭包，以及完整性失败不进入成功发布路径。

关键不变量是往返保留数据语义，转换位置与契约选择出的 ContentRef 位置完全一致。过滤和通配符的验证必须包含同一数组内有效 CID 文本与真实引用的混排，证明不会扩大匹配。

## 本次版本策略

项目仍在内部开发阶段。本次 breaking change 直接调整已有定义及依赖调用方；现有 Schema version 和 API version 为 V1 的继续保持 V1，不因本次修改引入 V2 或其他迭代版本号。

此决定不是包版本、发布渠道或发布授权的变更，也不授权重写历史制品。用户已另外确认全部切换、不维护旧交换协议；不从“保持 V1”推导历史制品兼容承诺。
