# 子任务 07：Rehearsal 与评估

2026-09-09：离线与合成 API 验收已完成，结果见 [08-implementation.md](./08-implementation.md)。以下真实 task 清单保留为后续只读抽样参考；本次未运行全量数据库 rehearsal。后续优先 default 小范围样本。

## 状态与环境假设

本系统尚未上线，当前阶段只验证目标设计：

- 不维护旧 schema 兼容；
- 不设计数据库 migration 或 backfill；
- 测试数据库和 Memory state 可以按目标 schema 重建；
- 真实 task 只作为只读 shadow/rehearsal 输入，CI 使用脱敏样本。

## 分阶段验证

### P0：写入动作与机械防线

- 用 `append / revise / correct` 取代普通文本 item 的通用 `update`；
- 验证每个 section 只接受声明的 action；
- 验证 recent episode append 使用确定性 ` → ` 拼接；
- 验证 Profile、WorldFact、Relationship 不允许 append；
- 验证字符、容量、ref、revision 和 atomic failure；
- 输出 action、长度、来源数量和机械拒绝 reason。

### P1：Provenance 与 legacy 调度

- append 对当前 evidence 做有意义的并集；
- revise/correct 替换当前 evidence；
- event log 保留完整 lineage；
- turn-less rebuild 使用确定性 `message_batch` 水位；
- periodic 和 final Librarian 均可恢复、去重。

### P2：Librarian 操作模型

- 验证 move、revise、correct、同 section split 和 merge；
- split/merge 只能选择 task 授权 evidence；
- 首期 remove 只允许带 keeper 的 duplicate；
- 所有操作生成可解释 audit event。

### Future：只评估，不默认实施

- 单轮 Librarian 建立质量和成本基线；
- 只有高风险操作评估失败时才尝试条件式双轮；
- 完整三轮和 Episode/Milestone 分离分别作独立实验。

## 评估方法

每个样本输出逐 section before/after diff，并把结果分成三类：

### 机械正确性

必须由测试完全保证：

- action/section 组合；
- target 和 evidence 授权；
- append 拼接结果；
- 长度与容量；
- revision、retry、replay 和事务原子性。

### 模型质量

通过人工标注和 eval 衡量，不宣称确定性保证：

- section 分类；
- target 选择；
- 是否属于同一互动弧；
- revise 与 correct 的选择；
- split/merge 的信息保留；
- milestone 长期意义。

### 运维表现

- noop 和 unable-to-decide 比例；
- schema repair、截断和 provider retry；
- stale 与重复调用数量；
- item 长度和 evidence 数量分布。

真实 `task_payload`、Memory 和消息正文不得提交为 fixture；CI 使用保持相同结构和边界条件的脱敏样本。

## Lina-Weil 真实 task 样本

以下 task 的 base snapshot 当前均存在，适合本地只读 shadow 或隔离测试数据库 rehearsal。ID 失效时更新清单，不影响验收场景定义。

### WorldFact 膨胀与 provenance

- `b9ed9f8c-fb13-4cc6-8211-bab62f77a6b4`
- `e2494be1-2c94-48a1-b8a8-dedf4c00af75`
- `b81cbb7b-f295-4e74-845e-77e235dfc5fe`
- `889ba771-a7a8-4068-a800-43afdfa98522`

覆盖初始误写、异常增长，以及文本缩短但 `sourceRefs` 继续增加。

### Capacity 与恢复链

- parent：`6e319539-deaa-47e1-9ae4-142b92703aef`
- maintenance child：`dc8f588d-77df-4fb6-9950-fae5f06473ce`
- maintenance child：`3e15fdcc-11dd-481c-8973-0b1a930f1e4f`

覆盖 capacity deferred、连续 `unable_to_compact`、resume epoch、最终提交和幂等。

### 当前复合中断

- task：`fea52da1-55f8-4984-b04a-a88495b10538`
- child：`93df26ec-b742-42e6-af93-776d920124ca`
- 相同 base revision pending：`a5efaeed-690d-4fb5-ae8d-9fa67624d9cc`
- 相同 base revision pending：`4f4e3fdc-d675-41b0-949a-22e3f49825a0`
- 相同 base revision pending：`546c651b-8691-422e-8e41-ed45103a7ca3`

覆盖 halted target、持久化 compiled proposal、重启不重复调用 Provider 和 wave 原子恢复。

### Stale wave

- `a950afbe-a0a0-438a-9653-6bcd45334733`
- `14a4b7be-93fa-43c9-820e-d65bfc6d6432`
- `44f80a38-21fc-4c15-9ff0-e35b47eccff6`

作为同一 cohort 验证 `wave_baseline_mismatch` 后整波取消与重建。

### Episode/Milestone 分离

- 明确转折：`51c6159c-e013-4526-9b81-48b3b68e295b`
- 边界争议：`270d4338-6e12-4de5-89f4-88381457e600`
- 强情绪但保持 milestone noop：`2e71da55-4c9a-4adc-b549-05929f6510a0`

### Schema repair 补充样本

- `6d520767-d9a0-40d1-910a-640d8fda5084`

覆盖两次 schema-invalid repair、跨 section 混合结果和最终 commit。

## 总回归清单

- 普通文本 item 不再使用含糊的通用 update；
- append 不能覆盖旧文本，且仅用于声明为演进记录的 section；
- revise/correct 不继承无关历史 evidence；
- turn-less rebuild 可周期运行 Librarian；
- revision 变化后不会使用旧 ref 提交；
- 同 section 复合 item 可以拆分；
- split/merge 只使用授权 evidence；
- event replay 精确恢复目标 state；
- 每次维护修改都有 audit event；
- 所有 section 的最短 noop 和正常 changes 测试均保留；
- 受保护 prompt JSON 示例未被无授权修改。

## 当前操作边界

文档和本地实现工作本身不授权对共享测试服务器执行写操作、运行远端 Librarian 或中断正在执行的 rebuild。需要远端 rehearsal 时再单独确认具体范围。
