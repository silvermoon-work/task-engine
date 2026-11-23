# 生态核查与复用判断

核查日期：2026-11-17。范围限本仓依赖及以下公开资料，不宣称整个生态不存在类似协议。
本文解释组件复用，JS Bundle 协议本身仍需仓库定义。

## 当前依赖

[catalog](../../../../../../pnpm-workspace.yaml) 已固定 esbuild 0.25.12、enhanced-resolve 5.18.3、
ipfs-unixfs-importer 17.1.1、exporter 16.2.3、@ipld/car 5.4.6、dag-pb 4.2.0、
dag-cbor 10.0.2、multiformats 14.0.5。Builder 已实际消费构建/CAR 库，
Store 已有 raw/PB/CBOR 闭包，不需要新依赖才开始抽取；内部依赖仍 workspace:*。

esbuild 已通过树插件 write:false 提供内存 Node/CJS 输出；
Browser/ESM 还须改条件解析、禁止 Node builtin external、处理 CSS/URL 和宿主引用，
不能只改 platform 后宣称浏览器通过。

## 外部核实

| 来源 | 已核实能力 | 不提供的保证 |
| --- | --- | --- |
| [UnixFS importer](https://github.com/ipfs/js-ipfs-unixfs/tree/main/packages/ipfs-unixfs-importer) | path/content iterable 支持内存树/流，不要求扫描目录 | 不定义 include、宿主协议或文本归一 |
| [CARv1](https://ipld.io/specs/transport/car/carv1/) | roots + CID/原 block bytes，可表示 IPLD DAG | 标准也容许不完整/额外块运输；完整闭包、单根、无重复须应用收紧 |
| [js-car](https://github.com/ipld/js-car) | 标准 reader/writer/iterator | 不自动证明完整 DAG、runtime 或协议 |
| [IPIP-0499](https://github.com/ipfs/specs/blob/main/src/ipips/ipip-0499.md) | UnixFS 参数 profile，强调参数影响 CID | 不替我们规范文本、metadata、glob 或 CAR 顺序 |
| [本仓 Store DAG](../../../../../../packages/ipfs-store/src/dag.ts) | 真链接提取、规范 CBOR、原块校验 | CID 字符串不是链接；CBOR codec 不等于 Bundle 协议 |

CARv1 的 Determinism 节将确定性留给应用；Security and Verifiability 节说明 roots 不能单独代表
整份 CAR 完整性。因此根 CID 与整份 CAR 摘要须分别验证。

## profile 差异

| 参数 | 当前本仓 CAR | IPIP-0499 unixfs-v1-2025 |
| --- | --- | --- |
| CID / hash / leaves | v1 / SHA-256 / raw | 相同 |
| fixed chunk / balanced width | 262144 / 174 | 1048576 / 1024 |
| HAMT | 禁用 | fanout 256，完整 block-bytes 超过 256KiB 切换 |
| 空目录 | 不交付 | 默认包含，可 opt-out |
| symlink | 输入解引用为树内文件/目录，不存节点 | 默认保留 |
| mode/mtime | 自有文件不编码；import 原节点保留 | 默认不编码，可 opt-in |

最小建议继承现有参数并赋自定义版本，不冒称 IPIP profile 合规；
若选现代 profile，须完整采用并验证目录阈值/单叶/大文件等边界，不只改 chunk size。
无论选哪一个，imported 子图的 profile 都不可改变。

## 未覆盖

本轮未穷举全部 JS 分发标准，也未完成新 Browser host 实测。
有限核查未找到完整覆盖方案，不代表生态不存在方案。
组件足以支撑公共 build/UnixFS/CAR，优先抽取，不 fork Builder；协议命名见[决策清单](decisions.md)。
