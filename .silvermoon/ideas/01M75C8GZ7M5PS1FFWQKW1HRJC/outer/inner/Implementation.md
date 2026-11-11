# Implementation

沿用迭代 1 固定的 ipfs/specs `3000be69497e47c399cdb719440d0809f085388b` 规范基线。
只影响 CLI 宿主，不修改 Engine 核心、版本或发布配置。能力矩阵、测试结果与安装消费者输入见
[verification.md](verification.md)。现有任务专用 CAR 输入校验不作为通用 gateway 的内容约束。

## Steps

### I-S01: 建立路径证明遍历

复用现有 `ipfs-unixfs-exporter` 的 `walkPath/exporter`，支持普通 UnixFS 目录、HAMT 目录及其必要子分片、file/raw 终点。
仅收集根、必要中间节点和终点原始 blocks，不遍历文件载荷 DAG 或兄弟节点，不跟随 symlink。
本地读取 capability 与 raw 共用，不注入任何网络读取入口；每块在输出前独立验证 CID。
路径解码一次后处理分隔符、重复斜线及 dot segments，保留 literal percent 与 Unicode 名称，不套用 bundle 白名单。

### I-S02: 输出有界 CAR 流

只支持 CARv1、`order=dfs; dups=n`、显式 `dag-scope=block` 和 GET/HEAD；
Accept 与 format、CAR 查询参数按声明优先级协商，未知变体明确拒绝。
省略 scope 不冒充 all；唯一例外为 `bafkqaaa` 标准探测。identity 虚拟块不写入数据段。
补齐 Content-Type/version、attachment、表示专属 ETag、Content-Location、IPFS URI 与条件请求；
HEAD 和 304 在响应前验证完整路径。普通 CAR roots 不作为客户端信任锚。

### I-S03: 覆盖流式错误并记录能力

根缺失在响应开始前返回 404/only-if-cached 412；开始输出后缺失或损坏子块则销毁传输，不正常结束部分证明。
共用既有访问策略、并发、每块 bytes 和总时限；新增累计读取/输出 bytes 与 block 次数预算。
CarWriter 单生产者配合 socket drain 背压；中断后排空当前有限 writer 消息以解除 put/close 等待，停止后续读取。
更新 CLI README 和证据，运行 CAR/raw、受管双节点回归及 `pnpm check`。

## Acceptance criteria

### I-AC01: 证明不依赖服务端信任

独立 `CarReader` 与不调用服务端遍历函数的 dag-pb 命名边验证器，从调用者请求根验证多层路径和终点；
改写 CAR roots 不改变正确根的验证结果，错误请求根、删除中间块/终点、替换终点或篡改 bytes 均失败。
HAMT 测试覆盖实际子分片、逐块原始 bytes、精确所需集合及非路径读取拒绝；外部独立 Kubo 验证属于父级部署门禁。

### I-AC02: 表示契约准确

测试 Accept 权重/排除/参数、format 与查询覆盖、显式 scope、HEAD/304/412、探测、identity、
URL 编码与不支持变体；省略 scope 不返回冒充默认 all 的 block 子集。
多块文件的载荷叶子和兄弟块不在本地仍可成功返回恰好根/路径/终点证明，原始 bytes 保持一致。

### I-AC03: 流式故障有界

注入根缺失、输出后缺失/损坏子块、慢读取、暂停客户端及断连；客户端识别 transport 失败，
HEAD/条件请求不把不完整证明变成成功。配置了真实计数上游的命中、缺失、only-if-cached 均零出站。
读取和完整 CAR framing 均受预算限制；暂停客户端阻止全证明预读，超时/断连/shutdown 后 slot 可回收。
相关回归及 `pnpm check` 通过，证据记录实际内存边界与不支持项，不宣称完整 gateway 兼容。
