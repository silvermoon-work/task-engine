# 支持通过 IPFS 地址加载 Worker 模块

## 问题

当前引擎校验 bundle 后把 worker.cjs 交给 Worker eval 执行，IPFS 地址尚不能作为模块入口，现有产物的地址生成也假设本地文件。

## 结果

让引擎管理的 Worker 以 ipfs:// 地址加载已验证 bundle 的入口，具备真实内容地址并保持任务生命周期。详见 [需求说明](requirements.md) 与 [设计调研](design-research.md)。

## 边界

- 首期仅加载单文件 CJS 入口，不扩展多文件交付、跨 CID 导入或 fetch；复用宿主校验，不修改宿主全局加载行为。
- 允许最低 Node 提升至至少 22.15，优先保留 CJS API；实际最低版本必须完成验证。
- 重建产物以修正模块地址；保持 task.yaml 结构和 schema 版本，不新增旧产物识别协议或 eval 回退。

## 验收标准

- 新产物通过 IPFS 入口完成任务，模块地址语义正确，不依赖 bundle 源码临时落盘。
- 非法模块请求明确拒绝，加载错误可归因；取消和关闭不遗留工作。
- 在声明支持的 Node 版本上验证 CJS API 与任务生命周期行为。
