# 公共协议候选（未批准）

本文基于[现实现](capability-map.md)提出最小一致建议，用于判断可行性和暴露选择，
不是已发布标准。[决策清单](decisions.md)确认后才冻结接口；构想验收不批准具体接口。

## 公共和专用层

建议公共 `js-bundle` 库拥有声明、树、选择、归一、build/CAR；compiler-free 格式/树/CAR 子入口
不得加载 esbuild 或 Task schema。一库子入口还是分包需确认，不创建第二份 CAR codec。
Task Builder 委托公共核心，只保留契约生成、binding、callback wrapper、Task 约定和 init。

建议公共配置名 `js.build.yaml`、产物 `bundle.json`（严格 JSON、稳定序列化），
Task 的 `task.build.yaml` 可作同一公共配置的前处理入口，不保留旧产物兼容解析。
暂不新增 CLI 命令名；现 Task CLI 是适配候选，原始 JS 公共库入口不依赖它。
CLI 若扩展须另作需求确认，本文不是批准的命令树。

## 输入与产物

| 字段 | build 输入 | 确定产物 |
| --- | --- | --- |
| name | 人可读名称 | 同一名称，不作身份键 |
| runtime | 环境描述与输出模块要求 | 环境、兼容要求和明确模块形式，不含源码编译目录 |
| entry | 树内源码入口 | 已构建 JS 精确路径 |
| include | from/to 模式映射 | 排序唯一完整文件路径，包括 manifest、生成文件及 import 展开逻辑文件 |
| binary | 输出路径模式 | 精确排序文件路径，不留 glob；import 文件 opaque 并记录在内 |
| import | 位置→固定 CID | 已验证的同一映射，挂载节点与之相等 |
| metadata | 有限结构化 JSON | 稳定序列化、保持类型和值；公共层限制字节/深度/节点，不猜业务含义 |

建议新 `$schema` URI 固定公共格式版本、文本和 DAG profile，不复用旧 Task URI。
对象键递归排序、数组保持声明顺序、有限数字、UTF-8/LF/末尾一个 LF 是**生成 manifest**
候选规则，不是给任意文本添加换行。metadata 变化会改变根 CID；
顶层严格但 metadata 开放，不能忽略未知顶层拼写。

建议 runtime 明确 type/module；Node 另有 minVersion，Browser 为 browser/ESM。
公共层认识环境描述的结构，不把它映射为 Task/Renderer；编译 target 属构建选择。
建议 metadata 使用反向域名键如 `work.silvermoon.task` / `work.silvermoon.renderer`，
值含版本化 protocol URI 和本协议契约。Task 示例（**名字未批准**）：

```json
{
  "work.silvermoon.task": {
    "protocol": "urn:silvermoon:task:1",
    "parametersSchema": { "$ref": "schemas/parameters.json" },
    "resultSchema": { "$ref": "schemas/result.json" },
    "messageSchema": { "$ref": "schemas/message.json" }
  }
}
```

Task 保留离线 `$id/$ref` 和 schema 闭包；本协议包内路径引用以 bundle root 为基准，不得越界。
公共层不递归解释任意 JSON `$ref`。Renderer 独立声明协议版本、入口导出及
`styles: ["styles/main.css"]`，数组固定加载顺序、路径以根为准。
宿主验证引用存在/类型、mount/update/destroy 和清理，不是只看到 namespace 就执行。
任意其他协议可使用自己的键，不要求同时提供 Task/Renderer metadata。

## include

沿用 `* ?` 与整段 `**`，不加 brace/class/negation。
匹配域为配置所在树目录下的规范相对逻辑路径；静态前缀决定遍历根，
截去静态前缀后映射到 to 目录。路径/排序不依赖宿主 OS。

| 情形 | 现规则 | 最小候选 |
| --- | --- | --- |
| 空匹配/必需文件缺失 | 失败 | 沿用，不加 optional 静默忽略 |
| 重复源/目标（含相同字节） | 失败 | 沿用，不按顺序覆盖 |
| 匹配大小写 | 敏感 | 沿用；输出逐前缀拒绝大小写折叠冲突 |
| dotfile/node_modules | 遍历跳过点前缀项，但静态前缀可进入隐藏目录；模式禁止 node_modules 路径 | 精确沿用；模块依赖图仍可读取 node_modules，不自动交付源码 |
| to | 仅 resources/ 目录 | 放开至公共根下目录（含根），保留 manifest/生成入口位置；Task 可继续用 resources/ |
| 穿越、绝对路径、反斜线、保留设备名、非 NFC 路径 | 拒绝 | 沿用可移植路径规则，不纠正名字 |
| symlink | 适配器允许树内链接 | 保留句柄核对；越界/特殊文件拒绝；环失败；产物只含普通文件/目录 |
| include/import、生成/import、生成/include 的同路径或祖先后代冲突 | 不能覆盖 | 全部拒绝；共享普通目录祖先允许 |
| 不同 import 挂载重叠 | 拒绝 | 沿用；同 CID 至不重叠路径允许，块去重 |

产物 enumeration 是声明 resolve 结果；可以列举最终树检查未声明文件并失败，不能据此扩包。
多出**被声明 glob 命中**的文件属于范围变化，会改根；
未被任何规则/生成依赖图/import 命中的额外文件不应改变逻辑产物。

## binary 与 text-v1

binary 匹配最终输出路径，不匹配输入源；建议沿用零匹配允许、模式须合法、重复匹配幂等。
manifest、入口及宿主必需文本控制文件不得借 binary 绕过校验。
import 内文件始终 opaque；精确 binary 可记录它们，父模式不得改变原块解释。

建议 text-v1 原样继承现实现：

1. 严格增量 UTF-8，非法序列/截断 EOF 失败，不替换 U+FFFD。
2. CRLF/单 CR→LF，跨 chunk 一致；LF 不变。
3. 保留 UTF-8 BOM、末尾有无换行及数量，不做 Unicode NFC/NFD 内容归一。
4. binary 不解码不归一；import 不进此流水线。

路径须 NFC 与**文件内容**不归一不矛盾。可延迟读资源，但只有完整消费、归一、容量及闭包校验
后的 CAR 才称成功制品。

## 原 CID import 与 CAR

建议沿用 UnixFS 目录根：manifest CID 字符串是声明，挂载目录 DAG-PB `PBLink.Hash` 才是真链接。
先校验来源完整强闭包及文件树，再重建本包挂载祖先目录，
Hash 指向原 CID，保持原块 bytes/codec/chunk topology/mode/mtime；
不能把展开副本重新导入的 CID 当成 imported CID。Tsize 按原子 DAG 计算。

嵌套 import 只遍历真实可达 DAG，不重新解释内层 manifest 的 CID 字符串或补运行时下载。
普通文件树挂载与可执行 Task 校验是两件事；子协议不受支持不能尝试执行。
块按 CID 去重，逻辑路径/字节预算仍逐路径计。初版保留普通文件/非空目录，不无意拓展为任意 CBOR 对象。

单次 build 可在内存持有闭包；若提供磁盘中间树，建议保留完整公共 sidecar，
严格校验根/哈希/闭包/副本/未声明文件。sidecar 不进运行根；最终 CAR 不依赖它。
D-05 须确认是否继续支持两阶段中间产物，不能无说明删除 build/no-car/car 能力。

建议自有文件沿用现有 UnixFS 参数并赋**自定义版本化 profile**，
不声称遵循不同参数的 unixfs-v1-2025，见[调研](research.md)。
所有参数、排序、空目录和权限规则固定，import 不按父 profile 重编码。

最终 CARv1 单 root、所有且仅有可达块、每 CID 一次；writer 候选沿用根优先 DFS、
DAG-PB 规范 Links 顺序、首次出现去重。reader 可接受不同块顺序但完整校验；
重排块根不变，CAR SHA-256 会变。分别固定根和 writer 字节黄金。

Store 来自显式注入及共享配置；本地可用则读本地，损坏不回退，缺块只用明确来源。
取消/超时/预算失败向上传播；关闭操作自有 scope/staging，不关闭借用 Store/source，
不调用 pin/unpin/upload；多项清理错误聚合，不覆盖主错误或伪造完成。
