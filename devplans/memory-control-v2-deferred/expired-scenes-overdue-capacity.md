# Overdue Todo 长期容量（延后）

## 问题

Todo 到期后仍保留在 `working.todos`，仅由 Reducer 将 `status` 从 `active` 原位更新为 `overdue`。长期未完成的 overdue items 可能持续增长；完整解决可能需要归档、检索、清理和恢复语义。

`current.previousScene` 是单值字段，新场景过期时确定性替换旧值，不存在集合增长问题，因此不再属于本延后项。

## 当前确定性方案

1. `todos` 的写入容量只统计 `status=active` 的 items；overdue items 不阻塞新 active todo，也不触发 compactionProposer。
2. Renderer 只按 `becameOverdueAt DESC` 注入配置的最新 N 条 overdue todo，并受独立 `maxRenderedChars` 限制。
3. 未渲染的旧 overdue todo 仍保留原 itemId、dueAt 和 evidenceGroups，并可被 complete/cancel。
4. 当前不自动 archive 或删除 overdue todo。

## 延后原因

更精细的方案需要回答：

- 旧 overdue todo 何时转入 archive；
- archive 是否进入主聊天上下文，如何被检索；
- 归档/清理后如何保留 event、snapshot 和 evidenceGroups/suppression provenance；
- 如何避免长期增长同时不丢失尚未完成的任务。

当前个人单用户场景下，上述复杂度的收益不足，因此推迟。

## 重新评估条件

- overdue todo 的实际增长已影响 Proposer 输入或数据库操作；
- 用户需要查看或恢复长期未处理 overdue todo；
- 已经有明确的 archive/recall 产品需求。
