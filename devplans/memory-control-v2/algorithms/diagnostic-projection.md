# 异常诊断投影

本文定义从已提交 Memory semantic event 派生持久化告警的独立投影。该投影只观测事实，不参与 Reducer 决策、normal task 提交或 capacity maintenance 状态机。

## 1. 输入与边界

- 权威输入是 `result_revision IS NOT NULL` 的已提交 event group 及其 events；未提交事务和内存中的 Reducer 返回值不是投影来源。
- normal/maintenance 写入事务不得直接创建或清除本投影拥有的 diagnostic。
- 投影使用独立事务和 `chat_memory_diagnostic_projection_checkpoints`。投影失败不得回滚、降级或改写已经成功的 Memory task；失败原因写入 checkpoint，后续 runtime poll、startup reconciliation 或 context assembly 重试。
- Renderer 和健康聚合只消费 active diagnostic，不读取 reducer/task 内部状态猜测告警。
- diagnostic 写入携带 `source_generation`，并受“同 scope/subject/type 仅一条 active row”的 partial unique index 约束；并发创建必须走原子 upsert，不能先 select 再 insert。
- generation 初始化时 resolve 所有非空且不等于新 generation 的 active diagnostics。它们是旧 source 世代失效，不代表新世代已经追平，因此不创建 recovery notification。

## 2. `scene_capacity_exceeded`

投影 key 固定为 `scene_capacity_diagnostics`，按 `(user_id, preset_id)` 串行处理 `id > processed_event_id` 的已提交 events：

1. `target_key=scene`、`section=scene`、`decision=rejected`、`reject_reason=capacity_exceeded` 的字段 patch，把 `patch_summary.path` 加入 active diagnostic 的 `detail.rejectedPaths`。
2. 后续 accepted scene patch 只移除与自身 `patch_summary.path` 相同的 pending path；不得因同 bundle 或后续 bundle 中另一个 scene 字段成功而误报恢复。
3. `rejectedPaths` 非空时 upsert `target + scene + scene_capacity_exceeded`；为空时 resolve diagnostic，并在同一投影事务中创建 recovery notification。
4. 同一 event group 内先聚合全部 scene decisions 再落 diagnostic 终态，因此部分 accepted、部分 capacity rejected 时告警保持 active。
5. diagnostic 的 `target_cursor` 记录最近处理 group 的 `cursor_after`；`detail` 记录 rejected paths、来源 event group、generation 和 revision，供开发/运维定位。

## 3. 幂等与失败

- checkpoint row 在投影事务中 `FOR UPDATE`；diagnostic 更新、恢复通知和 `processed_event_id` 推进原子提交。
- 重复调用只处理 checkpoint 之后的 event；恢复通知仍受自身唯一约束保护。
- 任一步失败时投影事务整体回滚，checkpoint 不推进。错误记录使用独立 best-effort 事务，不影响下一次从旧 checkpoint 重放。
- Privacy hard delete 必须同时删除 diagnostic、notification 和 diagnostic projection checkpoint。

## 4. 用户可见语义

active `scene_capacity_exceeded` 将 Memory 健康状态映射为 `degraded`，Renderer 在 `[当前状态]` 前显示 `[该类记忆可能滞后]`。响应 `memory_health.alerts` 遵循集中配置的 `alertDebounceMs`，通过防抖后说明最近一次更新因长度超限未写入；Renderer 标记本身不受该 health-alert 防抖影响。它不把 target 改成 `capacity_blocked/halted`，也不创建 maintenance task。
