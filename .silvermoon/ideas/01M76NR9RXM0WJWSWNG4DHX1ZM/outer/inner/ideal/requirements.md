# IPFS 模块加载需求

## 背景与目标

当前 [BundleCache](../../../../../../packages/task-engine/src/bundle.ts) 从调用者提供的 IPFS 客户端读取并验证 bundle，把 worker.cjs 保存为源码字符串；[引擎注册](../../../../../../packages/task-engine/src/bundle-engine.ts) 使用 ipfs://<cid>/worker.cjs 作为逻辑地址，但 [Worker 启动](../../../../../../packages/task-engine/src/type-supervisor.ts) 实际执行 new Worker(source, { eval: true })。不存在 bundle 源码临时落盘，也没有运行时 IPFS 模块解析 hook。

目标是让内容地址成为真正的模块加载地址，而非仅作为注册元数据。[设计调研](design-research.md) 记录已核实的运行时限制与用户确认的边界。首期仅替换已验证单文件 bundle 的入口加载，不把这一变更描述为通用 IPFS 模块图支持。

## 地址与模块语义

- 支持以 ipfs://<cid>/worker.cjs 加载当前已验证 bundle 的入口；CID 和路径必须经统一解析、验证与规范化，禁止凭据、非法 CID、路径穿越及编码后越界。查询与片段不得被默默丢弃；首期不支持的形式应明确拒绝。
- 入口应具有可辨识的 IPFS 模块身份，加载失败包含足以定位模块的地址上下文，但不泄漏网关凭据或宿主敏感信息。
- 首期保持 Builder 的单文件 CJS 产物形态、产物契约及依赖打包方式，不支持运行时相对模块图、ESM bundle、多文件资源执行或跨 CID 依赖。修正模块地址需要重建产物，但不因此升级产物 schema。
- Node 内置模块保留既有使用行为；支持 IPFS 地址不代表开放宿主本地模块、node_modules 或任意外部协议。实现前核对现有能力，避免无意扩大或收紧既有权限。
- IPFS 模块空间只开放当前 bundle 的规范入口；其他 IPFS 路径和 CID 明确拒绝，不能借资源路径执行代码。内置模块仍可使用；普通依赖继续由 Builder 打包。入口采用 import 还是 require 是保留 CJS 行为的技术选择，不属于作者新增的调用 API。
- 正确的模块地址要求新产物的 import.meta.url 为规范 IPFS 入口地址，不得经过 pathToFileURL 转换。__filename 与 __dirname 表示逻辑模块身份而非宿主磁盘路径；不能假定 fileURLToPath(import.meta.url)、createRequire(import.meta.url) 或 path 拼接适用于 IPFS URL。文档必须说明这一有意的地址语义变化。

## 重建与迁移边界

- 重建是为了使用修正了模块地址生成方式的 Builder 产物；说明重新构建、重新生成 CID 并重新提交的操作。不能把这项要求扩大成新增构建器版本识别、强制拒绝全部旧产物或双向版本门禁。
- 保持 task.yaml 结构、taskSchemaUri、SDK 握手和 Space 协议不变，不新增 loaderVersion 或能力标识；input/result/message schema、JSON Schema draft 和 task-build 配置版本也不因加载方式变化而升级。
- 如需提高产物最低 Node 要求，使用已有 runtime.minVersion 字段；它不是构建器版本标识。直接受影响的包声明和模板应与实际最低版本一致。
- Builder 在生成产物时确定正确地址语义，不在加载时改写已验证源码，也不篡改 Node 的全局 URL API 来兼容旧 banner。旧产物不保证自动获得修正后的 import.meta.url，不添加 eval 兼容分支。
- 外部 v1 schema 与当前实现存在差异属于既有问题，不在本次修复，也不作为本次加载变更的前置。关于未来新 schema 由本仓库维护的方向，不构成本次升级 schema 的要求。

## 获取、校验与授权

- 宿主继续在 bundle 准备阶段完成读取和校验，将当前入口的已验证源码交给 Worker 的局部加载适配；hook 不另行联网或重新下载源码。复用已有内容客户端、DAG/CID 校验、缓存、网关策略、并发与容量约束，不依赖公共网关直连。
- IPFS 加载适配仅处理当前已验证 bundle 的入口映射；CID 身份验证不等于代码执行授权。跨 CID 模块导入首期拒绝，不从资源读取权限推导模块执行权限。这是加载路径的能力边界，不代表 hook 能限制 Node 内置模块本身提供的全部能力。
- 共享内容块缓存不共享授权结论；不同 Run、Worker 和 bundle 不能借缓存命中绕过各自策略。相同 CID 在同一模块上下文中的身份应稳定。
- 与另一个 IPFS fetch idea 共享内容读取基础能力，但模块格式、模块执行授权、模块缓存语义属于本 idea；fetch 的 Response 语义不进入此处。

## 生命周期、兼容性与失败

- 使用引擎随包分发的本地 bootstrap，在 Worker 内安装 hook 后加载 IPFS 入口；本地 bootstrap 是引擎实现文件，不是 bundle 的临时物化。hook 必须在任务入口前生效，不污染宿主或其他 Worker，不描述为安全沙箱，也不为任务派生的子 Worker 承诺自动支持 IPFS。
- 保持任务输入、结果、消息、日志、取消、强制停止和资源释放语义。读取与加载受引擎/Run 生命周期约束；关闭后不得继续不受控拉取。
- 用户已允许最低 Node 提升到至少 22.15，以优先保留 CJS 行为。实施须验证同步 hook 与 CJS 入口的组合，在确定的最低版本及支持版本上覆盖 require、require.cache、require.resolve 和内置模块；不以异步 hook 的受限 CJS 行为作静默兼容回退。
- 最低版本变化应覆盖直接受影响的包声明、运行时检查、Builder/SDK 产物要求、初始化模板、CI 和文档。22.15 是同步 API 引入版本，不是本次已完整验证的支持下限；实际下限由实施兼容性验证确定并明示。
- 无效地址、未授权模块、缺失文件、不可达内容、校验失败、容量超限和取消均产生明确、可归因的失败，不回退为未校验执行、本地临时文件或隐式 eval。

## 验证场景与明确排除

成功场景覆盖重建产物入口、正确的模块地址、CJS API、内置模块及并发 Run；拒绝场景覆盖非法/编码路径、非入口资源路径、缺失或损坏内容、跨 CID、网关策略限制、容量限制及中途取消。验证同一 Worker 内入口不会重复求值，不同 Run 仍使用独立 Worker/模块状态；关闭与强制退出必须覆盖 bootstrap 和加载器拥有的工作。

本 idea 仅改变引擎模块加载及 Builder 地址生成，不改变产物协议、单文件交付及依赖打包策略；不实现任意远程依赖安装，不提供 fetch API，不引入可变 IPNS 寻址，也不要求发布 npm 包。[IPFS fetch idea](../../../../01M76NXWH50ZXJBAN92MEH2ZAQ/outer/inner/ideal/Idea.md) 可独立推进，二者复用现有 IPFS 内容能力而非相互依赖功能完成。
