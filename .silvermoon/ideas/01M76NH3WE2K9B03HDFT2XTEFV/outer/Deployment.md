# RC 发布与远端 smoke test

用户已授权本 idea 的 RC 发布及 scottwei@office-ubuntu 安装验证，并委托主 Agent 负责阶段门限审批。仅对本 idea 必需的包逐个发布 RC，不授权 stable 发布、改变 latest 或批量发布整个 workspace。审批与发布边界见[执行与门限分工](./inner/ideal/execution-and-gates.md)。

实施已由主 Agent 接受，准确修订为
`de8464302233de4e449dd196096a458099470a70`，决定已同步 primary
`ba86cecab380a3eca9076d495cabb265c46a09f3`。本轮仅准备并同步[逐包发布与远端 smoke 计划](./release-and-smoke-plan.md)及[只读预检快照](./release-preflight.json)，等待主 Agent 审阅后才允许真实发布；不修改已验收 Inner
/ Ideal World，也不提前记录 submitOuter。

## Steps

### D-S01: 独立消费验证

主 Agent 通过实施门限后，明确受影响包、精确 RC 版本和依赖顺序，按仓库发布规则逐包更新 manifest、构建验证并同步 main。仅从通过精确提交 main
CI 的提交推送不可变 package-specific RC tag，经 publish-npm.yaml 的 Trusted
Publishing 发布；禁止本地真实 npm
publish、不覆盖既有版本或移动 tag。每个依赖的精确版本可查询后再发布依赖它的包，新增共享库先配置发布映射与 Trusted
Publisher；外部配置不具备时明确阻塞，不绕过。

当前拟用七包的精确版本、四类依赖字段和串行顺序以发布计划为准，不自动扩展到未涉及的 HTTP
/ Storage / Server 包。公开 registry 当前无法读取 `task-content`，且官方 npm
trust 文档要求包先存在；须先由 npm
owner 核实包与授权状态、解决首发/绑定前置条件，再开始整个发布链。不得用 stage 自动生成的非 RC 占位版本、stored
token、本地 publish 或未经批准的工作流绕过。

通过 SSH 在 scottwei@office-ubuntu 的独立测试目录安装真实已发布的精确 RC 包。遵守远端实际 registry 配置，不继承本机镜像要求。先检查现有工具与服务，避免替换共享全局安装、修改现有配置或重启其他服务。使用隔离 data
dir 与测试配置，记录安装来源、版本、命令、CID 和可重现结果。

构建并运行带通用 imports 和共享静态依赖的父任务，以及无需子调用授权的外部 SpaceRef 调用；不得用本地 workspace
link 或未发布 tarball 代替 RC 消费证据。

验证公共默认内容配置下的构建与运行复用，以及各自覆盖网关或 data
dir 后的独立工作；任务目录交付到无原构建缓存的环境后仍可离线生成 CAR。

### D-S02: 验证离线与失败边界

完整准备后断开内容来源验证静态闭包执行；另行验证动态依赖缺失、import 修改、超限、已有受控资源拒绝及旧调用形式的明确失败，记录迁移所需操作。不新增通用资源权限系统或自动内容 GC。

按迁移说明更新旧工程的配置与调用并重新构建，保留原制品不改写；验证相同 schema 标识下的新定义与明确弃用行为。如运行事实不兼容，使用新数据域验证，不修改旧历史。

远端 smoke test 的失败必须修复并重新发布新的不可变 RC 后重测，不因 npm
publish 成功即判部署完成。只清理本次拥有的临时路径；保留可重现脚本及脱敏证据，不记录凭据。

## Acceptance criteria

### D-AC01: 消费者可统一调用

以独立环境的调用结果证明作者只传 SpaceRef 即可运行父 DAG 内任务及外部任务，无需子任务启动授权，并能追溯 Engine 固定的执行 CID；以默认复用及独立覆盖的结果证明配置和内容存储边界符合约定。

提供每个发布包的精确 RC 版本、main commit、成功 CI 与 publish
run、不可变 tag 和精确版本可见性证据；证明 latest 未被本次发布改变，并在指定远端安装该精确 RC 完成 smoke
test。

### D-AC02: 准备承诺可复现

以断源后的成功结果及缺块、修改、超限和受控资源拒绝记录证明完整准备不静默降级、CID 校验有效且资源边界保留，用户文档足以重现验证。

记录旧格式失败与显式迁移后成功的对应结果，证明不依赖隐式兼容、不改写既有 CID 或旧数据域。
