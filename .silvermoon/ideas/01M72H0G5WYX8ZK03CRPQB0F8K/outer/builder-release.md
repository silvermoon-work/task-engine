# Builder 发布前置：CI 门禁阻塞

## 本段授权与候选

- 父级本段唯一批准：映射 `task-builder`，
  `@silvermoon-work/task-builder@0.1.0-canary-261110-1`。
- 待创建的唯一 tag：`task-builder-v0.1.0-canary-261110-1`。
  **本段没有创建或推送该 tag，没有触发 npm 发布 workflow。**
- 已接受实现：`e4954dd7da53bffb167090b69c1fa8506df8be6d`，acceptInner#9。
- 执行前已同步的 deploymentRevision：
  `a0bc4f24610c6373c5e1e2f0d3591c3b32ed0d52`。
- 候选/刷新后的 main：
  `9b4e31b809b290cd204dbe19cdd1769dec6d108d`，祖先可达检查通过；
  tagged manifest 待选身份为上述 Builder 包和版本，没有其他包的发布授权。
- 不重试已取消 CAR 方案，不发布 Builder CLI、Engine CLI、Protocol 或其他依赖。

## Registry 与 tag 前置

2026-11-10，在现有 Node24 环境：

```powershell
npm config get registry
pnpm config get registry
npm view @silvermoon-work/task-builder@0.1.0-canary-261110-1 name version dist --json
git ls-remote --tags origin 'refs/tags/task-builder-v0.1.0-canary-261110-1*'
```

两个 registry 均为 `https://mirrors.cloud.tencent.com/npm/`；
精确候选查询返回退出 1 / `E404: No match found for version 0.1.0-canary-261110-1`。
本地及远程目标 tag 均不存在，等待结束后再次远程核查仍不存在。
未覆盖 registry、未回退官方源、未运行本地 real publish 或使用 token。
因为尚未发布，没有候选的 registry dist/integrity 或安装成功证据。

## Exact-commit CI：两次真实失败

候选最新 `ci.yaml` / `push` / `main` run：
[42821471205](https://github.com/silvermoon-work/task-engine/actions/runs/42821471205)，
head SHA 始终为 `9b4e31b809b290cd204dbe19cdd1769dec6d108d`。

| attempt | Node22.13.0 | Node24.11.1 | Release verification (v1) |
| --- | --- | --- | --- |
| [1](https://github.com/silvermoon-work/task-engine/actions/runs/42821471205/attempts/1) | failure | success | failure |
| [2](https://github.com/silvermoon-work/task-engine/actions/runs/42821471205/attempts/2) | failure | failure | failure |

第一次失败带 child deadline 超时迹象，因此只执行一次对同一 SHA 的完整 CI 重跑：

```text
gh run rerun 42821471205 --repo silvermoon-work/task-engine
gh run watch 42821471205 --repo silvermoon-work/task-engine --exit-status --interval 30
```

没有选跳测试、修改超时/断言、关闭校验或伪造 aggregate 成功。
第二次仍失败，因此不能继续将问题视作已经排除的偶发失败，也不循环重试求绿。

### 重复主失败

[storage startup test](https://github.com/silvermoon-work/task-engine/blob/9b4e31b809b290cd204dbe19cdd1769dec6d108d/packages/task-engine-storage/test/startup.test.ts#L91)：

```text
crash before startup commit distinguishes resumable queued from uncertain run
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
0 !== 1
packages/task-engine-storage/test/startup.test.ts:91:14
```

attempt 1 的 Node22、attempt 2 的 Node22/Node24 均实际报告该失败。
此外 Node22 两次都报告
[composition test](https://github.com/silvermoon-work/task-engine/blob/9b4e31b809b290cd204dbe19cdd1769dec6d108d/packages/task-engine/test/composition.test.ts#L184)
`capacity one has distinct parent, child and grandchild lanes`：
预期 completed，实际 failed，Task error 为 `child_timeout / Child deadline exceeded.`。

attempt 2 的 Node24 根失败仍是 task-engine-storage#test；Turbo 随后终止其他运行中的测试，
出现 `Promise resolution is still pending but the event loop has already resolved`，
不能将这些取消结果冒充独立通过。
该轮新 CAR 双消费者四项矩阵与 compiler-free 依赖图测试虽通过，
也不能替代整个 required CI 的失败事实。

`Release verification (v1)` 的 `Confirm required checks succeeded` 两次均失败：

```text
Every required validation job must succeed; received failure.
```

其他两个含重构代码的 main runs：
[90c8776 / 42821040666](https://github.com/silvermoon-work/task-engine/actions/runs/42821040666)、
[c851f81 / 42821218126](https://github.com/silvermoon-work/task-engine/actions/runs/42821218126)
均为 cancelled；不能退选它们当作成功发布证据。
更早的成功 run 对应重构前代码，也不满足此次发布身份。

## 当前状态与恢复条件

这是**发布前置 CI 失败**，不是已尝试发布后的 npm 认证失败；本段没有 publish run。
没有动业务代码/测试、没有改发布守卫，没有创建 Builder/CLI 新 tags，
旧 CAR 不可移动 tag 原样保留。D-S04 及全部 D-AC 项仍未完成，
最终 registry-installed init/build/car 与 Engine 消费尚未执行。

需父级处理上述重复失败的原因并确定下一步范围。修复若影响实现交付物，应重新验证/
同步相应候选；发布之前必须具备该准确候选最新 main push CI 的 Node22、Node24、
aggregate 和 required step 全部真实成功，再重新核对版本/tag 未占用。
不能用本地 Node24 的绿灯、部分新 suite、旧代码的 CI 或反复重试替代门禁，
也不能直接修改测试期限/断言或降低验证规则以继续发包。
