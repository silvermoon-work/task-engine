# 局部 CAR 与协商 RC 验收

## 身份与复核边界

按用户明确的夜间自主推进/门禁委托，主 Agent 独立检查实现、重跑 17 个 CAR/raw 聚焦测试与 `pnpm check`，均通过后接受实现 `c645a15209abbff874d2f484d703b65ff6227057`。本轮仅局部读取和 CAR 协商；不包含回源或 IPNS。

唯一发布包为 `@silvermoon-work/task-engine-cli@0.2.0-rc.4`，准确提交 `27d3041368239e73fef4bbde0c7626ab6b1956d5`、不可变 tag `task-engine-cli-v0.2.0-rc.4`。
[准确提交 main CI](https://github.com/silvermoon-work/task-engine/actions/runs/43063934785) 的 Node 22/24 与版本化聚合全部通过，另经 `github-ci-verify` 确认。
[Trusted Publishing](https://github.com/silvermoon-work/task-engine/actions/runs/43066629889) 成功，未本地 publish、移动 tag 或发布依赖。

Ubuntu 普通精确 SemVer 安装成功，registry tarball、安装包 manifest 与锁条目 integrity 一致：

```text
sha512-KyLtr7oDIY3LWNNWxiSygYhm2idBZzuSzb9hheg8cCUgauDzHvJCph6P5c8ejiD4FkwslglB/K7zxxEwG89TNw==
```

`rc=0.2.0-rc.4`，历史 rc.0 至 rc.3 保留；`latest=0.1.0` 与 `canary=0.2.0-canary-261111-1` 未变。首次目录传播未就绪，等待 120 秒后同一版本正常安装；未更改目标 registry 或使用工作区/tarball 替代。

## D-AC01：最小集合、独立恢复与传输收益

在指定 SSH 设备隔离 consumer 使用 Node `v24.16.0`、pnpm `11.5.1`、Kubo `0.43.1`，执行先同步的 [外部脚本](verify-range-ubuntu.mjs) 和 [公共 fixture/oracle](inner/range-proof.mjs)。固定文件由 8 个不同的 32768-byte 叶及两级文件结构构成，总长 262144 bytes；请求路径为 `R/deep/file.bin`，精确根/CID/布局见 oracle 的 manifest 和实施证据。

每个范围的实际 CID 序列恰为手工布局计算的最小集合；所有原始 bytes/multihash 验证通过。每个 CAR 分别导入一个新的空 Kubo repo，不启动 daemon、不导入完整 CAR，以 `ipfs --offline cat --offset --length` 恢复并与原始切片逐字节比较：

| case | 恢复 bytes | 必需 blocks | CAR bytes | 恢复 SHA-256 |
| --- | ---: | ---: | ---: | --- |
| cross `32749:32805` | 57 | 6 | 66219 | `fedf8cdde063f9b17712e5088ae8993827482852bfc0c119c31c0e23601b2c42` |
| branch `131059:131095` | 37 | 7 | 66449 | `c0c3c24892c7e94a7b543d6988ce9ea16a06f12d2eb5ba3f42e331f3426c4814` |
| tail `-73:*` | 73 | 5 | 33412 | `9774610059029f424fc3a08e8b0aa82c3f61ab7a520ef4dd14b04b8d98b9e2a6` |

完整文件 entity 响应为 **263291 bytes**，不是混入其他 fixture 的档案大小。尾范围仅约 12.69% 的传输量，减少约 87.31%；不是从完整 CAR 取字节切片。HEAD 无 body、ETag 与对应 GET 相同，范围命中条件请求为 304；完整文件、不同范围与 dups 变体 ETag 不混用。

## D-AC02：表示、边界及故障

- 共享图的 dfs/dups=n 实际序列为 `G,L0,L1`，65890 bytes；dups=y 为 `G,L0,L1,L0,L1`，131504 bytes。原始重复 blocks 完整输出，identity 虚拟块省略，响应 Content-Type 与实际重复策略一致。
- 加权 Accept 选择 y；query `car-dups=n` 覆盖同名 header；不支持版本明确 406，坏/重复范围明确 400。
- 根文件完全越界在输出前为 400；路径流式发现越界返回必要路径与终点的有效 CAR。非字节目录忽略范围，仅返回 entity 目录块。
- raw、default-all、完整 entity 回归通过。缺失根为 404，only-if-cached 缺失为 412。
- 删除未请求的 L0 不影响尾范围 304；删除必需 L7 后 GET body 失败、HEAD 为 404、only-if-cached 条件请求为 412，不能误报成功/304；恢复后读取正常。
- 全部相关请求的计数上游为 **0**，关闭上游后局部读取仍可用。
- 负偏移/负终点、双侧部分越界、空文件、超大整数、共享子树不同偏移、坏 proof、预算/取消/背压等其余确定性边界由主 Agent 重跑的实施测试覆盖；不冒充全部远程压力演练。

## 清理与复现

自有 Engine 停止成功，独立连接确认 listener 关闭；Kubo 全程使用专用离线空仓库，未启动 daemon。保存简洁机器报告与 registry audit 后，删除本轮精确临时 consumer，包含 HOME/config、安装包、tarball、Kubo repos、CAR、源文件和恢复切片；随后确认目录不存在。共享环境未改变。

新建隔离 consumer，普通安装以下依赖，将 `inner/range-proof.mjs` 与 `verify-range-ubuntu.mjs` 复制到同一目录，执行 `node verify-range-ubuntu.mjs`。脚本拒绝复用专用 HOME；结束后精确清理本轮目录。

```json
{
  "name": "task-engine-range-rc4-verification",
  "private": true,
  "type": "module",
  "dependencies": {
    "@silvermoon-work/task-engine-cli": "0.2.0-rc.4",
    "@ipld/car": "5.4.6",
    "@ipld/dag-pb": "4.2.0",
    "@ipld/dag-cbor": "10.0.2",
    "ipfs-unixfs": "13.1.2",
    "multiformats": "14.0.5"
  }
}
```
