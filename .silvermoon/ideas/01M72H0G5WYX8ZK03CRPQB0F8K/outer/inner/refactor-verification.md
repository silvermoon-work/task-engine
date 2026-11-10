# CAR 职责迁移验证

## 当前实现与不变边界

用户授权取消独立 `task-bundle-car` 发布单元；没有用另一新包替代，也没有删除校验。
原始 r14 仍为 43438 字节，SHA256
`0B05BF985DB364C0ED7BED8DB42FC537BB5F2169732F647C1A7BA77F6CE67EAE`。
没有修改 Ideal World、其他 Idea、Protocol 或 Engine core。
父级添加的 Actions-only / Trusted Publisher 发布规则原样保留，只补充删除包时更新 mapping。

| 落点 | 责任与证据 |
| --- | --- |
| [Builder tree](../../../../../packages/task-builder/src/tree.ts) | 原文件树端口和流工具迁回其实际所有者。编译解析仍可 list/read、反复读取与解析依赖；未用单次 importer 迭代取代编译 IO。 |
| [Builder car](../../../../../packages/task-builder/src/car.ts) | 原有标准 `@ipld/car`、UnixFS importer/exporter、multiformats 组合及有界暂存迁回 `./car`，保留生产和真实交付字节复核 API。没有自创 codec，也不加载 esbuild。 |
| [Engine CLI car](../../../../../packages/task-engine-cli/src/car.ts) | 标准 CarBlockIterator + MemoryBlockstore 读取离线 CAR，校验 hash/codec/根 DAG，再以 exporter/importer 校验 canonical 文件树。只暴露 cid、block.get、close 和容量观测；不引入 Builder 文件树、编码器或大套归档 API。 |
| [既有 Protocol](../../../../../packages/task-protocol/src/bundle.ts) | 两端都复用既有 `readTaskBundle`、路径和容量规则，验证 Task 精确 include、Worker、Schema 闭包、UTF8/LF/二进制；没有复制 Schema 实现或增加 Protocol 发布版本。 |
| [Engine CLI 接线](../../../../../packages/task-engine-cli/src/index.ts) | `--car` 使用内部只读块源，再调用既有 runBundle/Engine；Engine core API、行为及版本不变，损坏归档仍在 Worker 启动前拒绝。 |

Engine 的适配器不是把原 488 行整个复制到另一包：没有归档生产、作者文件树、tree
返回值或声明/Schema 解析实现。Task 校验期间最多保留协议 bytes 上限内的临时文件快照，
校验后释放；块存储另受 retainedBytes/maxBlocks/maxBlockBytes 约束，close 清空持有状态。
MemoryBlockstore 按 multihash 存储，适配器额外记录精确 CID/codec，不能借相同 hash
的另一 codec 隐式补出未声明的块。标准 CAR reader 本身不校验 hash，适配器明确补齐。

独立包的全部 7 个 tracked 文件移除/迁移；确认仅剩其生成的 dist/cache/node_modules
与空 src/test 后清除该退役目录。没有修改无关文件。发布 mapping 现为九个库，
release tests 明确拒绝旧 CAR package ID；tsconfig、lockfile、消费者 imports 和模板
release-age 排除项一致，不残留运行时 workspace CAR 引用。

## I-S01～I-S04 / I-AC01～I-AC04 的实际验证

2026-11-10，Windows，现有 Node v24.12.0、pnpm11.22.0。manifest 改动后先确认 npm/pnpm
有效 registry 都为 `https://mirrors.cloud.tencent.com/npm/`，再执行 `pnpm install`；
使用既有 catalog 版本，没有回退官方源或引入新测试工具。

```powershell
pnpm --filter @silvermoon-work/task-builder-cli... --filter @silvermoon-work/task-engine-cli... build
pnpm --filter @silvermoon-work/task-builder exec tsx --test test\car.test.ts
pnpm --filter @silvermoon-work/task-engine-cli exec tsx --test test\car.test.ts test\dependencies.test.ts
pnpm --filter @silvermoon-work/task-builder --filter @silvermoon-work/task-builder-cli --filter @silvermoon-work/task-engine-cli test
pnpm check
```

实际结果：

- Builder **49/49**：迁回的原 CAR suite **9/9** 完整保留，不把旧 re-export 身份测试
  当成归档正确性。文件树、懒资源、读一次、流式规范化、JS/TS 契约禁输出、取消清理均通过。
- Builder CLI **19/19**：十个 r14 实例、精确模板版本、TTY/pipe 结构、旧输出保护、
  部分交付与不确定清理，以及父级 junction/祖先 alias 回归全部复验。
- Engine CLI **26/26**：原有真实进程 CAR/多层 Task/资源/拒绝策略/timeout/signal/回收
  集成通过；新增双消费者验证矩阵与完整安装生产依赖图检查通过。
- `pnpm check` 成功：format、release lint/test、Turborepo **40/40**、
  测试类型检查、各包 publint。40 而非旧 44 是退役一个 workspace 的四项任务，不是跳过校验。
  全部受影响 suite 无跳过、取消或失败；私有 app 仍只有既有 publint 建议。

### 不变的字节与 CID golden

[Builder CAR suite](../../../../../packages/task-builder/test/car.test.ts) 与
[双消费者矩阵](../../../../../packages/task-engine-cli/test/car.test.ts) 都实际验证：

```text
CID:    bafybeiaqaprnovrabnvimctr7rn5jxkpxyv2jlqrb3sfa5gajbtp7idhwe
长度:   896 bytes
SHA256: a1ab6d9ddebbc06528f55b27524c595b7d535631430ee3451813593daf8b3f6a
```

保留插入顺序无关、二进制 600,000 字节跨块内容与 input lifetime 隔离。
两端共同拒绝：错误 expected CID、损坏 hash、截断/尾随边界、CAR version、
零/多个 roots、重复/缺失/不可达额外块、不支持的 codec/hash、非 canonical rawLeaves、
131072 非标准 chunk 与 balanced 2 非标准布局。固定 profile 仍为 CIDv1/rawLeaves/
wrap directory/262144 chunk/balanced174。
两端共同拒绝缺 Worker、空 Worker、未声明文件、Schema 引用缺失、不安全路径、
CRLF、无效/不完整 UTF8；明确 binary 资源仍原字节通过。
容量 exact 成功、低一字节失败，以及块数/块大小/retention/文件/路径容量均验证；
挂起输入取消关闭 reader，超大 upstream chunk 在复制前拒绝，close 后读取失败且保留字节归零。

### 生产依赖与实际 pack

[完整安装闭包测试](../../../../../packages/task-engine-cli/test/dependencies.test.ts)
递归解析 runtime/optional/peer 依赖，断言无 Builder、Builder CLI、esbuild、
`@esbuild/*`、enhanced-resolve、typescript 和独立 CAR 包，不只是检查顶层 manifest。
另外实际对三个受影响包禁用 lifecycle pack，并读取 tarball 内的 package.json：

| 包 | candidate version | 实际 packed runtime 依赖 |
| --- | --- | --- |
| Builder | `0.1.0-canary-261110-1` | 现有 Protocol `261109-2` 与 catalog 的标准 IPFS/CAR 库、编译依赖；无独立 CAR 包 |
| Builder CLI | `0.1.0-canary-261110-1` | 新 Builder `261110-1`、既有 Protocol `261109-2`、commander/yaml；无独立 CAR 包 |
| Engine CLI | `0.1.0-canary-261110-2` | 既有 Engine `261109-3`、Protocol `261109-2`、标准 IPFS/CAR 库；无作者/编译依赖 |

Engine CLI 原 `261110-1` 已发布；准备前 Tencent registry 只列出该旧 Canary，
远程 `task-engine-cli-v0.1.0-canary-261110-2` tag 不存在，所以选择未占用的独立候选 2。
没有新增 Protocol/Engine/SDK 候选或改其代码/manifest。
额外通过设备 Tencent registry 查询精确已发布 Engine `0.1.0-canary-261109-3` 的
name/version/dependencies 与 Protocol `0.1.0-canary-261109-2` 的 name/version，均成功；
该已发布 Engine 的 runtime 仅依赖现有标准 IPFS 库、semver 和 Protocol 2，
没有 Builder 或已取消 CAR 包，因此新 Engine CLI 不依赖未发布的新 Engine/Protocol 字节。
本地 pack 仅验证候选依赖，不是 registry 独立安装或发布证据；tarball 检查后清理。

## 发布边界与后续

本轮未推任何 release tag、未执行任何 publish、未重试旧 CAR workflow。
旧 CAR tag 仍准确指向 `88450166b49b5eddbd5f0c8df3e89ba7ec6afa59`。
新的依赖链不再需要首次 CAR 包身份/Trusted Publisher；后续只按父级明确审批逐包发布
Builder、Builder CLI，并从 registry 独立安装新 CLI 做真实闭环。
Engine CLI 候选 2 的发布另行审批，不是完成 Builder 部署的隐式前置。
历史 Outer 失败保留，D 项全部未完成，不把源代码或 pack 验证当作新部署成功。
