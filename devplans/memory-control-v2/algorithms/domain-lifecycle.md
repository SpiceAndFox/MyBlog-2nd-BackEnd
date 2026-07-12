# 领域生命周期算法

本文是 scene TTL、Todo active/overdue/revive、dueAt 日历运算、recentEpisodes 滑动窗口和请求时 effective view 的单一权威来源。字段 shape、patch op、cleanup event shape 和容量配置 shape 见 [状态契约](../state-contract.md)。

## 1. 时间输入与日历运算

Todo 的 `dueAt` 表达式为 `{ "mode": "absolute", "date": "YYYY-MM-DD" }`，或 `{ "mode": "relative", "days"?: N, "months"?: N, "years"?: N }`。relative 的三个时长字段至少出现一个，计算顺序为 `years → months → days`。

- absolute date 的 deadline 是该日期在用户时区下结束后的首个日界线（即用户时区次日 00:00）；用户时区从 preset 配置读取，默认 UTC。
- relative deadline 以本 patch `evidenceRefs` 中 messageId 最大的 evidence message 的数据库 `createdAt` 为 anchor，在 anchor 基础上按用户时区做日历运算。
- relative `months`/`years` 运算遵循日历月规则：若结果日期不存在（如 1 月 31 日 + 1 个月），取目标月的最后一天（2 月 28 日或 29 日）。
- 禁止使用 task/worker 执行时间作 anchor。
- Reducer 只负责确定性日期计算和 ISO 8601 格式化；已到期的结果仍可写入，并由同一事务或随后 housekeeping 原位标记 overdue，不能因历史回放发生在 deadline 之后而拒绝事实。

Scene/Todo housekeeping 读取同一事务捕获的 `now`。Context compiler 为同一次请求捕获一个 `requestNow`；Renderer effective view 与持久化 housekeeping 必须调用同一组纯代码 lifecycle 函数。

## 2. Scene 生命周期

Scene TTL 基于 scene 四个非 null 字段中最大的 `updatedAtMessageId` 所对应消息的数据库 `createdAt` 加配置 TTL 计算；scene 全空时不读取 anchor、不产生过期动作。

当 `now >= sceneAnchorCreatedAt + TTL`：

1. 把到期的完整 `current.scene`（含字段 provenance）写入 `current.previousScene`；
2. 令 `expiredAt = sceneAnchorCreatedAt + TTL`；
3. 把 current.scene 四个固定字段分别重置为 `{ value:null, evidenceRef:null, updatedAtMessageId:null }`；
4. 写 `system_cleanup: scene_expired`；
5. 若覆盖了非 null 的旧 `previousScene`，同一 cleanup revision/event group 还必须写 `system_cleanup: expired_scene_evicted`；
6. `previousScene` 是单值字段，新 scene 到期时直接替换旧值，不调用 compactionProposer，也不参与 scene 的 `maxRenderedChars` 容量门。

## 3. Todo 状态机

Todo `addItem` 必须提供 `actor` 与 `requester`，Reducer 强制初始化 `status="active"`、`becameOverdueAt=null`；Proposer 不得输出或直接修改这两个 lifecycle 字段。

Todo status × op 合法操作表：

| 当前状态 | 操作 | 结果 |
| --- | --- | --- |
| active | updateItem (keep/clear/set) | 仍 active；set 到已过期 dueAt 时由 lifecycle 归一化原位变 overdue |
| active | completeTodo / cancelTodo / expireTodo | 从数组移除 |
| active | mergeItems | 合并（需 actor/requester/dueAt 分别相同） |
| overdue | completeTodo / cancelTodo | 从数组移除 |
| overdue | updateItem + set future dueAt | 原位变回 active，清空 becameOverdueAt，写 `todo_revived_from_overdue` |
| overdue | updateItem + keep / clear / set past dueAt | 拒绝，reason=`invalid_state_transition`；overdue todo 不允许清除或保持已过期 dueAt，如需清除期限应先 complete/cancel |
| overdue | expireTodo | 拒绝，reason=`invalid_state_transition`；overdue 已过期，"自然失效"语义不适用，应使用 cancelTodo |
| overdue | mergeItems | 拒绝，reason=`invalid_state_transition` |

当 active todo 满足 `now >= dueAt`：

1. 在 `working.todos` 内原位设 `status="overdue"`；
2. 令 `becameOverdueAt=dueAt`；
3. 保留 itemId、actor、requester、dueAt 和全部 provenance；
4. 写 `system_cleanup: todo_became_overdue`；
5. 重复 housekeeping 必须 noop，不能重写首次时间。

当 overdue todo 的 `updateItem` 设置 `dueChange.mode=set` 且新 dueAt 在未来：

1. 原位设 `status="active"`；
2. 令 `becameOverdueAt=null`；
3. 保留 itemId、actor、requester、dueAt（新值）和全部 provenance；
4. 写 `system_cleanup: todo_revived_from_overdue`。

`todos.maxItems/maxRenderedChars` 只统计并约束 `status=active` 的 items。overdue items 不占 active 容量、不触发 compaction；Renderer 对 overdue 子集使用独立的 `maxRenderedItems + maxRenderedChars` 配置。Todo merge 只允许合并 `status=active` 且 `actor`、`requester`、`dueAt` 三者分别相同的 items。

## 4. Recent Episodes 滑动窗口

`recentEpisodes` 同时受 `maxItems + maxRenderedChars` 约束。Proposal apply 后超限时，Reducer 按 `createdAtMessageId`（再以 itemId 打破平局）滚出最旧 items，直到两项限制均满足，并为每个滚出项写 `system_cleanup: recent_episode_evicted`；不触发 compactionProposer。

## 5. Proposal 内归一化与后台 Housekeeping

若 lifecycle 变化由一个 proposal 的模拟 post-state 直接触发（例如新增已到 deadline 的 todo，overdue todo 设置未来 dueAt，或 recentEpisodes apply 后超窗口），对应 `system_cleanup` events 与 proposal decisions 共用该 proposal event group、revision 和完整 snapshot，保证最终 post-state 原子满足 lifecycle/容量规则。

没有 proposal 的后台 housekeeping 才创建 `group_kind=system_cleanup` 的独立 revision/group。两种路径都复用同一纯代码 lifecycle 函数；无变化不创建空 revision。

Cleanup event 使用正式 section/target 映射：

- scene cleanup：`section=scene,target_key=scene`；
- todo cleanup：`section=todos,target_key=todos`；
- episode cleanup：`section=recentEpisodes,target_key=episodes`。

System cleanup task 不拥有或推进 raw-message cursor。

## 6. 请求时 Effective View

Context compiler 捕获一次 `requestNow`，并按 current.scene 最大 `updatedAtMessageId` 读取对应消息 `createdAt` 作为 `sceneAnchorCreatedAt`，再调用纯代码 `buildEffectiveMemoryView(memoryState, lifecycleAnchors, requestNow, config)`；该函数只复制并转换运行时 view，不直接写数据库：

1. scene 已达到配置化 TTL 时，在 view 中把完整 current.scene（含 provenance）移到单值 previousScene、令 `expiredAt=sceneAnchorCreatedAt+TTL` 并清空 current.scene；因此本次请求不得继续把它称为当前状态。已有 previousScene 在 effective view 中被替换。
2. active todo 满足 `requestNow >= dueAt` 时，在 view 中原位显示为 overdue，并令 `becameOverdueAt=dueAt`；不得继续出现在 active 列表。
3. 发现上述未持久化变化时，幂等唤醒 housekeeping。effective view 不是新的 authority，也不能替代持久化。

## 7. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.6、§3.8、§4。

