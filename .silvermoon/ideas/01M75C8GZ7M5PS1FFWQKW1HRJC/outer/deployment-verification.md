# CAR 路径证明 RC 与独立 Ubuntu 验收

## 结论与范围

主 Agent 按用户授权独立审查并验收实现，完成新 CLI RC 发布及指定 Ubuntu 设备的外部复核。仅本轮显式 `dag-scope=block` 的 CARv1/dfs/dups=n profile 通过，不代表 entity/all、完整文件下载、字节范围、IPNS 或递归回源已经实现。

实现复核包含源代码、原始 block 保留、路径解析、协商、背压与取消；独立重跑 9 个 CAR/raw 测试及 1 个受管双 Engine 测试，全部通过。`pnpm check` 通过。验收对应实现 revision `7d26ba94eb85e214ddac520727a0038e960408ce`，源码提交 `dcdd9754ce46894edb5498353aab567ab442d9a5`。

## D-AC01：发布身份与独立路径验证

### 唯一包发布

- `@silvermoon-work/task-engine-cli@0.2.0-rc.2`，其余内部包仍使用已发布 `0.2.0-rc.0`。
- 准确发布提交：`234b1d4d03a96931565148c272b817a1802ce966`。
- 不可变 tag：`task-engine-cli-v0.2.0-rc.2`。
- [准确提交 main CI](https://github.com/silvermoon-work/task-engine/actions/runs/43046903779)：attempt 2 的 Node 22.13.0、24.11.1 和 `Release verification (v1)` 均通过，并通过仓库 `github-ci-verify`。
- [Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43051729330)：成功，准确提交校验、单包构建/打包、artifact/内部依赖校验、publint、OIDC 发布全部通过。未本地 publish，未移动 tag。
- registry 精确版本、下载 tarball 与普通安装包 manifest 完全一致；安装锁中该精确包条目的 integrity 匹配：

```text
sha512-vhl0axtblqairAdH3MqsR/BaozR1Dt1oNS0TR74F9e5z9twSMDnwRiB2DkIsKKYwQkMDdtiHmpcQ8AyOInk9YA==
```

发布后 `rc=0.2.0-rc.2`；`latest=0.1.0`、`canary=0.2.0-canary-261111-1` 保持不变，历史 rc.0/rc.1 仍存在。初次安装因 registry 目录尚未传播而找不到 rc.2；等待 90 秒后普通精确 SemVer 安装成功，未用上传的 tarball/工作区替代，未改目标设备 registry。

CI 首次 attempt 未通过：Node 24 的既有 managed lifecycle 测试在重启后的 stop 遇到 `ESRCH: no such process, read`；Node 22 job 被取消，聚合失败。未修改测试、跳过检查或豁免发布门禁；重跑相同提交的失败 jobs 后两矩阵与聚合全部成功，再创建 tag。

### 外部 consumer 与信任锚

在指定 SSH 设备新建独立临时 consumer，使用 Node `v24.16.0`、pnpm `11.5.1` 和 Kubo `0.43.1`。普通安装精确 registry RC；不构建 monorepo，不改共享工具或用户全局配置。脚本与契约先同步到发布提交，再执行 [独立验证脚本](verify-car-ubuntu.mjs)。

脚本创建真实 bundle 和执行任务，输出包含 `nested/deep/payload.bin`，实际写入 3000000 字节随机内容。客户端的信任锚是请求根 CID 与路径；独立 DAG-PB 命名边验证器不使用服务端路径解析代码，也不信任 CAR header roots。所有 block 独立校验 SHA2-256，原始 bytes 与 raw 响应逐块一致。

UTC `2026-11-11T15:49:49Z` 左右取得以下实际结果：

| 项目 | Bundle 路径 | 任务输出路径 |
| --- | --- | --- |
| 请求根 CID | `bafybeiay5uxuedjbkoc34noneewkh2v2lphf7evlukl7mbxjtcmc4pdxui` | `bafybeifc6vvdmq326gnirp4spbkz4k65tceqr2pie44pbr2bwbnlzb65my` |
| 路径 | `resources/nested/proof.txt` | `nested/deep/payload.bin` |
| CAR blocks | 4，恰为根、两级目录和终点 | 4，恰为根、两级目录和终点文件根 |
| CAR bytes | 558 | 541 |
| CAR SHA-256 | `2849b50db61427f0de73dfcd6fff130971571411a24311d5c421143188c7430a` | `50985b2cd032aaebe62eda2721a1ca814d87effc994ee9a18d308f859a7fbe84` |
| 独立离线 Kubo | 导入、请求路径 resolve、终点 block get 均成功 | 导入、请求路径 resolve、终点 block get 均成功 |

任务结果为 `{echo:"independent-car-path",bytes:3000000}`。输出终点文件根有 3 个后代 links，均不在返回 CAR 中，证明 block scope 没有悄悄传输整个文件 DAG。本轮不能用 `ipfs cat` 要求完整文件内容；其成功标准是路径证明和终点 block 存在。

响应实际包含 `application/vnd.ipld.car; version=1; order=dfs; dups=n`、attachment、ETag、Vary、Content-Location 等；HEAD 无 body，条件请求返回 304，根 block 查询只有 1 个 block。bafkqaaa 返回合法 CAR header、零虚拟数据块。

## D-AC02：负例、传输失败与资源边界

- 独立验证器拒绝截断 CAR、删中间块、删终点、用另一个合法 block 替换终点、原 CID 配篡改 bytes、错误请求根。
- 仅替换 CAR header roots 时，仍从正确请求根验证成功；用错误请求根验证失败。这不是根据服务端声明自证。
- 删除中间块的可解析 CAR 可以导入全新离线 Kubo，但 resolve 失败；删除终点时 resolve 仍可能成功，而 block get 失败。验证同时要求终点存在，不能把 resolve 或 CAR 可解析当成完整成功。
- Engine 所配置的计数上游在全部相关请求之后仍为 0；关闭上游后路径请求仍成功，最终计数为 0。
- GET/HEAD 根缺失为 404，only-if-cached 缺失为 412。缺省 scope、all/entity 和 entity-bytes 明确拒绝；不支持的 CAR 版本/dups 明确 406，未静默降级。
- 从本轮自有文件缓存移走必要中间块后，已开始的 GET body 读取失败；HEAD/If-None-Match 不误报成功或 304。恢复原文件后路径读取成功，slot 可继续使用。
- token 模式无凭证为 401，正确凭证成功且 private；disabled 为 404。遍历 block 预算设为 1 后，多层 HEAD 明确 413。
- 远程验证没有声称吞吐/RSS 压测通过。慢接收背压、取消、shutdown、超时与并发池确定性证据来自主 Agent 重跑的实现测试。

## 清理与复现

验证脚本结束时自有 Engine 停止成功，独立连接确认 listener 关闭。所有 Kubo 命令使用各自新建 repo 的 `--offline` 模式，没有启动 Kubo daemon 或接入公共网络。保留简洁机器报告与 registry audit 后，删除本轮精确命名的临时 consumer，连同其中离线 Kubo 仓库、CAR、随机 payload、专用 HOME/config、安装包和 tarball；随后确认该目录不存在。token 未写入报告，演练后从专用配置移除。

上一轮四个远程测试目录已在本轮开始前确认不存在，无遗留 Node/Kubo 测试进程；此前保留的二进制 CAR 测试载荷也已删除，只保留紧凑报告。

复现时使用一个全新临时目录，普通安装以下精确依赖，`pnpm-workspace.yaml` 仅允许 esbuild 构建脚本，再复制 [已同步的脚本](verify-car-ubuntu.mjs) 并运行 `node verify-car-ubuntu.mjs`。该脚本拒绝复用已存在的专用 HOME；完成后按本节边界清除本轮目录。

```json
{
  "name": "task-engine-car-rc2-verification",
  "private": true,
  "type": "module",
  "dependencies": {
    "@silvermoon-work/task-engine-cli": "0.2.0-rc.2",
    "@silvermoon-work/task-builder": "0.2.0-rc.0",
    "@silvermoon-work/task-builder-cli": "0.2.0-rc.0",
    "@silvermoon-work/task-sdk": "0.2.0-rc.0",
    "@ipld/car": "5.4.6",
    "@ipld/dag-pb": "4.2.0",
    "multiformats": "14.0.5"
  }
}
```
