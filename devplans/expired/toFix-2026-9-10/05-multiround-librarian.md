# 子任务 05：多轮 Librarian 远期构想

## 状态

- 定位：Future / 暂不实施
- 当前不是完整性修复的前置，也不预先设计数据库字段或状态机
- 启用条件：单轮 Librarian 的真实样本 eval 证明存在稳定、重要且无法通过 prompt、输入或操作收敛解决的质量缺口

## 保留的构想

复杂维护未来可以拆成：

1. 审计：找出疑似分类、复合、重复和 evidence 问题；
2. 复核：质疑审计结果，选择 noop 或处理计划；
3. 执行：输出严格 structured operations。

这只是候选交互模式，不代表三轮一定优于单轮，也不保证模型自我质疑会提高正确率。

## 当前基线

先实现并评估：

```text
确定性异常指标 + 固定 Memory/evidence 输入
  -> 单轮 structured proposal
  -> 机械校验
  -> 原子提交或 noop
```

单轮基线只复用现有 task lifecycle，不增加新的 durable stages。

## 可能的最小升级

如果 eval 表明 `split | merge | remove` 风险明显高于 `move | revise | correct`，可以只对这些高风险操作增加一次复核，而不是让所有任务固定运行三轮。

只有条件式双轮仍无法解决问题时，才重新评估完整三轮。

## 评估指标

- 分类、原子性、信息保留和 evidence 选择质量；
- noop 准确率；
- 错误 split、merge 或 remove 数量；
- 每个 task 的调用数、token、延迟和失败率；
- revision churn 下的 stale 和重复调用数量。

## 明确不做

- 不预先定义九阶段持久化状态机；
- 不永久保存完整模型思考或工作笔记；
- 不让 noop 和简单 move 固定承担多轮成本；
- 不把“多轮”本身当作正确性保证。

## 完成定义

当前完成条件只是保留构想和启用门槛。没有 eval 证据时，本任务保持 Future，不进入实现队列。
