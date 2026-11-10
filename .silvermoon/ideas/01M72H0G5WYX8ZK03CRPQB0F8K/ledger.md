# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 落实三个命令的用户契约
- [x] **I-S02:** 落实可信交付与失败边界
- [x] **I-S03:** 补齐契约验证与使用文档
- [x] **I-S04:** 按实际职责取消独立 CAR 包
- [x] **I-S05:** 修复回归门禁的同步与资源饥饿

### Implementation acceptance criteria

- [x] **I-AC01:** 命令与结果契约一致
- [x] **I-AC02:** 交付与故障结果可信
- [x] **I-AC03:** 示例与回归验证可复现
- [x] **I-AC04:** 标准库迁移保持身份和验证强度
- [x] **I-AC05:** 同步修复与准确提交的 CI 均有真实证据

## Deployment

### Deployment steps

- [ ] **D-S01:** 确认外部验证候选与环境
- [ ] **D-S02:** 验证消费者交付闭环
- [x] **D-S04:** 发布并验证 Builder 候选
- [ ] **D-S05:** 发布并验证 CLI 候选

### Deployment acceptance criteria

- [ ] **D-AC01:** 独立安装可识别且可调用
- [ ] **D-AC02:** 真实消费结果符合契约
- [ ] **D-AC03:** 单包发布链真实可追溯
