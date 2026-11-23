# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 补齐范围遍历语义
- [x] **I-S02:** 支持复杂 DAG 并限制资源
- [x] **I-S03:** 建立范围回归与支持矩阵

### Implementation acceptance criteria

- [x] **I-AC01:** 三种 scope 集合准确
- [x] **I-AC02:** 复杂结构和 codec 可验证
- [x] **I-AC03:** 缺块和预算不会隐瞒失败

## Deployment

### Deployment steps

- [x] **D-S01:** 部署已知完整与不完整数据集
- [x] **D-S02:** 执行独立客户端恢复与枚举

### Deployment acceptance criteria

- [x] **D-AC01:** 真实客户端获取正确范围
- [x] **D-AC02:** 不完整缓存不被冒充完整
