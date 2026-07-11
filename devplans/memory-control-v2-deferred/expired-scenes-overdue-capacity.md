# Expired Scenes / Overdue 长期容量（延后）

## 问题

`expiredScenes` 和 `overdue` 都可能随时间持续增长。完整解决该问题可能需要归档、检索、压缩、清理和恢复语义，会显著扩大本轮实现范围。

## 当前确定性方案

### expiredScenes

1. `maxItems` 配置为 1。
2. 新 scene 过期时以最新 item 替换旧 item。
3. 替换时记录 `system_cleanup: expired_scene_evicted` event，不静默删除。
4. 不调用 compactionProposer。

### overdue

1. Active state 当前保留全部 overdue items，不设会阻塞写入的 `maxItems`。
2. Renderer 只按 `becameOverdueAt DESC` 注入配置的最新 N 条，并受 `maxRenderedChars` 限制。
3. 未渲染的旧 overdue 仍可被 complete/cancel。
4. 当前不自动 archive，不调用 compactionProposer。

## 延后原因

更精细的方案需要回答：

- 旧 overdue 何时从 active state 转入 archive；
- archive 是否进入主聊天上下文，如何被检索；
- 是否允许语义合并，以及由谁执行；
- 归档/清理后如何保留 event、snapshot 和 evidenceGroups/suppression provenance；
- 如何避免长期增长同时不丢失尚未完成的任务。

当前个人单用户场景下，上述复杂度的收益不足，因此推迟。

## 重新评估条件

- overdue active state 的实际增长已影响 Proposer 输入或数据库操作；
- 用户需要查看或恢复长期未处理 overdue；
- `expiredScenes = 1` 已不能满足 scene recall 需求；
- 已经有明确的 archive/recall 产品需求。
