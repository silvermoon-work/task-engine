# CAR block-scope profile 与实现复核依据

## 规范与边界

沿用迭代 1 的 ipfs/specs `3000be69497e47c399cdb719440d0809f085388b`：
[Trustless Gateway](https://github.com/ipfs/specs/blob/3000be69497e47c399cdb719440d0809f085388b/src/http-gateways/trustless-gateway.md)、
[Path Gateway](https://github.com/ipfs/specs/blob/3000be69497e47c399cdb719440d0809f085388b/src/http-gateways/path-gateway.md)。
本轮只实现有限 block-scope profile，不是 entity/all 或完整 UnixFS 内容响应。

| 要求 | 实现和证明 |
| --- | --- |
| 请求根信任锚 | `test/car-gateway.test.ts` 的独立验证器使用标准 CarReader/hash/dag-pb 命名边，从调用者传入的根和路径验证；不读取 CAR roots 或服务端终点作为依据 |
| 必要路径块 | `src/car-gateway.ts` 复用已安装 UnixFS exporter/walkPath，启用 yieldSubShards；普通目录与真实 HAMT 子分片均逐块比对所需集合及原始 bytes |
| 不读取终点载荷 DAG | 测试仅将根、dir、deep 和终点文件根放进真实 DiskContent，故意不存载荷叶子或兄弟块；请求仍成功，读取列表恰好四块 |
| 明确 scope | 除空 identity 探测外，缺省/entity/all/entity-bytes 均 400；不能把 block 证明当默认 all |
| 表示协商 | CARv1、dfs、dups=n；format 优先选择表示，CAR 查询参数覆盖 Accept 同名参数，不可满足 406、重复参数 400；纯 wildcard 维持 raw 默认 |
| GET/HEAD 与缓存 | Content-Type 全参数、attachment、nosniff、Vary、Content-Location、IPFS URI、强 ETag；HEAD/304 在响应前遍历整条证明，不伪造 Content-Length |
| identity | identity 可在本地虚拟解析，不加入 CAR 数据段；bafkqaaa 探测可无 scope，CAR header 根固定为该 CID，GET/HEAD 均覆盖 |
| 本地能力隔离 | 只注入 DiskContent.local；真实计数 HTTP 上游在命中、根缺失、only-if-cached 时总计零调用；受管双 Engine 回归另检查文件缓存、SQLite 输出根与缺失 |
| 错误完整性 | 根缺失先返回 404/412；已输出后缺失/损坏子块销毁 HTTP 传输，fetch/arrayBuffer 拒绝，不能依赖部分 CAR 的可解析性认定成功 |
| URL 语义 | percent-decode 一次，编码 slash 也是分隔符，再处理 dot segments；测试多层 Unicode/空格/literal `%2F`、重复 slash、编码 slash 与编码 dot 路径 |

支持 raw `0x55` 与 UnixFS dag-pb `0x70`；SHA2-256 与 identity；CIDv0/v1。
路径中间节点只能是普通或 HAMT 目录；终点可为目录、file/raw 或 raw codec。
symlink/metadata 不在 profile 内，不跟随 symlink；其他 codec/hash 明确拒绝。
不支持 IPNS、entity/all、entity-bytes、递归回源、上传、pin 或 Range 部分输出。
控制字符、反斜线、非法 percent 编码、越过请求根的 dot 路径为 400。

## 缓冲、预算与取消

- 复用 `server.rawGatewayAccess/Token/MaxConcurrent/MaxBlockBytes/TimeoutMs`，
  raw 与 CAR 共用独立于任务执行的并发池，不建立等待队列。
- 新增 `server.carGatewayMaxBlocks=128` 限制块读取次数与去重集合；
  `server.carGatewayMaxBytes=67108864` 分别限制累计读取 bytes 和完整输出 bytes（含 CAR header/framing）。
- 既有每 block 默认 2 MiB、总时限 10 秒；pathname 上限 16384 字符、64 个路径段、
  CID 文本 2048、定制 filename 256。设置改变后重启生效。
- 一次只 await 一个 CarWriter.put，socket.write 为 false 时等 drain；
  不构建整份 CAR 数组，也不为文件 payload 预取。writer header/CID/framing 与当前 block
  有限排队；Node socket 高水位、当前块和解析副本仍占内存。
- HAMT 递归会保留父分片及解码状态，最坏受累计读取 bytes、块数和时限共同约束；
  不能宣称始终只占一块或严格 byte-for-byte RSS 限额。public/token 仍不是租户隔离；
  调高预算会增加内存风险。
- AbortSignal 联通读取、drain 等待与 shutdown；中断后仅排空当前 writer 的有限消息，
  让 put/close 不悬挂，再释放 slot。测试不依赖上游、SSH 或外部 IPFS 服务。

## 实际验证

以下命令在 Windows、Node.js `26.13.0`、pnpm `11.22.0`、现有依赖环境执行；
产品最低 Node.js 版本仍为 22.13，不更改 release 版本或发布配置：

```powershell
pnpm --filter @silvermoon-work/task-engine-cli build
pnpm exec tsx --test packages\task-engine-cli\test\car-gateway.test.ts packages\task-engine-cli\test\raw-gateway.test.ts
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test --test-name-pattern="two independent" test\managed.test.ts
pnpm typecheck:tests
pnpm check
```

聚焦 CAR/raw 共 9 项测试通过；受管双 Engine 1 项通过，测试类型检查通过。
全仓 `pnpm check` 通过：Turborepo 40/40 任务成功；CLI suite 58 项、57 通过、1 跳过、0 失败，
包含所有 workspace 的 lint/typecheck/test/build、测试类型检查、发布守卫与 publint。
lint 仍有 warning、private app 的 publint 仍有既有 suggestion，但无错误；没有安装新依赖。
测试创建的目录使用各自 `.cache/<随机ID>` 并由 after 清理；自有 listener/受管进程均停止，
不保留完整 CAR、测试载荷或逐次命令日志。

负例不只测 CAR 解析：

- 可解析 CAR 删除必要中间块或终点，路径验证失败。
- 替换终点为另一个 hash 正确的 block，因请求根证明边仍指向原终点而失败。
- 原 CID 配篡改 bytes，hash 验证失败。
- 把 CAR header roots 改为其他 CID，正确请求根仍可验证；信任错误请求根失败。
- 真实传输已开始后注入缺块或篡改，客户端 body 读取拒绝；HEAD/If-None-Match 不返回成功或 304。
- 暂停接收 32 层、每层约 512 KiB 的目录证明，100ms 时未预读完整路径；
  slot 仍占用并返回 429，总时限后释放，探测恢复 200。

## 安装消费者复核输入

只影响发布包 `@silvermoon-work/task-engine-cli`；Engine/Protocol/Builder 无需改版。
本轮不改版本、不发包、不推 tag、不 SSH；父级独立决定实现门禁与发布/Ubuntu 部署。
以下只是具体输入，不表示外部验证已经完成：

1. 使用独立安装的 Builder 创建普通任务；加入资源
   `resources/nested/proof.txt`（可用超过 chunk 大小的内容），构建得到 `dist/<name>.car`。
   同一 bundle 的 `worker.cjs`、`task.yaml` 为单层路径，资源为多层路径。
   请求根使用 Builder 回执的 bundle CID，不能用输出 CID 代替。
2. 隔离配置目录中设置 `server.rawGatewayAccess=public`，启动专用 data-dir/端口；
   通过 `task-engine run --car <本地CAR> --input <JSON>` 使合法任务包进入本地缓存。
   如需上游零出站外部复核，启动时显式配置可计数的隔离 HTTP 上游。
3. GET/HEAD `/ipfs/<bundle-cid>/resources/nested/proof.txt?format=car&dag-scope=block`，
   Accept 为 `application/vnd.ipld.car;version=1;order=dfs;dups=n`。
   还可 GET `/ipfs/<bundle-cid>/worker.cjs?format=car&dag-scope=block` 取得两块证明。
4. 独立验证器必须使用上一步请求根与路径。Kubo 可将 CAR 导入独立空 repo，
   再 `ipfs resolve /ipfs/<bundle-cid>/resources/nested/proof.txt`；
   不要用需要完整文件内容 DAG 的 `ipfs cat` 判定 block-scope 失败。
   Kubo resolve 可能只解析父边，应另行确认其终点 block 在 CAR/本地 repo 中存在。
5. 对删中间块、删终点、改 bytes、替换终点和错误请求根做负例；解析 CAR 成功不代表检索成功。
   缺块演练必须在无网络的隔离 repo 中进行，不能让验证端自动补全缺失证明。
6. 根缺失和 only-if-cached、无 scope、entity/all、未知版本/dups、identity 探测、
   token/disabled、暂停接收及传输中缺块按 Deployment 合同独立复核。结束后停止专用 Server/Kubo，
   清除本轮自有配置、data-dir 与载荷，保留精简请求/headers/hash/退出结果即可。

CLI README 给出 curl 命令。实现侧 fixture 和断流注入位置在
`packages/task-engine-cli/test/car-gateway.test.ts`，受管宿主路径在
`packages/task-engine-cli/test/managed.test.ts` 的 `two independent` 测试。
