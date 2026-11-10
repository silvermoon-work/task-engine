# Deployment

外部验证以 [CLI Spec r14](./inner/ideal/task-builder-cli-spec.html) 为准。
用户已授权取消独立 task-bundle-car 包，回到实现阶段重构；新 Inner 必须重新验收后才恢复发布。
历史 [CAR 发布失败](./car-release.md) 保留，但其发布方案与 D-S03 已撤销，不复用该稳定 ID，
不重试其 workflow、不移动/删除已存在的 `task-bundle-car-v0.1.0-canary-261110-1` tag。
重新验收后的 Builder 发布、registry 完整字节身份和已解除的历史 CI 阻塞，
见 [Builder 发布证据](./builder-release.md)；CLI 发布与真实安装闭环仍未完成。

| 用途 | npm 包 | 精确候选 | 发布权限 |
| --- | --- | --- | --- |
| Builder | `@silvermoon-work/task-builder` | `0.1.0-canary-261110-1` | 重新实现验收后由父级独立批准 |
| CLI | `@silvermoon-work/task-builder-cli` | `0.1.0-canary-261110-1` | Builder 发布后由父级独立批准 |
| 配套 SDK | `@silvermoon-work/task-sdk` | `0.1.0-canary-261109-2` | 只验证已发布依赖，不改版、不发布 |
| 协议 | `@silvermoon-work/task-protocol` | `0.1.0-canary-261109-2` | 复用既有规则，不引入新发布依赖 |
| Engine 消费者 | `@silvermoon-work/task-engine` | `0.1.0-canary-261109-3` | 从 registry 安装，通过公开 API 消费；不自动发布 Engine/Engine CLI |

真实 registry 安装及 init→外部依赖安装→build（默认 CAR）→独立 car 完整闭环仍是硬要求；
本地 tarball、workspace/dist 执行或仅 pack 不能替代。所有 D 项保持未完成。

## Steps

### D-S01: 确认外部验证候选与环境

重新观察已接受的新 implementationRevision，确认发布映射中没有独立 CAR 包。
记录候选精确版本、registry/tag 状态、实际 Node/pnpm、OS 和独立消费者安装位置。
本地 Node24/pnpm11.22；包操作前验证 Tencent Cloud registry，不用 --registry 覆盖或源回退。
CI 使用自身的官方发布配置，不套设备镜像限制。消费者使用仓库内操作自有目录的独立包项目，
独立 manifest/lockfile/node_modules，与 monorepo workspace 隔离，无源码链接或本地 tarball。
本契约有实质变化时先 check/commit/sync/reobserve 稳定 deploymentRevision，再执行外部验证。

### D-S02: 验证消费者交付闭环

从 registry 按精确版本安装 CLI；保存 metadata、完整 integrity、lockfile、
bin realpath/版本和完整生产依赖闭包，证明没有残留 task-bundle-car。
三个生产命令使用安装下来的可执行文件：
init → 外部安装生成项目依赖 → build（默认 CAR）→ 独立 car（不同新输出）。
确认生成模板固定当前 CLI/Builder 和配套 SDK 版本，不查远程 tag 替代。
保存实际 stdout/stderr/退出码、CID 与文件选择；重复 build 后模块/CAR 有效，
修改源码后 --no-car 只更新模块且旧 CAR 字节不变，独立 car 拒绝覆盖。
验证未选旧文件不参与归档、输入与链接边界受保护。
用 registry 安装的 Engine 与 Builder 的 compiler-free CAR 接口消费实际归档，
核对完整内容、根 CID、`Hello world`、资源读取、物理回收与进程自然退出；
不以源码或未发布 Engine CLI 代替外部消费结果。

### D-S04: 发布并验证 Builder 候选

仅父级重新批准该明确包后执行，不自动发布依赖。
刷新 primary，确认精确候选 commit 可达 main、版本/tag 未存在；等待该 exact SHA 最新
ci.yaml main push 的 Node22、Node24、Release verification (v1) /
Confirm required checks succeeded 全成功。
普通 push 不可移动的 `task-builder-v0.1.0-canary-261110-1`，仅通过现有
publish-npm.yaml/npm environment/OIDC 实际发布。workflow 只 pack 选中包一次，
身份、依赖、publint 检查后发布同一 tarball。禁止本机 real npm publish、token、
本地登录、dry run 冒充成功或修改门禁规则。
保存精确 SHA/tag、workflow run/attempt、registry metadata/dist-tag/integrity。
已有版本只核验身份与字节而不重发；认证失败交给维护者核查 Trusted Publisher，
仅在明确恢复且允许重试时重跑原 tag，不移动 tag。完成后向父级回报，不自动发 CLI。

### D-S05: 发布并验证 CLI 候选

仅父级单独批准该包后，确认新 Builder/SDK/protocol 精确依赖已发布，
按 D-S04 相同规则发布唯一 tag `task-builder-cli-v0.1.0-canary-261110-1`。
registry 可安装后才执行 D-S02；发布成功本身不等于消费者验收完成。

## Acceptance criteria

### D-AC01: 独立安装可识别且可调用

真实发布 workflow/tag、registry 版本/完整 integrity、安装 lockfile 和 bin 解析共同证明
所用 CLI 是精确 registry Canary，非 workspace、仓库 dist 或本地 tarball。

### D-AC02: 真实消费结果符合契约

三个生产场景、默认路径、重复构建、no-car、拒绝覆盖与 Engine 消费均有实际命令和结果。
完整 CAR/模块字节校验及运行回收通过，不把旧产物、部分交付或清理不确定报成成功。

### D-AC03: 单包发布链真实可追溯

Builder 与 CLI 分别具备审批对应身份、不可移动 tag、main 可达 commit、exact-commit
成功 CI、真实 OIDC publish 与 registry 字节身份。没有发布独立 CAR 包或自动发布其他依赖。
外部权限或可用性未解决则保留相关 D 项未完成，不 submitOuter、不 acceptOuter。
