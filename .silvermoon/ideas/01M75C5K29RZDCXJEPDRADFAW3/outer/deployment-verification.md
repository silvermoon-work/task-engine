# 本地 raw gateway RC 发布与 Ubuntu 验收证据

## 结论与边界

主 Agent 按用户授权独立复核并接受实现，随后完成下述发布和外部验证。仅第一个 Idea 的非递归 raw profile 通过；未实现 CAR、IPNS、通用公开网关或恶意租户隔离，后续六个 Idea 未推进。

实现复核包含源代码、访问边界及本地读取预算审查，独立重跑四个协议/双 Engine 测试，均通过；`pnpm check` 40/40 Turbo tasks 及其后续类型和包检查通过。实现验收对应 `implementationRevision=95afdb96e5a500d3e50aa024c568cddd6c9c8ff1`。

## D-AC01：RC 身份、发布与渠道

- 唯一新发布包：`@silvermoon-work/task-engine-cli@0.2.0-rc.1`。其余内部依赖沿用已发布 `0.2.0-rc.0`。
- 准确源码提交：`d114d17da055f163b4679ae29899374a91140d7d`。
- 不可变 tag：`task-engine-cli-v0.2.0-rc.1`，指向上述提交。
- [准确提交 main CI](https://github.com/silvermoon-work/task-engine/actions/runs/43036295764)：Node 22.13.0、24.11.1 以及 `Release verification (v1)` 全部通过；本地另运行仓库的 `github-ci-verify` 确认该证据。
- [Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43038012016)：成功，准确提交校验、单包构建/打包、manifest 与内部依赖验证、publint、OIDC 发布全部通过；未本地 publish，未移动 tag。
- 精确版本记录与下载的 registry tarball 均确认为该包/版本，SHA-512 为：

```text
sha512-Ap908KqLtkDL2CxK/+3o1uzUVQ8p7tEt60y+XQe2qsYZbxm+HL0kkkifhXU/7c3ZI3/urm2rHVbHJSYgfjgmYA==
```

远程普通精确 SemVer 安装成功，安装包 manifest 与 registry tarball manifest 的身份和依赖一致，lockfile 中该精确包条目的 integrity 匹配上述值。tarball 单独下载仅用于审计，未作为本地包替代安装。

发布后实际查询：`rc=0.2.0-rc.1`；发布前后的 `latest=0.1.0`、`canary=0.2.0-canary-261111-1` 保持不变，历史 `0.2.0-rc.0` 仍存在。

最初 registry 精确版本端点已可用而包目录仍旧，`pnpm view` 暂时报找不到新版本。等待传播后普通 `pnpm install` 成功，未切换 registry、替换依赖来源或绕过验证。远程 npm 自身的 `view` 命令有既存运行错误，因此使用该设备已存在的 pnpm，没有修补共享全局工具。

## D-AC02：独立 Ubuntu 双节点执行

使用用户指定的 SSH 设备，Node `v24.16.0`、pnpm `11.5.1`。这里只运行安装包 consumer，不在设备上构建 monorepo。全局工具、现有配置和其他服务未改变；每个 CLI 子进程使用本轮专用 HOME。

先在一个新临时 consumer 普通安装上述精确版本并完成首次演练；随后将相同 registry lockfile 在第二个新 consumer 中通过 `pnpm install --frozen-lockfile` 复核，再运行已同步并加强 PID 断言的 [验证脚本](verify-ubuntu.mjs)。

最终脚本在 UTC `2026-11-11T14:31:21.445Z` 至 `14:31:39.138Z` 执行成功，使用同步提交 `c1b5b4c9cf4d23fd9c1465d411fc173ca2b14f25` 的契约和脚本；本文件仅追加已观察结果，不改变要求。

| 项目 | 实际结果 |
| --- | --- |
| A/B 初始进程 PID | `2015735` / `2015759`，启动后分别确认存活且不相同 |
| A/B loopback 端口 | `37451` / `43605` |
| 任务包 CID | `bafybeihrhkkxuzxgucqqm2rf2oqnh4ahl5ttmr4ptsajcr7gmsh4uxokjm` |
| 多 block fixture | callback 内保留 800000 字符随机数据，产生 11 个缓存 blocks |
| A 的预置 | 使用已发布 Builder 生成 CAR，并由 A 执行成功 |
| B 的获取 | 空缓存，只配置 A；关闭 A 的计数上游后，B 按 CID 独立执行成功 |
| 业务结果 | `echo=ubuntu-registry-independent`、`bytes=800000`、`prefix=7ffAdXlv` |
| 内容验证 | 11 个 A raw 响应逐块校验 multihash，并与 B 已校验落盘 bytes 完全相同 |
| 持久输出 | A 的 SQLite 输出根也通过 raw 获取和独立 multihash 校验 |
| 默认边界 | B 未开启 gateway，请求缓存 CID 仍为 404 |

## D-AC03：不回源、授权、故障与清理

- 上游计数器在命中、GET/HEAD 未命中和 only-if-cached 请求之后仍为 0；关闭该上游后，A 命中与 B 的任务执行均成功，最终计数仍为 0。
- GET/HEAD 根缺失为 404，only-if-cached 缺失为 412；bafkqaaa GET/HEAD 为 200；HEAD 无 body，If-None-Match 返回 304。
- 修改本轮自有根 block 文件后返回 500，随后恢复原始 bytes。
- token 模式无凭证访问已有/缺失 CID 均为 401；正确凭证成功且响应缓存为 private。凭证未写入本文件或原始命令报告，演练后从专用配置移除。
- 显式 disabled 后返回 404；将 block 上限设为 32 字节后，本地根 block 请求返回 413。
- 所有自有受管进程停止成功，随后独立连接确认最终两个 listener 均已关闭；未终止其他进程。
- 远程未声称压力/时序验收；429、504、断连和 shutdown 的确定性证明来自主 Agent 独立重跑的实现测试。共享 listener/事件循环以及 public/token 对整个实例缓存的访问范围仍是明确限制。

原始机器报告包含 `ok=true`、11 个已验证 blocks、两个零出站计数、所有边界检查为 true、两个实例均清理成功；报告不包含 token。

## 复现输入

在新的独立 consumer 目录中保存以下 `package.json`；使用目标设备本身的 registry 配置，不从仓库工作区或上传的 tarball 安装。

```json
{
  "name": "gateway-raw-rc1-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@silvermoon-work/task-engine-cli": "0.2.0-rc.1",
    "@silvermoon-work/task-builder": "0.2.0-rc.0",
    "@silvermoon-work/task-builder-cli": "0.2.0-rc.0",
    "@silvermoon-work/task-sdk": "0.2.0-rc.0",
    "multiformats": "14.0.5"
  }
}
```

本轮专用 `pnpm-workspace.yaml` 仅允许 esbuild 的构建脚本；安装器为显式 prerelease 请求自动记录的 release-age 例外仅存在于临时 consumer，不修改全局策略。

```yaml
allowBuilds:
  esbuild: true
```

执行普通 `pnpm install`，将已审阅提交的 `verify-ubuntu.mjs` 复制到该目录，再执行 `node verify-ubuntu.mjs`。不要对同一演练目录重复执行，脚本刻意拒绝复用已经存在的专用 HOME；重放时使用新目录。脚本会生成 `smoke-report.json`，其中命令记录对 token 值脱敏。
