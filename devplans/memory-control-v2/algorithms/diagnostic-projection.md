# 异常诊断投影（version 3）

本文定义从已提交 Memory semantic events 派生持久化告警的独立投影。它只观测事实，不参与 Reducer、source scan、boundary cycle、candidate lifecycle 或 capacity maintenance 决策。version 3 的诊断边界统一使用 `boundary_message_id + detail`；该字段不代表 writer 处理进度。

## 1. 输入、checkpoint 与边界

- 权威输入是数据库事务已经提交的 event group/events，包括 `result_revision IS NULL` 的 rejected/deferred audit group；未提交事务、task 内存结果、proposal 文本和 candidate decision 建议都不是投影事实。state mutation group 必须有 result revision，rejected-only group 不伪造 revision但仍是诊断事实。
- normal/maintenance 写入事务不得直接创建或清除本投影拥有的 diagnostic。
- 投影使用独立事务和 `chat_memory_diagnostic_projection_checkpoints`，至少保存 `(userId,presetId,projectionKey,sourceGeneration,processedEventId,status,lastErrorReason,updatedAt)`。
- checkpoint row 在投影事务中 `FOR UPDATE`；diagnostic upsert/resolve、recovery notification 和 `processedEventId` 推进原子提交。
- 投影失败不得回滚或改写已成功的 Memory task；失败原因写 checkpoint，runtime poll、startup reconciliation、retention barrier 或 context assembly 后续重试。
- Renderer/健康聚合只消费 active diagnostic，不通过 Reducer/task stage 猜测本投影的结论。

每个 event 的 source 边界按以下顺序解析：

1. event group 有 `boundary_cycle_id`：读取 immutable cycle 的 `source_boundary_message_id`；
2. maintenance/system cleanup 没有 cycle：读取关联 task 的 `source_boundary_message_id`；
3. 纯 wall-clock housekeeping 没有 raw 边界：使用当前 generation 已完成 scan 的 boundary，并在 `detail.boundarySource="housekeeping"` 标明来源。

无法证明边界时投影 fail closed、checkpoint 不推进。`boundary_message_id` 只是该 diagnostic 已观察事实的 source 截止点；它不表示任一 target 处理进度。

diagnostic 带 `source_generation`，并受同 scope/subject/type 单 active row的 partial unique index约束；并发写使用原子 upsert。generation 初始化时 resolve 所有不等于新 generation 的 active diagnostics，但这是世代失效，不创建 recovery notification，也不声称新 generation healthy。

## 2. `scene_capacity_exceeded`

投影 key 固定为 `scene_capacity_diagnostics`，按 `(user_id,preset_id)` 串行处理 `event_id > processed_event_id` 的已提交 events：

1. `target_key=scene`、`section=scene`、`decision=rejected`、`reject_reason=capacity_exceeded` 的字段 patch，将 `patch_summary.path` 加入 pending `rejectedPaths`；
2. 后续 accepted scene patch 只移除自身同一路径，不得因同 group/后续 group 的另一字段成功而误报恢复；
3. 同 event group 先聚合所有 scene decisions，再落一次终态；部分 accepted、部分 capacity rejected 时保持 active；
4. `rejectedPaths` 非空时 upsert `subject_kind=target`、`subject_key=scene`、`diagnostic_type=scene_capacity_exceeded`；为空时 resolve，并在同一事务创建 recovery notification；
5. active row 的 `boundary_message_id` 更新为本次聚合涉及的最大已证明 source boundary，同 generation 单调不减。

`detail` 至少为：

```js
{
  rejectedPaths: ["note", "location"],
  pathSources: {
    note: {
      eventGroupId,
      eventId,
      boundaryMessageId,
      sourceGeneration,
      revision
    }
  },
  lastProcessedEventGroupId,
  lastProcessedEventId,
  lastResultRevision,
  boundarySource: "cycle" | "task" | "housekeeping"
}
```

当一个 path 被 accepted 移除时同时删除其 `pathSources`。diagnostic 的 boundary 不因移除 path 倒退；恢复 notification 使用 resolve 时 active row 已达到的最大 boundary。

## 3. 幂等、乱序与 retention barrier

- 重复调用只处理 checkpoint 之后的 event；event group 内按 `event_index`，group 间按 `event_id` 稳定顺序。
- 同一 event group 的聚合、diagnostic 变更、notification 和 checkpoint推进原子提交；任何失败整体回滚。
- 错误日志使用不含完整 raw/prompt 的独立 best-effort 写入，不影响从旧 checkpoint 重放。
- recovery notification 受 `(subject,notificationType,sourceGeneration,boundaryMessageId)` 唯一约束保护，提供 best-effort once 创建语义。
- retention 删除 events 前必须锁定 checkpoint，并证明 `processed_event_id` 已越过拟删除最大 event id；否则先投影，失败即终止 retention。
- event group 关联的 cycle/task 在投影越过该 group前不得先清理，否则无法证明 `boundary_message_id`。

## 4. Privacy 与 generation reset

Privacy hard delete 必须物理删除或重建该 scope 的：

- active/resolved diagnostics；
- recovery notifications；
- diagnostic projection checkpoint 与错误 detail；
- detail 中的 eventGroup/task/cycle/source 引用。

privacy operation 未 verified 时投影不得运行。scope 保留时，在新 generation rebuild后从新 event chain 初始化 checkpoint并重新派生；不能复用旧 `processed_event_id` 或复制旧 active diagnostic。整个 scope 删除时直接清除投影数据。

普通 generation 切换只 resolve 旧 generation diagnostic、重置 checkpoint并等待新链；不把旧边界投射到新 generation。

## 5. 用户可见语义

active `scene_capacity_exceeded` 将 Memory 查询健康映射为 `degraded`，Renderer 在 `[当前状态]` 前显示 `[该类记忆可能滞后]`。响应 `memory_health.alerts` 可按集中配置防抖，说明最近一次更新因长度超限未写入；Renderer 的稳定标记不受该防抖影响。

该 diagnostic 不把 target 改成 `capacity_blocked | halted`，不创建 maintenance task，也不改变 observation-target 状态。只有后续 accepted 同 path event 经投影处理后才恢复；task 成功、cycle 完成或 scan checkpoint 推进本身都不是恢复证据。

## 6. Harness

验收至少覆盖：group 内部分接受、跨 group 同 path 恢复、boundary cycle/task/housekeeping 三种边界解析、乱序/重复投影、generation reset、retention barrier 和 privacy hard delete。详见 [Harness 验收契约](../harness.md)。
