# 需求与不可退化边界

本文记录用户已确认的目标；具体接口候选见[协议候选](protocol-candidate.md)，尚未确认部分见
[待决策项](decisions.md)。Task 与 Renderer 是公共格式的使用方式，不是公共层封闭的两个分支。

## R-01: 公共数据与宿主边界

- 保留 `name`、`runtime`、`entry`、`include`、`binary`、单数 `import`、开放结构化 JSON `metadata`。
- runtime 与交互协议独立。Node 不等于 Task，Browser 不等于 Renderer。
  宿主分别验证环境、模块形式、协议标识/版本及所需能力，拒绝不支持的组合后才可加载 JS。
- Task 三种 schema 移入 metadata；共享 schema、离线 `$ref`、typed ContentRef、
  build-locked binding 等现有表现力不能丢失。
- Renderer 协议、样式声明及其引用也属于 metadata。公共层只验证 JSON、封装及公共路径约束，
  不解释 Task schema 或 Renderer 的 mount/update/destroy。
- JS 依赖自包含；Node 内建模块是显式运行环境能力，不是偷偷保留的第三方依赖。
  Browser 不允许未声明的 Node API 或运行时网络依赖。

## R-02: 构建输入不等于产物

- 统一公共 build 支持源码入口、glob、来源到目标映射；专用 build 可先从可信契约源码生成
  schema/binding 或校验 Renderer 入口，但不重写文件选择、归一、import 或 CAR。
- 产物只含已构建入口、确定文件集合、准确引用及运行 metadata；不保留 glob、源码位置、
  outDirectory 等纯构建信息。
- 输入支持磁盘、内存 mock 和虚拟只读树。包由 include、生成规则及 import 定义，
  不能用任意磁盘扫描代替声明。未匹配文件不能进入产物；必需文件缺失必须失败。
- 现有 include 能映射任意受支持文本/二进制，也能选择完整子 Task 树，不是 assets 扩展名清单。

## R-03: 字节与身份

- binary 在确定的输出文件范围构建时 resolve；匹配文件原字节保留。
  其余自有文件全部按文本处理，非法 UTF-8 明确失败，不做二进制猜测。
- 固定版本化文本规则，在 CID 编码前应用；跨平台不能隐式改字节。
  BOM、末尾换行、Unicode 策略需明确，不能把建议写成用户既定结论。
- 已 import 的内容始终不归一、不按父包规则重编码，保持原始 CID 与 DAG 身份。
- 标准 CAR 携带单一运行根所需的完整可达块集；根 CID 和 CAR 文件字节稳定性分别证明。

## R-04: 不可变依赖

- import 表示逻辑位置到固定 CID，保留普通 UnixFS 文件、目录和子 Task 的现有能力。
  本地已有即可离线构建，只有明确配置的来源才可获取缺块。
- 逐块校验准确 CID、哈希和完整递归闭包；缺块、错误 CID、冲突、未知 codec 或预算耗尽均失败，
  不尝试未授权来源。共享子图块去重，嵌套 import 沿真实 DAG 递归。
- CID 字符串只是声明；必须存在从最终根可达的真实 IPLD link，不能留给消费者运行时下载。
- 复用共享 IpfsStore 配置、读取、scope、预算及所有权；不另造客户端，不关闭借用源。
  build/CAR 编码不是 upload/publish/pin 授权，不操作共享 daemon。

## R-05: 迁移与验证

- 允许 breaking change，不要求双格式兼容，不重写历史 CAR/CID。
  重建任务和父依赖，替换准确 CID；不支持的旧格式及协议明确拒绝。
- 保留参数/结果/消息、日志、资源读写、typed 内容、子调用、取消、退出及清理证明。
  Node Worker 和浏览器资源访问由对应宿主实现，不能以同名 API 假定等价。
- 同一公共层交付并验证 Task 与浏览器 JS/CSS/assets 两个样例；内存/磁盘等价、glob、
  归一、原 CID 闭包、预算/失败、Windows/Linux、根/CAR 双重确定性都需证据。
- 同步更新相关文档、模板、CLI、工具链和测试，保留 pnpm check 全部门限。
  不包含 npm 发布、release tag 或远端制品上传。证明方法见[验证矩阵](migration-validation.md)。
