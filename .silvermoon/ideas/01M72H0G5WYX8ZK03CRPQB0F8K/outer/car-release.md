# CAR 前置发布：外部认证阻塞

> 历史方案已由用户撤销：task-bundle-car 不再是发布单元。保留本文件及旧不可变 tag
> 作为当时失败事实，不重试该 workflow、不发布该包。后续按新的 Deployment.md 仅推进
> 明确批准的 Builder/CLI 发布；以下恢复建议只属于已取消方案，不再作为当前执行步骤。

## 执行范围与契约

- 2026-11-10，父级明确批准的唯一发布目标是
  `@silvermoon-work/task-bundle-car@0.1.0-canary-261110-1`，映射 `task-bundle-car`。
- 部署契约先于外部执行同步：commit
  `329cebc1eee45ebc3c7b59ae04b5efa6145662b6`，
  `deploymentRevision=d05298bdbf638c09d2d38a739966f3b96644dc97`。
- 已接受的 implementationRevision 保持
  `2a707f415a36ca58fa95fa3b399bc3c7a0646cec`；没有修改 Inner、代码、版本或发布基础设施。
- Builder/CLI 未取得本段发布审批，未创建或推送其候选 tags，未发布其他依赖。
  未执行消费者安装/闭环、submitOuter 或 acceptOuter。

## 前置检查与并发历史

本地每次 npm 查询前，`npm config get registry` 和 `pnpm config get registry` 都确认
`https://mirrors.cloud.tencent.com/npm/`。使用现有 Node24 环境，没有 `--registry` 覆盖、
源回退、token 或本地 publish。

```powershell
npm view @silvermoon-work/task-bundle-car@0.1.0-canary-261110-1 name version dist --json
git ls-remote --tags origin 'refs/tags/task-bundle-car-v0.1.0-canary-261110-1*'
```

发布前版本查询退出 1/`E404`；本地及远程目标 tag 均不存在。
此前父级的官方 registry 只读核查也确认无版本，见
[verify-npm run 42809088942](https://github.com/silvermoon-work/task-engine/actions/runs/42809088942)。

两次候选 CI 被并发 main 更新取消，均未据此推 tag：

- [42810493825](https://github.com/silvermoon-work/task-engine/actions/runs/42810493825)，
  SHA `329cebc1eee45ebc3c7b59ae04b5efa6145662b6`。
- [42810805955](https://github.com/silvermoon-work/task-engine/actions/runs/42810805955)，
  SHA `6985134a2543c63250ce3b63608221366d119291`。

刷新 primary 后，以普通 fast-forward 保留 Engine Idea 的并发提交及验收事件，
没有改写/重放/编辑其文件。每次整合后重新观察本 Idea，其部署契约 revision 未改变。
最终发布候选是 main 可达的
`88450166b49b5eddbd5f0c8df3e89ba7ec6afa59`。

## 完整 exact-commit CI 门禁

最终候选最新 `ci.yaml` main push run：
[42810997907 / attempt 1](https://github.com/silvermoon-work/task-engine/actions/runs/42810997907/attempts/1)，
head SHA `88450166b49b5eddbd5f0c8df3e89ba7ec6afa59`，结论 **success**。

实际通过：

| 必需检查 | 结果 |
| --- | --- |
| Node.js 22.13.0 | success |
| Node.js 24.11.1 | success |
| Release verification (v1) | success |
| Confirm required checks succeeded | success |

通过 `gh run list --workflow ci.yaml --commit <SHA> --branch main --event push` 确认
这是该 SHA 的最新 run，再读取 job/step 结果逐项核对。发布前再次 fetch，
HEAD/primary 相同且 `git merge-base --is-ancestor <SHA> origin/main` 成功。

## 真实发布尝试

普通创建、推送的唯一 release tag：

```text
task-bundle-car-v0.1.0-canary-261110-1
  -> 88450166b49b5eddbd5f0c8df3e89ba7ec6afa59
```

tag 由真实 `push` 触发现有 `publish-npm.yaml`，不是 workflow_dispatch/dry run：
[42811711129 / attempt 1](https://github.com/silvermoon-work/task-engine/actions/runs/42811711129/attempts/1)，
job [Publish verified package](https://github.com/silvermoon-work/task-engine/actions/runs/42811711129/job/129814524734)。
workflow 于 2026-11-10 11:57:41 UTC 创建，最终 **failure**。

| 阶段 | 结果 |
| --- | --- |
| Verify release commit is on main | success |
| Verify release metadata | success |
| Verify exact-commit main CI | success |
| Build package and workspace dependencies | success；仅 CAR 与 protocol 构建范围 |
| Pack only the selected package | success；仅选中 CAR，一次 pack |
| Verify artifact identity and published workspace dependencies | success |
| Validate package artifact | success |
| Install the trusted publishing client | success；workflow 固定 npm 11.21.0 |
| Publish selected package | **failure，ENEEDAUTH** |
| Validate without publishing | skipped；本次确实是实际发布分支 |

现有 workflow 使用 npm environment、`id-token: write` 和同一个
`PACKAGE_TARBALL` 完成身份/依赖/publint 校验后进入 npm publish。
未添加 token、未改发布验证规则、未替换为另一次 pack。
发布日志显示包身份和准备提交的 tarball：

```text
npm notice name: @silvermoon-work/task-bundle-car
npm notice version: 0.1.0-canary-261110-1
npm notice shasum: bfd5e7bbddaca84028564bff1b7488db5f34b9ca
```

完整 registry integrity 尚不存在于本次验证证据；npm notice 的 integrity 是截断显示，
不能将其当作完整校验值或已发布字节证明。

实际失败信息（11:58:14 UTC）：

```text
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
npm error need auth You need to authorize this machine using `npm adduser`
```

该错误证明发布客户端未获得所需 npm 身份，不足以单独断定具体是首次包身份未建立，
还是 Trusted Publisher 某项匹配缺失。未执行日志建议的交互登录；不使用 token 或本地发布绕过。

## 发布后核查与真实状态

发布失败后再次通过设备 Tencent registry 查询精确版本，仍退出 1/`E404`。
这不能证明镜像与官方实时一致，但本次 workflow 没有成功发布，且没有可验证的安装结果。
远程核查确认唯一新增候选 tag 仍准确指向上述 SHA；Builder/CLI 候选 tags 不存在。

- **D-S03 未完成**：真实发布失败，不能仅凭 tag、pack 或前置校验成功打勾。
- D-S01/D-S02/D-S04/D-S05、D-AC01/D-AC02/D-AC03 均仍未完成。
- 没有伪造 registry 安装、bin/integrity 来源或生产闭环证据。

## 恢复条件

由具有 npm 管理权限的维护者核查/建立 `@silvermoon-work/task-bundle-car` 包身份，
并确认该包的 Trusted Publisher 精确绑定：
owner `silvermoon-work`、repository `task-engine`、workflow `publish-npm.yaml`、
environment `npm`。若首次包初始化需要额外操作，由父级明确处理其授权与平台限制，
不得由本执行段自行使用 token、本地 publish 或降低验证要求。

外部认证恢复后，先重新观察 primary、核对现有版本与不可移动 tag；
若该精确版本已存在，核验身份/字节，不重发。若仍不存在且同一候选具备最新合格 CI，
可在父级确认后重试原失败 workflow，**不移动、不删除 tag**。
只有 CAR 发布及 registry 可用性有真实证据后，才向父级申请下一明确 Builder 发布段。
