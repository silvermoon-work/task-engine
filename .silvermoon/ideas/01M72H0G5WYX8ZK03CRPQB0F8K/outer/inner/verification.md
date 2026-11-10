# 实现验证

> 当前正在执行用户授权的独立 CAR 包取消重构。下文先前 41/19 与发布依赖记录是历史证明，
> 不能代表新拓扑已经通过；本轮完成后补充迁移结果与实际复验。不删除旧失败证据。

## 候选与边界

- 工作区：`D:\Code\task-engine.worktrees\task-builder-cli-redesign-setup`。
- 分支：`agents/task-builder-cli-redesign-setup`；仅本 Idea、业务实现、直接相关测试/文档与 lockfile。
- r14 原件未修改：43438 字节；SHA256
  `0B05BF985DB364C0ED7BED8DB42FC537BB5F2169732F647C1A7BA77F6CE67EAE`。
- 本文件记录工作区实现验证，不是 registry 安装或发布验收。未发布包、未推 release tag，
  未执行 `acceptInner`/`acceptOuter`。父工作区及其他 Idea 未改动。

## 实现索引

| 契约项 | 实现与证明 |
| --- | --- |
| I-S01、I-AC01 | [CLI runner](../../../../../packages/task-builder-cli/src/index.ts)、[模板组装](../../../../../packages/task-builder-cli/src/project.ts)、[runner 测试](../../../../../packages/task-builder-cli/test/runner.test.ts)：仅 init/build/car，默认值、精确模板版本、共享 JSON、文本帮助/版本、普通失败 1、重复/未知参数均校验。 |
| I-S02、I-AC02 | [交付层](../../../../../packages/task-builder-cli/src/delivery.ts)、[Node 文件适配](../../../../../packages/task-builder-cli/src/node.ts)、[交付测试](../../../../../packages/task-builder-cli/test/delivery.test.ts)、[故障注入](../../../../../packages/task-builder-cli/test/faults.test.ts)：完整暂存/校验、逐文件替换、最终字节验证、竞争检测、旧文件保留、取消和未知状态。 |
| I-S02、I-AC02 | [契约进程](../../../../../packages/task-builder/src/contract-worker.ts)、[求值与编译](../../../../../packages/task-builder/src/esbuild.ts)、[契约输出测试](../../../../../packages/task-builder/test/contract-output.test.ts)：自动 CLI 求值，console/直接标准流/依赖/捕获异常/异步输出均失败；API 显式许可不变；运行期日志不受影响。 |
| I-S03、I-AC03 | [十例子进程测试](../../../../../packages/task-builder-cli/test/cli.test.ts)、[真实 SDK Worker 测试](../../../../../packages/task-builder-cli/test/worker.test.ts)、[CLI 使用文档](../../../../../packages/task-builder-cli/README.md)、[消费者指南](../../../../../docs/end-to-end-verification.md)。 |

## 十个设计示例的实际验证

以下命令由 `cli.test.ts` 通过当前 Node 执行已构建 `dist/bin.js`，在每例独立的
仓库内 `.cache/cli-<UUID>` 目录运行；不是只调用内存函数或比较文档字符串。
命令的实际 CID/宿主绝对路径在断言中比较，不沿用 Spec 的展示 CID。
成功与失败均验证 stdout 只有一个以换行结尾的 JSON 对象、stderr 为空、退出码 0/1；
失败对象的 error 仅包含非空 code/message。

| r14 示例 | 实际命令与结果 |
| --- | --- |
| 1 init 成功 | `task-builder init demo`：成功；8 个完整相对文件、目录名默认包名、无 node_modules；scope 名称与显式 Task 名也验证。 |
| 2 init 已存在 | 再执行 `task-builder init demo`：`OUTPUT_EXISTS`，原 package.json/构建描述快照不变。 |
| 3 默认 build | `task-builder build` 以及再次 `task-builder build task.build.yaml`：模块与 dist.car 均有效，CID 一致；实际 Worker 可执行并输出运行期日志。 |
| 4 no-car | 修改源码后 `task-builder build --no-car`：新模块 CID 变化、data.car 为 null，旧 CAR 字节不变。 |
| 5 契约日志 | 改为带 console.log 的 contract.ts 后 `task-builder build`：`CONTRACT_OUTPUT_FORBIDDEN`；输出内容不泄漏、旧模块/CAR 快照不变。 |
| 6 源码缺失 | 删除本例 main.ts 后 `task-builder build`：`SOURCE_NOT_FOUND`；旧输出快照不变。 |
| 7 CAR 写入失败 | 让目标为不可替换目录后 `task-builder build`：`CAR_WRITE_FAILED`、可信 module/CID、car:null。另以真实 rename 故障注入验证旧普通 CAR 文件完整保留。 |
| 8 独立 car | `task-builder car dist/task.yaml`：同一模块 CID、完整声明文件列表；无效 build 描述不被读取，未选择 notes/旧资源/链接内容不被读取；输入快照不变。 |
| 9 Worker 缺失 | `task-builder car dist/task.yaml --output missing.car`：`MODULE_FILE_MISSING`，不产生归档。 |
| 10 目录入口 | `task-builder car dist`：`INVALID_ARGUMENT`。 |

## 故障与覆盖验证

- 父级审查在 `ping#5` 指出独立 CAR 的 lexical 输入目录与 realpath 文件树边界不一致。
  新增真实 CLI 回归先复现失败：`car alias/task.yaml --output dist/inside-module.car`
  在旧实现返回 0 并写入真实输入目录。随后修复为在计算边界/交付之前拒绝输入模块及
  其所有祖先中的 symlink/junction。不是只检查输出路径，也未修改 Spec。
  模块 alias、祖先 alias、输出 alias 共六种拒绝场景均验证退出 1/`UNSAFE_PATH`、
  目标未创建、输入完整字节快照与递归目录项不变；正常外部输出仍成功且 CID 一致。
- 输出位置优先级：描述目录缺省 dist、描述 outDirectory、cwd 相对 --out-dir；
  显式位置不重写构建描述。资源遍历/输入重叠和链接输出被拒绝。
- 模块/CAR 按声明选取；无效 UTF-8 的未选择 notes、旧 resources 文件与空目录不会
  污染验证或归档；它们也不会被清理。
- 无效选中资源在更新旧输出前失败；真实读取中输入发生变化以 `INPUT_CHANGED` 失败。
- 逐文件交付中断导致模块尚未整体确认时，不返回伪造的 module/CID，返回
  `DELIVERY_UNCERTAIN` 和 1。
- 已确认新模块后 CAR rename 失败，保留新模块与未替换旧 CAR。
  同位置注入取消，清理确认后返回 `INTERRUPTED`、可信部分 data 和 143。
- 取消同时注入 sibling unlink 失败时返回不确定性与 1，而不是被 SIGTERM 覆盖成 143；
  阶段目录清理失败也返回 `CLEANUP_UNCERTAIN`，保留实际已确认交付的数据。
- 契约覆盖全局 console、独立 Console、process.stdout/stderr、fs descriptor/stream、
  继承标准流的子进程、依赖、catch、Promise 和 timer 输出；任一尝试均失败。
  静默 JS/TS 正常执行，挂起求值可取消。JSON 不执行。
- 两个真实 SDK Worker 测试分别验证 explicit/callback、已锁定 Schema 和资源消费。
- TTY 一致性使用 writer.isTTY=true/false 的 runner 测试，并有真实子进程管道测试。
  不把它冒充物理终端或跨 OS 的手动执行。
- 130/143 验证包含程序化中断和信号退出码映射；故障注入覆盖取消清理不确定时必须 1。
  不宣称 Windows 上已发送真实 POSIX SIGTERM。

## 实际命令与结果

2026-11-10，在本工作区使用现成 Node **v24.12.0** 与 pnpm **11.22.0**：

```powershell
$env:PATH = 'C:\Users\Wei\AppData\Roaming\nvm\v24.12.0;' + $env:PATH
pnpm --filter @silvermoon-work/task-builder-cli... build
pnpm --filter @silvermoon-work/task-builder --filter @silvermoon-work/task-builder-cli test
pnpm --filter @silvermoon-work/task-builder-cli test
pnpm check
```

- 构建成功；Builder **41/41**，最终 CLI **19/19**，均无跳过/取消/失败。
- `pnpm check` 成功：format、release lint/test、Turborepo **44/44** lint/typecheck/test/build、
  测试类型检查及各包 publint。未修改测试以规避现有 Node26 identity 弃用警告。
- publint 仅对既有私有 app 给出建议，无失败；不将无关建议纳入修改。
- 检查日志是工作区 `.cache` 内的操作产物，不作为必须持久化的世界附件。
  本文、稳定测试名称、断言和标准命令构成可复现证据。

## Canary 发布依赖：未执行部署

2026-11-10 只读查询前，`npm config get registry` 与 `pnpm config get registry` 均为
`https://mirrors.cloud.tencent.com/npm/`。未强制覆盖或回退其他 registry：

| 包 | 当前源 manifest / registry 观测 | 部署影响 |
| --- | --- | --- |
| task-builder-cli | 按父级授权准备 `0.1.0-canary-261110-1`；registry 仍只有旧版本 | 版本准备不是发布；未推 tag，必须单独通过父级发布门禁。 |
| task-builder | 按父级授权准备 `0.1.0-canary-261110-1`；registry 仍只有旧版本 | CLI 的 packed runtime 依赖已固定到该新 Builder，不再指向旧 `261109-3` 字节。 |
| task-bundle-car | 源 manifest 原已是 `0.1.0-canary-261110-1`，本次未改；设备 registry 返回 **E404** | CLI/Builder 的必要运行依赖；父级另核实官方 registry 也缺失，首次发布/身份/Trusted Publisher 仍须明确门禁。 |
| task-protocol | `0.1.0-canary-261109-2`；registry 版本列表含该版本 | 未修改业务代码或版本。 |
| task-sdk | `0.1.0-canary-261109-2`；registry 版本列表含该版本 | 当前 Builder 模板的发行配套 SDK；未修改代码/版本，仅更新直接相关使用文档。 |

父代理保留内部依赖发布及 CLI 发布决策；发布前须重新查询，
按精确 main commit 的 CI 和单包映射顺序处理，不能批量自动发布。
如需变更实现交付物/版本，先重新验证并同步对应候选，不将旧提交视为新字节的证明。
Deployment.md 已细化必须真实发布 Canary、registry 独立安装、核实 bin 来源并完整闭环；
所有 D 项仍未勾选。

### 本轮候选版本准备与打包检查

父级授权的两个候选版本均为 `0.1.0-canary-261110-1`。2026-11-10 本轮准备前再次执行
`npm view @silvermoon-work/task-builder versions --json`、
`npm view @silvermoon-work/task-builder-cli versions --json`，设备 Tencent registry 的
版本列表均不含候选；`git ls-remote --tags origin` 对两个精确候选 tag（含 peeled 引用）
均返回空。未据此推送 tag 或发包。

`pnpm install --lockfile-only --ignore-scripts` 成功，431 项 supply-chain 检查通过；
lockfile 无 diff 是因为内部依赖仍使用 `workspace:*` / `link:../...`，不应伪造版本条目。
模板测试从实际安装 metadata 读取 CLI/Builder 新版本，配套 SDK 仍为
`0.1.0-canary-261109-2`；root --version 测试与模板版本测试均通过。

额外执行两个禁用 lifecycle 的本地 pack，并读取 tarball 内的 `package/package.json`：

```powershell
pnpm --filter @silvermoon-work/task-builder --config.ignore-scripts=true pack --out <repo-owned-candidate.tgz>
pnpm --filter @silvermoon-work/task-builder-cli --config.ignore-scripts=true pack --out <repo-owned-cli-candidate.tgz>
```

实际 packed Builder/CLI version 均为 `0.1.0-canary-261110-1`；
CLI 的 Builder、CAR 运行依赖均为 `0.1.0-canary-261110-1`，protocol 为
`0.1.0-canary-261109-2`；Builder 包包含 `dist/contract-worker.js`。
这些只证明本地打包候选，不替代 registry 安装/部署成功；操作自有 tarball 在检查后清理。

父代理提供的独立只读发布前置证据：
[verify-npm run 42809088942](https://github.com/silvermoon-work/task-engine/actions/runs/42809088942)，
head `48e8d1020548a0d9057b9efbfb4ab59ddd931e06`。
该 CI 针对 task-bundle-car 查询官方 registry，返回 `availableVersions: []`、
`expectedVersion: 0.1.0-canary-261110-1` 缺失，不是仅本地镜像延迟。
此项是父级执行的外部观测，不冒充本子代理的本地查询；本地包操作仍只用 Tencent registry。
