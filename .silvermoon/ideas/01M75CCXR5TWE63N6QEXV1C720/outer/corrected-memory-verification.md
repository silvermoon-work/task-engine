# 修正后的独立 RSS 对照与外部验证

## 口径与发布身份

用户批准将旧生命周期 maxRSS 差值改为同条件匹配实验；随后批准将协议一致性并发设为16，资源/内存压力仍为2。这是先声明的新实验，不追溯将旧失败改为通过。原始错误口径、主线程采样缺口、并发2下的429均保留在历史证据。

新 sampler 使用独立 Worker 每50ms读取进程级 `process.memoryUsage.rss()`，主 isolate 的 heap/external/arrayBuffers 独立保留真实时间和间隙；不插值，不将 external 与 arrayBuffers 相加，不用 lifetime maxRSS 判定。Worker 的固定仪器开销在两臂预热前同样引入，RSS不是应用硬限额。

主 Agent 独立审查源码、重跑认证 status/采样/配对与受管生命周期测试和 `pnpm check` 后接受实现 `49f9265dc07e9961454fbb5f98349630f4d672f6`。

- 唯一新版本：`@silvermoon-work/task-engine-cli@0.2.0-rc.6`。
- 准确发布提交：`c3b6b30002fa777a4091207b6bd66e4b4b679514`。
- [准确提交 CI](https://github.com/silvermoon-work/task-engine/actions/runs/43128616506)：Node22/24与聚合均通过，`github-ci-verify`另行验证。
- tag：`task-engine-cli-v0.2.0-rc.6`；[Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43129674912) 成功，不覆盖rc.5。
- Ubuntu普通registry安装、下载tarball与安装manifest、锁integrity一致：

```text
sha512-bp8B4pmauNlNXEc6x76vt/S3oVkxqZP9dbGU4jby1AQLUCJ/Wy5jU+2NybSEHGmmiBBChFUBGTfftH1gGam1tA==
```

`latest=0.1.0`、`canary=0.2.0-canary-261111-1`不变，历史rc.0至rc.5保留，rc指向rc.6。目录传播暂未就绪后等待，同一精确版本正常安装，没有本地包替代。

## Ubuntu独立匹配结果

实际环境Node `v24.16.0`、pnpm `11.5.1`。已发布包公开CLI回放，六个独立实例、顺序C/T、T/C、C/T；每臂3波、每波8任务，共144个成功测量任务。处理臂每波32次1MiB raw读取；控制臂相同任务但不开启网关读取。所有配置、等量预热、任务CAR与采样器开销按冻结协议匹配。

全部9对差值不超过134217728 bytes，实际最大 **56770560 bytes（约54.14 MiB）**。所有RSS窗口真实连续序号及边界/相邻250ms覆盖检查通过，最大间隙 **57.025146484375ms**。原始样本gzip校验值与配对报告独立复核；main isolate诊断间隙保留，不冒充RSS缺口。

| 重复/波 | C阶段增长bytes | T阶段增长bytes | T−C bytes | T最大延迟ms | 配对门限ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0/0 | 25731072 | 68292608 | 42561536 | 5376.05 | 25228.06 |
| 0/1 | 262144 | 131072 | -131072 | 5423.31 | 25422.56 |
| 0/2 | 32690176 | 28241920 | -4448256 | 5370.29 | 25018.27 |
| 1/0 | 23347200 | 80117760 | 56770560 | 5371.82 | 25402.37 |
| 1/1 | 2097152 | 1835008 | -262144 | 5413.55 | 25269.73 |
| 1/2 | 0 | 0 | 0 | 5737.34 | 25045.45 |
| 2/0 | 24363008 | 49483776 | 25120768 | 5447.89 | 25356.36 |
| 2/1 | 0 | 43171840 | 43171840 | 5335.59 | 25194.54 |
| 2/2 | 47013888 | 0 | -47013888 | 5667.10 | 24863.03 |

没有把负值截零、挑最佳轮次或强制GC。阶段增长为本阶段load/drain实际采样RSS峰值减自身quiet中位数；各对再相减，不把整个宿主/Worker增长归因于网关。三个有限波次不构成无泄漏或RSS严格回到基线的证明。

负载并发上限2与429拒绝检查仍生效，全部配对延迟通过原5倍/2000ms规则。六个实例abort回收633.53至651.24ms、带活跃消费者shutdown686.06至708.97ms，均小于3000ms。缺块/存储错误/取消分类、在线GC拒绝与离线清理断言全部通过。所有指标来自原回放断言与独立摘要核对，不是仅进程存活。

## 真实浏览器与TLS/HTTP2

主 Agent 使用真实集成Chromium/Electron，经仅绑定loopback的自有SSH tunnel访问Ubuntu安装包。浏览器origin `http://127.0.0.1:18786`，public/token实例分别18785/18787，fixture token为公开测试值。

实际跨源JS检查：public与token均取到精确 `hello\n`、ETag/attachment/roots可读、HEAD200空body、条件304空body、CAR探测26bytes、编码CID/UTF-8附件名/Accept权重均通过。token触发Authorization preflight，无token401仍可读；`credentials:include`被CORS阻止，未开放cookie凭证。userAgent包含Chrome150/Electron43.8.6；预期401/CORS控制台事件不是任意网络错误忽略。

本轮专用自签证书经显式CA信任验证，Node HTTP2客户端实际ALPN=`h2`，200且body精确匹配，CORS头保留。未关闭TLS验证、不冒充公开互联网部署。SSH tunnel在验证后已停止；public/token/origin/TLS代理均为180秒有界工具，已退出。

## 规范套件与尚待完成项

rc.6在原并发2协议实例上，两次固定完整选择器仍出现同一正常429，不能记为通过。独立诊断复现只检查headers、不消费前两份CAR body即发第三请求的200/200/429，实际前两份响应未完成，完成后slot约0.05ms内释放；完全消费的对照30/30成功、active归零，没有证据支持slot泄漏。

用户已批准协议实例并发16、负载实例仍2。脚本策略经独立检查：仅有fixtures时选择16、load仍为2，组合用途明确拒绝；源码和契约先同步，接受新的实现revision `f64d68891be52a97ccf5c01851f5540c3e29c884`后执行外部套件。此调整没有改变已测matched实验的源码/负载/采样或rc.6产品artifact，不需要重发该不可变版本。

rc.6在批准的协议16实例上，原完整specs和`^(TestTrustless.*|TestCors)$`选择器**连续三轮各503 pass事件、0 fail、0 skip、11个顶层测试**。主Agent逐行验证NDJSON终止事件与测试数量，30份fixture校验和与固定清单一致。未改runner、选择器、用例或通过串行化隐藏失败；之前并发2的429保留为该容量下的真实拒绝，不能混写为协议通过。

最后确认所有六个测量arm和suite/public/token回放自有工作目录已清理；对18781/18785/18786/18787/18789端口独立连接均为拒绝，自有SSH tunnel已停止。保存精简报告及可审计的压缩采样后，精确删除本轮consumer，包含安装包、tarball、Go工具/源码/module/build caches、证书、配置、fixture和载荷；只在确认自有Go缓存路径后恢复owner写权限清理，最终确认consumer不存在。没有修改共享工具或终止其他服务。

本文件当前记录完整的新口径验证结果，可用于该准确部署候选的submitOuter与委托验收；历史失败文件继续保留，不追溯为通过。有限样本仍不代表RSS硬上限、无泄漏或恶意租户隔离。
