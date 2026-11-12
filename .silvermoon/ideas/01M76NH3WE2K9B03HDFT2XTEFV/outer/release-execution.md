# 七包 RC 与隔离消费执行证据

## 执行授权与固定边界

父 Agent 于 2026-11-12 08:51 UTC 明确批准计划 commit `b07a2b4eac0452ec69519bb80a1e5fcdf2f7f654` 的七个精确版本与顺序：
ipfs-store `0.1.0-rc.1` → Protocol `0.2.0-rc.1` → SDK `0.2.0-rc.1` →
Builder `0.2.0-rc.2` → Builder CLI `0.2.0-rc.2` → Engine `0.2.0-rc.2` → Engine CLI `0.2.0-rc.10`。
授权包括仅由指定 tag Actions／Trusted Publishing 发布，以及 office-ubuntu 的新隔离目录消费矩阵；不包括 stable、stage、本地真实 publish、token 绕过、移动 tag、自动换号或干扰其他资源。

实施仍固定已接受 Inner `bbca358050dda9b26c645266dcca67a47197623b`，Ideal `edbb07ccf3167af68b321bbcb458fce6b19eac15`。运行代码失败需修复时，先报告并重验实施与新 RC，不把 fixture 降级冒充契约满足。

## V 准备前的真实复核

08:52:47.660–08:52:56.178 UTC，原 office-ubuntu Node 以正常验证 TLS 的官方 HTTPS 复核七个候选 exact endpoint，均为 404；对应七个远端 Git tag 查询退出 0 且无结果。没有把传输失败解释为 404。

ipfs-store 的 `0.0.0-stage` 与 `0.1.0-rc.0` 均仍存在，latest／rc 仍为 `0.1.0-rc.0`；其他六包 latest 均为 `0.1.0`，canary 保留，rc 仍为 Protocol／SDK rc.0、Builder／Builder CLI／Engine rc.1、Engine CLI rc.9。这是发布前基线，后续只允许 rc 改为本表版本。

Git 与 primary 在准备前为 `b07a2b4eac0452ec69519bb80a1e5fcdf2f7f654`，ahead／behind 为 0／0。实际核对 npm 与 pnpm registry 都是 `https://mirrors.cloud.tencent.com/npm/`。通过 package manager 的 `npm version --no-git-tag-version --ignore-scripts --workspaces=false` 仅修改七个 manifest version；没有创建 Git tag、改依赖范围或运行发布 hook。manifest 改动后执行 `pnpm install`，未传 `--registry`，lockfile 未改。

下一门限是该候选的完整 `pnpm check`、Silvermoon 检查、固定 V 同步和 V 的成功精确 main push CI。此处尚不声称 V、CI、任何 publish 或 remote install 已完成。

### 版本候选本地检查：已通过

版本候选的完整 `pnpm check` 已实际退出 **0**：**44/44 tasks successful、0 cache hits**；690 个测试条目中 **689 通过、1 个既有 Linux-only Windows skip、0 失败**。Turborepo 用时 **31m51.205s**，完整命令墙钟 **33m09.177s**；最终测试类型检查与所有工作区 publint 也通过。没有跳过失败项、放宽时限或改运行代码。

真实输出在本工作区 `.cache/release-V-check.log`，SHA-256 为 `556bdb0917f69d016bd44049d86afab544d1a58dedec9b2353e07af2204aa3fa`。再次逐包比较 HEAD 的 JSON：只改变七个已批准 version 字段，其他 manifest 字段、lockfile、运行代码和已接受 Inner／Ideal 没有 diff。同步前刷新 primary 仍为 b07a2b4，ahead／behind 0／0，没有并发源码需要合并。

下一步冻结并同步版本提交 V；精确 V main push CI 尚未完成，仍不能打 tag。本地通过不替代 Actions CI 或真实发布验证。

## 隔离消费驱动准备

[registry-spaceref-smoke.mjs](./registry-spaceref-smoke.mjs) 是本计划的外部消费驱动，不包含产品实现。它先核对 ownership marker、精确 installed manifests、registry lock／tarball/integrity 和非 symlink 路径，再从这些已安装包加载公开 API／真实 CLI；不加载 workspace src／dist。

驱动覆盖冷准备后首次子调用前断源、嵌套共享原 CID、外部动态完整准备／断源失败、真实丢 ACK 与恢复身份、可写／旧调用拒绝、取消／超时／预算、标准配置复用与独立覆盖、同对象 reader 所有权、整目录搬运后的 library／CLI 离线 CAR 和新 managed data domain。所有自建 CLI 实例都记录 PID／birth，停止后按 `/proc` 身份确认原进程已退出；不停止未知实例。

CLI init 生成作者项目后，按批准的显式迁移步骤普通安装精确 SDK `0.2.0-rc.1` 与 Builder／CLI `0.2.0-rc.2`，记录模板初值及选择后的依赖；不改初始化器代码、不用本地 runtime shim。此时仅执行了 `node --check`（退出 0），驱动 SHA-256 为 `cb2a839c4c3fc1c991503483dd8af97bdc071c6e6a54b8101bed0394d2a3e24d`；尚未在远端安装或运行，不能将准备代码称为通过证据。
