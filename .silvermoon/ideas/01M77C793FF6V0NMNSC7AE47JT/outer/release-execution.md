# Kubo RC 与 Ubuntu 消费执行证据

本文服务于
[Deployment](./Deployment.md)。用户授权父 Agent 审批门禁、发布新 RC 及隔离 smoke；不从 Git、测试或 Agent 叙述推断验收。已接受 Inner 固定为
`c76d42ef88ea485d2a198c4e9852c93cf5ca6b3c`。

## 发布准备：已验证，尚未发布

[发布计划](./release-plan.md)
明确五包和顺序，[发布前观察](./release-preflight.json)
为远端真实 registry 结果：五候选 exact 均为 404，latest／canary／原 rc 已记录；五个新 Git
tag 查询均为空。Protocol / SDK `0.2.0-rc.1` 已可见，不发布计划外依赖。

本机 npm／pnpm 有效 registry 均为 Tencent，`nrm current` 为
`tencent-cloud`；只用 package
manager 更新五个 manifest 的 version，未创建 tag、运行 hook 或改变依赖字段。随后
`pnpm install --frozen-lockfile` 通过，lockfile 无变化，`pnpm test:release`
**21/21** 通过。

版本候选运行代码与已接受实现相同。仅将五个 version
manifest 的归档传入已归属本会话的 Ubuntu 源码验证目录；归档 SHA-256
`d9fbe234eccd13d442f73d2316b1eefbea931e897dd8a9633c63b0a457b17dcd`
核对通过。Node.js **24.11.1** 下完整 `pnpm check` 再次**退出 0**：Turbo
**44/44** 成功、8 个缓存命中、用时
**9m23.161s**，最终测试类型检查与全部 publint 通过。原始 `release-check.log`
SHA-256 为 `401be144c38fb8d0c77c85bdc3ecbc49974556c4ef8b57c9edebc88448178052`。

其后只补充 Outer 验证驱动／证据，以及两份 README 中与新后端不符的旧 SQLite／pin 绝对描述，不改运行源码、断言、依赖或已接受 Inner。README 格式检查、两份驱动
`node --check`
通过。证据目录原本被默认 Prettier 忽略，另用显式空 ignore 路径格式化驱动和本轮 Outer 文档，不宣称忽略文件被默认全量格式检查覆盖。

## 固定驱动，等待准确 V CI

- [observe-rc.mjs](./observe-rc.mjs)：只读复核精确版本、依赖、未变渠道、实际 tarball 摘要及公开 SLSA 的精确仓库／tag／workflow／commit；不安装或执行下载的包。
- [registry-kubo-smoke.mjs](./registry-kubo-smoke.mjs)：只从全新 consumer 的 registry 安装路径加载公开 API／CLI，使用专用真实 Kubo
  0.43.1，覆盖文件字节、两个 SQLite
  Engine、重启／GC／prune、外部清理、断连和 managed CLI。

两份驱动目前仅完成语法及审阅准备，**尚未执行 registry RC
smoke**。发布提交 V、准确 main
CI、逐包 Actions 及 Ubuntu 实测将在实际发生后追加；当前 D-* 不勾选，不推断 Outer 完成。
