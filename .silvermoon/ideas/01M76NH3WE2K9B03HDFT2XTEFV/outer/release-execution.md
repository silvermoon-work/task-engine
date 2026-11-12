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

## 固定 V 与精确 main CI：已通过

版本提交 **V=`bbc504364514ef91edbd28e3a4a7f61d828cb58b`** 已普通 push 同步 main。其 Inner／Ideal 树仍分别为已接受的 bbca358050dd／edbb07ccf316。
[main push CI 43192357661](https://github.com/silvermoon-work/task-engine/actions/runs/43192357661) 的 headSha 完全等于 V，Node.js 22.15.0、24.11.1 和 `Release verification (v1)` 均 success，`Confirm required checks succeeded` 已成功。

本机另实际执行仓库 `github-ci-verify`：显式 repository=`silvermoon-work/task-engine`、sha=V、branch=main、workflow=ci.yaml、准确 job／step，返回 `ok:true`、runId=43192357661、runAttempt=1。本机无 Actions 的 repository／summary 环境，先前缺环境参数的两次 CLI usage error 不算验证结果；最终调用显式 repository 且省略仅渲染用的 summary，未弱化任何 CI 条件。

后续 primary 并发推进到 `4a0e0904df8e80aff84454f307ae697f55c1cb6a`，只有另一个 idea 的设计元数据，无 package／运行代码变化。V 仍为 main 祖先，全部 release tag 固定 V，绝不追移动 HEAD。

## 首包发布：已成功且精确版本可见

2026-11-12 09:44:49.366 UTC 的发布前官方复核确认 ipfs-store `0.1.0-rc.1` 及其余六候选仍未占用，所有候选 Git tag 均不存在，ipfs-store stage／rc.0 仍保留且 latest／rc 都为 rc.0。未发现依赖前置边（首包无内部依赖）。

随后只创建并普通 push **ipfs-store-v0.1.0-rc.1 → V**，
触发 [publish run 43194287700](https://github.com/silvermoon-work/task-engine/actions/runs/43194287700)。其 event=push、headBranch 为该 tag、headSha 为 V；精确 CI 校验、单包 pack、artifact 全字段校验、publint、直接 publish 步骤均 success。没有使用本地 publish、token 或 stage；新包真实 Trusted Publishing 路径已成功，不再是初始化／认证阻塞。

09:49:03.764 UTC 官方 exact record 为 `@silvermoon-work/ipfs-store@0.1.0-rc.1`，rc 已指向它，latest 仍为 `0.1.0-rc.0`；stage 和旧 rc.0 都保留。只读下载公开 tarball（没有安装或执行）得到 23605 字节，SHA-1=`c0e3158b7c613897812a0335865441c044883215`，SHA-512 与 registry integrity 一致。
公开 Trusted Publisher 标记为 true；SLSA v1 声明的 repository／workflow／ref 分别对应本仓库、`publish-npm.yaml` 和该 tag，resolved gitCommit=V，subject SHA-512 与实际 tarball 匹配。registry `gitHead` 为 null，未把它伪称为源提交。

首包完整 before／after、Actions steps、tarball hashes／integrity 和公开 provenance 在 [registry-publication.json](./registry-publication.json)。此刻其余六包仍未发布，D-* 与 remote smoke 尚未完成。后续只按单包顺序继续：`publish-authorized-one.mjs` 每次只接受一个批准 ID，检查所有先前成功收据、V 的精确 CI、剩余 tag／版本及全部内部依赖，再推一个 tag；不支持批量发布或自动换号。registry 可见性仅对明确的缓存延迟作有上限等待，其他失败立即停止。

## 隔离消费驱动准备

[registry-spaceref-smoke.mjs](./registry-spaceref-smoke.mjs) 是本计划的外部消费驱动，不包含产品实现。它先核对 ownership marker、精确 installed manifests、registry lock／tarball/integrity 和非 symlink 路径，再从这些已安装包加载公开 API／真实 CLI；不加载 workspace src／dist。

驱动覆盖冷准备后首次子调用前断源、嵌套共享原 CID、外部动态完整准备／断源失败、真实丢 ACK 与恢复身份、可写／旧调用拒绝、取消／超时／预算、标准配置复用与独立覆盖、同对象 reader 所有权、整目录搬运后的 library／CLI 离线 CAR 和新 managed data domain。所有自建 CLI 实例都记录 PID／birth，停止后按 `/proc` 身份确认原进程已退出；不停止未知实例。

CLI init 生成作者项目后，按批准的显式迁移步骤普通安装精确 SDK `0.2.0-rc.1` 与 Builder／CLI `0.2.0-rc.2`，记录模板初值及选择后的依赖；不改初始化器代码、不用本地 runtime shim。此时仅执行了 `node --check`（退出 0），驱动 SHA-256 为 `cb2a839c4c3fc1c991503483dd8af97bdc071c6e6a54b8101bed0394d2a3e24d`；尚未在远端安装或运行，不能将准备代码称为通过证据。
