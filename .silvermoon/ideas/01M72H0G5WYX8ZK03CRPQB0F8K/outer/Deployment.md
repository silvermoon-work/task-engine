# Deployment

外部验证以 [CLI Spec](./inner/ideal/task-builder-cli-spec.html) 为准。
用户要求实际发布 Canary、从 registry 独立安装并使用该安装的可执行文件完成闭环；
源码工作区、仅 pack 或本地 tarball 安装均不能替代。
实现已接受：`implementationRevision=2a707f415a36ca58fa95fa3b399bc3c7a0646cec`；
部署不修改 Inner World、业务代码、版本或发布验证规则。
CAR 前置发布的实际执行、认证阻塞与恢复条件见 [CAR 发布证据](./car-release.md)；
失败尝试不等于已完成发布。

候选版本固定如下；每个待发布包必须分别取得父级明确审批，不因依赖关系自动获准：

| 用途 | npm 包 | 精确版本 | 发布 tag / 权限 |
| --- | --- | --- | --- |
| CAR 前置 | `@silvermoon-work/task-bundle-car` | `0.1.0-canary-261110-1` | `task-bundle-car-v0.1.0-canary-261110-1`；本回合唯一获准发布目标 |
| Builder | `@silvermoon-work/task-builder` | `0.1.0-canary-261110-1` | `task-builder-v0.1.0-canary-261110-1`；等待独立审批 |
| CLI | `@silvermoon-work/task-builder-cli` | `0.1.0-canary-261110-1` | `task-builder-cli-v0.1.0-canary-261110-1`；等待独立审批 |
| 配套 SDK | `@silvermoon-work/task-sdk` | `0.1.0-canary-261109-2` | 只验证已发布依赖，不改版、不发布 |
| 协议 | `@silvermoon-work/task-protocol` | `0.1.0-canary-261109-2` | 只验证已发布依赖，不改版、不发布 |
| Engine 消费者 | `@silvermoon-work/task-engine` | `0.1.0-canary-261109-3` | 从 registry 安装后通过公开 API 消费；若不可用则报告阻塞，不自动发布 Engine |

## Steps

### D-S01: 确认外部验证候选与环境

记录上述精确候选的 registry/tag 状态、实际 Node/pnpm、操作系统及独立消费者安装位置。
本地使用 Node24、pnpm11.22；每次包操作前确认设备有效 Tencent Cloud registry，
不以 `--registry` 覆盖、不回退官方源；此限制不扩展到 CI。
消费者是仓库内操作自有目录中的独立包项目，具有自己的 manifest/lockfile/安装目录，
与 monorepo workspace 隔离，不能链接仓库 packages 或替换为本地 tarball。
新建或实质修改本契约后，先检查、提交、同步 primary，重新观察稳定 deploymentRevision，
再对该版本执行外部验证。

### D-S02: 验证消费者交付闭环

从 registry 按精确版本独立安装已发布 Canary，记录命令解析到的 bin 真实来源，
用它执行 init → 外部依赖安装 → build（默认 CAR）→ 独立 car（不同新输出），
核对重复 build、--no-car、独立 car 拒绝覆盖及标准流；记录实际模块/CAR 的 Engine 消费结果。
保留 CLI registry metadata、tarball integrity、安装 lockfile、实际 bin realpath/版本和
生成项目依赖版本。三个生产命令使用安装下来的可执行文件，不使用仓库 dist。
用 registry 安装的 Engine/CAR 库消费实际生成归档，核对根 CID、`Hello world` 结果、
资源读取和物理回收；显式记录使用的公开 API 与进程自然退出。
重复 build 后模块及默认 CAR 有效；修改源码后 --no-car 只更新模块、旧 CAR 字节不变；
独立 car 对已有目标拒绝覆盖，未选旧文件不进入归档，整个过程中输入受保护。
所有命令保存实际退出码与 stdout/stderr；JSON 单对象、可信部分结果和路径均按 Spec 核验。

### D-S03: 发布并验证 CAR 前置包

仅针对已明确批准的 `task-bundle-car@0.1.0-canary-261110-1`。
刷新 primary，确认准确候选 commit 可达 main、版本/tag 未存在；等待该 exact SHA
最新 `ci.yaml` main push 的 Node22、Node24 及 `Release verification (v1)` /
`Confirm required checks succeeded` 全成功。
普通 push 唯一不可移动 tag，使用现有 `publish-npm.yaml`、npm environment 与 OIDC；
workflow 构建依赖但只 pack 选中包一次，校验并发布同一 tarball。禁止 token、本地 publish、
手动 dry run 冒充发布、force 或移动 tag。
记录 workflow URL/run/attempt、发布 SHA/tag、registry 版本/dist-tag/integrity与依赖核验。
若版本已存在，核验身份与字节而不重发；暂时错误可在保留 tag 下重试。
若首次包身份、Trusted Publisher、2FA 或维护者权限阻塞，只记录真实失败和恢复条件、
同步 Outer 证据并停止，不能修改门禁规则。
本段完成或遇到外部阻塞即回报父级，等待下一包明确审批。

### D-S04: 发布并验证 Builder 候选

只在父级单独批准 Builder 后执行，并先确认 CAR 所需精确版本可用。
应用 D-S03 的独立 exact-commit CI、不可移动单包 tag、同 tarball OIDC 和 registry 核验规则，
仅发布 `task-builder@0.1.0-canary-261110-1`；完成后再次回报，不自动推进 CLI 发布。

### D-S05: 发布并验证 CLI 候选

只在父级单独批准 CLI 后执行，并确认 Builder/CAR/SDK/protocol 的精确版本依赖已发布。
应用同一独立发布规则，仅发布 `task-builder-cli@0.1.0-canary-261110-1`。
registry 可安装后才开展 D-S02 的真实闭环，发布成功本身不等于消费者验收完成。

## Acceptance criteria

### D-AC01: 独立安装可识别且可调用

保存真实发布 workflow/tag、registry 版本与 integrity、安装 lockfile 和 bin 解析证据，
证明 CLI 来自 registry 发布的精确 Canary，而非 workspace 链接、仓库 dist 或本地 tarball。

### D-AC02: 真实消费结果符合契约

以独立环境的命令结果、交付物校验及 Engine 消费记录，证明三个生产场景可用，默认路径、重复构建和独立封装的覆盖边界符合 Spec。
三个生产命令必须使用安装下来的可执行文件；记录真实 CID、退出码、结果对象、
模块文件选择与完整 CAR 消费，并验证新生成项目的精确依赖版本符合运行安装。

### D-AC03: 单包发布链真实可追溯

CAR、Builder、CLI 分别具备审批对应的准确包身份、不可移动 tag、main 可达 commit、
exact-commit 成功 CI、真实 OIDC publish workflow 和 registry metadata/integrity 证据；
不得以 dry run、本地 pack、源码执行或一个包的成功替代另一个包。
外部权限或可用性未解决时保留相关 D 项未完成，不 submitOuter、不 acceptOuter。
