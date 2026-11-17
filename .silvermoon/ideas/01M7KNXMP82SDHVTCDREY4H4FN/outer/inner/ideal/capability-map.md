# 已有能力核实与抽取映射

核实基线：`e365218e7533292867a0f1d7fb653ba7bf46dd31`（创建时 primary）。
以下是源码事实，不以历史 README 发布说明替代接口。

| 已有机制与证据 | 当前实际边界 | 新结构映射 |
| --- | --- | --- |
| [Task 声明](../../../../../../packages/task-protocol/src/bundle.ts) | task.yaml、Node/minVersion、固定 worker.cjs；精确 include/binary；顶层三种 schema、复数 imports，无 metadata | 公共声明 + Task metadata；新版本/标识，拒绝旧格式 |
| [文件校验](../../../../../../packages/task-protocol/src/bundle-files.ts) | 集合与 include 完全相等，固定目录，schema 闭包与离线引用 | 公共文件/文本/路径约束抽取；schema 编译留 Task |
| [只读树](../../../../../../packages/task-builder/src/tree.ts) | list/read、可重复流、memoryTree/fileTree、逻辑路径、取消与容量 | 公共只读树复用；公共 API 不继续归属 Task 包 |
| [选择/配置](../../../../../../packages/task-builder/src/index.ts) | from/to；* ? **；目标限 resources/；重复源也失败；每规则空匹配失败 | 公共选择器抽取，保留语义；放开目标属于新决策 |
| [资源流](../../../../../../packages/task-builder/src/streams.ts)、[归一/匹配](../../../../../../packages/task-protocol/src/bundle-content.ts) | fatal UTF-8、CRLF/CR→LF；BOM/末尾换行/Unicode 字节保留；binary 匹配输出路径，仅 resources；空 binary 匹配不失败 | 归一版本化，宿主控制文件不得 binary；import opaque |
| [esbuild](../../../../../../packages/task-builder/src/esbuild.ts) | 树内 enhanced-resolve、package exports/imports/条件、TS；Node22/CJS、内存输出、仅 builtin external、动态非静态依赖拒绝 | 抽取 resolver/编译核心；增加 Browser/ESM 和 loader；Task binding 留上层 |
| [契约生成](../../../../../../packages/task-builder/src/contract.ts)及 contract-worker | 三种及共享 schemas、保留 $id/$ref、TypeBox 限定语义；可信代码独立进程与输出禁令 | Task 前处理保留，公共构建不执行 metadata |
| [import](../../../../../../packages/task-builder/src/imports.ts)、[展开](../../../../../../packages/task-builder/src/content.ts)、[DAG](../../../../../../packages/task-builder/src/dag.ts) | 普通文件/非空目录；展开副本+.task-imports.car；校验后重建父目录链接，保留原节点 | 复用闭包/挂接，不复制；最终 CAR 完整；中间 sidecar 需决定 |
| [CAR](../../../../../../packages/task-builder/src/car.ts) | CARv1/UnixFS，哈希、准确根、完整闭包、去重、规范树、有界 staging、流关闭 | 公共 compiler-free CAR，不依赖 Task/esbuild；保留预算与 EOF 完成语义 |
| [Store](../../../../../../packages/ipfs-store/README.md)、[DAG](../../../../../../packages/ipfs-store/src/dag.ts) | raw/PB/规范 CBOR 强闭包；SHA-256、逐块验证、scope、local/Kubo、借用 fromClient；文件读取限 UnixFS | 注入同一 Store；不能因 Store 支持而误报 CAR 支持任意对象挂载 |
| [Engine Bundle](../../../../../../packages/task-engine/src/bundle.ts) | 准备闭包、文件预算、Node eligibility、挂载 CID、资源及 resources 子目录 childRoot | 公共校验后 Task 协议/运行约束，不根据 runtime 猜协议 |
| [SDK](../../../../../../packages/task-sdk/src/index.ts)、[binding](../../../../../../packages/task-sdk/src/binding.ts) | build-locked 声明/workerData 一致；generation/消息 ACK、schema、ContentRef、日志、内容桥接和子调用 | 保留完整宿主协议，读取 Task metadata，不只挪 YAML |
| [磁盘适配](../../../../../../packages/task-builder-cli/src/node.ts) | 树内链接可跟随，越界/特殊文件拒绝，读取后句柄身份核对，新文件写入及清理错误聚合 | 复用公共宿主适配，保留 pnpm 依赖树与跨平台保护；输出不保留 symlink |

## include 的实际含义

输入树为模块解析/选择提供遍历域，但交付范围不是整棵输入树。模块由入口依赖图进入
生成 Worker；显式 include 可以携带 JSON、Markdown、任意文本/二进制甚至完整子包。
schemas、manifest 和 Worker 是生成规则；import 展开的文件也进入精确 include。
不能把新 include 缩成 assets 清单，也不要求依赖源码全部列入交付 include。

现实现从模式静态前缀遍历，跳过遍历中遇到的点前缀项；静态前缀本身可以直接指向隐藏目录，
故不能概括为任何隐藏目录都无法选择。模式禁止 node_modules 路径，匹配大小写敏感；
输出及路径前缀不得大小写歧义。输入 target 为树内别名，用于 pnpm 的真实依赖位置。
有界遍历会使链接环耗尽预算失败，不应声称已有专门环检测或原子输入快照。

## 确定性事实与边界

现 CAR 参数：CIDv1、SHA-256、raw leaves、262144 fixed-size、balanced/174、
单叶约简、目录包装、关闭 HAMT、顺序导入；自有文件无 mode/mtime。
输出根优先 DAG-PB Links 深度优先首次出现去重；仅 raw/PB。
现黄金固定根 CID、CAR 长度和 SHA-256，不是任意 CAR 同根必同字节的证明。

Store 的混合 codec 闭包能力大于 Bundle CAR 文件树能力。
Builder 展开后用原块 graft，展开副本不是 import 身份来源。
返回构建树时资源仍延迟读取，完整 CAR 构建/读取至 EOF 才能证明所有资源有效。

## 可复用证明入口

- [Builder](../../../../../../packages/task-builder/test/builder.test.ts)：虚拟依赖、schemas、延迟资源、UTF-8/BOM、binary、取消及精确容量。
- [CAR 黄金](../../../../../../packages/task-builder/test/car.test.ts)：准确根/字节、反序输入、缺块/篡改/取消及 staging 释放。
- [import](../../../../../../packages/task-builder/test/imports.test.ts)：非规范 chunk/mode/mtime、断开原源后离线 CAR、原 CID、共享块、冲突。
- [文本流](../../../../../../packages/task-protocol/test/bundle-content-stream.test.ts)：分块边界及非法 UTF-8 尾部。
- [真实 Engine](../../../../../../packages/task-engine/test/bundle-contract-host.test.ts)、[子调用](../../../../../../packages/task-engine/test/composition.test.ts)、
  [内容桥接](../../../../../../packages/task-engine/test/spaces.test.ts)：不是 parser mock。

这些是现格式的已存在测试入口，不是新公共格式已实现或已通过的声明。
