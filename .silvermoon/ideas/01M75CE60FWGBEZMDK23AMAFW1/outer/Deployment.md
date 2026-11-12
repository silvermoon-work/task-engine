# Deployment

用户已授权顺序推进剩余迭代：本轮由新 subagent 实施，主 Agent 独立验收 impl/deploy、发布新 RC、在指定 Ubuntu 设备验证并清理自有测试资源。仅在专用 loopback/显式批准拓扑启用递归，不自动改变现有实例模式、共享工具或公开回源能力。

## Steps

### D-S01: 配置可观测的受控上游

实现复核通过后，仅为实际受影响映射包选择未占用的新 RC；main准确发布提交CI全部通过后，仅通过不可变package-specific tag及`publish-npm.yaml` Trusted Publishing发布，保留latest/canary与历史版本，不本地publish或自动发布依赖。

通过指定SSH设备在全新临时consumer普通安装精确registry版本，核对manifest/lock integrity。先同步验证契约、脚本和已冻结的请求数/时间/并发/字节预算，再建立可计数的固定上游、cold/warm缓存、self及A/B互指拓扑；所有upstream均显式批准，禁用公共网络兜底。配置/目录/端口限于自有实例，不能将任务接口的既有回源自动等同gateway授权。

### D-S02: 演练回源与故障隔离

独立HTTP/CAR客户端验证cold获取、逐块CID校验、atomic持久缓存与上游关闭后warm/reopen成功；计数证明同CID并发合并、单等待者取消不影响其他、全部取消/关闭释放工作。验证默认local、disabled/unauthorized、only-if-cached（包含已有inflight）始终零回源；拒绝未批准目标/重定向/错误bytes/超限/stall，不把错误内容缓存。

对self/A/B回路按先冻结请求数/时间上限验证有界失败，同时运行真实任务证明执行服务保持可用。raw/CAR范围、CORS及访问策略不回归。只保留简洁证据后停止所有自有实例/listener，删除精确命名的consumer、CAR、fixtures、HOME/config与测试payload；不得终止或删除其他工作。

## Acceptance criteria

### D-AC01: 受控回源带来可复用缓存

准确提交CI/tag/发布Actions、精确registry包身份和integrity、历史渠道不变有证据。请求计数、CID/原始bytes校验与cache/reopen记录证明cold成功、warm零上游；only-if-cached/local/disabled/unauthorized/未批准目标始终不回源，不能仅凭HTTP200判成功。

### D-AC02: 故障不会放大成失控负载

真实self/A/B回路、重定向、错误内容、超限/timeout/取消均在冻结的请求数/时间/资源预算内明确结束。singleflight等待者语义正确，损坏bytes不落cache，正常任务在故障负载中和演练后执行成功；资源回落与shutdown可观测。确定性本地注入与远程实测分别说明，不冒充RSS硬隔离；最终自有进程停止、listener关闭、测试目录不存在。
