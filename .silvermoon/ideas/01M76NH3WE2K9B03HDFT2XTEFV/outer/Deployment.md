# RC 发布与远端 smoke test

用户已授权本 idea 的 RC 发布及 scottwei@office-ubuntu 安装验证，并委托主 Agent 负责阶段门限审批。仅对本 idea 必需的包逐个发布 RC，不授权 stable 发布、改变 latest 或批量发布整个 workspace。审批与发布边界见[执行与门限分工](./inner/ideal/execution-and-gates.md)。

主 Agent 已接受准确 `implementationRevision=bbca358050dda9b26c645266dcca67a47197623b`，决定同步至 primary
`f330abbc14f1900da33453c2d2f9d70976b241ac`，生命周期为 deploying。
[更新后的七包计划](./release-and-smoke-plan.md)及[本轮只读预检](./release-preflight-ipfs-store.json)等待父 Agent 审阅；旧[预检快照](./release-preflight.json)仅为历史。
本轮只准备和同步计划、只读核对 registry／Git／CI／SSH；不改包版本，不 tag／publish／install，不启动服务，也不记录 submitOuter。计划审阅不是 Outer 验收。

## Steps

### D-S01: 独立消费验证

主 Agent 通过实施门限后，明确受影响包、精确 RC 版本和依赖顺序，按仓库发布规则逐包更新 manifest、构建验证并同步 main。仅从通过精确提交 main
CI 的提交推送不可变 package-specific RC tag，经 publish-npm.yaml 的 Trusted
Publishing 发布；禁止本地真实 npm
publish、不覆盖既有版本或移动 tag。每个依赖的精确版本可查询后再发布依赖它的包，新增共享库先配置发布映射与 Trusted
Publisher；外部配置不具备时明确阻塞，不绕过。

新候选按 `ipfs-store@0.1.0-rc.1`、Protocol／SDK `0.2.0-rc.1`、
Builder／Builder CLI／Engine `0.2.0-rc.2`、Engine CLI `0.2.0-rc.10` 串行发布；完整四类依赖边和精确 tag 见计划。
不扩展到 HTTP／Storage／Server。官方已存在 ipfs-store `0.0.0-stage` 和 `0.1.0-rc.0`；
后者当前同时为 latest／rc，均须保留，不能覆盖或冒充本 idea 的产物。其余六包 latest 基线为 `0.1.0`。
所有新发布只更新 rc；占位不作为运行依赖，新候选尚未授权执行。

用户已确认新包 Trusted Publisher 配置完成，不再要求其重复证明其他六包绑定。只读预检确认仓库
`publish-npm.yaml` 使用 `npm` environment、OIDC 与直接 publish；公开元数据不证明或否定当前 npm 私有配置。
未来实际 OIDC／权限失败必须显式阻塞，不能改用 token、本地 publish、stage 或其他 workflow。
真正发布前仍须核对未来版本提交 V 的精确 main push CI、占用状态及所有依赖可见性，不借用历史绿色。

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
