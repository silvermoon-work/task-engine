# Ubuntu registry 安装与真实 smoke 证据

## 冻结契约、环境与来源

修订后的部署契约先同步到 primary `bc310275abcab9e12b29c75bb984503a10ef0772`，重新观察稳定 `deploymentRevision=25cad109cce2e01d17a536ba8a9cb2c707505210`，再开始第二个独立目录的外部验证。产品源码、已验收 Inner World、四个 RC 版本和 release tags 均未改变。

成功 replay 在 `task-engine-ipfs-rc-smoke-20261112-b6044673-r2`，2026-11-12 **06:07:45.407Z–06:08:41.230Z** 执行，orchestrator 自然退出 0。使用既有 Node **24.22.2** / npm **12.2.2**，registry 仍为 `https://registry.npmjs.org/`；没有改变全局工具、NVM 默认选择、registry 或其他项目/服务。Npm cache、作者环境、消费环境和数据目录均在本操作私有目录内。

两份已同步 replay 的本地/远端 SHA-256 相同：

- registry-smoke.mjs：`c56f9a37fdbe240dae9e1454b3d405811b93c32b87a79ede198d54e5a6c94f19`
- registry-engine-probe.mjs：`c418c45021612aa4cbfff3b564525561bdfd5365e42cc01c737cde763109f593`

完整脱敏结果为 [ubuntu-result.json](ubuntu-result.json)；没有用 workspace dist、file/link/workspace 依赖、全局 CLI 或源码覆盖伪装 registry 安装。脚本同时验证实际包目录为私有安装目录内的非符号链接。

## 四包锁定与运行时安装图

四包 package-lock 的精确版本、resolved tarball URL、SHA-512 integrity 全部逐项等于 [registry-publication.json](registry-publication.json) 的官方发布记录：

| 环境 | 实际精确包 |
| --- | --- |
| author | task-builder 0.2.0-rc.1、task-builder-cli 0.2.0-rc.1；SDK 为已发布 0.2.0-rc.0 |
| consumer | task-engine 0.2.0-rc.1、task-engine-cli 0.2.0-rc.9 |

实际 `npm ls --omit=dev --all --json` 退出 0。消费端 Silvermoon 图仅为 **task-engine、task-engine-cli、task-protocol**；没有 Builder、Builder CLI 或 SDK。Engine manifest 的运行时依赖也没有 Builder，故编译器并非 Engine 运行时前置。

完整原始锁文件没有本地链接依赖：

- [author.package-lock.json](ubuntu-locks/author.package-lock.json)，SHA-256 `793e50a579bf038b21790d7a565bf886e75f7209a7d5f3ab6077d1c18485a0fd`
- [consumer.package-lock.json](ubuntu-locks/consumer.package-lock.json)，SHA-256 `3399e7663b1ff27c96da21402786113aa79bb6b3b44ce667669d62285128e0ff`

## 新 Builder、真实 CID 与模块行为

使用 registry 安装的 Builder CLI 生成三个真实 bundle/CAR：

| 夹具 | 根 CID |
| --- | --- |
| main | `bafybeieyxvijoauangq3tohwedr2ocojbce4xkwabtkgrgt6rcmv3u7m6u` |
| foreign | `bafybeidtan3ny2rmrzguwc5sotygd65jblo4kt23j2njikp4dwxka2ob5q` |
| startup | `bafybeiccssdmjyjara6bnm7sudcwfggugkw5vyadontqhochxzlea3q7fa` |

发布端只以 CAR 执行正常 main/foreign fixture，缓存其真实多块内容；消费端通过独立受管 Engine 与实际 HTTP Gateway/内容客户端按 CID 获取、校验、执行。没有 MemoryIpfsClient 或仅向 hook 塞固定源码的替代证明。

消费端 CLI task `01M775Y6V2XBNB265CHMFM9SFJ` 成功，返回 `bytes=600000`，日志实际存储并读出 `ipfs-entry:echo`。以下三个值与实际 main CID 完全一致：

```text
import.meta.url = ipfs://bafybeieyxvijoauangq3tohwedr2ocojbce4xkwabtkgrgt6rcmv3u7m6u/worker.cjs
__filename     = ipfs://bafybeieyxvijoauangq3tohwedr2ocojbce4xkwabtkgrgt6rcmv3u7m6u/worker.cjs
__dirname      = ipfs://bafybeieyxvijoauangq3tohwedr2ocojbce4xkwabtkgrgt6rcmv3u7m6u
```

require/cache/resolve/resolve.paths 均为原生 CJS API；内置模块正常，self require 命中同一 exports/cache，求值次数为 1，传输 source 字段对任务不可见。两个并发 Run `01M775YB2YK405R8ZV1BHX9BG3`、`01M775YB2YNAB4TDFJRKT1NBC5` 均各自求值 1 次、code=0、非强制退出并有 reclaimedAt，堆状态未共享。

Node **24.22.2** 的原生 `require.resolve(ipfsURL)` 本次已能返回 IPFS URL；这不同于 Inner World 已测 Node 22.15.0 / 24.11.1 的 MODULE_NOT_FOUND。没有加入 shim 或扩大通用 IPFS resolve 承诺，只记录实际 Node 行为。

## 七项 probe、故障与关闭

所有 probe 都独立启动 registry-only Node 消费进程，自然退出 0，实际内容客户端已关闭，宿主本地模块导入仍成功：

| probe | 观察结果 |
| --- | --- |
| isolation | 两个独立 Run、正确 IPFS/CJS/二进制读取/日志与非强制回收 |
| reject | 16 类 require 请求均为 unsupported_module；包括真实 foreign CID、非入口资源、非法 CID、凭据、编码与 dot-segment、query/hash、file/HTTPS、未打包包；错误仅含规范当前入口，不回显凭据 |
| startup | 独立真实 raw-block HTTP Gateway 提供新 Builder 的 startup CAR；实际请求次数大于 0；type_unavailable 错误包含规范 startup CID/worker.cjs 地址，Engine 正常关闭 |
| missing | 真实 HTTP 404，准备阶段 rejected / bundle_fetch_failed，没有执行 |
| corrupt | 真实 HTTP 错误 CID 字节，完整性校验后 rejected / bundle_fetch_failed，没有执行 |
| cancel | cancelTask 实际返回 changed=true 与 canceledAt；Worker code=0、forced=false，有 reclaimedAt |
| force | 阻塞 Worker code=1、forced=true；cleanupUnknown 保留、reclaimedAt=null；engine.close 返回 reclamation_failed，不伪造独立清理证明 |

cancel 的即时返回 stage 仍可为 running；取消事实由 canceledAt 表示，之后物理退出与回收另行记录。没有把取消请求、业务 outcome、退出和清理确认混为一谈。

活跃 CLI task `01M775YJT9ZQ73V7GB3P1DE5AA` 先确认 SDK 日志，再验证默认 stop 明确拒绝 ACTIVE_TASKS；显式 `--cancel-running` 后正常退出。第二轮 publisher PID 2456390、consumer PID 2456625 均通过正常 authenticated managed stop 关闭。

独立后验 [ubuntu-postcheck.json](ubuntu-postcheck.json) 在 **06:12:05.221Z** 再次确认两轮共四个自建 daemon 的 `/proc` 状态均 absent；第二轮两个 instance 均 stopped/released=true，首轮异常 publisher 的 released=false 未被改写。没有遗留自建服务；runtime 数据目录新增 bundle 入口 `.cjs` 文件列表为空。作者构建物与包自带 bootstrap 不属于 Worker 临时物化。

## 历史失败与剩余边界

首轮已真实通过安装和七项功能，但在共享 publisher 执行故意启动失败任务后，stop 按策略拒绝确认资源释放；详情与按校验 PID 的 SIGTERM 收尾见 [release-evidence.md](release-evidence.md) 和 [ubuntu-first-run.json](ubuntu-first-run.json)。没有删除该失败或把 released=false 改成 true。第二轮将坏入口隔离于独立 probe，并完整重跑通过。

强制终止不等于任意副作用已清理；本次如实保留对应 uncertainty。除此之外没有未解决的部署阻碍。后验再次确认四个精确版本仍为 HTTP 200、integrity 匹配，所有 latest 均为 0.1.0；没有重新发布、换版本、移 tag、修改产品/Inner World 或升级 schema。等待父 agent 对精确 Outer World 独立验收，不自行 acceptOuter。
