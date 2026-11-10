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
| CLI 0.1.0-canary-261110-2 | task-engine-cli-v0.1.0-canary-261110-2 | [42846750113](https://github.com/silvermoon-work/task-engine/actions/runs/42846750113)，success | [42847066264 attempt 2](https://github.com/silvermoon-work/task-engine/actions/runs/42847066264/attempts/2)，success |

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
随后同一只读检查 attempt 2 于 15:46:19 UTC 正向确认 CLI 2，
canary=当日 2、latest=0.0.0，所有内部依赖检查成功。
Tencent 在 15:47 后也正向返回四个准确包的 metadata/tarball/integrity，才开始安装。

| 包 | Tencent 返回的完整 integrity |
| --- | --- |
| protocol 1 | `sha512-cDCnKmSMeC8TfAj1/JCo1keNw/UI/mKrgincMpIpWXzf4Qih5EmqqWLLQrPfXtLoyasxJtgBjl9wcTGpUJ/Q4A==` |
| SDK 1 | `sha512-3mKoiRakTJxeWdrCWq5lq2KlogfXnfIAFsFRxx2ZHF4BwG77kmGP0K5V6sM6uCWgrpIjD9MDy4QdRForVMr5ng==` |
| Engine 1 | `sha512-TozDmwBuHfEteTB2Snzjby27jzvllKngI4t3zC7nMpCK54ozkV1fDxBZ+sRW6/vq0cb1qmxYsHEdMxweitGZAQ==` |
| CLI 2 | `sha512-QXTOpu9X2n+YjsN0a4dOTyEZz9kNrF2pUt7jTvI+WhWBsqTkvudc5Cs904NkW/FD9ZBB+gGETRLukppgitSlKw==` |

## 安装和运行验收

唯一仓库外安装命名空间为 `D:\Code\task-engine-canary-261110-d30f1b98`。
首轮真实 registry 安装退出 0（262 packages），实际 package bin 的 --version 返回 CLI 2。
首轮 smoke 随后在 Windows cmd shim 调用处失败：
Node 的默认 Windows 参数转义把脚本内引号转成了字面的反斜线引号，未启动 shim。
这是 Outer harness 的 cmd 调用错误，不是已安装 CLI 执行失败：
上一条直接运行真实 package bin 的命令已经退出 0。
完整失败命令/输出/退出码保留在 [registry-smoke-attempt-1.json](./registry-smoke-attempt-1.json)。

仅修正 Outer harness：cmd 使用 verbatim 参数与 `call` 正确引用 shim，
不改已接受实现、不关闭 warnings、不跳过 shim 断言。失败发生在启动任何 Server 之前，
没有遗留任务进程；自有 profile 目录已清理。重验前同步新脚本与契约修订。
其余 smoke 尚未完成，不能因安装或发布成功预填运行验收成功。
第二轮中 shim、元信息 SQLite 守卫、生产闭包 262 包、配置四动作、
已发布 Builder 工具和显式新 SDK 的实际 npm 安装均通过。
随后 harness 用 CommonJS require.resolve 解析 import-only 的 `@ipld/car/reader` 导出失败；
这是测试工具的 ESM 条件解析上下文错误，不是 CAR 包缺失或安装失败。
保留 [registry-smoke-attempt-2.json](./registry-smoke-attempt-2.json)，
改为在实际 producer 安装 cwd 用原生 import.meta.resolve 解析 ESM 导出，
并断言解析后的 realpath 属于仓库外安装，不转而加载 repo 或私有实现。
仍未启动 Server；只精确重建本任务生成的 fixture project，安装 prefix 保留。
第三轮正确解析实际安装的 ESM 后，在生成 fixture 时被已发布 Builder 正确拒绝：
harness 的 callback 字符串漏写箭头函数 `=>`，编译命令真实返回 JSON error/退出 1。
保留 [registry-smoke-attempt-3.json](./registry-smoke-attempt-3.json)，仅补全两处 fixture
callback 语法，不改 Builder 或 Engine，不删除失败断言；仍未启动任何 Server。
验收脚本为 [registry-smoke.mjs](./registry-smoke.mjs)，执行前须与本计划同步。
脚本只从实际 registry 安装的包运行，在仓库外 cwd/prefix 记录命令、输出、
退出码、integrity、真实入口、生产依赖闭包、共享多块图、数据清理与自有 PID 停止。
