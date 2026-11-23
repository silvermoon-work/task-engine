# 迁移范围与验证矩阵

这是交付要求与可行性核查，不是新格式完成报告。
主体世界补充实际测试位置、命令、工具版本和结果；不在 ledger 写叙事证据。

## 旧能力迁移

| 当前能力 | 迁移目标与不可丢失项 |
| --- | --- |
| Task 顶层三种 schema | 移到 Task metadata，保留主/共享 schemas、离线 $id/$ref、TypeBox 边界和闭包 |
| SDK build-locked binding | 生成/比较新格式 Task 契约，保留 workerData 防错配，不让旧 SDK 偶然执行 |
| explicit/callback、自选 SDK/export | Task 前处理保留；公共 build 不强迫 runTask，不生成 Task wrapper |
| imports / resources 子 Task | 改单数 import；文件/目录/子 Task 及嵌套/共享 CID 保留；更新 childRoot/准确 CID 检查 |
| include/binary/容量 | 公共抽取，保留映射、重复/空匹配失败及流容量；公共去目录限制不代表 Task 宿主约束自动消失 |
| Node22/CJS / Worker | runtime/module 和协议双验证，保留 Node eligibility、模块 URL、每 Run 隔离和退出证明 |
| 参数/结果/消息 | Engine 校验及 {data,cidPaths}/typed ContentRef 保留，不借字段移动重设计业务信封 |
| 内容与日志 | bundle CID、resolve/read/putContent、资源/目录、子调用 key/timeout、generation、消息/日志 ACK、取消、清理不退化 |
| build/no-car/car、init、outDirectory | CLI/模板协调；目录仅构建信息；保留新文件拒绝覆盖/失败清理；中间树方案先确认 |
| 历史产物/事实 | 不改旧 CAR/CID；显式拒绝，重建后更新准确根/父根；事实协议不兼容用新 Engine 数据域，不猜迁移 |

## 公共入口与调用链

原始 JS + assets 直接调用公共只读树 build→公共 CAR，不需要 Task schema、SDK、CLI 或 Engine；
Browser 走此链。Task 在同一链上增加契约/binding，不另写 glob、归一、import、UnixFS 或 CAR。
Protocol/Engine 仅依赖 compiler-free 格式/读取能力；CLI 复用共享配置并关闭自有 Store，
库仅借用，不读 ambient config。

拆包须同步 workspace、TS references、Turbo 脚本、catalog、release-packages 映射及 tarball 闭包，
不授权 release。使用匹配工具链重建，保存旧→新精确 CID 对照并重建父包；
旧 CID 不会因工具升级而升级。

## 验证矩阵

| ID | 需证明的行为 | 最小有效证明与旧测试锚点 |
| --- | --- | --- |
| V-01 | 新 Task 真实调用 | 新 CAR→离线块源→真实 Worker；参数/结果/双向消息成功及 schema 拒绝、typed ContentRef 往返；扩展 bundle-contract-host，不用 parser mock |
| V-02 | 资源与子内容 | 文本/二进制/目录/putContent、import 子 Task/嵌套/共享 CID；真实 invokeTask、key 重放/冲突、timeout；扩展 composition/spaces |
| V-03 | 浏览器与公共无 Task 耦合 | 同一 build/CAR 的 ESM+CSS+图像/字体或 JSON；真实浏览器 mount/update/destroy、样式/URL；无 Task metadata 也合法，Engine 拒绝 |
| V-04 | 磁盘/内存等价 | 同源码/依赖/声明，两树反序枚举；比较确定文件/字节/引用/根，不比绝对目录；额外未命中文件不改根 |
| V-05 | include resolve | * ? **、前缀/映射/完整子树、空匹配/缺文件、重复源/目标、dotfile、大小写前缀、保留名、穿越、越界链接/环、生成/include/import 冲突 |
| V-06 | text/binary 黄金 | 中文/€及 CRLF/CR/LF、分块 UTF-8→精确预期；BOM/无末尾LF/多LF/NFC与NFD；非法/截断失败；00 FF 0D 0A binary 原样；编码后检查字节而非仅比较 normalizer |
| V-07 | import 原身份/闭包 | 非标准 chunk/rawLeaves、mode/mtime、含 CRLF/非法 UTF-8 原文件，挂载 CID 原样；共享块一次、嵌套齐全；清空原源/cache，仅 CAR 离线读/执行 |
| V-08 | 身份/预算失败 | 错块哈希、根不符、缺子块、未知 codec、额外/重复块、字节/块/深度/逻辑路径预算边界；未配置来源零请求，配置源失败不切隐式源 |
| V-09 | 宿主拒绝组合 | Node+非Task、Browser+Task、未知协议/runtime/module、缺入口/schema/style、伪造 binding；执行前拒绝，无 Worker/DOM 入口副作用 |
| V-10 | 取消与清理 | 构建/流消费前及中途取消，阻塞输入/获取；主错误+close/unlink失败可观测；私有句柄/staging归零，借用源不关闭，不 pin/上传 |
| V-11 | 根/CAR 分开确定性 | 固定根CID；固定 writer 的 CAR 长度/SHA-256；重排块根相同而摘要不同、reader可验；import键/树顺序不影响结果 |
| V-12 | 平台/工具链/门限 | Windows/Linux 同输入双黄金、完整 pnpm check、相关测试与本地独立消费；不删门限/忽略失败，不以旧格式成功算新格式成功 |

## 风险与顺序

先复用现格式基线，再补公共层区分行为的黄金/负例，随后迁移 Task/真实 Engine，
最后浏览器与独立消费者；不留两套近似实现。

lazy 树不是字节快照，CAR 前须读到 EOF；磁盘检测不是跨文件事务，调用方保持树版本稳定。
跨平台结论需要 Linux 实证，不能仅在 Windows 构造 LF 字符串代替。
浏览器 URL/CSS、Task 子内容边界、依赖环、CAR staging 容量均是实施风险；
决策改变边界应更新主体契约并重置受影响 ledger 项。
