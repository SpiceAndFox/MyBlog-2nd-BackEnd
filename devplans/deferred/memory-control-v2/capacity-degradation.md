# 容量降级策略（延后）

## 问题

当前容量策略中，compaction 失败（`unable_to_compact` 或 `replay_failed`）后永久 halt 对应 target。对于长线情感聊天，`userProfile`/`relationship` 等 section 的 item 只增不减、互不重叠是常态而非边缘情况；容量迟早耗尽后，target 进入 halt 且 resume 只会重复同一结果，这不是边缘故障而是必然终局。

## 当前临时方案

compaction/replay 失败后 halt 对应 target，由运维手动调整容量配置后 resume。此方案用于在计划前期通过足够次数的 debug 判断容量的合适大小。

## 延后原因

自动降级策略需要回答以下问题，当前引入会显著提高系统复杂度，不适合在本轮进行：

- compaction 失败后是否只拒绝本次容量增长 patch、推进 cursor、保留 raw/RAG 覆盖？
- 降级状态下是否引入新的 per-target status（如 `capacity_warning`）而非 `halted`？
- 降级期间是否持续给出容量告警，告警语义如何与现有 degraded 映射？
- 降级后已有 item 是否仍可 update/forget/merge？
- 容量恢复后（运维扩容或 item 自然减少）如何自动从降级回到正常？

## 未来方向

待真实运行数据确定合适容量默认值后，再引入自动降级策略。可能的方向：

- compaction 失败后只拒绝本次容量增长 patch、推进 cursor、保留 raw/RAG，并持续给出容量告警；
- 或建立明确的人工扩容/归档操作，resume 前必须验证容量已经实际释放。

## 重新评估条件

- 已通过足够次数的真实运行确定各 section 的合适容量默认值；
- 出现 target 因容量耗尽而 halt 的实际案例，且手动调整成本不可接受；
- 降级策略的复杂度收益比已明确。
