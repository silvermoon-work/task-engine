# Builder CLI Canary 发布验证

## 明确授权与准确代码身份

本段唯一批准的发布目标：
`task-builder-cli` / `@silvermoon-work/task-builder-cli@0.1.0-canary-261110-1`。
执行前 deploymentRevision：
`d1eae40f7195d4f9fbdca14aafbf612d56475856`，已同步于 primary
`da76b79f4055b6464da95bf25940693c4ae625a8`。
已接受实现保持 `e5bfd48248009d986ef0d74c4703a916d61711fe`。

按父级批准选择与 Builder 相同的
`15caa9a71e4c0b3b0ca7c35618acbce3f4ed3ae5`：

- main 祖先可达；发布前比较 Builder/CLI 代码、manifest、release scripts 和 publish
  workflow，均无未纳入此 commit 的本 Idea 变更。
- 该 SHA 最新 main push [CI 42828771719](https://github.com/silvermoon-work/task-engine/actions/runs/42828771719)
  的 Node22、Node24、Release verification (v1) 和 required step 全 success。
- 不把并发 Engine/Protocol/SDK 新候选的 workspace 字节或版本带入 CLI。
  tagged CLI 的运行依赖只有 Builder、Protocol、commander、yaml；开发依赖 SDK。
- 发布前用设备 Tencent registry 普通 npm view 核实 Builder `261110-1`、
  SDK/Protocol `261109-2` 精确身份及 integrity 均可用；目标 CLI 版本 E404，
  本地/远程目标 tag 均未占用。

唯一新增 release tag：

```text
task-builder-cli-v0.1.0-canary-261110-1
  -> 15caa9a71e4c0b3b0ca7c35618acbce3f4ed3ae5
```

没有在本段发布 Engine CLI、Engine、SDK、Protocol 或其他依赖，也未重试废弃 CAR tag。

## 真实 OIDC 发布与官方核验

[Publish run 42835596747 / attempt 1](https://github.com/silvermoon-work/task-engine/actions/runs/42835596747/attempts/1)，
job [129896819576](https://github.com/silvermoon-work/task-engine/actions/runs/42835596747/job/129896819576)，
event=`push`、headBranch=`task-builder-cli-v0.1.0-canary-261110-1`、
headSha=`15caa9a71e4c0b3b0ca7c35618acbce3f4ed3ae5`，最终 **success**。

main 可达、metadata、exact-commit CI、依赖构建、仅选中 CLI 一次 pack、
同 tarball 的身份/已发布内部依赖/publint 检查和真实 publish 均通过；
`Validate without publishing` 为 skipped，不是手动 dry run。
成功回执时间为 2026-11-10 14:36:02 UTC：

```text
+ @silvermoon-work/task-builder-cli@0.1.0-canary-261110-1
```

发布日志记录签名 provenance 已上传
[Sigstore transparency log](https://search.sigstore.dev/?logIndex=3787711978)。
没有本机 real npm publish、token、本地登录或修改发布门禁。

现有只读 [verify-npm run 42836384569](https://github.com/silvermoon-work/task-engine/actions/runs/42836384569)
只选择 task-builder-cli，head=`da76b79f4055b6464da95bf25940693c4ae625a8`，
attempt 1 / **success**。官方 registry 确认精确版本、已发布内部依赖及
`canary=0.1.0-canary-261110-1`；`latest` 仍为 `0.0.0`。

## Registry 身份与真实安装的字节绑定

完整设备 registry 记录保存在 [CLI metadata](./cli-registry-metadata.json)：

```text
name: @silvermoon-work/task-builder-cli
version: 0.1.0-canary-261110-1
tarball: https://mirrors.cloud.tencent.com/npm/@silvermoon-work/task-builder-cli/-/task-builder-cli-0.1.0-canary-261110-1.tgz
shasum: 864c256e4f07dcca438fe3e21f09d7d64a856ef8
integrity: sha512-5zu7KvdHQ0lptizpRoU3fIAF5plIb5/uPsn03lJpkjR+eCXyGO9Y4anuqEdt7sCVufsR20rhu1p3Zw9rKc+1GA==
fileCount: 23
unpackedSize: 82158
```

SHA1 严格匹配 publish 回执。两个实际普通 pnpm install 生成的 lockfile 都记录
完全相同的完整 CLI integrity，不使用本地 tarball、URL 依赖、workspace 源码或仓库 dist。
设备 npm/pnpm registry 始终为 Tencent，strict-ssl=true。

实际 packed/installed 运行依赖：

```json
{
  "@silvermoon-work/task-builder": "0.1.0-canary-261110-1",
  "@silvermoon-work/task-protocol": "0.1.0-canary-261109-2",
  "commander": "14.0.3",
  "yaml": "2.9.1"
}
```

开发依赖 SDK 精确为 `0.1.0-canary-261109-2`。没有 task-bundle-car，
也没有并发 Engine 新版本被隐式打进 CLI 包。
实际安装、bin 来源、完整生产闭包和真实执行结果见
[消费者验证](./consumer-verification.md)；发布成功本身不是消费者成功的替代。
