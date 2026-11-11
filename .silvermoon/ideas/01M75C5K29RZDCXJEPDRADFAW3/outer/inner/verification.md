# 首版本地 raw profile 与复核依据

## 固定规范与范围

规范基线为 ipfs/specs 提交 `3000be69497e47c399cdb719440d0809f085388b`：
[Trustless Gateway](https://github.com/ipfs/specs/blob/3000be69497e47c399cdb719440d0809f085388b/src/http-gateways/trustless-gateway.md)、
[Path Gateway](https://github.com/ipfs/specs/blob/3000be69497e47c399cdb719440d0809f085388b/src/http-gateways/path-gateway.md)。
这是有限 raw profile，不宣称完整 gateway 兼容；CAR、IPNS、DAG 路径和范围读取不属于本轮。

| 适用要求 | 实现和证明 |
| --- | --- |
| 根 block GET/HEAD、原始 bytes | `raw-gateway.ts` 只接受 local read capability；`DiskContent.local` 校验 SHA2-256，HEAD 仍读并验证，不发送 body |
| CIDv0/v1 与 identity | 缓存键归一化 CIDv1；identity 直接返回 CID 内的 bytes，探测 bafkqaaa 为零字节 200；不支持 hash 为 501 |
| format/Accept | format 优先；无 format 时要求 Accept；具体媒体范围优先于通配符，q=0 排除生效；不可满足 406 |
| 不回源 | 适配器没有 GatewayClient.block.get；命中、缺失、only-if-cached、损坏、授权/禁用、探测均不能调用上游 |
| 缺失及故障 | 普通根缺失 404、only-if-cached 缺失 412；损坏、非法存储及 IO 错误 500；不返回未经验证 bytes |
| 响应与条件 | attachment、可安全指定 filename、raw Content-Type、nosniff、Content-Length、Content-Location、Vary、IPFS 路径/URI；强 ETag 包含 .raw；If-Match 与 If-None-Match 在本地验证之后求值 |
| 不支持的可选特性 | IPNS/路径/非法 CID、重复格式和 CAR 专用范围参数 400；CAR 等格式 406；不支持 hash 501；Range 忽略并返回完整 200，Accept-Ranges: none；无稳定修改时间，忽略日期条件 |
| 访问与资源 | 默认 disabled，显式 public 或独立 bearer token；token 不能保护任务 API；并发、block bytes、总时限独立于任务配额；listener/连接与事件循环仍共享，不构成恶意租户隔离 |

## 自动化证明

`packages/task-engine-cli/test/raw-gateway.test.ts` 覆盖：

- 二进制 bytes、CIDv0/v1 别名、非空 identity、GET/HEAD bafkqaaa、HEAD 空 body、SHA2-512 显式拒绝。
- Accept 权重/通配符/排除/参数、format 优先、非法路径/格式/方法、ETag 弱比较及 If-Match。
- 配置了计数 HTTP 上游的真实 DiskContent：全部普通/only-if-cached GET/HEAD 缺失及命中出站计数均为零；关闭该上游后命中仍成功。
- 对真实缓存文件破坏、替换目录，返回 500；损坏时 If-None-Match: * 不得产生 304。
- 禁用与未授权没有本地读取；token 成功响应 private；block 与 identity 输出预算 413。
- 可控的阻塞 local read 证明并发 429、总时限 504、客户端断开和 shutdown 取消，并在取消后立即复用 slot；不消耗任务执行/准备资源。

`packages/task-engine-cli/test/managed.test.ts` 的 `two independent` 测试：
启动两个不同 PID/目录的受管 Server，使用 Builder 实际构建的多 block CAR 在 A 执行并落盘；
A 配置的计数上游零次调用后被关闭。B 只配置 A 为上游，通过 CID 拉包并独立执行，
结果 `{echo:"independent"}`；逐块比较 A raw 响应与 B 已校验的落盘 bytes。
另校验 A SQLite 持久输出根的 raw 响应 multihash。B 保持默认禁用，不暴露自身缓存。
测试停止其自有进程，删除其专用目录，不依赖外部 IPFS 服务。

复现（仓库根执行；managed 测试工作目录需要为 CLI workspace）：

```powershell
pnpm --filter @silvermoon-work/task-engine-cli typecheck
pnpm exec tsx --test packages\task-engine-cli\test\raw-gateway.test.ts
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test --test-name-pattern="two independent" test\managed.test.ts
pnpm check
```

## 安装包后的隔离双节点演练

此处只是部署方复核输入，不代表已经发布或完成外部门禁；本轮不改版本、不发布、不 SSH。
仅影响发布包 `@silvermoon-work/task-engine-cli`，不改 Engine/Protocol/Builder 发布内容。
在隔离工作目录使用待发布 RC 安装的 `task-engine`；Builder 使用已有发布版产出的 CAR。
以下为两个 loopback 端口的命令序列（Linux shell 的本地路径用 `./`；Windows 用 `.\`）：

```sh
# 按现有 Builder 指引 init/install/build，得到 ./dist/<derived-package-name>.car。
# input.json 必须符合该任务的输入 schema。
task-engine config set server.rawGatewayAccess public
task-engine server start --data-dir ./engine-a --port 18787
# A 已启动的配置快照不变，B 使用新的 disabled 配置。
task-engine config reset server.rawGatewayAccess
task-engine server start --data-dir ./engine-b --port 18788 --ipfs-gateway http://127.0.0.1:18787
task-engine run --engine http://127.0.0.1:18787 --car ./dist/<derived-package-name>.car --input ./input.json
# 从 Builder build 回执取 bundle CID，不要拿 output.cid 代替 bundle CID。
task-engine run --engine http://127.0.0.1:18788 --cid <bundle-cid> --input ./input.json
curl -i 'http://127.0.0.1:18787/ipfs/bafkqaaa?format=raw'
curl -I 'http://127.0.0.1:18787/ipfs/<bundle-cid>?format=raw'
curl -i -H 'Cache-Control: only-if-cached' 'http://127.0.0.1:18787/ipfs/<known-missing-cid>?format=raw'
task-engine server stop --data-dir ./engine-b
task-engine server stop --data-dir ./engine-a
```

授权复核：先停止 A，`config set server.rawGatewayToken <随机URL-safe至少32字符>`、
`config set server.rawGatewayAccess token` 后重启 A；无 token 401，
`curl -H 'Authorization: Bearer <token>' ...` 成功，禁用后重启为 404。
现有 Engine 上游客户端不支持 bearer 配置；不能把 token 模式冒充双节点客户端兼容。
预算复核可分别设置 `server.rawGatewayMaxConcurrent`、
`server.rawGatewayMaxBlockBytes`、`server.rawGatewayTimeoutMs` 后重启；
超限/取消的确定性证据使用上列自动化测试，不靠不稳定的短网络时序推断。

## 风险与边界

本功能不是身份/租户隔离系统：public 共享实例全部缓存，包含输出；token 持有人也能读取全部缓存。
token 由用户配置保存，config list/get 可见；应保护配置并在公网前加 TLS/反向代理。
共享 listener 的连接级预算仍为 server.maxConnections；严格网络隔离需要独立实例或代理。
支持的 CID 文本长度最多 2048、filename 最多 256、默认 block 上限 2 MiB；
调用方可显式提高 block 预算，但内存预算随并发和上限增加。
本地受信任缓存可被外部进程修改；读取仍在发响应前验证 hash，故障只返回 500。
