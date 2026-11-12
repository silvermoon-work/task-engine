# RC 发布证据与部署阻碍

## 已完成：四个独立 RC 发布

四包均固定在版本准备提交 `b6044673239005bd219494972e9ca5822d31dd05`；该提交 main 可达，[精确 main CI 43156103840](https://github.com/silvermoon-work/task-engine/actions/runs/43156103840) 的 Node 22.15.0 / 24.11.1 和 Release verification (v1) 全绿。没有借用其他提交的 CI，没有改 verifier v1。

| package-id | 版本 | 不可变 tag | 成功 workflow | registry tarball |
| --- | --- | --- | --- | --- |
| task-builder | 0.2.0-rc.1 | task-builder-v0.2.0-rc.1 | [43157541848](https://github.com/silvermoon-work/task-engine/actions/runs/43157541848) | [tarball](https://registry.npmjs.org/@silvermoon-work/task-builder/-/task-builder-0.2.0-rc.1.tgz) |
| task-builder-cli | 0.2.0-rc.1 | task-builder-cli-v0.2.0-rc.1 | [43158313932](https://github.com/silvermoon-work/task-engine/actions/runs/43158313932) | [tarball](https://registry.npmjs.org/@silvermoon-work/task-builder-cli/-/task-builder-cli-0.2.0-rc.1.tgz) |
| task-engine | 0.2.0-rc.1 | task-engine-v0.2.0-rc.1 | [43159016455](https://github.com/silvermoon-work/task-engine/actions/runs/43159016455) | [tarball](https://registry.npmjs.org/@silvermoon-work/task-engine/-/task-engine-0.2.0-rc.1.tgz) |
| task-engine-cli | 0.2.0-rc.9 | task-engine-cli-v0.2.0-rc.9 | [43159792724](https://github.com/silvermoon-work/task-engine/actions/runs/43159792724) | [tarball](https://registry.npmjs.org/@silvermoon-work/task-engine-cli/-/task-engine-cli-0.2.0-rc.9.tgz) |

每次仅推一个 tag，等待对应 workflow 成功及官方 exact-version endpoint 可见，再处理下一包。每次 before 观察都确认版本不存在、latest 基线和全部内部 dependencies/devDependencies/peerDependencies/optionalDependencies 的精确版本可见。

四个 workflow 均为 tag push，不是 workflow_dispatch；已逐项核对 Verify exact-commit main CI、Pack only the selected package、Verify artifact identity and published workspace dependencies、Publish selected package 都成功。只使用现有 npm environment / Trusted Publishing；每次选定包 pack 一次，artifact verifier、publint、npm publish 使用同一 PACKAGE_TARBALL，没有本地 npm publish、批量 workflow、tag 移动或认证绕过。

完整 before/after、workflow 身份、全部内部依赖字段、tarball SHA-1/SHA-512 integrity 和 provenance endpoint 在 [registry-publication.json](registry-publication.json)。registry 的 gitHead 为 null，没有把它伪称为 source commit；源绑定由上述不可变 tag、workflow headSha、artifact 校验与 provenance 路径建立。

| package-id | registry SHA-1 | 发布后官方 exact-version 观察 UTC |
| --- | --- | --- |
| task-builder | a3fd92f68a34ca97956e08e7db20a8636757a2ba | 2026-11-12T04:58:19.683Z |
| task-builder-cli | c77464613dd13bd1c95c1ccae6fb670ad9267006 | 2026-11-12T05:05:14.070Z |
| task-engine | 7ee9ad473e727122dfad790f9d0779994bf71b9e | 2026-11-12T05:12:03.457Z |
| task-engine-cli | 5c69b0088421db3bb22c3de6e4ccf7128001c2ef | 2026-11-12T05:20:32.068Z |

四个 latest 均从发布前 `0.1.0` 保持为 `0.1.0`，仅 rc 指向新版本。没有发布 stable、独立 Server、Protocol、SDK 或其他包，也没有删除历史版本或 legacy tags。部分精确 endpoint 在成功 publish 后仍暂时 404；例如 Builder 约六分钟后才可见，期间仅等待，未重复 publish、移 tag、换号或跳过依赖验证。

随后 main 已并发集成其他 idea 的已验收 SpaceRef/content 变更；本工作区仅普通 fast-forward 保留这些历史，没有把新 workspace 代码冒充本次 registry 产物。四个 release tag 和实际已发布包仍固定在 b604467，metadata plan 也从该 Git 提交读取；本 idea 已验收 Inner World 仍为 `1adb16e34ee852991d84b8f3ea735bf5686803ac`。

## 已完成：Ubuntu 只读预检与隔离目录准备

确认现有 Node 24.22.2 / npm 12.2.2、原有官方 registry 与足够磁盘，没有改变全局 NVM、npm 配置、工具、项目或服务。只创建本操作私有目录 `task-engine-ipfs-rc-smoke-20261112-b6044673`，复制已冻结 replay；本地与远端 SHA-256 一致：

- registry-smoke.mjs：`915fc7d7a824f4491875ca6a13492afd04abb2365c8d50ca8a350becdc4a8821`
- registry-engine-probe.mjs：`eb43be31b2174366b7922bbf7fef8b6cf81bc7085941873d0c0e8815b94adfe9`

仓库不保存 SSH 账户、主机或个人路径。

## 历史阻碍：SSH 传输（已恢复）

最后一次官方 registry 观察在 `2026-11-12T05:20:32.068Z` 通过既有 SSH 通道成功。随后启动独立安装/smoke 的连接在 login 前发生 banner exchange 中断，退出 255；只读目录状态探测也 banner 超时。第三次有界只读 SSH 诊断确认既有路径的端口 22 连接超时。

没有禁用 hostkey/TLS 检查，没有修改 SSH、代理、路由、防火墙或密钥，也没有改用本机或 workspace dist 替代 Ubuntu 验证。当时没有取得安装或执行结果，因此未 submitOuter。用户通知连接恢复后，先有界只读验证：两个旧脚本 hash 仍匹配，commands.jsonl、package-lock 和结果文件均不存在，确认之前没有安装/执行。

## 首轮真实 replay：功能通过但清理预期失败

恢复后首次执行完成四包精确 registry 安装、真实双 Engine/Gateway CLI 成功与日志、7 个独立 Engine probe（并发隔离、16 类拒绝、启动失败、缺失、损坏、合作取消、强停），consumer 活跃任务取消关停也成功。实际结果见 [ubuntu-first-run.json](ubuntu-first-run.json)，该记录明确 `orchestratorSucceeded=false`，不把失败试跑称为全通过。

原因是夹具在共享 publisher 上执行了故意抛错的 startup artifact；它按既有策略留下 release uncertainty，publisher stop 返回 `RESOURCE_RELEASE_UNCONFIRMED`。orchestrator 原本要求 stop=0，因此最后失败；不是 NPM 安装失败，也不是其 7 个 probe 失败。

先按私有 instance PID、boot/starttime、安装目录 daemon cmdline 和无子进程校验所有权，再仅对该自建 publisher 发 SIGTERM 并确认物理退出。原 `released=false` 事实未改，没有伪造框架清理确认；consumer 已通过正常 authenticated stop 退出。

为得到可重复的完整收尾，只调整 Outer replay：startup CAR 改由独立 probe 中的真实 raw-block HTTP Gateway 提供，不在共享 publisher 运行坏入口；取消同时保存实际 canceledAt/changed。产品源码、Inner World、包版本和 tag 不变。先同步这项实质夹具修订并观察新 outer revision，再在新的独立目录完整重跑；在重跑完成前 D-S02/D-S03 与所有 D-AC 项仍未勾选，不 submitOuter/acceptOuter。
