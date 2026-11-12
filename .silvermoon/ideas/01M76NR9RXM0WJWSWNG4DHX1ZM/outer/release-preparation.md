# 发布准备证据

## 契约与预检

- 部署契约先在 main `21c9ce88f09d2a8cc5f9058c1567cbe5dc578426` 同步，重新观察为 `deploymentRevision=36650e4cbc3a8ffdbcce30be6029474c1d4fa47d`，然后才进行 registry 与 Ubuntu 外部预检。
- 2026-11-12，本机既有腾讯 registry 对 Builder/Builder CLI/Engine `0.2.0-rc.1` 与 Engine CLI `0.2.0-rc.9` 的精确查询均返回 E404；四包 latest 基线均为 `0.1.0`。原 rc 分别为 `rc.0`、`rc.0`、`rc.0`、`rc.8`。Protocol/SDK `0.2.0-rc.0` 均已可见；四个拟用 Git tag 的远端查询均为空。
- 这只是预检快照，不代替每包发布前再次查询。`registry-release-observe.mjs` 使用现有 verifier 的官方 registry exact-version 读取函数，逐一核对未占用状态与全部内部依赖字段的已发布版本，并在发布后记录 tarball/integrity；不改变 registry 配置。
- Ubuntu 非交互 PATH 最初没有 node/npm；只读确认已有 NVM Node `24.22.2`、npm `12.2.2`，通过单次命令的 PATH 使用它们，没有更改默认 NVM、profile、全局工具或 registry。原 registry 为 `https://registry.npmjs.org/`，可用磁盘约 1.77 TB。仓库不保存连接账户、主机或个人路径。

## 四包版本准备验证

仅修改四个目标包的 manifest version，保持 workspace:* 和其他包版本不变，未改变任何已验收 Inner World 文件或产品源码。

- `pnpm install --frozen-lockfile`：退出 0，lockfile 未变，没有修改 registry。
- `pnpm check`：Node `24.11.1`，退出 0，Turbo **40/40 tasks 成功**，耗时约 **23m18**；随后测试类型检查与所有 package publint 完成。此前 Inner World 中记录的历史 Windows 时序失败未删除或改写，本次版本准备的完整检查为绿色。
- 三个部署 replay 均经 `node --check`；从实际 smoke 入口抽取的作者 fixture 使用同一 Builder callback 模式本地编译成功，生成 29,203 字节 Worker。此项仅为准备验证，不冒充 registry/Ubuntu 安装结果；临时本地 fixture 目录已删除。
- 下一步仍须等待**版本准备提交自身**的 exact main push CI（Node 22.15.0 / 24.11.1 + Release verification (v1)）成功后才能推单包 release tag；不能借用先前 `58d9089` 的绿色结果。

实际发布 workflow、版本准备 commit、registry 及 Ubuntu 安装结果将在后续 Outer World 证据中记录，本文件没有声称任何包已经发布。
