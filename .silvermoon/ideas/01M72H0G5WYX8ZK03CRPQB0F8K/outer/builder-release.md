# Builder 发布验证

## 当前结果：唯一批准的 Builder 已发布并可从设备 registry 下载

此前 CI 阻塞已通过重新实现/验收解除；历史失败保留在后半节。
父级重新接受的 implementationRevision 为
`e5bfd48248009d986ef0d74c4703a916d61711fe`（acceptInner#11），
发布前观察的 primary 为 `8bfcf59db4756fa5df75df763473ea82643c4954`。
执行时已同步的 deploymentRevision 为
`8cb019b0b3ae747a774d3487886189060252f211`，已与执行前同步快照核对，
不以部署文件中的版本文字代替代码身份。

### 选择准确的已验证 commit

按父级明确授权，选择
`15caa9a71e4c0b3b0ca7c35618acbce3f4ed3ae5` 发布：

- 已可从刷新后的 main 到达；和当前业务代码、manifest、scripts、workflow、lockfile
  完全一致，完整 Git diff 仅包含本 Idea 的 lifecycle events.jsonl。
- 最新 exact-SHA `ci.yaml` main push run
  [42828771719 / attempt 1](https://github.com/silvermoon-work/task-engine/actions/runs/42828771719/attempts/1)
  的 Node22.13.0、Node24.11.1、Release verification (v1) 及
  Confirm required checks succeeded 全部 success；发布前重新逐项核实。
- 包身份为 `@silvermoon-work/task-builder@0.1.0-canary-261110-1`。
  发布前设备 registry 精确版本查询 E404，目标 tag 本地/远程均不存在。

唯一新增 release tag：

```text
task-builder-v0.1.0-canary-261110-1
  -> 15caa9a71e4c0b3b0ca7c35618acbce3f4ed3ae5
```

没有推 Builder CLI、Engine CLI、Protocol 或其他依赖 tags，也没有移动或重试废弃 CAR tag。

### 实际 OIDC 发布

[Publish run 42831222184 / attempt 1](https://github.com/silvermoon-work/task-engine/actions/runs/42831222184/attempts/1)，
job [129881447803](https://github.com/silvermoon-work/task-engine/actions/runs/42831222184/job/129881447803)，
event=`push`、headBranch=`task-builder-v0.1.0-canary-261110-1`、
headSha=`15caa9a71e4c0b3b0ca7c35618acbce3f4ed3ae5`，最终 **success**。

main 可达、metadata、exact-commit CI、构建依赖、仅选中包一次 pack、
同 tarball 的身份/已发布内部依赖/publint 检查、OIDC 发布全部通过。
`Validate without publishing` 被跳过，本次不是 workflow_dispatch 或 dry run。
成功回执（2026-11-10 14:10:04 UTC）：

```text
+ @silvermoon-work/task-builder@0.1.0-canary-261110-1
```

日志还记录 GitHub Actions source/build provenance 已签名并发布至
[Sigstore transparency log](https://search.sigstore.dev/?logIndex=3787295380)。
本机没有 npm publish、token、本地登录或发布验证规则修改。

### Registry 身份、完整 integrity 与真实下载

现有只读 [verify-npm run 42831691841](https://github.com/silvermoon-work/task-engine/actions/runs/42831691841)
只选择 task-builder，head `8bfcf59db4756fa5df75df763473ea82643c4954`，**success**。
它在 CI 官方 registry 确认精确版本存在、所有内部依赖已发布，
`canary=0.1.0-canary-261110-1`、`latest=0.0.0`。

本地每次包读取前均确认 npm/pnpm 的有效 registry 为
`https://mirrors.cloud.tencent.com/npm/`。发布后初始查询曾返回 E404；
后续该 mirror 的正常 scoped exact-version API 返回 200，普通
`npm view @silvermoon-work/task-builder@0.1.0-canary-261110-1 name version dist.integrity --json`
也已退出 0。没有回退官方 registry；HTTP 下载禁止重定向至其他 registry。

最终 metadata：

```text
name: @silvermoon-work/task-builder
version: 0.1.0-canary-261110-1
tarball: https://mirrors.cloud.tencent.com/npm/@silvermoon-work/task-builder/-/task-builder-0.1.0-canary-261110-1.tgz
shasum: d6966262ee8a6e7ae82c8094d2417f0748b3ef51
integrity: sha512-KTfDzyqxKLneXvmWa+HnoJgG/1kbGs4Z3W0p4zCsyBlILY/hgwT9MosKN+dKcMEaxfu6JiqARV49jMydGuIIBw==
fileCount: 39
unpackedSize: 165652
```

从该 Tencent tarball URL 实际下载 **40609 bytes**，重算 SHA1 和完整 SHA512 SRI，
均严格等于 metadata，SHA1 也等于发布 workflow 的 tarball 回执。
读取下载包的 package.json 核对上述 name/version；实际文件包含
`dist/car.js`、`dist/tree.js`、`dist/contract-worker.js`。
运行依赖包含精确 Protocol `0.1.0-canary-261109-2` 和既有标准 IPFS/CAR 库，
不含已取消的 task-bundle-car。

这证明实际 registry artifact 的身份、字节与可下载性，不是本地 workspace pack；
也不冒充 CLI 的独立安装/生产闭环。下载核验文件是操作自有 scratch，检查后清理。

### 真实清单状态与交回

仅 **D-S04 完成**。Builder CLI 尚未发布，D-S01/D-S02/D-S05 及所有 D-AC 保持未完成。
等待父级单独批准 Builder CLI 发布段；没有 submitOuter 或 acceptOuter。

## 历史：首次发布前置 CI 阻塞（现已解除）

### 当时授权与候选

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

### 当时 Registry 与 tag 前置

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

### 当时 Exact-commit CI：两次真实失败

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

#### 重复主失败

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

### 当时状态与恢复条件

这是**发布前置 CI 失败**，不是已尝试发布后的 npm 认证失败；本段没有 publish run。
没有动业务代码/测试、没有改发布守卫，没有创建 Builder/CLI 新 tags，
旧 CAR 不可移动 tag 原样保留。D-S04 及全部 D-AC 项仍未完成，
最终 registry-installed init/build/car 与 Engine 消费尚未执行。

需父级处理上述重复失败的原因并确定下一步范围。修复若影响实现交付物，应重新验证/
同步相应候选；发布之前必须具备该准确候选最新 main push CI 的 Node22、Node24、
aggregate 和 required step 全部真实成功，再重新核对版本/tag 未占用。
不能用本地 Node24 的绿灯、部分新 suite、旧代码的 CI 或反复重试替代门禁，
也不能直接修改测试期限/断言或降低验证规则以继续发包。
