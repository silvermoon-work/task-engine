# IpfsStore / SpaceRef 七包 RC 与隔离 smoke 计划

## 当前状态与批准边界

本文件服务于 [Deployment.md](./Deployment.md)，不是第二份契约或发布完成证明。

- 主 Agent 已接受准确 Inner `bbca358050dda9b26c645266dcca67a47197623b`，决定 commit 为 `f330abbc14f1900da33453c2d2f9d70976b241ac`，事件 digest 为 `766cc41afb0f2c71654b2e7a4e53086b6ccfadc2`。Inner／Ideal 不改。
- 本版取代旧 task-content 七包草案，父 Agent 已在 2026-11-12 08:51 UTC 明确批准本表七版本、顺序与隔离矩阵执行。批准对应计划 commit `b07a2b4eac0452ec69519bb80a1e5fcdf2f7f654`；不能自动扩展或改号。计划阶段没有发布或安装；后续实际动作见 [release-execution.md](./release-execution.md)。
- 新预检见 [release-preflight-ipfs-store.json](./release-preflight-ipfs-store.json)；[旧快照](./release-preflight.json)仅为历史，旧 B1 不再是初始化阻塞。用户已确认新包占位和 Trusted Publisher 配置完成，不再要求其重复证明其他六包绑定。
- 既有四包 `b6044673239005bd219494972e9ca5822d31dd05` 发布及 Ubuntu smoke 已由另一 idea 完成，见其[发布与 smoke 证据](../../01M76NR9RXM0WJWSWNG4DHX1ZM/outer/release-evidence.md)。这些是旧模块加载产物，不冒充本七包的消费验证；不复用、删除或重启该会话的目录／服务。

## 精确版本与顺序

scope 均为 `@silvermoon-work/`，映射沿用 `scripts/release-packages.js`。全部 tag 固定同一个版本准备提交 **V**，逐包推送。计划提交时 V 尚未创建；执行时已冻结为 `bbc504364514ef91edbd28e3a4a7f61d828cb58b`，实际 CI／发布结果见 [release-execution.md](./release-execution.md)。

| 顺序 | package ID | 准备前 manifest | 本次候选 | 不可变 tag |
| --- | --- | --- | --- | --- |
| 1 | ipfs-store | 0.1.0-rc.0 | 0.1.0-rc.1 | ipfs-store-v0.1.0-rc.1 |
| 2 | task-protocol | 0.2.0-rc.0 | 0.2.0-rc.1 | task-protocol-v0.2.0-rc.1 |
| 3 | task-sdk | 0.2.0-rc.0 | 0.2.0-rc.1 | task-sdk-v0.2.0-rc.1 |
| 4 | task-builder | 0.2.0-rc.1 | 0.2.0-rc.2 | task-builder-v0.2.0-rc.2 |
| 5 | task-builder-cli | 0.2.0-rc.1 | 0.2.0-rc.2 | task-builder-cli-v0.2.0-rc.2 |
| 6 | task-engine | 0.2.0-rc.1 | 0.2.0-rc.2 | task-engine-v0.2.0-rc.2 |
| 7 | task-engine-cli | 0.2.0-rc.9 | 0.2.0-rc.10 | task-engine-cli-v0.2.0-rc.10 |

2026-11-12 08:42 UTC 通过原 office-ubuntu 的正常、验证 TLS 的 HTTPS 观察官方 registry：

- ipfs-store `0.0.0-stage` 与 `0.1.0-rc.0` 均已存在（200），当前 **latest=rc=0.1.0-rc.0**。不得占用 rc.0、将其冒充已审源码或把 latest 改成其他值；所以本计划选择未占用的 **0.1.0-rc.1**。没有根据元数据推断 rc.0 的发布者或发布方式。
- 七个最终候选 exact endpoint 均为 **404**，七个精确远端 Git tag 均不存在，Git 查询退出 0。这不是版本预留；执行前和每个 tag 前都重查。占用、他人预留、manifest 或 source 变化须停止并重新交父 Agent 审阅，不自动改号。
- ipfs-store 既有 rc.0 没有公开 attestation／trustedPublisher 标记，也无匹配 release tag；这不证明用户当前配置缺失。它不作为本次已验证实现的运行依赖，必须发布本候选后再消费。
- 其余六包 latest 均为 `0.1.0`；Protocol／SDK 当前 rc 为 `0.2.0-rc.0`，Builder／Builder CLI／Engine 为 `0.2.0-rc.1`，Engine CLI 为 `0.2.0-rc.9`。这些当前 RC 有公开 Trusted Publisher／attestation 历史标记。

所有 existing latest、canary、stage、版本与 Git tags 原样保留。新发布只使用 **rc**，不发布 stable／stage，不删除占位或“纠正”历史 latest。每包发布后核对 latest 等于其本次 before 基线，rc 等于新精确版本。

## 四类依赖的拓扑

已从七个 manifest 读取并检查 dependencies／devDependencies／peerDependencies／optionalDependencies；所有内部边均为 `workspace:*`，后两类无内部边。以下是未来 pack 后要求在 npm 可查询的精确版本：

| 发布包 | dependencies 内部边 | devDependencies 内部边 |
| --- | --- | --- |
| IpfsStore 0.1.0-rc.1 | 无 | 无 |
| Protocol 0.2.0-rc.1 | 无 | 无 |
| SDK 0.2.0-rc.1 | Protocol rc.1 | 无 |
| Builder 0.2.0-rc.2 | IpfsStore 0.1.0-rc.1、Protocol rc.1 | SDK rc.1 |
| Builder CLI 0.2.0-rc.2 | IpfsStore 0.1.0-rc.1、Protocol rc.1、Builder rc.2 | SDK rc.1 |
| Engine 0.2.0-rc.2 | IpfsStore 0.1.0-rc.1、Protocol rc.1 | SDK rc.1、Builder rc.2、Builder CLI rc.2 |
| Engine CLI 0.2.0-rc.10 | IpfsStore 0.1.0-rc.1、Protocol rc.1、Engine rc.2 | SDK rc.1、Builder rc.2、Builder CLI rc.2 |

IpfsStore 已无 Protocol 依赖，因此可先发；优先验证新包真实 OIDC 路径，可在其他六包尚未发布前显式暴露权限失败。Protocol 再先于 SDK，Builder CLI 必须先于 Engine，即使该边只是 development-only。

不新增 task-content 兼容包，不扩大到 HTTP／Storage／Server／root／apps／示例。七包覆盖本次实际消费闭包；若要另发独立服务库，须另列必要性与精确版本再审。

## CI、Trusted Publishing 与逐包执行

1. 父 Agent 对本版的明确批准已具备；先准备固定 V，不得在其完整检查和精确 CI 成功之前推送首个 tag。
2. 执行前刷新 main，重查七包 exact endpoint、所有相关 tags、全部 dist-tags 和四类依赖。保留并发历史，普通 merge／push，不 rebase／force。
3. 仅调整这七包 version 到本表候选，保留 `workspace:*`、catalog 和其他包版本，创建未来 V。核对 Inner 仍为 `bbca358050dda9b26c645266dcca67a47197623b`，Ideal 仍为 `edbb07ccf3167af68b321bbcb458fce6b19eac15`。产品实质改动先报告并重验，不能在版本准备时绕过实施门限。
4. manifest 改变后才按需恢复依赖；本机安装前核对 NRM 的腾讯 registry，不传 `--registry`，不扩散到 CI／SSH。执行 `pnpm check`、Silvermoon worktree／staged 检查，普通提交并同步 main，冻结 V。
5. **唯一 tag 许可是 V 自身的成功 main push CI**：workflow=`ci.yaml`、event=push、branch=main、headSha=V，Node 22.15.0／24.11.1 和 `Release verification (v1)` 的 `Confirm required checks succeeded` 全成功。沿用 `github-ci-verify --sha V --branch main --workflow ci.yaml --job-name "Release verification (v1)" --step-name "Confirm required checks succeeded"`。未完成、失败、取消、跳过或不可读取均阻塞，不借用任何历史绿色。
6. 按表逐个创建指向 V 的不可变 tag，普通 push **一个**，等待该包 Actions 成功及官方 exact-version name／version 可见，再处理下一包。每次 artifact verifier 必须能查询全部四类内部依赖的精确版本，不能跳过 devDependencies 或依赖可见性。
7. 仅 `.github/workflows/publish-npm.yaml` 的 push-tag job 真发布：目标及依赖 build、禁 lifecycle hooks pack 目标一次、校验身份与依赖、publint，最后 publish 同一个 tarball；environment=`npm`，`id-token: write`，OIDC，`--tag rc`。workflow_dispatch 仅 dry run，不启动它冒充授权验证。
8. 用户关于新包绑定的确认作为配置证据；不要求重新证明其他六包。仓库 workflow／environment 与公开历史不能穷尽 npm 私有配置。**实际 OIDC、直接 publish 权限或过期失败就明确阻塞**，先查版本是否已经产生，不绕过为 token、本地 publish、stage、其他 workflow 或移动 tag。
9. 每包记录 V、tag SHA、main CI／publish run URL、pack／artifact 验证、官方 exact record、tarball/integrity、provenance 和前后 dist-tags。依赖可见性延迟只做有界等待；确认尚未发布时才可重跑同一不可变 tag。版本已存在即阻止再次 publish。

### 计划预检时的 CI／environment 观察（08:42 UTC 历史）

执行阶段的 V 已由 [43192357661](https://github.com/silvermoon-work/task-engine/actions/runs/43192357661) 精确 main push CI 核验成功；下面保留计划预检时的信息，不把旧状态冒充 V 的结果。

- 已接受决定提交 `f330abbc14f1900da33453c2d2f9d70976b241ac` 的 [main CI 43184831356](https://github.com/silvermoon-work/task-engine/actions/runs/43184831356) 在本轮读取时仍为 **in_progress**，两个 Node job 运行中，aggregate 尚未成功。实现提交 61b5661 与提交事件 207c08f 的 runs 已 cancelled，不能当作绿色。
- 本地已接受实现的完整结果是 44/44 tasks、689 通过、1 既有 skip；父 Agent 已独立复核部分测试。这不是未来 V 的 CI 许可。
- GitHub `npm` environment 可读，无 protection rules／deployment branch policy。workflow 使用该 environment、直接 `npm publish`、OIDC，不注入 NPM_TOKEN；这些只证明仓库路线，不宣称本轮进行了真实认证。
- V 尚未创建，因此精确 V CI 是**执行前必需门限**，不是声称已满足的预检。本轮不等待或触发真实发布。

## SSH 与隔离消费方案

08:42 UTC 原 `scottwei@office-ubuntu` 路径只读连接成功：Node `v24.22.2`、npm `12.2.2`、有效 registry `https://registry.npmjs.org/`，两个既有全局 CLI 存在，HOME 所在卷可用 `1773818772` KiB。只对该命令加入既有 NVM bin 的 PATH；未改 profile、SSH、全局工具、配置或服务，未访问另一会话的 smoke 目录。

只有本版计划获父 Agent 审阅、七包真实 RC 全部可读之后，才执行：

1. 在相对于 SSH 初始工作目录的 `task-engine-spaceref-smoke/<V12>-<nonce>` 创建带 ownership marker 的 consumer，已存在即拒绝覆盖；不写系统临时目录或旧会话目录。所有本地 scratch 均放当前工程目录之下，不使用 `/tmp`、mktemp。
2. 安装阶段保留远端原 HOME／registry 配置；prefix 与 npm cache 仅指向本次专有 consumer，不替换全局 CLI、不改 npmrc。明确安装本表七个精确 RC，不安装 stage，不用 tarball、workspace、file/link 或仓库符号链接替代。
3. fixture 显式声明标准库版本：UnixFS importer `17.1.1`、exporter `16.2.3`、CAR `5.4.6`、DAG-PB `4.2.0`、multiformats `14.0.5`，不依赖偶然 hoist。核对 installed manifests／lock／解析路径／registry tarball/integrity。
4. 只在运行 fixture／CLI 时设置本次隔离 HOME；默认复用案例使用标准公共 content 配置路径，不设 TASK_CONTENT_CONFIG、不传 content-data-dir。override 案例另设 gateway／dataDir，Engine 数据库单独隔离。
5. 自建 Source／Engine 仅 loopback，空闲端口冲突就失败重选，不能停止占用者。CLI 显式 dataDir／port／engine。只按自己记录的 PID／birth／instanceId／marker 停止清理，等待物理退出；不重启共享服务、不删除用户缓存。
6. 保存脱敏命令、CID、独立 Run／固定 child requestId／deadline、源计数和唯一块／逻辑预算统计。helper 只 import consumer 已安装包，先核对解析路径，不能从仓库 src／dist 加载替代实现。

## 真实 RC 验证矩阵

| 场景 | 必须观察的结果 |
| --- | --- |
| 通用导入与原 DAG | 777 字节非 raw leaves 文件、另一分块、带 mode／mtime 的非空目录、CRLF／binary；普通数据与任务都可 import，原 CID／字节／元数据保持 |
| 同一对象与独立实例 | Builder 与 Engine 接收同一 IpfsStore；同目录独立实例复用，独立目录覆盖隔离；本地零联网、无 gateway 缺块失败、冷缺失验证缓存、文件流／目录条目 |
| reader 所有权 | 两个 reader 共用获取，只取消一个仍可完成另一个；关闭 Engine 不关闭调用者 store，close 不删共享块，不自动 GC |
| 嵌套共享任务 | A 引入 B/C，C 再引入 B；相同 B 根，CAR 唯一块去重，但调用有独立 Run／逻辑预算 |
| 动态 SpaceRef | 父 DAG 外的 D 通过 context.space(D).root 调用，固定执行 CID，调用时完整准备，无 authorizeChild |
| task folder 搬运 | 复制完整目录含隐藏 sidecar，关闭自己的来源，移除自己的原工程与缓存；新 HOME／空 dataDir／坏内容配置下离线 car 零网络，根与 import CID 不变 |
| 新离线消费者 | 新 Engine dataDir 以真实已发 CLI 消费 CAR，断源仍独立执行并确认释放，不复用原缓存 |
| 准备后断源 | 父 Worker 门控等待，完整准备 A 后关自己的 Source，再触发嵌套子调用；静态执行成功且来源无新增请求，不能先运行全部子任务再伪称断源 |
| 失败与资源边界 | 修改／新增 import 文件、缺 sidecar／原块、路径冲突、CID 不符、文件／逻辑／唯一块超限都拒绝，不降级懒加载；保留 gateway 与受控资源拒绝，拒绝 output 子调用 |
| 身份与取消预算 | 丢 ACK／恢复／同 key 重试保留 targetCid、child requestId、deadline；意图改变冲突，取消／超时／配额与独立 Run 生效 |
| 显式迁移 | 旧 CID/path 调用和旧格式失败；更新调用与配置并重建成功，不改旧 CID／事实，不升级 schema 标识，不兼容事实用新数据域 |

## 停止与交接

计划提交 b07a2b4 当时只修改 Outer 计划／预检和用户指定的 README 重复残句，没有运行代码、manifest、lockfile 或 Inner／Ideal 变化；后来经新授权在 V 仅更新七个 version 字段。Inner／Ideal 与运行代码保持不变。
候选版本／tag 映射和全部四类依赖边已由脚本与实际七包 manifest 逐项核对通过；`pnpm format:check`、`pnpm test:release`（21/21）和 Silvermoon worktree 检查已退出 0。文档修正不冒充重新执行实现全仓验证；实施验证沿用准确已验收修订的真实证据。

现按明确授权进入版本准备；D-* 在真实证据完成前保持未完成，不提前 submitOuter／accept*。
预检、版本占用、并发冲突或 OIDC 出现明确失败就报告恢复条件，不无限重试、自动改号或绕过。
真实 smoke 失败涉及产品代码时先报告并重新验证实施；若需新产物，另选经审阅的新不可变 RC。全部 D-* 和真实外部证据完成、同步准确 Outer 后，才可 submitOuter 并交父 Agent 验收。
