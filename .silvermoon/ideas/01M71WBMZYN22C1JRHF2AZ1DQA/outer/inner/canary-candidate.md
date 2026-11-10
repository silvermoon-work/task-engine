# 明确授权准备的 canary 候选

父代理 2026-11-10 22:29 明确选择以下四个单包候选。
这是版本化交付物准备，不是发布授权，也不是 acceptInner 或部署成功。

| 顺序 | 映射 ID | 包名 | 精确版本 | 唯一预期 tag |
| --- | --- | --- | --- | --- |
| 1 | task-protocol | @silvermoon-work/task-protocol | 0.1.0-canary-261110-1 | task-protocol-v0.1.0-canary-261110-1 |
| 2 | task-sdk | @silvermoon-work/task-sdk | 0.1.0-canary-261110-1 | task-sdk-v0.1.0-canary-261110-1 |
| 3 | task-engine | @silvermoon-work/task-engine | 0.1.0-canary-261110-1 | task-engine-v0.1.0-canary-261110-1 |
| 4 | task-engine-cli | @silvermoon-work/task-engine-cli | 0.1.0-canary-261110-2 | task-engine-cli-v0.1.0-canary-261110-2 |

前三个 manifest 从旧已发布版本提升；CLI 原本已为选定候选 2，没有无谓修改。
所有内部依赖仍用 workspace:*，不改 Builder 的清单、生产 src、版本或 Idea。

SDK 清单提升后，根检查暴露 Builder init 测试把固定已发布模板默认值错误地
绑定到工作区候选 SDK 版本。唯一必要的相邻兼容测试修正为：
严格断言默认仍为已发布 `261109-2`，另严格验证显式传入当前候选版本的既有 API。
没有修改 Builder 的 src、清单、默认模板行为、版本或 Idea，也没有跳过断言。

## 只读预检证据

- 本机 npm/pnpm 有效 registry 均为 `https://mirrors.cloud.tencent.com/npm/`；
  没有覆盖 registry 或回退官方源。
- 四个候选精确 tag 的 `git ls-remote --tags origin` 查询均为空。
- 本机镜像对四个精确版本均返回 E404；这不作为官方槽位未占用证据。
- 为解决镜像传播与准确依赖的歧义，仅触发既有只读
  [verify-npm run 42835231424](https://github.com/silvermoon-work/task-engine/actions/runs/42835231424)，
  基线 `da76b79f4055b6464da95bf25940693c4ae625a8`，不是 publish workflow。
  CI 在官方 registry 返回完整 availableVersions，四个所选候选均未出现在该次观察中。
  发布前仍须重新验证不可变 tag 和精确 npm 版本，不能复用旧观察覆盖已占用版本。
- 组装基线的 main CI
  [42833776023](https://github.com/silvermoon-work/task-engine/actions/runs/42833776023)
  已为 success；它对应旧清单的 da76b79，不替代本组版本候选推送后的精确提交 CI。

## 准确依赖及真实阻断

当前 release verifier 包含 dependencies、optionalDependencies、peerDependencies、
**devDependencies** 中的内部 workspace 包；不能只检查运行时依赖。

| 候选 | 必须先可用的准确内部版本 |
| --- | --- |
| protocol | 无内部 workspace 依赖 |
| SDK | protocol 0.1.0-canary-261110-1 |
| Engine | protocol、SDK 0.1.0-canary-261110-1；Builder、Builder CLI 0.1.0-canary-261110-1 |
| CLI | protocol、SDK、Engine 0.1.0-canary-261110-1；Builder、Builder CLI 0.1.0-canary-261110-1 |

Builder core `0.1.0-canary-261110-1` 已由上述官方 CI 及本机镜像正向确认。
**Builder CLI `0.1.0-canary-261110-1` 尚不可用：该官方 CI 明确报 missing，
availableVersions 只有 stage/0.0.0、261109-1、261109-3；本机镜像也返回 E404，
未发现该精确 tag 或成功的该包 publish run。**

因此该只读 run 为 failure：缺少 Builder CLI 1，以及尚未发布的 CLI 候选 2。
这不是四包候选占用，也不是代码测试失败；是 Engine/CLI 后续发布的真实外部前置阻断。
本任务不改变 Builder CLI 依赖或清单来绕过 verifier，
不把它自动加入四包发布授权，也不代替其所有者发布。
父代理须另行协调这个准确版本可用后，才能执行相关包的发布步骤。

前三步候选之间的新版本依赖也必须按 protocol→SDK→Engine→CLI 逐包满足，
不得批量发布或跳过缺失版本检查。

## 仍待部署阶段验证

版本化代码与文档的准确 tree 绑定在 [实施验证](./verification.md)。
未来发布必须另经父代理最终批准，使用精确 main push CI 的
Release verification (v1)、Trusted Publishing、单次 pack 的同一 tarball。
本轮没有 release tag、npm publish、全局安装或安装 smoke 的成功事实。
