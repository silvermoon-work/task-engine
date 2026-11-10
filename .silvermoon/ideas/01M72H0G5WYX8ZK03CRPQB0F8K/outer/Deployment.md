# Deployment

外部验证以 [CLI Spec](./inner/ideal/task-builder-cli-spec.html) 为准。
用户要求实际发布 Canary、从 registry 独立安装并使用该安装的可执行文件完成闭环；
源码工作区、仅 pack 或本地 tarball 安装均不能替代。实施阶段只细化此要求，D 项保持未完成。

## Steps

### D-S01: 确认外部验证候选与环境

确认 CLI 候选精确 Canary 版本、内部依赖的实际发布状态与独立消费者环境。
Builder 代码变更需要其独立新版；未经父代理明确授权不得自动发布内部依赖。
每包遵守 README 的映射 tag、exact-commit main CI、同 tarball 校验及 Trusted Publishing，
由父代理保留发布决策；不移动 release tag、不批量发布。
当前设备包操作前确认 Tencent Cloud registry；此设备限制不扩展到 CI。

### D-S02: 验证消费者交付闭环

从 registry 按精确版本独立安装已发布 Canary，记录命令解析到的 bin 真实来源，
用它执行 init → 外部依赖安装 → build（默认 CAR）→ 独立 car（不同新输出），
核对重复 build、--no-car、独立 car 拒绝覆盖及标准流；记录实际模块/CAR 的 Engine 消费结果。

## Acceptance criteria

### D-AC01: 独立安装可识别且可调用

保存真实发布 workflow/tag、registry 版本与 integrity、安装 lockfile 和 bin 解析证据，
证明 CLI 来自 registry 发布的精确 Canary，而非 workspace 链接、仓库 dist 或本地 tarball。

### D-AC02: 真实消费结果符合契约

以独立环境的命令结果、交付物校验及 Engine 消费记录，证明三个生产场景可用，默认路径、重复构建和独立封装的覆盖边界符合 Spec。
三个生产命令必须使用安装下来的可执行文件；记录真实 CID、退出码、结果对象、
模块文件选择与完整 CAR 消费，并验证新生成项目的精确依赖版本符合运行安装。
