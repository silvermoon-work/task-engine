# Node 22.13 CI 超时诊断

## 观测

- 父级准确提交：`676e2bdd7011b455bc016f541df66e26abce4ecc`。
- Actions run `43074956779`，Node22 job `130712339611` 和重试 `130721327431`
  均在15分钟超时；没有断言失败输出。Node24成功。
- 在约5分钟进入 CLI 测试后不再输出；取消时留下 tsx/test-worker/esbuild 链。没有重试完整CI、放宽时限、修改验证器、筛掉测试或发布。

## 有界定位

从官方 `v22.13.0/SHASUMS256.txt` 校验临时运行时，不改全局Node：

| 归档                           | SHA256                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| node-v22.13.0-win-x64.zip      | b0feb09ebf41328628e7383f7a092fb7342ce1e05c867a90cf8f1379205a8429 |
| node-v22.13.0-linux-x64.tar.xz | 3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6 |

准确Node22下，原raw/CAR选择运行有30秒外部诊断上界：raw通过，CAR在首项成功后卡住。单独选择某些测试或增加即时日志会改变表现，因此没有把单测偶尔通过当作修复。随后仅为自有进程开启loopback
inspector，在活跃挂起进程抓取堆栈：

```text
node:internal/deps/acorn/acorn/dist/acorn  parseExpressionAt
node:internal/assert/utils               parseCode
node:internal/assert/utils               findColumn (递归)
node:internal/assert/utils               getCode / getErrMessage / innerOk
node:assert                             ok
car-gateway.test.ts                     负向 HAMT proof 的 blockstore.get
ipfs-unixfs-exporter                     findShardCid
```

一次快照深度1619；`findColumn` 参数为
`column=10563`、`code.length=13063`。Node22的隐式断言消息提取把tsx的一行转译调用位置用于读取原始TypeScript文件。当解析失败且长度差恰为2500时，保护条件使用严格
`>2500`，后续读取长度为0， `bytesRead < bytesToRead`
又为假，进入不推进的递归路径。这是Node22隐式断言诊断路径问题，不是gateway等待磁盘、慢消费者或资源取消。

`HAMT` 缺分片和 `entity` 缺block两个负向测试有意使裸 `assert.ok` 失败，再由原有
`assert.rejects/assert.throws`
捕获。断言本身早于迭代5已存在，但本轮转译后调用位置触发了该运行时诊断问题，直接阻塞本轮验证。

## 修复边界

仅给这两个**故意失败**的 `assert.ok`
加显式、描述必需证明块的消息。条件、缺失的块、异常类型和外层rejects/throws检查都保留；没有把真实失败变成通过，没有移除或跳过测试，没有调整超时或产品资源阈值。生产源码、CLI版本
`0.2.0-rc.5`、发布流程和父级外层契约均不修改。消息使Node22直接构造原本应有的AssertionError，不进入隐式源码提取路径。

## 验证与限制

修复后，原始两个测试文件在准确Windows Node22.13下19/19通过、0
skip/cancel，最终准确文件耗时3660.4053ms（首次修复验证3733.0629ms）；原断言没有替换成弱检查。完整CLI选择随后在Node22下正常结束（132496.361ms，无取消），报告62
pass、4 fail、1 Windows平台skip；不是全绿：既有 `managedDiagnostics`
重开文件身份检查返回
`Managed diagnostic file identity changed`，导致其data测试与两个生命周期场景失败（含父/子测试节点）。单独原data诊断测试再次精确复现同一错误，1060.968ms结束。该生产文件最后改于
`bf64d0be1d470aef3a5d7870bfccee6a4da60a17`，早于本轮且未被本轮修改；不扩修此独立Windows
Node22问题，不把失败改为skip或通过。完整 `pnpm check`
使用现有默认Node26.13.0另行验证通过，40/40 tasks、2m5.607s；准确结果见
[evidence.json](evidence.json) 的 `node22Followup`。

已尝试独立WSL Ubuntu源码副本与校验后的Linux
Node22：本地WSL既有localhost代理不可达，直接registry连接也超时；离线cache因缺少supply-chain元数据拒绝安装。没有覆盖registry或关闭策略。通过校验临时Linux
esbuild尝试复用挂载依赖时，Engine
data导入在Node22和Node24均超过独立诊断上界，因此该路径不能充当Linux
CI通过证据。最小内置断言消息探针可在Linux Node22执行，但未复现完整挂起，
**不把它称为Linux完整回归通过**。

Linux发布证据仍必须来自父级对新准确main提交的真实CI；本次只交回可复核的有界根因修复，不接受门禁、不重试发布、不放宽CI。自有Windows/WSL运行时、下载、诊断测试副本、inspector和进程均在结束前清理，不触碰父级远端consumer或Go/suite工具。
