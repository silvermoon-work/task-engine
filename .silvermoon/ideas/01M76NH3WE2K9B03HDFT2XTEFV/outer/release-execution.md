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

## 后续串行进度

以下每包都在前一包已成功且官方 exact endpoint 可见后才推 tag；全部固定 V，四类内部依赖字段均核对精确版本。

| package | 精确版本 | 成功 Actions run | 官方完整 after 观察 UTC |
| --- | --- | --- | --- |
| task-protocol | 0.2.0-rc.1 | [43196076650](https://github.com/silvermoon-work/task-engine/actions/runs/43196076650) | 2026-11-12T10:00:08.552Z |
| task-sdk | 0.2.0-rc.1 | [43196487503](https://github.com/silvermoon-work/task-engine/actions/runs/43196487503) | 2026-11-12T10:02:48.009Z |
| task-builder | 0.2.0-rc.2 | [43196914719](https://github.com/silvermoon-work/task-engine/actions/runs/43196914719) | 2026-11-12T10:06:39.557Z |
| task-builder-cli | 0.2.0-rc.2 | [43197494196](https://github.com/silvermoon-work/task-engine/actions/runs/43197494196) | 2026-11-12T10:12:42.024Z |
| task-engine | 0.2.0-rc.2 | [43198440993](https://github.com/silvermoon-work/task-engine/actions/runs/43198440993) | 2026-11-12T10:17:22.896Z |
| task-engine-cli | 0.2.0-rc.10 | [43199115450](https://github.com/silvermoon-work/task-engine/actions/runs/43199115450) | 2026-11-12T10:22:26.715Z |

表内各包的 tarball 实际 SHA-1／SHA-512 都与官方元数据一致，公开 SLSA 的 tag／repository／workflow／gitCommit=V 和 subject digest 也匹配。所有 latest／canary 原样，仅 rc 更新。Builder CLI 的 Actions 成功先于 exact record 可见；只按有上限的既定等待复查同一 endpoint，没有重复 publish、rerun 或移动 tag。

Engine 在上述 Builder CLI 精确版本可见后才发布，包含 development-only 前置边。Engine CLI 在 Engine 精确版本可见后才发布，六条内部依赖字段均已精确可见。现在七包全部 Actions success、exact version 可见、tarball integrity 与公开 provenance 来源／摘要匹配；没有任何 rerun、版本覆盖、tag 移动或认证绕过。Engine CLI 曾等待 rc 元数据的缓存延迟，只读复查后才完成收据，没有重复 publish。

七个 latest 和历史 canary 都未变，ipfs-store 的 stage／rc.0 保留。完整结构化记录的 `allSevenPublishedAndVisible=true`；这只代表发布链完成，不是 remote smoke 或 Outer 验收完成。

隔离安装入口 `prepare-registry-consumer.mjs` 已通过语法检查：它在写目录之前先要求七个精确官方版本全部为 200，检查四类内部依赖，再只创建带 V／nonce／uid 的专有目录，使用原 HOME／原 registry 和专有 npm cache 安装，不改全局工具。其 SHA-256 为 `a4b559d26c30d35e5db92c2fbc65558dbb0a3ca33a224e43f8b84bf5e3592deb`。此处仍仅为准备，不是安装或 smoke 成功证据。

## Ubuntu 首轮：安装成功，驱动目录准备失败

在同步发布证据 primary `da9c40a804fdf6850cc6b05c6676780ab27e70c0` 并观察 Outer `b29ec8c3a1ca` 后，实际执行新隔离目录安装。10:27:55.805 UTC 的 [ubuntu-bootstrap.json](./ubuntu-bootstrap.json) 证明七包全部来自真实官方 registry，精确版本、非 symlink 安装路径、lock／tarball/integrity 匹配；没有 workspace、源码或本地 tarball 替代，也没有改 user HOME／registry 配置、全局工具或其他会话资源。

第一专有目录为 `task-engine-spaceref-smoke/bbc504364514-523f5f68-f03c-41a3-97f5-b853074b66ed`。10:29:38.889 UTC 的[驱动校验](./ubuntu-script-verification.json)确认 ownership／uid／V 与原驱动 SHA-256 cb2a839c4c3f 一致，然后才开始执行。

真实首轮退出 **1**，见 [ubuntu-first-result.json](./ubuntu-first-result.json)。同对象 reader 取消与来源所有权、原 UnixFS 文件／目录流／缓存两组通过；首次 task build 在调用 `writeDirectory` 时因驱动没有先创建自己的 `bundles` 父目录而 ENOENT。这个 API 本来就先 realpath 既有父目录并仅创建新输出；没有产品库行为与合同不符的证据。此轮不能冒称矩阵通过，D-* 不勾选。

首轮 finally 记录 `allOwnedEnginesClosed=true`、`sourceClosed=true`，尚未启动任何 CLI daemon，没有需要强杀或操作他人的服务。仅在 Outer 驱动的 build helper 增加 `mkdir(dirname(directory), {recursive:true})`；不改运行库、manifest、已发 RC、断言或已接受 Inner／Ideal。修订后 `node --check` 退出 0，驱动 SHA-256 为 `8add718d2c60a4349c9fe00743fcd362a7acdf26aa2cdacf6314e18c7b00fd09`。

先同步这项驱动修订并观察新 Outer，再创建新的 nonce 目录，重新安装同七个精确 RC 并完整重跑；不复用首轮暖缓存，不删除失败记录，也不以局部通过替代最终结果。

## Ubuntu 二轮：CLI 参数夹具错误，保留失败

修订在 primary `6b395da39202337becf1f058c454ce27390af558`／Outer `6af93be51953` 同步重观察后，创建第二个独立 nonce consumer，重新从 registry 安装同七包，见 [ubuntu-bootstrap-replay.json](./ubuntu-bootstrap-replay.json) 与[驱动 hash 校验](./ubuntu-script-verification-replay.json)。

[ubuntu-second-result.json](./ubuntu-second-result.json) 真实退出 1：前三组对象／原 DAG／冷 hint 拒绝通过，全部四个 task folder／CAR 的构建已完成；CLI init 拒绝驱动误写的 `--name`。只读调用已发布 CLI 的 `init --help` 明确列出正确选项 `--package-name`，与源码公开定义一致，不能把这个调用方错误归咎产品。

finally 确认所有本轮 Engine 与 Source 关闭，未启动 CLI daemon。只将驱动该参数替换为 `--package-name`，所有功能断言、已发 RC、运行库、Inner／Ideal 保持不变。修订后语法检查退出 0，驱动 SHA-256=`ac03a9b8c092c581df490ea9d559fad8fabc9b035093f5b210d55fb153823c56`。再次同步并重观察后，将在第三个全新目录完整执行，保留前两轮失败，不复用暖缓存或选择性跳过。

## Ubuntu 三轮：主体矩阵通过，缺文件断言使用错误文本

在 primary `cf55f1f743dc779ac706e763909c1545f3a5d934`／Outer `31a88a502edf` 同步重观察后，用第三个全新 nonce 重新安装；[安装](./ubuntu-bootstrap-final.json)与[hash／所有权校验](./ubuntu-script-verification-final.json)均为真实结果。

[ubuntu-third-result.json](./ubuntu-third-result.json) 退出 1，16 个已执行组中 15 组通过：包括 CLI init／标准共享配置／独立覆盖、冷 Engine 完整准备后首次子调用前断源、嵌套共享目标、动态外部成功与离线失败、丢 ACK／恢复、output／旧调用／超时拒绝、深度与字节／唯一块预算、原 schema 显式迁移、真实父子取消。目录搬运组也已完成无缓存离线 CAR、原根／元数据、CLI car、离线 library 执行和修改拒绝，随后库正确以 `ENOENT` 拒绝缺 sidecar，但驱动错误要求英文文本包含 missing／not found，所以整组仍记失败，最后一组尚未执行。

把此检查改为更精确的 `{code:"ENOENT"}`，不接受成功或任意错误，不改库或任何已发版本。另只读测得实际 CAR 为 101263 字节、base64 最小 135020 字节，已超过 managed HTTP 默认 65536 帧上限；为最后的 CAR 上传实例明确配置公开选项 `--max-payload-bytes 262144`。这是足够的外层传输帧，不改变 task／文件／逻辑字节／唯一块预算或负面断言。

finally 确认本轮所有自建 Engine、Source 与已启动 CLI daemon 已关闭。新驱动语法检查退出 0，SHA-256=`28c0665a32da661587e03757466e534e9ee117382dcfe6d36498c700e036cf57`。同步后再以第四个全新目录完整重跑；三轮失败保留，D-* 仍不勾选。

## Ubuntu 第四轮：完整主矩阵通过

在 primary `532f0146c273ee252746b7d13983e0f93308278a`／Outer `f7e77b9de0ef` 同步重观察后，创建第四个全新 consumer `task-engine-spaceref-smoke/bbc504364514-93c45d97-0ccb-45ce-99fa-914b756158d1`，没有复用前三轮缓存。
[ubuntu-bootstrap-complete.json](./ubuntu-bootstrap-complete.json) 与[驱动校验](./ubuntu-script-verification-complete.json)证明实际安装同七个精确 registry RC，V 仍固定，驱动 hash 为 28c0665a32da。

**2026-11-12T10:48:08.674Z–10:48:49.340Z 实际退出 0，17/17 组全通过。** 原始结果为 [ubuntu-result.json](./ubuntu-result.json)，脱敏逐命令证据为 [ubuntu-commands.jsonl](./ubuntu-commands.jsonl)。没有 skip、关闭原根校验、绕过断源或用 workspace 替代：

- 原始资源 CID `bafybeiebhzeaiuldkqbkqadzxxqdrleo6puiuc3wdpadlnimq5g4mpuvam` 保留 777 字节非 raw leaves、mode／mtime／CRLF；导入、流读、本地零网络、无 gateway 缺块、取消一个 reader 不影响另一 reader，均直接使用已发 IpfsStore。
- 父根 `bafybeib3wgickzpucn3b4gkezmafm6ozktn7pygceeyf5fn4n7r37g45bq` 在全新 Engine cache 完整冷准备；第一次子调用前关来源，随后 A／C／两个共享 B 共四个独立 Run 成功，来源无新增请求，固定 B CID 相同。import.meta.url 为规范 IPFS 入口。
- 父 DAG 外的 D 离线调用明确失败，恢复来源后完整获取并独立执行；真实丢 ACK／同 key 与恢复保留一个固定 targetCid／child requestId／deadline。可写目标、旧形式、超时、深度配额、唯一块与逻辑预算、旧 imports 格式都明确拒绝；真实父子取消后回收。
- 已发 CLI init 后显式安装准确迁移 SDK；默认公共配置确实复用 Builder 缓存，独立 gateway／dataDir 覆盖不改默认目录，disabled raw gateway 不开放已缓存 CID。
- 搬运包含隐藏 sidecar 的完整目录，删除自己的原作者源和所有相关内容缓存，断来源、坏配置下 library／真实 CLI 离线 CAR 同根、唯一 CID 去重、原文件元数据与字节保持；修改／缺 sidecar 失败；全新 managed dataDir 实际消费该 CAR，独立子 Run 成功并正常停止。

10:49:09.682 UTC 的独立 [ubuntu-postcheck.json](./ubuntu-postcheck.json)再核对原始结果 SHA-256=`1f016a17aefc831f5cddef5eeebbb723666aa1633855149efa7c5779351cbd39`、17 组完整性及 default／override／offline 三个实例的 PID／birth，确认全部原进程物理退出、state=stopped／released=true，所有自建 Engine／Source 关闭；没有操作其他会话资源。

10:50:01.385 UTC 的 [registry-final-state.json](./registry-final-state.json)再次确认七个 exact 200、所有公开 Trusted Publisher 标记为 true；六包 latest／canary 不变，ipfs-store latest rc.0 与历史 stage／rc.0 保留，只有 rc 指向批准版本。

为逐一覆盖计划里“CID 错误、缺后继原块、单文件 CID 与第二分块 profile、额外 import 文件及 Engine 逻辑容量”的更细颗粒观测，另准备 `registry-edge-probe.mjs`；它只使用同一已验证 consumer 的真实安装包，并为每个负面路径创建新的自有冷缓存，不修改主矩阵结果或已发产品。先同步这项补充驱动，再执行并单独记录结果，尚不把补充项宣称通过。

## 隔离消费驱动准备

[registry-spaceref-smoke.mjs](./registry-spaceref-smoke.mjs) 是本计划的外部消费驱动，不包含产品实现。它先核对 ownership marker、精确 installed manifests、registry lock／tarball/integrity 和非 symlink 路径，再从这些已安装包加载公开 API／真实 CLI；不加载 workspace src／dist。

驱动覆盖冷准备后首次子调用前断源、嵌套共享原 CID、外部动态完整准备／断源失败、真实丢 ACK 与恢复身份、可写／旧调用拒绝、取消／超时／预算、标准配置复用与独立覆盖、同对象 reader 所有权、整目录搬运后的 library／CLI 离线 CAR 和新 managed data domain。所有自建 CLI 实例都记录 PID／birth，停止后按 `/proc` 身份确认原进程已退出；不停止未知实例。

CLI init 生成作者项目后，按批准的显式迁移步骤普通安装精确 SDK `0.2.0-rc.1` 与 Builder／CLI `0.2.0-rc.2`，记录模板初值及选择后的依赖；不改初始化器代码、不用本地 runtime shim。此时仅执行了 `node --check`（退出 0），驱动 SHA-256 为 `cb2a839c4c3fc1c991503483dd8af97bdc071c6e6a54b8101bed0394d2a3e24d`；尚未在远端安装或运行，不能将准备代码称为通过证据。
