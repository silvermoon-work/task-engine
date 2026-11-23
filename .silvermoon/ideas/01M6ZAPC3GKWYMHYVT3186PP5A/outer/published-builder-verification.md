# 已发布 builder 包的独立验证

本文是 [Deployment](Deployment.md)
的部分前置证据，不是 CLI 的完整部署验收。2026-11-09 已确认另一 session 发布到 canary 的两个包是 builder 与 builder
CLI，并非本 idea 的新 engine 与 engine CLI。

## 发布身份

| 包                                  | 已发布版本              | canary     | 发布证据                                                                                    |
| ----------------------------------- | ----------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `@silvermoon-work/task-builder`     | `0.1.0-canary-261109-2` | 指向该版本 | [实际 publish run](https://github.com/silvermoon-work/task-engine/actions/runs/42577672894) |
| `@silvermoon-work/task-builder-cli` | `0.1.0-canary-261109-1` | 指向该版本 | [实际 publish run](https://github.com/silvermoon-work/task-engine/actions/runs/42577838042) |

两次 run 都是 tag push，release commit 均为
`85161c8a7211080e7f15f2f71dc8e9e96b21b80e`，exact-commit main
CI 与实际 Publish 步骤成功，dry-run 步骤跳过。不是仅凭 workflow 状态推断已经发布。
已安装 lockfile 中的 integrity 与 registry metadata 一致：

```text
builder:
sha512-I/CJy6bPpev2cIfR6Yh97TbuYKzzXmQp86STNskOeXAInZzaNAyODJWhuGL0N2LU9LlTVSu1pe8Kp7+vHodFqQ==
builder CLI:
sha512-pfSdEhcsLevEM7fe0EdNo14reFsiNLhj6kbwNb1K2SKgaguSGYvbDb+JKXcATHk+rkH04+PLM7V0wpgmMtiI0w==
```

## 独立 consumer 结果

环境为 Windows、Node.js `v24.11.1`、pnpm `11.22.0`。独立 consumer 位于
`D:\Code\task-engine-registry-smoke-7c074a1b`；没有使用 workspace
link、本地 tarball 或仓库 dist 作为安装替代。默认和大资源项目均由已安装包的真实 bin 创建，再独立安装自身依赖；核对实际入口均解析到各 consumer 自己的
`node_modules`，准确版本与上述 metadata 一致。

执行链路是已发布 CLI 的 help/version/init，再运行生成项目的
`pnpm install`、`pnpm build`、`pnpm car` 和
`pnpm check`，完整读取 CAR 并交给真实 SDK Worker 执行。机器可读命令和解析路径见
[完整结果](published-builder-evidence.json)。

| 场景             | 实际结果                               | 内容读取    | 回收证明                   |
| ---------------- | -------------------------------------- | ----------- | -------------------------- |
| 默认资源         | `Hello canary`，6 字节，1 chunk        | 11 次块读取 | `2026-11-09T07:48:06.218Z` |
| 大资源 CRLF → LF | `Hello canary`，600,006 字节，3 chunks | 16 次块读取 | `2026-11-09T07:48:27.921Z` |

两种场景均证明：

- manifest、Schema 闭包、CID 和完整资源通过 CAR 验证，文本中不存在残留 CR。
- 错误类型输入明确 rejected。
- 重复 build 退出码 1，原 Worker 字节哈希未改变。
- 损坏 CAR 的 check 退出码 1。
- Run 存在 reclaimedAt 且无 cleanupUnknown；engine 和内容源正常关闭，CAR
  retainedBytes 回到 0，整次验证进程退出码 0。

本次读取完成时间为 `2026-11-09T07:48:30.252Z`。

## 尚未满足的 CLI 部署条件

运行兼容性使用已发布的
`@silvermoon-work/task-engine@0.1.0-canary-261109-1`，以及该已发布包的 `testing`
MemoryStore；没有拿本地新版 `runBundle` 或 `drain`
充当已发布能力。这份结果只证明新 builder 的发布与运行兼容性：它不证明新 CLI 的解析、自动耗尽、派生闭包或信号处理，也不替代 HTTP/SQLite 专项验证。

当时 registry 观察结果：

- `task-engine@canary` 仍为 `0.1.0-canary-261109-1`；对准确候选
  `0.1.0-canary-261109-2` 查询返回 E404。
- `@silvermoon-work/task-engine-cli@canary`
  查询返回 E404，尚无对应实际发布证据。

因此不能勾选本 idea 的 D-* 发布或已发布 CLI
smoke 验收，也不能记录 submitOuter/acceptOuter。仍需先具备新 engine 和 engine
CLI 的实际发布版本，再执行 [发布与 smoke 计划](publication-smoke-plan.md)
中完整的已发布 CLI 场景；版本不可用时明确报告阻塞。
