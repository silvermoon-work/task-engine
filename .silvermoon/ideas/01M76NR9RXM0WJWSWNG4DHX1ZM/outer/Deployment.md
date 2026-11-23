# Deployment

## Steps

### D-S01: 逐包发布已批准 RC

按父 agent 已批准顺序发布 Builder `0.2.0-rc.1`、Builder CLI `0.2.0-rc.1`、Engine `0.2.0-rc.1`、Engine CLI `0.2.0-rc.9`。只更新这四个版本，保持 workspace:*，不发布独立 Server 或其他依赖。每包发布前复核版本未占用、全部内部依赖精确版本可见；只对 main 可达且精确 main CI 成功的提交逐一推送单包 tag，使用现有 Trusted Publishing workflow。保留 latest 和历史版本，遇版本冲突或认证阻碍停止并报告，不自行换号、移动 tag 或本地发布。

### D-S02: 验证独立 registry 安装与真实 IPFS 执行

先只读查看 Ubuntu 的 Node/npm、磁盘及已有 registry 配置，再在本操作独立目录安装四包精确 registry RC，作者工具与运行消费环境分开。使用新版 Builder 生成真实 bundle/CAR，以真实内容客户端和本地 HTTP Gateway 执行，记录包安装来源、CID、模块 URL、CJS、结果、日志、Run 隔离与宿主本地加载行为。不得使用 workspace dist，不覆盖全局工具、服务、项目或修改远端 registry。

### D-S03: 验证故障与物理退出

在同一消费环境演练非入口、跨 CID、非法地址、内容不可达及校验失败，以及合作取消、强制停止和关闭。记录可观察错误、物理退出与清理边界，不把退出伪称为任意副作用已清理。保存可重放证据后同步 primary，再提交精确 outer revision；详细步骤见 [部署计划](deployment-plan.md)。

## Acceptance criteria

### D-AC01: 四包发布身份与依赖可验证

四个独立 workflow 均成功，记录 tag、main/CI commit、精确版本、registry tarball/integrity；registry 查询和 Ubuntu lockfile/安装图证明实际消费这些 RC，latest 与发布前基线一致，Engine 运行时安装闭包不含 Builder。现有 workflow 对选定包 pack 一次、验证并发布同一 tarball，不批量发布。

### D-AC02: 真实消费结果与模块语义成立

Ubuntu 真实 Gateway/内容客户端执行新版构建物，返回预期结果、日志与 CJS 行为，import.meta.url、__filename 和实际 CID 一致，同入口复用状态、不同 Run 隔离；宿主本地模块仍可加载，不产生 bundle 入口临时源码文件。保留命令和输出，不改变已验收 inner、产物/业务 schema 或 SDK/Space 协议。

### D-AC03: 故障边界与退出证据成立

非入口和跨 CID 请求明确拒绝，加载错误含规范模块地址且不泄漏请求凭据；内容失败、取消及关闭均对调用者可见，确认本操作 Worker/进程实际退出，没有 loader 额外拉取或自建服务器残留。缺少独立宿主清理证明时保留既有 uncertainty，不新增 eval、加载时源码改写或 bundle 临时文件回退。
