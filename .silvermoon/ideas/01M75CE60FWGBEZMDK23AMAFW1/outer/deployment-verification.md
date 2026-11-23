# 受控递归 RC 与 Ubuntu 验收

## 身份与独立复核

主 Agent 独立检查固定origin allowlist、only-if-cached本地端口、canonical singleflight、等待者取消、原子持久化、四跳/实例循环防护及独立预算。29个recursive/raw/CAR定向测试与全仓`pnpm check`通过后，接受实现`0be071f2c71f6267fac5a45b0d3d7f62e857e464`。

并发主分支的其他Idea文档/事件通过普通merge保留，未修改其范围或验收事实。

- 唯一新版本：`@silvermoon-work/task-engine-cli@0.2.0-rc.7`。
- 准确发布提交：`0535d30341ff2a8bd7b588a6c5c3c7a4abd870aa`。
- 不可变tag：`task-engine-cli-v0.2.0-rc.7`。
- [准确提交CI](https://github.com/silvermoon-work/task-engine/actions/runs/43136300238)：Node22/24和聚合全部通过，`github-ci-verify`另行验证。
- [Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43137390176)成功，单包构建/pack/artifact/内部依赖校验、publint、OIDC均通过。没有本地publish或自动发布依赖。
- Ubuntu普通registry精确安装，tarball/安装manifest/锁integrity一致：

```text
sha512-6oN9GwMV1+Hs8FSgF4M7fhHUwMEggk64PuaC1rLqcmsZgRHIoAAnRdu8ahCrHRgR2CC0kZmp2IrnvR9A3tMA8w==
```

`latest=0.1.0`与`canary=0.2.0-canary-261111-1`不变，历史rc.0至rc.6保留，rc指向rc.7。等待registry目录传播后普通安装成功，未使用工作区或上传tarball替代，未改目标registry。

## D-AC01：冷暖获取、持久缓存与禁止回源

指定Ubuntu设备Node`v24.16.0`、pnpm`11.5.1`，使用独立consumer安装包和先同步的[公开CLI回放](inner/replay.mjs)，不导入产品私有源码。

冻结配置：HTTP admission16，独立acquisition2，无排队；累计接收1024bytes、总2000ms、单次1500ms；24个不同CID故障请求、A/B≤3请求且<2500ms、真实任务<30000ms。不是修改产品默认local或原有压力实例预算。

- 冷缓存raw GET/HEAD的only-if-cached均412，真实计数upstream为0。
- 首个等待者触发一次回源后保持inflight，CIDv0/v1第二等待者加入同一flight；认证status实际确认joined=1，不依赖固定sleep猜测。
- inflight期间raw与CAR的only-if-cached立即412，不join等待或发起新获取；上游计数仍1。
- 取消首个等待者，第二等待者仍收到200与精确31bytes；CID/SHA2-256对应，落盘后停止并重启实例，上游503仍能读相同bytes，累计请求仍**1**。
- 保留批准上游配置但改为默认local时缺块404；disabled模式缺块404，上游计数不变，不能用CID或配置存在当授权。

## D-AC02：故障、回路与执行可用

24个不同CID stall请求同时进行，实测**2个502、22个429**；仅**2次回源**，acquisition峰值**2**、结束active**0**。状态显示recursive failures=2、timeouts=2、rejected=22，local storageErrors=0，未把网络失败冒充存储错误。

同时通过已发布Builder构建并执行真实callback任务，结果`succeeded/value=42`，**1308.364094ms**，小于冻结30000ms。不是仅进程存活或HTTP200。

A/B分别独立实例/目录、相互指为唯一upstream，缺失同CID请求明确502；扣除各自identity就绪探测后实际**3次HTTP请求、41.575743ms**，均在冻结3次/2500ms内，无失控环路。

单/全部等待者取消、close/shutdown、self-loop与spoofedheader、错误CID/type/声明或流式超限/redirect/stall、fallback总字节/总时限、不隐藏持久化错误、CAR缺必需后代与only-if-cached全后代本地等确定性负例由主Agent独立重跑的定向测试证明；没有将这些全部冒称为远程演练。原raw/CAR范围/dups/访问与CORS回归保持通过。共享listener/磁盘/事件循环不是硬CPU/RSS/租户隔离，普通DNS批准域名责任与不支持upstream bearer/path prefix等边界见实施文档。

## 清理与复现

回放finally停止全部自有managed实例、关闭Node上游listener并删除专用work/source/CAR；报告cleanup为空，未保留未释放实例。保存简洁机器报告与registry audit后，确认work不存在，再精确删除本轮临时consumer（安装包、tarball、HOME/config、数据与payload），最终确认目录不存在。共享环境未改变。

复现使用全新consumer，普通安装CLI`0.2.0-rc.7`及Builder/BuilderCLI/SDK各`0.2.0-rc.0`，仅允许esbuild构建脚本；复制[replay.mjs](inner/replay.mjs)，执行：

```text
node replay.mjs --consumer . --work .recursive-owned --report recursive-report.json
```

work必须不存在且明确归本轮所有，report在work外。验证后依照上述边界精确清理consumer。无IPNS能力或公共递归部署声明。
