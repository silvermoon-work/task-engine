# 待决策项

以下是建议而非已获授权接口。准备阶段提交方向及完整性边界，实施时在对应代码变更前逐组确认，
在主体世界记录最终选择及理由；Idea 方向验收不代替具体行为决策。

| ID | 需确认的选择 | 最小建议与影响 |
| --- | --- | --- |
| D-01 | 库边界、配置/manifest 名、版本标识 | 公共 js-bundle 库分 compiler-free 子入口，js.build.yaml / bundle.json，新 schema URI；Task 专用前处理。不以本文占 npm 包名 |
| D-02 | runtime 模块字段和 Browser 基线 | type/module，Node/minVersion+CJS 保留；Browser/ESM，ES2022 编译候选。浏览器范围、CSS/图片 loader 及宿主 URL 映射须同步确认 |
| D-03 | metadata 键、协议标识、Renderer 生命周期 | 反向域名键+版本 URI；Task 离线 $ref 保留；Renderer mount、可选 update、destroy、有序 styles，以及更新失败/销毁语义，不共用 Node API |
| D-04 | include/binary 可见性变化 | 精确沿用 glob/空匹配失败/重复源失败及点前缀遍历规则（静态前缀仍可进入隐藏目录）；放开公共目标；binary 匹配最终路径、空匹配允许。若扩大点文件匹配须另行确认 |
| D-05 | 可迁移磁盘中间树 | 建议保留两阶段构建及公共 sidecar，最终 CAR 自包含；只保证单次 build→CAR 会影响 build --no-car/car 流程，不可无说明删除 |
| D-06 | 文本和 DAG/CAR 版本策略 | text-v1 继承严格 UTF-8、CRLF/CR→LF、保留 BOM/末尾/Unicode；自定义 profile 继承 256KiB/174/无 HAMT，固定 DFS writer。现代 1MiB/1024 profile 需额外边界黄金及新 CID 说明 |

## 不待选择的底线

单数 import、开放 JSON metadata、runtime≠协议、完整 Task 表现力、
import 原 DAG 身份/最终 CAR 闭包、声明驱动和未配置来源不回退已经是需求，不可作为删减选项。
源码/输出目录不进运行契约，不改写历史 CID。

## 进入实施的条件

先按生命周期完成构想方向的明确验收；随后确认影响实现的行为选择，再细化主体步骤和测试。
当前所有 I-* / D-* 保持未完成；不把调研或旧格式测试冒充新格式证据。
