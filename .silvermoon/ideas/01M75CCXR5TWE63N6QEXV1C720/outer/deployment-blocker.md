# 夜间推进阻塞：Ubuntu 共载 RSS 超出冻结门限

## 当前状态

第五轮实现已通过独立复核并接受，CLI RC 已发布，但 **部署未通过、未 submitOuter/acceptOuter**。第六、七轮不启动。按用户“遇到 blocking issue 停止”的授权边界，保留证据并停止后续推进；不提高门限、减少负载或把失败改为通过。

## 已完成且可独立追溯的部分

- Node22 CI 超时已由原实施 subagent 有界定位：隐式断言消息的源码提取路径在 tsx 负向测试中挂起。仅为两个预期失败的断言增加消息，条件、外层 rejects/throws 和时限均未削弱，见 [诊断](inner/node22-diagnosis.md)。
- 主 Agent 重跑 19 项 CAR/raw 测试及 `pnpm check` 通过，接受准确实现 revision `d04b0cc29cabc8126f6d515e99b63ed4c78d2029`。
- 修正后的 [准确提交 Linux main CI](https://github.com/silvermoon-work/task-engine/actions/runs/43084685425) 中 Node 22.13.0、24.11.1 和聚合全部通过，另经 `github-ci-verify`。
- 唯一新发布包 `@silvermoon-work/task-engine-cli@0.2.0-rc.5`，不可变 tag `task-engine-cli-v0.2.0-rc.5` 指向 `ac0418ef88727213a87d3233be81338bdbb1ba40`；[Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43086504494) 成功。没有本地 publish 或移动 tag。
- 指定 Ubuntu 设备的普通 registry 精确安装成功；tarball/安装 manifest、锁 integrity 一致：

```text
sha512-zdRPdSEsC+6L9UuNhzfoP+LcFS2OujZwNKa+7e3/zI2u/zkf9cG8yO2Ggxavl8xx1VtjADzGEAXED4+bKnGm2Q==
```

`rc=0.2.0-rc.5`；历史 rc.0 至 rc.4 保留，`latest=0.1.0` 与 `canary=0.2.0-canary-261111-1` 未变。首次目录传播未就绪，等待后同一版本正常安装，未替换为本地包。

## 外部规范套件

在 Ubuntu 独立构建并运行固定 upstream suite，而不是产品自制 HTTP 测试代理：

- `ipfs/gateway-conformance v0.14.1`，commit `011d20bd61c4736e3301d35e8fe388773e492511`。
- Linux Go `1.27.4`，官方归档 SHA-256 `7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840`。
- 固定源归档 SHA-256 `00df2d910b8e2400cc831b5c71e13deb5b30c0bfa13054e900f5b73ff06e70fe`。
- 30 份 fixtures 的 SHA-256 全部与实施前冻结清单一致。
- 保持原 specs、`^(TestTrustless.*|TestCors)$` 选择器、默认 runner 并发和服务预算；没有 `-skip` 或改为串行隐藏失败。

首次完整运行在 format precedence 案例遇到服务预算内的 429，记为失败（4 个失败事件，不是 4 个独立请求）。保留该结果；随后同配置连续三轮各 **503 pass 事件、0 fail、0 skip、11 个顶层测试**，NDJSON 终止事件已独立校验。规范集合通过不代表负载门禁通过。

## 阻塞证据：固定负载两次超预算

实际环境：Node `v24.16.0`、pnpm `11.5.1`。使用已安装 RC 的公开 CLI 与原冻结 [replay.mjs](inner/replay.mjs)，未导入产品私有源码。

固定负载保持：网关并发 2、2 MiB block、8 MiB CAR、128 blocks、1000 ms 请求预算；8 个真实任务各执行 4 次 1 MiB raw 读取，合计 32 次。**RSS 增长上限为 134217728 bytes（128 MiB）**。

| 外部执行 | 实测 RSS 增长 | 冻结上限 | 结果 |
| --- | ---: | ---: | --- |
| 首次原样回放 | 212733952 bytes（约 202.88 MiB） | 134217728 | 失败 |
| 确认 suite 进程清理后，同配置新实例原样复查 | 203059200 bytes（约 193.65 MiB） | 134217728 | 失败 |

两次均在 `replay.mjs` 的 RSS 断言处退出。此前的任务/429/并发/延迟断言未报错，但未生成完整负载报告；不能据此宣称故障演练、回收、shutdown 或全部资源标准通过。**本轮父级外部浏览器/TLS 验证尚未执行**；实施阶段的浏览器结果不能冒充已发布包的外部部署证据。

尚未确定 RSS 的具体分摊与根因，不把它猜测为网关缓存、Worker 或测量误差。后续须在同一冻结负载下有界采样，识别实际分配/生命周期，并在保持行为、负载和门限的前提下修复后重新提交/验收。若必须改变验收要求，需明确新决定，不能追溯性放宽此次门限。

## 清理与恢复边界

fixture suite 的有界服务器已正常退出，两个失败负载回放均执行 finally 停止自有实例并移除专用工作目录；三个实例目录的不存在已逐项确认。没有启动 Kubo daemon、外部浏览器服务或 SSH tunnel。

保存精简 suite/fixture 清单、registry audit 和失败输出后，删除精确命名的本轮 remote consumer，包含 Go toolchain/source/module/build caches、证书、配置、安装包、tarball、CAR、fixture 和失败载荷。Go module cache 的只读文件在确认属于本轮自有路径后仅恢复 owner 写权限再清理；最终确认 consumer 目录不存在。共享工具与其他工作未改变。

已发布版本/tag 必须保留。恢复后仍须完整通过数值负载、外部浏览器/TLS 等剩余标准，才能提交第五轮部署；不能跳到第六轮回源或第七轮 IPNS。
