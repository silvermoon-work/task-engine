# Implementation

以已接受的 [CLI Spec r14](./ideal/task-builder-cli-spec.html) 为唯一接口依据。
实现范围是 Builder、独立 CLI、直接相关测试、文档和包交付，不修改 Ideal World。
实际命令和验收映射记录于 [实现验证](./verification.md)。
用户已授权取消独立 task-bundle-car 发布单元并重新实施；此前已接受的证明不覆盖本次
依赖拓扑变化。Ideal r14、事件历史及旧失败 tag 保持不变，重新完成全部 I 项后提交新修订。
父级另授权修复阻挡发布的测试同步/资源调度：先定位重复 CI 失败，再以新实现候选重新验收；
不改业务 deadline、生产 Engine 逻辑或发布必需门禁。

## Steps

### I-S01: 落实三个命令的用户契约

对照 Spec 调整命令入口、完整可编辑模板、参数与共享结果，保留各命令独立的输入和覆盖边界。
删除旧默认 build、check、版本/业务覆盖选项及格式选项；init 固定实际 CLI/Builder
和发行配套 SDK 版本，不查远程、不安装；更新生成脚本和相关消费文档。
按父级授权将 Builder 与 CLI 候选分别准备为 `0.1.0-canary-261110-1`；
确认 registry/tag 不冲突，验证生成模板与打包依赖不会指向旧 Builder 字节，不推 tag、不发布。

### I-S02: 落实可信交付与失败边界

落实声明选取、默认路径、契约无输出及模块与 CAR 的阶段性交付规则，不把旧产物或未知状态报告为成功。
契约及求值依赖在捕获标准流的短生命周期进程执行，输出尝试即失败，保留非沙箱边界。
完整构建和内容验证先于覆盖；按单文件完整替换，最终模块/CAR 再校验，保留未选择旧文件。
观察到交付竞争、输入变化、路径链接、部分写入或清理不确定时准确失败。
独立 CAR 的输入模块与输出必须使用一致的真实路径边界；明确拒绝输入模块及其祖先
链接，避免 lexical dirname 与 realpath 产生不同模块范围。

### I-S03: 补齐契约验证与使用文档

将 Spec 场景转为可重复的验证，补齐失败、取消和重复构建覆盖，更新直接相关使用文档。

### I-S04: 按实际职责取消独立 CAR 包

Builder 拥有可遍历/可重读文件树 IO 端口，以及不加载编译器的 `./car` 生产和交付复核；
Engine CLI 使用标准 CAR/UnixFS 库组合为有界、可关闭的离线 block source，不依赖 Builder。
Task 规则复用现有 Protocol/Engine 校验，不复制整套归档实现到两个 CLI，不增加 Protocol
发布候选。迁移独立包的完整测试，移除发布 mapping、工作区/构建引用与过时模板配置，
保留不可变历史证据，并为受影响已发布 Engine CLI 准备独立未发布候选而不发布。

### I-S05: 修复回归门禁的同步与资源饥饿

用明确延迟/时序和 runner 资源证据定位固定等待及嵌套测试并发。
将恢复验证绑定到真实生命周期完成条件并保留失败期限；约束测试执行资源竞争，
保留所有原测试和业务 deadline，不用放宽断言、跳过选择或反复重跑求绿。

## Acceptance criteria

### I-AC01: 命令与结果契约一致

通过自动化测试核对三个命令的参数、模板版本、路径优先级、结果对象、标准流、退出码与帮助行为，覆盖 TTY 和非 TTY。
TTY 验证明确区分可复现 writer.isTTY 场景与子进程管道，不宣称未执行的物理终端测试。

### I-AC02: 交付与故障结果可信

通过文件快照、实际模块与 CAR 校验及故障注入，证明只交付声明选中文件、保护输入和旧输出，并准确表达部分交付、取消与不确定状态。
Builder 的 API 执行许可保持兼容；CLI 自动执行 JS/TS，JSON 不执行，Task 运行日志不受影响。
真实 CLI 子进程回归覆盖模块 junction/symlink、祖先 alias 与输出 alias：
拒绝写入、模块完整快照和目录项不变，正常外部 CAR 仍成功。

### I-AC03: 示例与回归验证可复现

为十个设计示例建立可复现验证，记录实际命令和结果；相关测试及仓库检查通过，文档不把预期示例冒充执行证据。

### I-AC04: 标准库迁移保持身份和验证强度

完整 CAR suite 与固定 CID/字节 golden 不变；验证单根、完整边界、hash/codec、
重复/缺失/不可达块、canonical import profile、Task 文件/Schema/UTF8/LF/二进制、
容量、取消、close 及真实 Engine CAR 消费。Engine CLI 完整生产依赖闭包不得包含独立 CAR 包、
Builder/Builder CLI、esbuild 或 enhanced-resolve；Builder 的懒资源/文件树行为保持，
模板、manifest、lockfile、tsconfig、release tests 及文档一致，最终 Node24 `pnpm check` 通过。

### I-AC05: 同步修复与准确提交的 CI 均有真实证据

受控延迟复现旧固定等待失败，修复后成功恢复分支必须等待任务及 Run 实际完成/回收，
uncertain 分支必须保留 cleanupUnknown 且不重启；原有身份、deadline、启动次数与终态
断言保持。正常子任务 2000ms、显式 timeout 场景 100ms、
恢复请求 1000ms 与 VirtualClock 语义不变。最小相关测试和完整 pnpm check 通过，
新准确 main push SHA 的 Node22/24 及 Release verification (v1) /
Confirm required checks succeeded 全部实际成功，才重新 submitInner。
