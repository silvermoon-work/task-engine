# Content Payload：已确认设计与实施边界

本文件支持 [Implementation](Implementation.md)，记录 2026-11-14 已讨论确定的设计及其必要验证。当前仍为准备阶段，不授权实现、构想提交或发布。标为候选的字段与 API 不代表已确认。

## 契约命名

契约字段统一使用 `parameters / message / result`，对应类型为 `Parameters / Message / Result`：

- parameters：启动 Task 时的业务参数集合，不包含整个提交请求的身份、超时等控制信息。
- message：运行期间可以追加的单条业务消息，不改名为暗示特定处理语义的 Signal 或 Update。
- result：最终业务结果。

parameters 和 result 支持内容引用往返；message 是否同样允许 ContentRef 见[阻塞项 B-04](ideal/OpenQuestions.md#b-04-协议调整的覆盖范围)。

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

普通 CID 字符串不因内容形状而成为引用；例如 label 始终保持业务字符串语义。ContentRef 表达真实内容引用，JSON 编码定位目标 CID，不附加 path。若来源是定位 Space 子节点的引用，编码目标必须是该节点 CID，而不是 Space 根 CID。

## 载荷与引用不是同一类型

- 单个引用类型：`ContentRef`。
- 包含业务数据及内容引用语义的载荷类型：`ContentPayload<T>`。
- 工具包：`@silvermoon-work/content-payload`，放在 `packages/`。

2026-11-14，用户确认方案 A：每个载荷自带引用路径，可脱离原 Task 契约识别引用语义。parameters/result 使用同一信封原则；不以仅传业务 JSON、依赖外部契约恢复引用的方案 B 为默认协议。

方案 A 的示意字段为 `data + contentRefPaths`，路径相对于 data 求值，不相对于整个信封；字段名仍待最终定名。`value + references` 和 `data + cidPaths` 是此前的命名候选，不得当成已批准 API。

路径提供引用语义，不替代完整业务 Schema 校验，不授予内容访问权限，也不证明内容已交付或保留。Engine 已绑定可信契约时，必须核对载荷的引用定位与契约及实际判别分支一致。独立解码不要求找回原 Task 契约，但仍需验证载荷与定位表达式；完整业务结构验证需要对应 Schema。

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

不能退化为 `$['items'][*]['value']`，否则文本分支会被误转换。过滤表达式的确切支持子集、嵌套条件表达和具体下标回退规则尚待 B-01 决定。数组通配符是尽可能使用的原则，不允许为压缩路径而扩大引用集合。

构建时预编译定位规则、运行时按 discriminator 求值是可行候选，不意味着已决定编译产物格式。重组父子结果后重新按当前契约及数据求值，不复用旧具体位置。

## 引用身份与宿主访问能力

2026-11-14，用户确认引用访问方案 A：ContentRef 只表示不可变的 CID 身份，读取通过 context 提供的受控内容能力进行。不采用在解码引用对象上绑定 readBytes 等读取方法的方案 B。

以下调用形式是接口示意，不代表最终方法名：

```ts
const bytes = await context.content.readBytes(parameters.document);
const report = await context.content.putBytes(reportBytes);
return { report };
```

构造或解码引用不授予访问权限，也不要求立即下载内容。读取权限、取消和预算由宿主负责；跨 Task 传递引用不传递原运行的能力。工具包不依赖 Engine Store，也不把读取能力绑定到 ContentRef 上。

新内容由宿主的受控写入能力存储，成功后返回 ContentRef；失败、取消或超过预算明确失败，不能只计算 CID 后声称内容已存储。具体方法、raw/UnixFS/结构化节点等内容模型以及流式行为仍待 B-02 收敛，写入后的保留责任按 B-03 单独决定。

## 工具包职责

提供可共享的 ContentRef JSON 编解码能力，避免 Engine、SDK 和消费者重复实现：

- 支持作者侧引用类型、可序列化的契约语义以及引用定位。
- 在真实引用与传输 JSON 之间转换，根据判别分支保持引用语义。
- 明确处理无效 CID、非法数据和错误的引用元数据。
- 不把存储失败包装成成功引用，不根据普通 JSON 对象形状恢复引用。

工具包不负责 Task 调度、内容下载、内容保留或完整 DAG/CAR 打包。解码恢复轻量引用身份，实际 I/O 由 context 内容能力执行；引用构造与宿主接口的具体形状待 B-02 收敛，不能注入宿主完整 Store 权限。

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

关键不变量是往返保留数据语义，转换位置与契约选择出的 ContentRef 位置完全一致。过滤和通配符的验证必须包含同一数组内有效 CID 文本与真实引用的混排，证明不会扩大匹配。

## 本次版本策略

项目仍在内部开发阶段。本次 breaking change 直接调整已有定义及依赖调用方；现有 Schema version 和 API version 为 V1 的继续保持 V1，不因本次修改引入 V2 或其他迭代版本号。

此决定不是包版本、发布渠道或发布授权的变更，也不授权重写历史制品。旧字段是否保留过渡入口、旧 output 的具体替代边界仍按 B-04 确认，不从“不升级 V1”推导未明确的兼容承诺。
