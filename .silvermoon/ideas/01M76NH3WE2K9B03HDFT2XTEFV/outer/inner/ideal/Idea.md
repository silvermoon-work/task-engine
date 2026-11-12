# 以 SpaceRef 调用子任务并固定依赖闭包

## 问题

任务调用目前要求作者同时维护子 bundle 的 CID 与父目录路径，静态依赖也缺少明确的闭包准备承诺。

## 结果

静态子任务以 CID 链接纳入父 bundle 的 Merkle DAG，共享相同内容块并支持一次准备完整依赖闭包。Context 启动子任务只接受 SpaceRef；已知 CID 时先创建 Space，由 Engine 解析并固定执行身份。

task.build.yaml 以 imports: Record<Path, CID> 引入文件或目录，不限于任务。build 获取完整静态闭包并交付自包含 task folder，car 离线打包并核对引入 CID。Builder 与 Engine 共用内容机制和独立公共默认配置，允许分别覆盖。

设计取舍、调用示例与语义边界见[讨论细节](./dependency-and-invocation.md)。

## 边界

- 不设置子任务启动授权关口；权限约束位于具体资源访问，保留独立执行、校验和预算边界，不扩展通用 Node.js 权限系统。
- 外部静态 Space 属于动态依赖，不承诺随父 bundle 预备完成；首版拒绝可写 output 引用。
- 内容寻址复用不等于零传输、零内存或永久可用；准备须有界验证并保留所需内容。共享内容存储不强制共享客户端实例或 Engine 运行数据库。

## 验收标准

- 父 bundle 内子树及外部 CID 均通过 SpaceRef 调用，不再暴露 CID 与路径双参数。
- 完整准备后的静态依赖闭包可在来源离线时执行，缺块或超限明确失败。
- 调用身份固定为解析后的 CID，重试不漂移；可写空间引用拒绝，import 修改或缺块明确失败，完整准备不降级为懒加载。
