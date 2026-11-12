# Deployment

用户已授权顺序完成剩余迭代：本轮新subagent实施，主Agent独立审批impl/deploy、发布RC并连接指定Ubuntu验证、清理自有测试资源。仅本地host-owned签名记录输入与HTTP读取，不授权公开IPNS发布、DHT发现、DNSLink或公共上传。使用临时测试密钥，私钥与凭据不得进入仓库或报告。

本轮唯一新版本为`@silvermoon-work/task-engine-cli@0.2.0-rc.8` / `task-engine-cli-v0.2.0-rc.8`；内部依赖沿用已发布`0.2.0-rc.0`，新增外部依赖使用catalog固定版本，不重发其他workspace。发布前latest=`0.1.0`、canary=`0.2.0-canary-261111-1`、rc=`0.2.0-rc.7`。同版本/tag已占用则停止。独立consumer执行先同步的[公开回放](inner/replay.mjs)，冻结15秒短生命周期、20秒等待上限和5秒HTTP时限不变；Kubo结果须检查`Validation.Valid`而非exit0。

## Steps

### D-S01: 配置可控记录及独立客户端

实现复核通过后，仅为实际受影响映射包选择未占用的新RC；准确main push CI全部通过后经不可变package-specific tag及`publish-npm.yaml` Trusted Publishing发布，保留latest/canary与历史版本，不本地publish或自动发布依赖。

通过指定SSH设备在全新隔离consumer普通安装精确registry包，核对manifest/lock integrity；验证契约、脚本及受控生命周期/预算须先同步再执行。临时生成真实测试签名记录，记录非敏感名称/record摘要/序列/有效期，使用明确host-owned输入接口导入专用实例，不预置产品私有源码、不从其他节点补全。

独立客户端从请求IPNS key验签并验证名称绑定和有效期；使用公开IPNS库及适用Kubo record inspect作为不同客户端，不能只信任服务端返回的解析CID。签名fixtures覆盖旧/新序列、同序列选择、错名、篡改、过期。

### D-S02: 演练更新与到期

验证record原bytes、GET/HEAD/Accept/format/ETag/缓存期限、token/disabled与CORS；更新后重启并尝试低序列覆盖，包含已见新记录过期后旧版本不能回滚。真实短生命周期在规定上限内等待验证到期，不修改共享系统时钟；复杂边界由本地可控时间测试与远程实测分别说明。

验证raw/CAR/显式递归能力不回归，记录错误输入的明确失败，禁止未授权HTTP上传/隐式联网。保存简洁可重放结果后停止所有自有实例/listener，精确删除consumer、专用HOME/config、记录库、临时密钥、CAR和fixtures；不得终止或删除其他工作。

## Acceptance criteria

### D-AC01: 客户端自行证明名称绑定

准确提交CI/tag/发布Actions、精确registry身份/integrity与历史渠道不变有证据。有效record的原bytes和名称绑定可独立验证；错名/篡改/无效签名输入明确拒绝，不成为成功结果。GET/HEAD和协商实际行为符合声明，报告不包含私钥/token。

### D-AC02: 更新和过期行为符合声明

记录新序列、同序列选择、重启、旧记录和到期演练，旧值不能覆盖持久已见新值，过期后不能发200/304，缓存max-age不超过适用记录期限。客户端自行验签，不能宣称离线可证明全网最新。raw/CAR/递归回归通过；最终自有进程停止、listener关闭、所有测试密钥/目录不存在，清理失败明确记录而不冒称完成。
