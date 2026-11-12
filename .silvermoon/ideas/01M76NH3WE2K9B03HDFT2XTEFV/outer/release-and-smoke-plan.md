# SpaceRef / imports 逐包 RC 与远端 smoke 计划

## 当前边界与状态

本文件服务于
[Deployment.md](./Deployment.md)，不是第二份契约，也不是发布完成证明。

- 主 Agent 已接受 implementationRevision
  `de8464302233de4e449dd196096a458099470a70`；决定 commit 为
  `ba86cecab380a3eca9076d495cabb265c46a09f3`，事件 digest 为
  `f9a38f8cb592217a3a49d9bd651da13457557094`。
- 本轮只准备计划、核实公开信息并请求主 Agent 审阅。没有更新 package
  version、创建或推送 release tag、运行 publish /
  stage、安装远端消费包或启动远端测试服务。
- 原始只读观察见 [release-preflight.json](./release-preflight.json)。匿名 HTTP
  404 只代表相应官方公开记录不可读，不证明 npm
  owner 的私有包、预留状态或 Trusted Publisher 配置不存在。
- 发布计划目前有前置阻塞 B1；即使主 Agent 认可版本与测试矩阵，也不能跳过 B1 或精确提交 CI。

## 精确七包、版本与标签

包 ID / npm name 映射沿用 `scripts/release-packages.js`，scope 均为
`@silvermoon-work/`。仅发布以下七包，严格串行；所有标签固定同一个未来版本准备提交
`V`，而不是创建标签时的移动 HEAD。

| 顺序 | package ID       | 当前 manifest | 本 idea 拟用精确 RC | 不可变标签                   |
| ---- | ---------------- | ------------- | ------------------- | ---------------------------- |
| 1    | task-protocol    | 0.2.0-rc.0    | 0.2.0-rc.1          | task-protocol-v0.2.0-rc.1    |
| 2    | task-sdk         | 0.2.0-rc.0    | 0.2.0-rc.1          | task-sdk-v0.2.0-rc.1         |
| 3    | task-content     | 0.1.0-rc.0    | 0.1.0-rc.0          | task-content-v0.1.0-rc.0     |
| 4    | task-builder     | 0.2.0-rc.1    | 0.2.0-rc.2          | task-builder-v0.2.0-rc.2     |
| 5    | task-builder-cli | 0.2.0-rc.1    | 0.2.0-rc.2          | task-builder-cli-v0.2.0-rc.2 |
| 6    | task-engine      | 0.2.0-rc.1    | 0.2.0-rc.2          | task-engine-v0.2.0-rc.2      |
| 7    | task-engine-cli  | 0.2.0-rc.9    | 0.2.0-rc.10         | task-engine-cli-v0.2.0-rc.10 |

2026-11-12 05:08
UTC 的官方 exact-version 查询对以上七个候选全部返回 404；随后七个精确远端 Git
tag 查询均为空。这不是永久版本预留：主 Agent 允许继续后、版本准备时及逐包打 tag 前均重查。任何占用、他人预留或新 manifest 变化都停止并重新交主 Agent 审阅，不自动改版本或移动标签。

并发 `ipfs-module-loading` idea 在 `b6044673239005bd219494972e9ca5822d31dd05`
预留 Builder / Builder CLI / Engine `0.2.0-rc.1` 及 Engine CLI
`0.2.0-rc.9`。05:08 的官方精确记录已能读到前三包 rc.1，CLI
rc.9 当时仍为 404。不得占用它们；本 idea 开始发布前须确认该链已完成或由对应协调者明确排除冲突，避免迟到的并发发布把
`rc` 倒退。既有 latest / canary / 历史版本与标签均保留。

### 必要性与不发布范围

- Protocol、SDK 的 SpaceRef wire / author
  API 与子调用事实校验已经改变，不能混用已发布旧协议代码。
- Content 是共用内容机制；Builder、Builder CLI、Engine、Engine
  CLI 实际使用它及本 idea 新行为。
- 不发布 task-engine-http、task-engine-storage、task-engine-server、root、apps 或示例。远端本轮直接消费 Engine
  library 与 managed CLI；它们不依赖上述三包。不得仅因 workspace
  build 或这些包依赖 Protocol 而顺带发布。
- 若主 Agent 希望另验 HTTP / SQLite library /
  Server 的新协议发布，应另列明确版本和必要性并再审阅，不把七包计划悄悄扩大为全 workspace。

## 四类依赖字段与实际发布拓扑

以下均来自当前七个 manifest，覆盖 dependencies / devDependencies /
peerDependencies /
optionalDependencies；后两类当前没有内部依赖。源码内部依赖继续为
`workspace:*`，由 pack 转换为表中精确版本，不手写宽泛 npm range。

| 发布包             | dependencies 的内部精确版本                     | devDependencies 的内部精确版本           |
| ------------------ | ----------------------------------------------- | ---------------------------------------- |
| Protocol rc.1      | 无                                              | 无                                       |
| SDK rc.1           | Protocol rc.1                                   | 无                                       |
| Content 0.1.0-rc.0 | Protocol rc.1                                   | 无                                       |
| Builder rc.2       | Protocol rc.1、Content 0.1.0-rc.0               | SDK rc.1                                 |
| Builder CLI rc.2   | Protocol rc.1、Content 0.1.0-rc.0、Builder rc.2 | SDK rc.1                                 |
| Engine rc.2        | Protocol rc.1、Content 0.1.0-rc.0               | SDK rc.1、Builder rc.2、Builder CLI rc.2 |
| Engine CLI rc.10   | Protocol rc.1、Content 0.1.0-rc.0、Engine rc.2  | SDK rc.1、Builder rc.2、Builder CLI rc.2 |

尤其 Builder CLI → Engine 是 development-only 的发布前置边，不能因为 production
install 不装 devDependencies 而省略。每一步均等待所有字段内依赖的官方 exact-version
endpoint 返回 200 且 name /
version 一致；catalog 缓存或某个 dist-tag 不是替代证据。

## CI 基线、版本准备与逐包发布

1. 先取得主 Agent 对本计划及 B1 恢复路径的明确同意。本轮不执行下列动作。
2. 重新观察 main、七包 manifest、Git
   tags、官方精确版本与 latest 基线；保留并发历史，禁止 rebase /
   force。先解决所有包的 owner / Trusted
   Publisher 前置条件，再发布第一个包，避免发布一半才发现新包无法首发。
3. 只调整表列七包的 version，保留第三方 catalog、`workspace:*`、private
   apps 和其他包版本。记录未来提交 `V` 的完整 SHA，并核对 inner /
   ideal 树仍分别为已接受的 `de8464302233de4e449dd196096a458099470a70` /
   `edbb07ccf3167af68b321bbcb458fce6b19eac15`。产品源码实质变化必须暂停并报告主 Agent、重新验证实施，不能借版本准备绕过门限。
4. manifest 改变后才按实际需要恢复依赖；本机先确认当前有效 registry 是 NRM 管理的腾讯镜像，安装不传
   `--registry`。执行 `pnpm check`，Silvermoon worktree /
   staged 检查后普通 commit / push 同步 main。
5. **唯一允许打 tag 的 CI 依据是 `V`
   本身**：event=push、branch=main、workflow=ci.yaml，Node.js 22.15.0 /
   24.11.1 均 success，`Release verification (v1)` 的
   `Confirm required checks succeeded` success。使用仓库同一
   `github-ci-verify --sha V --branch main --workflow ci.yaml --job-name "Release verification (v1)" --step-name "Confirm required checks succeeded"`。未完成、失败、取消、跳过或不可读取均阻塞，不能借用 ba86ce
   / b60446 / 更早绿色结果。
6. 按顺序逐个创建 `package-id-vversion` 指向
   `V`，逐个普通 push，等待该包结果与官方元数据可见后再处理下一包；不一次推七个 tag，不批量 publish
   workspace。发布仅由 `.github/workflows/publish-npm.yaml` 的 push-tag
   job 执行。
7. 该 workflow build 目标及其依赖、禁用 lifecycle hooks
   pack 目标一次、校验 name/version/全部内部依赖、publint，并 publish **同一个**
   tarball；OIDC / Trusted Publishing，无 NPM_TOKEN、本地真实 publish 或 stored
   token fallback。手动 workflow_dispatch 仅 dry run，不能当作绑定验证或发布。
8. 每包记录 `V`、tag SHA、精确 CI / publish run URL、pack / artifact 校验、npm
   exact record、integrity /
   tarball 来源、provenance 和前后 dist-tags。现有六包 latest 基线为
   `0.1.0`；Content 的 public
   latest 当前不可读，owner 恢复后须重新冻结可核验基线。RC 只更新 rc，不改变任何 latest 或历史 tag。
9. 依赖可见性延迟用同一个 exact
   endpoint 有界等待；若一次未发布成功且 registry 仍无该版本，可在恢复外部条件后重试同一不可变 tag。若版本已存在，不重新 publish、不移动 tag、不绕过 verifier。

### 当前实际 CI 信息

已接受源码基线 `ba86cecab380a3eca9076d495cabb265c46a09f3` 的
[main CI 43158654344](https://github.com/silvermoon-work/task-engine/actions/runs/43158654344)
在 05:08 UTC 仍为 in_progress，两项 Node
matrix 尚未完成；没有把它写成绿色。该信息也不是未来 `V` 的 CI 许可。

本机已接受实现的全仓结果为 44/44 Turbo
tasks、678 通过、1 既有平台 skip；主 Agent另复跑 imports、content 和 composition 并接受了准确 inner。这些用于确认实施基线，不替代未来发布提交的精确 CI。

## B1：新包存在性与 Trusted Publisher 前置阻塞

### 已查证

- 官方公开 package endpoint 和拟用 `task-content@0.1.0-rc.0` exact
  endpoint 均返回 404；本机直接访问官方域名遇到 TLS 握手失败后，使用既有 Ubuntu
  Node 正常 HTTPS 对同一官方 endpoint 只读观察。没有关闭 TLS、改 registry 或把传输失败当 404。
- GitHub `npm` environment 存在，当前没有 protection rules / deployment branch
  policy。它不是 npm 侧绑定，也不能代替本轮的父 Agent 审阅。
- 既有 Builder / Builder CLI rc.1 的
  [43157541848](https://github.com/silvermoon-work/task-engine/actions/runs/43157541848)
  /
  [43158313932](https://github.com/silvermoon-work/task-engine/actions/runs/43158313932)
  成功执行了 Trusted Publishing；官方 Builder / Builder CLI / Engine
  rc.1 记录也有 provenance 和 trustedPublisher 标记。这只能证明相应历史发布，不能证明任何包当前配置未被改动。
- npm 官方
  [npm trust 前置条件](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)
  明确要求包已存在、操作者有 write 权限与 2FA；[Trusted publishing 设置](https://docs.npmjs.com/trusted-publishers/)
  从包设置创建授权。公开 registry / GitHub
  environment 不提供可代替 owner 登录的完整绑定检查。
- 当前官方说明中新建配置默认允许 stage publish；现有 workflow 使用直接
  `npm publish`，所以必须另确认 **Allow npm
  publish**。新配置须在 2 天内完成首次成功发布，否则会过期；仅保存表单不会预验证字段。

### 恢复条件

由具有 write 权限和 2FA 的 npm owner 在 npm 官方界面核实
`@silvermoon-work/task-content`
是否已有私有 / 预留 / 可配置的包记录，并提供脱敏确认：

| 字段                 | 必须匹配                                                    |
| -------------------- | ----------------------------------------------------------- |
| provider             | GitHub Actions                                              |
| Organization or user | silvermoon-work                                             |
| Repository           | task-engine                                                 |
| Workflow filename    | publish-npm.yaml（不是完整目录）                            |
| Environment          | npm                                                         |
| Allowed action       | 直接 npm publish 已允许                                     |
| 状态                 | 未过期；账号有 publish/write 权限；包与 repository.url 匹配 |

其他六包也须确认同一准确绑定及直接 publish 权限；不自动删除或覆盖他人的 publisher。`npm whoami`、dry-run 和历史成功都不是本次授权的充分证明。

若 owner 确认该包真正尚未建立，当前官方 npm
trust 前置条件不允许 Agent 直接配置一个不存在的包。本轮没有可核验且符合既有规则的自动 bootstrap 路径：须由 owner
/
npm 官方支持先确认不引入未授权发布的 provision 方案，再交主 Agent审阅。若无法做到，保持阻塞；任何发布政策例外或改为其他共享包布局都需要另行决定，涉及代码则重新验证实施，不能自行改已验收 inner。

尤其不得尝试 [npm stage publish](https://docs.npmjs.com/staged-publishing/)
绕过：官方说明它会为尚不存在的包公开生成 `0.0.0-stage`
占位版本，超出本任务仅 RC、只经指定 Actions/tag 发布的授权。也不使用本地 publish、stored
token、临时稳定版、移动 tag 或其他 workflow。

## office-ubuntu 隔离安装与运行方案

本轮只读预检：既有 Node `v24.22.2` / npm `12.2.2` 可用，registry 为
`https://registry.npmjs.org/`，两个全局工具已存在，可用容量约 1.77
TB（原始 KiB 见快照）。只对单次 SSH 命令设置既有 NVM
bin 的 PATH；没有安装、改 profile / NVM 默认版本或重启服务。

实际执行在主 Agent 允许发布且七个精确 RC 全部真实可读之后：

1. 新建独占、带 run nonce / ownership marker 的
   `$HOME/.cache/task-engine-spaceref-smoke/<V12>-<nonce>`，已存在即拒绝覆盖；不用
   `/tmp`、mktemp、共享工具目录或既有 Engine dataDir。
2. 使用已有 npm，以原 HOME / 原 user
   registry 与 scope 配置进行普通 registry 安装；`--prefix` 和 `--cache`
   都指向本次目录。记录生效 registry（不记录凭据），不添加本机腾讯镜像要求、不改远端 npmrc
   / 全局工具。
3. consumer 明确安装本表七个精确版本。fixture 另显式声明现有 catalog 版本：ipfs-unixfs-importer
   `17.1.1`、ipfs-unixfs-exporter `16.2.3`、@ipld/car `5.4.6`、@ipld/dag-pb
   `4.2.0`、multiformats `14.0.5`，不依赖偶然的 transitive hoist。核对 npm
   lock、installed manifests、解析路径、registry
   tarball/integrity；七个项目包必须都来自真实 registry，不能出现
   `file:`、`link:`、`workspace:`、本地 tarball 或指向仓库的符号链接。
4. 用已安装的 Builder CLI
   init 独立作者项目，再在该项目普通安装其精确 registry 依赖；不把 workspace/node_modules 链接进项目。执行 bin 使用本次 prefix，不替换既有全局命令。
5. 仅在运行 CLI / SDK
   helper 时设置隔离 HOME，使 Engine 配置、默认公共内容配置与默认内容目录均落入本次目录；安装阶段仍沿用原 HOME 的 registry 配置。默认复用案例使用隔离 HOME 下的标准
   `~/.config/task-content/config.json`，不设置 TASK_CONTENT_CONFIG，不传 content-data-dir，从而真正验证两方默认共用存储而不碰用户默认配置。
6. 所有测试 Source
   Gateway 和 Engine 仅绑定 loopback；先取得空闲端口，撞端口就明确失败换新端口，不能终止占用者。Engine 一律明确本次
   `--data-dir`、port、host；查询/运行明确
   `--engine`。记录并仅停止自己启动的 PID / instanceId，等待真实退出。
7. override 案例给 Builder `--content-gateway` / `--content-data-dir`，给 Engine
   `--ipfs-gateway` / `--content-data-dir`
   指向另外的本次目录；核对 source 计数与块目录边界，确认不混 Engine 数据库。
8. 保存脱敏命令、结果 JSON、所有源/产物 CID、tarball/integrity、父子 Run/request/deadline、共享唯一块统计及错误码。清理只针对 ownership
   marker 和 PID 核对后的本次路径；不删除别人的缓存或重启别人的服务。

## 真实 RC 消费验证矩阵

| 场景                                | 做法与必须观察的结果                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通用文件、目录和不同 UnixFS profile | 用已安装的标准 UnixFS importer 构造 777 字节非 raw leaves 与另一种分块的文件/非空目录，含 mode、mtime、CRLF 和 binary；imports 同时引入普通数据与任务。最终路径解析 CID 必须等于原根，元数据/字节保持，不用有损重编码代替 |
| 嵌套共享任务                        | A 引入 B 与 C，C 再引入同一个 B；A/C 通过自己的 bundle SpaceRef 调用，证明 B 根 CID 相同、CAR 内唯一 CID 去重，但独立调用仍有独立子 Run / 逻辑预算                                                                        |
| 完全外部 SpaceRef                   | 另建不在 A DAG 内的 D，使用 context.space(D).root 调用；没有 authorizeChild / CID 白名单，Engine 实际执行 CID 与固定事实可追溯，调用时完整准备                                                                            |
| 默认复用 / 独立覆盖 / 保留          | Builder 与 Engine 使用同一个隔离 HOME 的默认内容配置，构建后关来源仍命中相同内容目录；再分别覆盖 gateway / dataDir，确认只接触指定源与目录。关闭或取消一个 reader 不破坏另一个 reader，关闭客户端不删块                   |
| 无原机器缓存的离线 CAR              | 复制完整 task folder（含隐藏 .task-imports.car）到新目录，停止自己的来源，移除自己的原工程与构建缓存；在新 HOME、空 dataDir、故意不可用的内容配置下运行已发布 car，拦截网络并断言零获取，原根和 import 根不变             |
| 离线 CAR 的新消费者                 | 新建另一个隔离 Engine dataDir，用已发布 Engine CLI 消费该 CAR，来源保持关闭；独立子 Run 全部成功并确认释放，不能复用原构建缓存或未发布包                                                                                  |
| 准备完成后断源                      | 真实 Engine library 完整准备 A，父 Worker 用消息门等待；观察 Worker 已开始后停止自己的 Source Gateway，再释放消息门触发 B/C/孙调用。全部静态执行成功，来源请求无新增；不是仅在先执行过所有子任务后才断源                  |
| 修改与失败边界                      | 改 import 展开字节、加未声明文件、缺侧车/原块、路径覆盖、CID 不符均明确失败；文件数/逻辑字节/唯一块超限不能降级懒加载；动态 D 缺内容明确失败                                                                              |
| 既有资源边界                        | 通过真实 gateway hint / raw gateway 入口证明未授权网络候选不会被请求、已缓存 CID 不打开 disabled raw gateway；拒绝可写 output 作为子任务目标，不宣称覆盖任意 Node 文件/网络权限                                           |
| 固定身份 / 取消预算                 | 同 parentRunId + key 的重复/丢 ACK 重试只有一个固定 targetCid / child requestId / deadline，改变意图冲突；独立 Run、取消/超时和子调用配额仍生效                                                                           |
| 明确迁移                            | 真实旧 CID/path 调用和不符合当前定义的旧 manifest 被拒绝；更新调用/配置并重建后成功，旧 CAR/CID 不被改写，schema URI/version 保持既有标识；不兼容旧事实显式要求新数据域，原域 hash 不变，不自动清库                       |

所有 helper 只导入本次 consumer 已安装的 npm 包，先断言 import 解析真实路径；不从仓库 src/dist 或 workspace
alias 加载实现。测试脚本和 fixture 是外部消费驱动，不是替换包实现的本地 shim。

## 失败、完成与后续交接

发布前权限、CI、官方可见性或 SSH 不具备即停止，记录具体失败与恢复条件；不无限轮询、不改现有环境。先核对是否已实际产生 npm 版本，避免把失败 run 当作未发布而重复 publish。

实际远端 smoke 的失败按契约修复并准备新的不可变 RC 后重测；涉及产品代码实质变化先报告主 Agent，重新验证实施，不编辑已验收 inner 来掩盖变更。publish
success 本身绝不是部署完成。

只有全部 D-* 和真实 RC/SSH 证据完成、candidate 同步 primary 后，才记录准确 submitOuter 并交主 Agent 决定；本轮不 submitOuter、不 accept*。本轮交接是对本计划版本/顺序/前置条件的审阅，不是 outer 验收。
