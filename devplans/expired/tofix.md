# 后续修复

## 重建时序

- 修复 `forceDrainTo` 按 target 一次性跑完整段历史的问题，改为按 source watermark 分波次/轮转推进各 target。
- 每个波次冻结同一份基线；任何 Proposer 都不得读取超过自身 `targetMessageId` 的派生 Memory，消除“未来记忆”泄漏和 target 顺序偏差。
- Provider 计算可以并行；提交必须保持原子或确定性串行，继续满足 revision、ref、retry 和幂等约束，禁止部分波次写入。
- Profile 内部三个专家使用同一 immutable artifact 并行计算，全部校验成功后仍合并为一次 `profileRelationship` 提交。

## 验证

- 增加不同 lag/context 配置下的波次对齐、无未来泄漏、崩溃恢复、schema retry 和顺序无关测试。
- 修复后重新构建 `user_id=1 / preset_id=default`；generation 5 只代表技术完成，不作为语义验收基线。
- 验收 Profile 是否完整保留具体沟通边界，并确认 Relationship 只压缩“过去阶段—转折—当前状态”，不含消息编号、事件流水或未经确认的角色重启推断。
