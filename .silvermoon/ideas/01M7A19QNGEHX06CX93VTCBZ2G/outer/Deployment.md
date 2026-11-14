# Deployment

用户指定中间 iteration 及本 Idea Deployment 只做本地验收，由主 Agent 依据证据代理审批。此契约不要求或宣称 RC 发布、线上部署或发布后 Smoke；全部 iteration 完成后，另进入统一发布验证阶段。

## Steps

### D-S01: 本地消费场景验收

使用本地构建产物或隔离本地 fixture 验证三通道强引用、父子调用、混合闭包、raw/UnixFS 及普通 JSON。builtin 与隔离 Kubo 适配用例验证既有可见性归属，不操作共享服务，不向 npm 发布。

### D-S02: 本地恢复与保留验收

在本地临时数据域验证 SQLite 恢复、归档故障、迟到完成、unpin 与详情缺失；归档失败不撤销 SQLite 完成或重跑 Run。仅清理测试自建资源，不迁移真实数据，不需要 RC 或远程 Smoke 才能完成本门限。

## Acceptance criteria

### D-AC01: 本地引用消费验证通过

保存本地验证命令、退出状态和关键断言：完整归档闭包与普通数据语义正确、file/directory 流和按需树形包可用。证据明确来自本地构建，不冒充已发布 RC 消费结果。

### D-AC02: 本地归档恢复验证通过

本地恢复后业务状态、期限、幂等与消息正确，首次归档失败和后续详情丢失均不重执行，迟到任务不复活已清理记录，共享/外部 pin 不受损。只在全部 iteration 与本地验收完成后进入统一 RC/Smoke，不提前发布或宣称外部验证成功。

## 本地验收证据

实现已接受为 `implementationRevision=dfa09e299b4b`。本 Deployment 只消费本地构建与隔离 fixture，不发布 RC，不操作共享 Kubo，不把源码测试写成 registry smoke。

命令环境：Node 24.12.0，`TSX_DISABLE_CACHE=1`，隔离 Kubo 使用 `KUBO_REAL_TEST=1` 与 `C:\Users\Wei\AppData\Local\Programs\Kubo\ipfs.exe`，独立 offline daemon，不对共享节点 GC。

### D-S01 / D-AC01

- `ipfs-payload` `contract`+`payload`：17/17，三通道 JSON/ContentRef/DAG 往返，普通字符串与同形对象不误转换。
- `ipfs-tree`：6/6；plain worker 524B、显式 import 后 1877B（+1353B），未引入树形包的产物不含其运行时。
- `task-sdk`：4/4，CID 能力与锁定 Bundle，无 Space 身份。
- `task-engine-http` `run-history-archive`：1/1，`GET /runs/:id/archive` 复用 history 授权并校验闭包，未授权 403。
- 全仓 `pnpm check`（实现提交前，同一 Node）退出码 0，turbo 56/56；本轮不重复宣称已发布消费。

### D-S02 / D-AC02

- MemoryStore/isolated-kubo：8/8；SqliteStore/isolated-kubo：8/8。覆盖完整归档、I/O 失败后完成态保持、write-ahead 根不变、隔离回收后详情 `missing`、迟到 completeArchive 不复活、共享 owner pin 不受 unpin 影响、导出授权与闭包。
- SQLite backup restore：1/1，恢复后运行状态与幂等保留，缺失 IPFS 详情保持 `missing`/`not_archived`，不从 DAG 重建业务记录。
- 受控归档样例：100/1,000/10,000 条消息分别为 3/6/42 块、31154/302052/3012889B，每根 1 次 pin RPC。

无 RC、无 npm publish、无远程 Smoke。统一发布验证仍待后续独立阶段。
