# 四包发布与安装验收证据

## 冻结执行基线

- 部署计划已在 `1e6b8354e9cd92e1ccf4dfc4bbbc5b21a9d3b83d` 同步。
  执行前已新鲜观察 deploymentRevision `10ee244f0785b019df4dc2fc04ed48f805c46f5d`。
- 四包 release source 统一选择
  `d306ab44997c6435ce84a8c78195a7e26b0f1601`，可从刷新后的 main 到达；
  其 Inner tree 与已接受 `8640cb14177d8b68c707d89f95e1ed1bea7a4718` 一致。
- 精确 main push CI
  [42839765556](https://github.com/silvermoon-work/task-engine/actions/runs/42839765556)：
  event push、branch main、head SHA 精确为上述 d306；
  Node.js 22.13.0、24.11.1 和 `Release verification (v1)` 均 success，
  `Confirm required checks succeeded` success。没有借用其他 commit 的成功。
- 四个 source manifest 的 name/version 已逐一读取该不可变 commit 核对，
  各 tag 在首次操作前本地与远程均未占用。

## 外部前置复核

Builder CLI 发布
[42835596747](https://github.com/silvermoon-work/task-engine/actions/runs/42835596747)
已独立查看：push、精确 tag、head `15caa9a71e4c0b3b0ca7c35618acbce3f4ed3ae5`，
artifact identity/dependency verifier 和真实 Publish selected package 均 success。
仓库外 `D:\Code` 的 npm/pnpm registry 均为 Tencent；
精确 Builder CLI 1 的 name/version/integrity 正向匹配父代理提供的值。
没有修改 Inner 中此前 missing 的历史记录。

只读官方 registry 预检
[42842632781](https://github.com/silvermoon-work/task-engine/actions/runs/42842632781)
正向返回 Builder/core/CLI 当日 1；
完整 availableVersions 中四个待发布候选均缺失。因此该预检为预期的四个 missing failure，
不是构建或身份校验失败，不把镜像 E404 当作未占用证据。

## 串行发布进度

所有 tag 都指向上述 d306，未移动、未覆盖；没有本地 npm publish。
真实发布只经既有 workflow 的一次 selected-package pack、
同一个 tarball 的 identity/dependency/publint 验证及 Trusted Publishing。

| 包/版本 | 精确 tag | Publish run | 正向 registry 确认 |
| --- | --- | --- | --- |
| protocol 0.1.0-canary-261110-1 | task-protocol-v0.1.0-canary-261110-1 | [42842911243](https://github.com/silvermoon-work/task-engine/actions/runs/42842911243)，success | [42843277001 attempt 2](https://github.com/silvermoon-work/task-engine/actions/runs/42843277001/attempts/2)，success |
| SDK 0.1.0-canary-261110-1 | task-sdk-v0.1.0-canary-261110-1 | [42844505054](https://github.com/silvermoon-work/task-engine/actions/runs/42844505054)，success | [42845616124](https://github.com/silvermoon-work/task-engine/actions/runs/42845616124)，success |
| Engine 0.1.0-canary-261110-1 | task-engine-v0.1.0-canary-261110-1 | [42845940887](https://github.com/silvermoon-work/task-engine/actions/runs/42845940887)，success | [42846415774](https://github.com/silvermoon-work/task-engine/actions/runs/42846415774)，success |
| CLI 0.1.0-canary-261110-2 | task-engine-cli-v0.1.0-canary-261110-2 | [42846750113](https://github.com/silvermoon-work/task-engine/actions/runs/42846750113)，success | [42847066264](https://github.com/silvermoon-work/task-engine/actions/runs/42847066264) 首次元数据仍缺失，待正常传播后重验 |

实际 npm 回执：

```text
2026-11-10T15:18:49Z + @silvermoon-work/task-protocol@0.1.0-canary-261110-1
2026-11-10T15:28:20Z + @silvermoon-work/task-sdk@0.1.0-canary-261110-1
2026-11-10T15:36:22Z + @silvermoon-work/task-engine@0.1.0-canary-261110-1
2026-11-10T15:40:56Z + @silvermoon-work/task-engine-cli@0.1.0-canary-261110-2
```

Protocol 的发布 workflow 全部 mandatory step 成功，但首次只读 metadata 检查在
15:20:39 UTC 仍只见旧版本，明确报 missing。
调查确认失败在 registry 元数据可见性，不是发布、构建、artifact 或认证步骤。
没有重跑真实 publish 或移 tag；正常等待传播后，只重试同一只读检查的 failed job。
attempt 2 在 15:26:44 UTC 正向包含精确新版本，
canary 为当日 1、latest 仍 0.0.0；随后才推 SDK tag。
SDK 在 15:34:06 UTC 正向确认准确版本、依赖和 canary/latest，随后才推 Engine tag。
Engine 在 15:38:37 UTC 正向确认准确版本及所有内部 dev/runtime 依赖后才推 CLI tag。
四个成功 workflow 的完整机器回执在 [release-workflows.json](./release-workflows.json)。

CLI 真实 publish 成功后，15:42:20 UTC 的只读检查仍只见 CLI 1，
Tencent 镜像也暂报 E404；没有绕过 registry、重跑 publish 或改 tag。
安装必须等待准确 registry 版本可见。

## 安装和运行验收

尚未执行，不能据上述发布回执宣称安装或 smoke 成功。
已分配唯一仓库外安装命名空间 `D:\Code\task-engine-canary-261110-d30f1b98`，
此时仅有 work 目录，不把目录存在当作安装成功。
验收脚本为 [registry-smoke.mjs](./registry-smoke.mjs)，执行前须与本计划同步。
脚本只从实际 registry 安装的包运行，在仓库外 cwd/prefix 记录命令、输出、
退出码、integrity、真实入口、生产依赖闭包、共享多块图、数据清理与自有 PID 停止。
