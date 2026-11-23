# 四包 canary 部署执行计划

本计划先检查、提交并同步 primary，取得稳定 deploymentRevision 后才执行发布和安装验收。
父代理 2026-11-10 23:00 明确最终授权以下四个条件式单包发布；所有 acceptOuter 仍归父代理。
不改已接受 Inner 文件、实现、清单或版本；需要修复交付物时停止并返回父代理。

## 冻结身份与授权范围

已接受 implementationRevision：`8640cb14177d8b68c707d89f95e1ed1bea7a4718`。
执行时核对其交付 tree 与四个 manifest，保持准确内容，不仅比较版本文字。

| 顺序 | 映射 ID | 包名与准确版本 | 唯一批准 tag |
| --- | --- | --- | --- |
| 1 | task-protocol | @silvermoon-work/task-protocol@0.1.0-canary-261110-1 | task-protocol-v0.1.0-canary-261110-1 |
| 2 | task-sdk | @silvermoon-work/task-sdk@0.1.0-canary-261110-1 | task-sdk-v0.1.0-canary-261110-1 |
| 3 | task-engine | @silvermoon-work/task-engine@0.1.0-canary-261110-1 | task-engine-v0.1.0-canary-261110-1 |
| 4 | task-engine-cli | @silvermoon-work/task-engine-cli@0.1.0-canary-261110-2 | task-engine-cli-v0.1.0-canary-261110-2 |

没有 stable、批量或额外包发布授权；没有移动 tag、force push 或本地 npm publish 授权。

## 前置解除与复核

主体世界记录的 Builder CLI 1 缺失是此前时点真实观察，保留不改。
父代理现已确认：

- `task-builder-cli-v0.1.0-canary-261110-1` 指向 `15caa9a`；
  [Trusted Publish 42835596747](https://github.com/silvermoon-work/task-engine/actions/runs/42835596747)
  成功，artifact verifier 和 npm publish 实际回执匹配准确身份。
- Tencent 镜像返回
  `@silvermoon-work/task-builder-cli@0.1.0-canary-261110-1`，
  integrity 为 `sha512-5zu7KvdHQ0lptizpRoU3fIAF5plIb5/uPsn03lJpkjR+eCXyGO9Y4anuqEdt7sCVufsR20rhu1p3Zw9rKc+1GA==`。
- Builder core 当日 1 已发布。因此不需要额外依赖发布或修改 manifest。

执行时重新正向核对已发布依赖；verifier 包括 dependencies、optionalDependencies、
peerDependencies 和 devDependencies 中的内部 workspace 包，不缩小检查范围。

## 每个包的串行流程

1. 选择包含冻结交付物、main 可达、且自身 main push CI 已成功的 release commit。
   检查 `Release verification (v1)` 的 `Confirm required checks succeeded`，
   精确 head SHA、workflow `ci.yaml`、event push、branch main 必须一致。
   可以复用同一合格 commit 发布四个包，但不能借用另一 commit 的 pass。
2. 查本地/远程精确 tag 是否已存在，并通过 CI 官方 registry 观察准确版本是否已用。
   本机只用既有 Tencent registry；镜像 E404 不证明官方未占用。
   占用、依赖缺失或 CI 失败均停止调查，不覆盖、不移动、不绕过保护。
3. 仅创建并推送当前一个 tag，触发现有 `.github/workflows/publish-npm.yaml`。
   使用其 Trusted Publishing、精确提交 CI 守卫、依赖构建、单次 selected-package pack、
   同一个 tarball 的 identity/dependency/publint 验证与真实 npm 发布。
   不用 manual dry-run 冒充发布，不新增 workflow 或修改权限/环境。
4. 记录 tag target、publish run/job URL、成功步骤和准确 npm 输出。
   通过只读官方 registry 验证正向确认该准确版本及依赖、canary dist-tag；
   确认后才进入下一包。保存版本与 integrity，证明 latest 没有被本任务改为 stable 发布。

后续包的内部新依赖按上述顺序满足；Builder/core/CLI 当日 1 只复核，不再发布。
失败的本任务 pre-publication run 可以在同一不可变 tag 上调查重试，不移 tag；
任何必须改变交付物的修正返回实施门限。

## 真实 registry 安装与生产者

- 本机先在仓库外 cwd 验证 npm/pnpm 有效 registry 为
  `https://mirrors.cloud.tencent.com/npm/`，不使用 --registry 或官方 fallback。
  传播延迟只正常重试并记录，不从源码、本地 pack 或 tgz 代替 registry 安装。
- 创建唯一、自有的仓库外稳定安装 prefix。CLI 用准确版本安装，记录 npm 命令、
  实际 package/version/integrity、bin/shim 的 realpath、Node 版本和 cwd。
  运行入口不得落入 `D:\Code\task-engine`。
- npm 安装保留本机 NRM 环境；仅 CLI 运行子进程隔离 HOME/USERPROFILE/LOCALAPPDATA，
  避免改变 npm 用户配置或触发隐式 registry 切换。不关闭 runtime warnings。
- 在独立生产者安装中使用已发布 Builder CLI/core 当日 1，
  显式选择新 SDK 当日 1，不依赖固定旧模板默认值。
  通过实际 CLI 生成预编译 CAR；消费 CLI 的完整生产依赖闭包不能有 Builder/compiler。

## 安装后的可观察 smoke

- version/help 和原生 SQLite 导入守卫；不创建配置/数据目录。
- config list/get/set/reset、15 个键与 Gateway unset、产品默认、独立数据目录和用户配置位置。
- 后台 start 就绪、可信 status、同目录重复启动拒绝，运行中 prune 拒绝。
- CAR 与仅缓存 CID、异步受理后 query/logs/await，合法 null、
  业务失败 stdout code/message/退出 1，最终结果等待整任务释放。
- 在途任务默认 stop 拒绝、显式取消后停止、重复 stop 幂等。
  实际结束已核实自有实例再重启：历史结果/日志持久，未完成任务 failed 不重跑。
- 用多块共享资源构造 A/B/C 任务包，从实际 CAR 推导去重 CID 集合和载荷字节：
  cache-only 保留所有保留历史可达节点；只删 C 历史不删块；
  清理孤立块；组合删 A 历史再按 B 的传递引用清理，计数准确且共享后继保留。
  不能用根 CID 存在代替完整传递可达证明。
- 磁盘耗尽沿用已接受实施阶段的可控注入证据，不填满本机磁盘。

完整命令、stdout/stderr、退出码、任务/实例标识与 cleanup 证明保存在本 Outer 支持文件。
fixture、profile、运行数据均限定为唯一自有目录；停止所有本任务实例后才精确删除运行数据，
不停止其他 session 的进程。安装 prefix 可保留供父代理复核，不作为运行数据遗留。

## 完成门限

外部结果真实成功后才勾选对应 D 项。证据同步 primary、完成 worktree/staged 检查后，
为准确 deploymentRevision append submitOuter 并同步；在 upstream 门限停止，
不 append acceptOuter。
