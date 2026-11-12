# 历史阻塞：共享 Kubo 原生 pin 的所有权不可判定

本文是 [Implementation](./Implementation.md) 的同世界实施证据，不改变已接受的 Ideal，不表示功能完成或生命周期验收。

## 已验证的环境与命令

2026-11-12，Windows，Node.js `v24.11.1`，pnpm `11.22.0`，本机已安装的 `ipfs version 0.43.1`。未安装依赖；操作前有效 npm registry 为 `https://mirrors.cloud.tencent.com/npm/`。

在仓库根执行：

```powershell
node .silvermoon\ideas\01M77C793FF6V0NMNSC7AE47JT\outer\inner\ownership-probe.mjs
```

结果：退出码 `0`，全部断言通过。这是**真实 daemon / HTTP RPC**，不是 mock。探针使用新建的 `.cache\kubo-ownership-<随机 UUID>` 作为 `IPFS_PATH`，空 repo、test profile、空 Bootstrap、`--offline`、`--routing=none`、随机 loopback RPC/Gateway 端口；`id` 确认 `Addresses: []`。仅终止本次创建的子进程并删除本次创建的 repo；未接触现有 daemon / repo，未运行任何 GC。该 daemon 启停只属于隔离验证，不是 Engine 的运行策略。

## 可复现反例

测试块 CID：

```text
bafkreifpsfz57dbv6zpcsdegwdkefh7rg2orbtfpmynbsvrvpxmhhsncfy
```

1. `block/put(format=raw, mhtype=sha2-256, pin=false)` 写入测试块。
2. 系统通过 `pin/add(recursive=true)` 保留该 CID。`pin/ls(names=true)` 返回该 CID 的 `{"Type":"recursive","Name":""}`。
3. 一个不参与 Engine 协调的外部调用方再次执行同样的 `pin/add`。调用成功，但全部可见 pin 记录与步骤 2 **完全相同**，没有第二个所有者或计数。
4. 系统在最后一条自身引用删除后调用 `pin/rm(recursive=true)`。该 CID 不再出现在递归 pin 列表，外部调用方的保留要求也一起丢失。
5. 使用 `name=task-engine/owner-a` 重复步骤 2、3，仍只有同一条记录，完全相同。名称是调用方可读写的标签，不是所有者身份、鉴权能力或租约。
6. 即使外部调用方使用不同名称 `external/manual`，标记之后到删除之前的外部 `pin/add` 仍会被系统随后按 CID 的 `pin/rm` 移除。`pin/rm` 没有“仅当名称／版本仍等于旧值时删除”的条件参数。仅增加删除前 `pin/ls` 会缩小而不能消除竞态窗口。

独立 repo 自带的空 MFS 根 `QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn` 始终保留；反例断言只针对本次测试块，不误把其他 pin 当作系统所有物。

本机 `ipfs pin add --help` 同样明确说明：再次以不同名称 pin 会**更新该 pin 的名称**；`ipfs pin rm --help` 的删除参数只有 CID 和 recursive，没有 owner / expected-name / expected-version。

## 为什么只协调 Engine 仍不够

比较两段历史：

- H1：系统 pin R，系统所有 Task / Run 引用均被删除。
- H2：系统 pin R，外部再次 pin R，系统所有 Task / Run 引用均被删除。

所有参与 Engine 的持久化数据库、稳定 owner ID、协调日志与锁状态相同；Kubo 可观测的 pin 状态也相同。H1 要求清除最后系统引用；H2 要求保留外部需求。单靠这些输入，任何清除算法都不能可靠作出不同决定。数据库与 RPC 的写前日志、恢复扫描和重试可以修复 Engine 间的部分提交，却不能恢复从未被记录的外部需求。

每个 Engine 使用随机 nonce 的 DAG 包装根，可以让普通外部 pin 原始业务根的场景彼此独立，但不能建立已接受契约要求的**可证明管理边界**：包装根仍是可列出的原生 pin CID，外部可以合法 pin 同一包装根，反例和删除竞态仍成立。将其作为独占 pin 的假设需要新增、明确且可执行的权限边界，不能默认为已有保证。

这不是宣称所有共享 pin 方案都不可能，而是当前允许“不参与协调的调用方直接修改同一 Kubo pin 集合”、同时禁止误删其要求的条件下，原生 RPC 缺少所需原语。

## 当前处理与解除条件

- 没有实现“系统首先 pin 就拥有该 pin”、只扫描当前数据库、只靠 pin name、或永远跳过清除却报告成功等方案。
- 未修改产品源码、配置 schema、版本、发布映射或依赖。local 基线不变；Kubo 后端、Task / Run 根集接入、managed / DiskContent 路径和恢复机制**均未实现**，不得作为完成项发布。
- ledger 的所有 I-* 保持未勾选；未修改 Ideal、Deployment 或生命周期事件。
- 如果当前管理边界无法证明，唯一符合已接受安全方向的运行行为是保留 pin 并显式返回“元数据已删，保留清理未完成”；这不等于已完成“最后引用清除”的验收。

继续端到端实现需要先取得一种真实可执行的管理边界，例如所有 `pin/add` / `pin/rm` 写入都强制经过支持独立租约和原子条件删除的协调服务，且外部调用方不能绕过；或底层提供真正的 owner-scoped pin 原语。专属 repo、放宽自动清除或限定外部写入权限属于契约／部署边界变化，实施方不能擅自选择。当前仅记录阻塞，交由父协调者评估后续处理；不请求、不推断、不记录新的批准。

## 验证范围

探针证明了共享原生 pin 的不可区分历史与名称检查竞态；它不证明完整 Kubo Store、DAG 预算、两 Engine 恢复、Task / Run 保留或 CLI 调用链已实现。没有用本探针代替那些尚未完成的验证。

| 命令 | 结果 | 含义 |
| --- | --- | --- |
| `node .silvermoon\ideas\01M77C793FF6V0NMNSC7AE47JT\outer\inner\ownership-probe.mjs` | 退出码 0 | 真实 Kubo 0.43.1 上复现上述阻塞，不是产品后端通过验收 |
| `pnpm check` | 退出码 0 | format、release lint/tests、各 workspace lint/typecheck/test/build、测试类型检查与 publint 全部通过；产品代码仍为原基线 |
| `silvermoon check --worktree --audience agent` | 退出码 0，`valid: true` | 当前生命周期候选布局／历史有效，不代表 Inner 已提交或验收 |
| `git diff --check` | 退出码 0 | 当前变更无空白错误 |

探针运行后 `.cache` 内没有残留 `kubo-ownership-*` repo。本次未执行 commit、push、发布、事件变更或远程部署。

## 父 Agent 门禁审查

父 Agent 已阅读反例与探针代码，并独立重跑同一真实 daemon 探针，退出码 0，复现相同 CID 在系统单独 pin 和外部再次 pin 后的列表完全一致；按 CID unpin 后外部保留也消失。该事实支持当前管理边界存在缺口，不支持“所有共享 Kubo 方案都不可实现”的泛化结论。

审查结论：实现尚不具备 `submitInner` 条件，不能记录 `acceptInner`，不能将现有包换号作为本 Idea 的新 RC 发布，也不能把 Ubuntu 基础连通性当成产品 smoke 通过。用户已授权父 Agent 审批门禁，但未授权擅自改变已接受的外部 pin 保护要求。

最小待确认点是自动清除所依赖的管理边界：是否要求所有 pin 写入通过可强制执行的协调入口，还是允许专用 repo，或在非独占共享 repo 上保留无法证明归属的 pin 并显式报告未完成。第三项符合安全方向，但不能冒称此类 pin 已满足自动清除结果。只有 pin name 或参与 Engine 的锁不能解除本反例。

## 用户澄清后的处理

用户随后明确：可用 pin name 标记 `@silvermoon-work/task-engine` 来源，pin 只作为优化 hint，不保证外部不会清除此 pin；local 的 dataDir 缓存同样可被用户手工清空。此次需求澄清不否定上述反例，而是撤销“必须保证任意外部保留意图不受干预及内容绝对可用”的前提。

因此不再要求专用 repo 或强制外部写入协调服务；按修订后的 Ideal 实施具名提示、参与 Engine 引用标记清除、未知可见名称保守跳过，以及外部清理后读取真实恢复或显式报错。pin name 仍不是所有者租约，RPC 和校验错误仍必须显式处理。本文保留历史阻塞证据，不再作为继续产品实现的未决需求；修订后的准确 Ideal 需重新提交并由获授权父 Agent 审查。
