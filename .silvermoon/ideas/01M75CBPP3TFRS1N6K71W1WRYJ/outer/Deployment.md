# Deployment

用户已明确授权夜间按顺序自主推进剩余迭代：每轮新 subagent 实施，主 Agent 独立审批门禁、发布新 RC、在指定 Ubuntu 设备验证并清理自有测试资源；仅在真实 blocking issue 时停下，不绕过门禁。本契约只覆盖局部读取与 CAR 协商，不扩展到回源或 IPNS。

外部复核使用先同步的 [Ubuntu 范围验证脚本](verify-range-ubuntu.mjs)，将 [公共库 fixture/oracle](inner/range-proof.mjs) 复制到同一独立 consumer。范围响应必须能被空离线 Kubo 按 offset/length 恢复；不能通过增添无关 blocks 规避最小证明要求。

## Steps

### D-S01: 准备可重复的大文件范围查询

实现复核通过后，仅为受影响映射包选择未占用的新 RC；main 的准确发布提交 CI 全部通过后，通过不可变 package-specific tag 和 `publish-npm.yaml` Trusted Publishing 发布，保留 latest/canary 与历史版本。不能本地 publish、移动 tag 或自动发布依赖。

本轮仅发布 `@silvermoon-work/task-engine-cli@0.2.0-rc.4`，tag 为 `task-engine-cli-v0.2.0-rc.4`；内部依赖沿用已发布 `0.2.0-rc.0`。发布前 latest=`0.1.0`、canary=`0.2.0-canary-261111-1`、rc=`0.2.0-rc.3`；若版本/tag 已占用则停止。

在指定 SSH 设备的新临时 registry consumer 普通安装精确 RC，核对 manifest/lock integrity。使用至少 8 个不同数据块、已知布局的多层大文件，以及共享引用 DAG；记录请求根、路径、文件大小、独立预期范围/块集合。验证契约与脚本须先同步 primary，再执行外部检查；不能用产品同一遍历函数生成 oracle。

### D-S02: 记录协商和带宽结果

使用独立 CAR 读取器、文件结构验证器与隔离离线 Kubo，演练跨块、头尾、负偏移、星号、部分/完全越界和非字节实体；记录完整/小范围的实际传输 bytes、CID 集合、恢复 bytes 与原始切片比较。测试 dups=y/n 的实际顺序/重复、query/header 优先级、ETag/条件、缺块失败及 raw/完整 scope 回归。

每次仅操作明确命名的本轮专用 HOME/data-dir/Kubo repo。保留简洁证据后停止全部自有进程，删除临时 consumer、安装包、CAR、随机 fixture、配置及证书，不得删除或终止其他工作。

## Acceptance criteria

### D-AC01: 范围验证与传输收益成立

记录准确提交 CI、tag、发布 Actions、精确 registry 包身份/integrity 及历史渠道不变。客户端仅依赖请求根/路径/区间与返回 CAR，恢复内容与预期切片逐字节一致；跨块小范围仅包含独立计算的必要结构/内容块，实际传输小于完整文件查询。保存明确大小、CID 集合和 SHA-256，不能只证明 HTTP 200 或 CAR 可解析。

### D-AC02: 不同客户端正确理解表示

独立客户端验证 dfs 和 dups=y/n 的实际输出与声明一致，范围/协商变体的 ETag 不混用；不支持变体明确错误，不静默降级。边界范围按规范返回适用的错误或足够结构证明。缺失必要块/中断传输不被当作完整成功，only-if-cached 等请求零回源。确定性预算/取消证据与远程实测分开陈述；最终自有 listener 关闭、进程停止、测试目录不存在。
