# 完整 DAG scope RC 与 Ubuntu 验收证据

## 结论与边界

主 Agent 按用户授权独立复核并接受实现，完成新 CLI RC 发布及指定 Ubuntu 设备的 registry consumer 验证。三种 scope、缺省 all、多层文件、普通目录、HAMT、通用共享/identity DAG 与缺块边界均通过。字节范围、IPNS、回源、永久 pin 与严格租户隔离不在本轮。

实现复核针对 codec 解码、scope 遍历、去重、预算、错误传输及 GC 一致性；主 Agent 独立重跑 13 个 CAR/raw 聚焦测试与全仓 `pnpm check`，均通过。准确实现 revision 为 `9fd2ebd2b0fa3b17e1e095733c51904527e48374`，源码提交 `47eabf706196c0861ce299d1e2069c1d9f78aefb`。

## D-AC01：唯一 RC 身份与正确范围

### 发布及 artifact

- 唯一新发布包：`@silvermoon-work/task-engine-cli@0.2.0-rc.3`；内部依赖仍使用已发布 `0.2.0-rc.0`。
- 准确发布提交：`945d1885a5abb518965dfd4502a15b4ea2d95c68`。
- 不可变 tag：`task-engine-cli-v0.2.0-rc.3`。
- [准确提交 main CI](https://github.com/silvermoon-work/task-engine/actions/runs/43056637731)：attempt 1 的 Node 22.13.0、24.11.1 和 `Release verification (v1)` 均通过，并经仓库 `github-ci-verify` 确认。
- [Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43058171271)：成功，包括准确提交、单包构建/打包、artifact 与内部依赖校验、publint、OIDC 发布。未本地 publish，未移动 tag。
- 精确 registry tarball、安装包 manifest 完全一致；安装锁中精确包条目的 integrity 匹配：

```text
sha512-IBE+t68fniU3LsdBW0a1TDfnG5i28sxkiOvlrLWpCNuASZofQ3HE0cVdpgcA8ffmLXlLUQbqYUDbGXxbzAjniA==
```

发布后 `rc=0.2.0-rc.3`；`latest=0.1.0`、`canary=0.2.0-canary-261111-1` 保持不变，rc.0/rc.1/rc.2 历史版本仍存在。初期 registry 目录和精确版本端点尚未传播；等待后普通精确 SemVer 安装成功。没有用本地 tarball/工作区替代，没有改变远程 registry。

### 独立实际数据集

使用指定 SSH 设备、Node `v24.16.0`、pnpm `11.5.1`、Kubo `0.43.1`。在隔离 consumer 普通安装精确 registry RC，随后用相同 registry lock 在另一个全新 consumer 再次安装并验证。未构建 monorepo，未改共享工具或用户全局配置。

fixture 仅使用公共 codec/importer 库生成；以明确的离线维护操作将 hash 已验证 blocks 写入已经停止的本轮专用实例，不是产品上传/pin 接口。普通目录与 3 MiB 文件的预期闭包由独立离线 Kubo 先从完整 fixture 导出；HAMT 的全部分片/名称由独立 exporter 提供，all 闭包再由 Kubo 导出；通用 DAG 有手工明确的共享/identity 预期集合。验证端不调用产品遍历函数作 oracle。

执行使用已同步提交 `4753c311dc0588f9f80811ff9efcc83a428b352d` 的 [验证脚本](verify-scopes-ubuntu.mjs)；UTC `2026-11-11T16:32:36Z` 至 `16:32:47Z` 成功，初始自有 Engine PID `2021117`、loopback 端口 `42185`。

| 对象 | block | entity | all / 缺省 |
| --- | ---: | ---: | ---: |
| 3 MiB 多层文件 | 1 | 73 | 73 |
| 含该文件的普通目录 | 1 | 1 | 74 |
| 500 项 HAMT 目录 | 1 | 146 个所需分片 | 646 |
| DAG-CBOR 共享/identity 子图 | 1 | 1 | 2 个非虚拟 blocks |

所有响应的实际 CID 集合与独立预期完全一致，所有 block hash 与原始 bytes 一致；无重复输出。每个数据集缺省与 all 的 CAR bytes、ETag 完全相同，三种 scope 的 ETag 区分正确。HEAD 无 body，完整集合的条件请求为 304。路径 proof 与 raw 读取回归通过。

文件根为 `bafybeigvwjnyltybuyhxzicoes5ybn2xfzzmb63r6mxe77je7mqoh6bwmq`。从仅导入 file entity CAR 的空离线 Kubo 恢复 **3145728 bytes**，与原始随机文件逐字节一致，SHA-256：

```text
c917d74169a245e33eca0c3facc11b85a6e9f0ad5750fcd9b78302bcdd28b187
```

file block CAR 不能恢复完整文件。普通目录 entity 能列出名称但无法读取子文件。HAMT 根为 `bafybeiekmowkctsnepoilevivbn7zzscodhjvqb3vab5pl7w6abuushnby`；entity 在空离线 Kubo 中使用 `ls --resolve-type=false --size=false` 完整枚举 500 个预期名称，文件读取失败，证明未附带 child payload。HAMT all 可完全离线重新导出 646 个预期 blocks，首/中/末文件内容正确。

通用 DAG 根为 `bafyreiau22fiqcs62ejgaevz2yfb53rlrzzptnrthxnttfzdwbkhc2kwhy`；空离线 Kubo 能通过 `left/child` 的 identity 节点解析并读取 shared leaf，返回预期 bytes。entity 等同 block；all 遍历 virtual 后代但不输出 identity 数据段，重复引用的 leaf 仅输出一次。

## D-AC02：不完整缓存与故障边界

- 成功/失败/普通缺失/only-if-cached 请求的计数上游总计 **0**；关闭上游后 file entity 仍成功。
- 移走本轮缓存中一个必需 leaf 后，GET body 传输失败；HEAD、匹配旧 ETag 的条件请求不会成功或返回 304，only-if-cached HEAD 为 412。恢复原 bytes 后重新读取成功，slot 可用。
- 将一个语法有效但缺必要 leaf 的 CAR 导入另一个空离线 Kubo，完整 file cat 失败；不能把可解析 CAR 或仅根存在当作完整成功。
- 未知 scope、entity-bytes、未支持 codec 均明确拒绝；遍历预算设为 1 后完整文件 HEAD 为 413。
- 并发 prune 的确定性证明来自主 Agent 重跑的 LocalRead 故障注入：读取分支时删除尚未读取的 leaf，GET 失败且 HEAD/条件请求不能成功。远程演练是读取前移除必要 leaf，不冒充并发压力测试。
- 既有取消、超时、shutdown、慢接收背压与并发池回收测试通过。预算限制遍历深度、block/frontier、累计读取与输出 bytes；不声称 byte-for-byte RSS 限额或完整 pin。逐块验证后已经发出的数据不因后续 GC 自动失效，未读取的必需后代缺失则失败。

### 复核工具修正与清理

首轮外部脚本在 HAMT 原始 bytes 比较时将相同内容的 Buffer 与 Uint8Array 作构造器敏感比较，导致工具断言失败；产品请求已正常返回。没有将该轮称为通过。将两侧规范化为 Buffer、同步脚本后，在全新 consumer 从头执行上述全部验证成功；另预先按 Kubo 原生编码器修正 `dag resolve` 的 bare CID 文本断言。未修改发布版本或绕过产品检查。

两轮脚本均停止自有 Engine，并独立连接确认 listener 关闭。Kubo 全程使用专用空仓库与 `--offline`，没有启动 daemon。保存简洁机器报告与 registry audit 后，删除两个精确命名的本轮临时 consumer，包含安装包、tarball、专用 HOME/config、Kubo repos、CAR、fixture、3 MiB 随机载荷；随后确认两目录不存在。共享环境和其他工作未改变。

复现时在全新 consumer 普通安装以下精确依赖，复制本 Idea 的 `inner/fixtures.mjs` 与 [已同步验证脚本](verify-scopes-ubuntu.mjs)，再运行 `node verify-scopes-ubuntu.mjs`；脚本刻意拒绝复用已经存在的专用 HOME。验证后按本节边界清理本轮目录。

```json
{
  "name": "task-engine-dag-rc3-verification",
  "private": true,
  "type": "module",
  "dependencies": {
    "@silvermoon-work/task-engine-cli": "0.2.0-rc.3",
    "@ipld/car": "5.4.6",
    "@ipld/dag-cbor": "10.0.2",
    "multiformats": "14.0.5",
    "ipfs-unixfs-importer": "17.1.1",
    "ipfs-unixfs-exporter": "16.2.3"
  }
}
```
