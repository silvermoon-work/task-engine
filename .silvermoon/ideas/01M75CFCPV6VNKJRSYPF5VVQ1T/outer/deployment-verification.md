# 最终 IPNS record RC 与独立 Ubuntu 验收

## 发布身份与实现审查

主 Agent 独立检查维护库签名/名称绑定、legacy一致性、纳秒winner排序、持久过期高水位、独立有界SQLite、offline import锁、GET/HEAD/缓存/条件及授权边界。41个IPNS/help/raw/CAR/recursive聚焦测试与全仓`pnpm check`通过后接受实现`f12adf6dcd51be0d3488ba08a53c8f0ccd0779a3`。

- 唯一新版本：`@silvermoon-work/task-engine-cli@0.2.0-rc.8`。
- 准确发布提交：`f34c54c8e6a727f257fb456ad36817b09a412aa8`。
- 不可变tag：`task-engine-cli-v0.2.0-rc.8`。
- [准确提交CI](https://github.com/silvermoon-work/task-engine/actions/runs/43143879844)：attempt2的Node22/24与聚合均通过，`github-ci-verify`另行验证。首次Node22的既有managed故障退出/异步准备生命周期场景遇到`ESRCH`/退出码断言，未跳过或更改门限；相同提交failed-job重跑通过。初次失败保留，不称首次全绿。
- [Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43145655141)成功，单包构建/pack/artifact/内部依赖/publint/OIDC通过，没有本地publish或自动发布依赖。
- Ubuntu普通registry精确安装，tarball与安装manifest、锁integrity一致：

```text
sha512-CekijtyS9srIF9XXOizbgQ+YnNfNyPW075y3rSam8mMC+zGbw4R9DxHiK1jSWlvh6bnd2nQ5KtH22a+SZiS/Xw==
```

`latest=0.1.0`、`canary=0.2.0-canary-261111-1`不变，历史rc.0至rc.7保留，rc指向rc.8。全部内部runtime/dev依赖沿用已发布rc.0，新增外部签名/编码库使用catalog固定版本。

## D-AC01：原始签名、信任锚与独立客户端

指定Ubuntu设备Node`v24.16.0`、pnpm`11.5.1`、原有Kubo`0.43.1`。在全新隔离registry consumer运行先同步的[公开回放](inner/replay.mjs)，准确包版本断言通过，没有`--source`、工作区替代或产品内部导入。

临时生成Ed25519私钥仅留进程内；host-owned命令`data import-ipns --key --record`写入已停止且锁定的专用实例，不是HTTP上传或IPNS发布。record原始bytes由独立`ipns@11.0.1`及Kubo`ipfs name inspect --verify`验证，信任锚为请求名称而不是服务端解析结果。

实际报告`ok=true, mode=registry-consumer, cliVersion=0.2.0-rc.8`。临时公开名称：
`k51qzi5uqu5dgyf7g8006oh3ygh6rk03ah272m5x50astm6udluv9uejxrtl5a`。

- 默认disabled读取404；离线导入序列0和1，低序列覆盖明确拒绝；错名/篡改导入明确失败。
- 运行中import返回DATA_IN_USE；public HTTP返回原record精确bytes，独立JS验证器通过，GET/HEAD/Accept/ETag/304/CORS及attachment正确，错误format拒绝。
- Kubo共5项独立检查：原记录有效、错名无效、签名篡改无效、HTTP原bytes有效、实际过期记录无效。Kubo可能exit0但`Validation.Valid=false`，脚本逐项断言该字段，不把退出码当验签成功。

## D-AC02：更新、重启与真实到期

冻结command45秒、HTTP5秒、gateway并发2/时限5秒、短生命周期15秒、最大等候20秒，不修改设备系统时钟。

序列2更新返回新bytes/ETag，max-age按TTL与EOL剩余时间较小值裁剪。停止、尝试序列1回滚被拒绝；重启后当前ETag条件仍304。等待真实15秒到期后GET和HEAD（携带先前ETag）均404、无ETag、no-store，独立JS/Kubo均判过期。再次停止后，仍拒绝未过期但低序列1；导入序列3后读取恢复，证明重启和过期没有丢失已见高水位。

同序列EOL纳秒/原bytes排序、反序并发更新、RSA/名称别名、字段/存储损坏、额度/linked文件、受控时间等更细边界由主Agent独立聚焦测试及准确Linux CI覆盖；不全部冒称远程回放。只证明本地已见winner与签名有效性，不能宣称全网最新、缓存即时撤销、DNSLink/DHT发现或公共上传。

### 真实浏览器与前序能力回归

另运行先同步的[浏览器回放](verify-browser.mjs)，临时public/token实例与独立origin经仅loopback SSH tunnel连接。真实Chromium/Electron JS验证两种模式均取得**168个精确原始record bytes**、HEAD200空body、条件304、暴露ETag/attachment可读，max-age=60不超过fixture TTL/EOL；token触发Authorization preflight，无token401仍可读，cookie凭证被CORS阻止。userAgent包含Chrome150/Electron43.8.6。测试token为公开fixture，生产凭据/私钥未写入页面或报告。

rc.8的原递归[公开回放](../../01M75CE60FWGBEZMDK23AMAFW1/outer/inner/replay.mjs)重新执行通过：cold/warm仅1次回源，24故障请求仅2次上游、峰值2/active0、22次429，真实任务成功**1275.768754ms**，A/B**3次请求/56.843107ms**。另独立HTTP+CAR reader验证原raw精确`hello\n`，bafkqaaa CAR26bytes、root正确且零identity数据块；完整范围/协商等源码回归在41项测试及Linux CI中覆盖。没有新增公开网络IPNS acquisition。

## 清理与复现

公开签名回放finally停止实例、删除其专用目录，报告`instanceStopped=true, ownedDirectoryRemoved=true, privateKeyFiles=0`。浏览器回放120秒后停止两实例/origin并删除专用工作目录，临时SSH tunnel明确停止；对18885/18886/18887端口独立连接均拒绝。递归回放专用工作目录也不存在。

保存精简record/browser/registry/regression报告后，精确删除本轮consumer，包括安装包/tarball、临时record库、HOME/config、所有公共records/fixtures；最终确认目录不存在。私钥从未落盘，未启动Kubo daemon、init共享仓库或改全局工具。

复现：全新consumer普通安装CLI`0.2.0-rc.8`、`ipns@11.0.1`、`@libp2p/crypto@5.2.0`、`@libp2p/peer-id@6.0.18`、`multiformats@14.0.5`；复制已同步的回放：

```text
node replay.mjs --expected-version 0.2.0-rc.8 --kubo /home/xiaonuo/.local/bin/ipfs
```

浏览器验证另复制`verify-browser.mjs`，在新consumer执行，仅转发自有loopback端口并调用页面的`checkIpnsBrowser()`。不要保存私钥、实例token或整个临时目录。原始失败与历史发布tag保持不变。
