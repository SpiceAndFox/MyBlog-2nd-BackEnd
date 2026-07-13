# Reducer Apply 算法

本文是 Reducer 校验、模拟、apply、事件生成和 revision 提交顺序的单一权威来源。Patch shape、policy table、容量 shape、event/DDL 等静态契约见 [状态契约](../state-contract.md)。

## 1. 职责边界

Reducer 是纯代码的 Policy Gate + State Applier。它不使用 LLM，不做开放式自然语言判断，不做语义冲突检测，不做语义匹配。

## 2. 权威执行顺序

Reducer 必须按顺序执行：

1. **schema 校验**：patch 的 op、path/itemId、value 是否符合 [状态契约](../state-contract.md) §4 的 Patch Op 约束；item patch 由所属 `sectionResults` key 直接确定 section，只有 scene 字段操作使用 `path`。Todo add 必须含 actor/requester，todo update 必须含显式 dueChange；Reducer 解析 dueAt 表达式，相对期限以该 patch 最新 evidence message 的数据库 createdAt 为 anchor，在 task 创建时从 User 字段固化的用户时区（默认 UTC）下做日历运算，不使用 task/worker 时间。
2. **evidence source 校验**：普通模式非 `mergeItems` patch 的 `evidenceRefs.messageId` 必须在 `observedMessages` 范围内且真实存在；数据库中的 user/preset/role/createdAt/contentHash 必须与 proposal-time task payload 一致，并按 evidenceKind 校验真实 role。`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`，Reducer 校验 `itemIds` 指向的 source items 存在且带有结构合法的 `evidenceGroups`。完整算法见 [Evidence 校验与 Quote 匹配](evidence-validation.md)。
3. **quote 模糊匹配**：普通模式非 `mergeItems` patch 按 [Evidence 校验与 Quote 匹配](evidence-validation.md) 的 200-code-point、最少 3 个信息字符和统一 Levenshtein 规则校验。
4. **policy gate**：按 section + op + evidenceKind 查 [状态契约](../state-contract.md) §6 的 policy table，判断是否允许。
5. **结构化冲突检测**：只检查同字段覆盖（`setField`）、同 itemId 操作（`updateItem`/`forgetItem`/`completeTodo` 等）、跨 section 合并、itemId 是否真实存在和操作顺序合法性。不做语义冲突检测。
6. **领域生命周期归一化**：先在模拟 post-state 上应用 dueAt 到期、scene TTL 和 recentEpisodes 滑动窗口规则；任何确定性持久化变化都按 [状态契约](../state-contract.md) §9.2 写对应 system cleanup event，禁止 silent mutation。完整算法见 [领域生命周期](domain-lifecycle.md)。
7. **长度预算**：scene 字段 patch 在 apply 时逐条执行预算门，超过 `scene.maxRenderedChars` 的单个 patch 以 `capacity_exceeded` 拒绝，不创建 maintenance task。Reducer 只持久化 rejection 事实；用户告警由[异常诊断投影](diagnostic-projection.md)在写入提交后派生。其余 section 对 lifecycle 归一化后的模拟 post-state 按 [状态契约](../state-contract.md) §8 校验容量。Todo 容量只统计 active items；recentEpisodes 已由滑动窗口收敛；previousScene/overdue 不触发 compaction。其余 item section 超限时进入 [Compaction 与 Proposal Replay](compaction-and-replay.md)。
8. **apply**：通过校验的 patch 应用到 state，生成新 state。普通 add/update item patch 的 `evidenceRefs` 补入已校验的数据库 `contentHash` 后，与 `patch.evidenceKind` 包装为一个 `evidenceGroup` 追加到 item；`forgetItem` 从 pre-state item 的完整 evidenceGroups 生成 tombstones 后移除 item，不把 forget evidence 追加到已移除对象；`mergeItems` 继承 source items 的 `evidenceGroups`，各 group 保留各自 evidenceKind。Todo add 写入 actor/requester/dueAt；update 按 dueChange keep/clear/set 修改 dueAt。Todo merge 仅在 actor/requester/dueAt 分别相同时成立并原样继承三字段。
9. **事件记录**：为整个 task bundle 建立一个 event group；每个 patch 的决策写一行 event，`noop` 写占位，Reducer/housekeeping 的确定性 state 变化写通用 `system_cleanup` event。Proposal 模拟 post-state 直接触发的 cleanup 与 proposal decisions 共用该 proposal group/revision；无 proposal 的后台 housekeeping 使用独立 `group_kind=system_cleanup`。accepted/system cleanup 必须保存完整 `normalized_operation`。
10. **revision 事务提交**：预留 event IDs、生成最终 item IDs，设置 `meta.revision = baseRevision + 1`，并把 post-state、完整 snapshot、event group/events、cursor、task 终态和 target status 同事务提交。若本次只有不改变 state/cursor 的运行失败，则不走此步骤，改走 [Task 执行、Cursor 与幂等](task-execution-and-idempotency.md) 的运行状态事务。

职责顺序敏感，不可随意调换。

## 3. 相关算法

- Correction、forget、tombstone 和 hard delete 见 [Suppression、Hard Delete 与 Retention](suppression-and-retention.md)。
- Revision、cursor、task phase identity 和 commit outcome 见 [Task 执行、Cursor 与幂等](task-execution-and-idempotency.md)。
- Compaction 的 pending item 保护和 replay 见 [Compaction 与 Proposal Replay](compaction-and-replay.md)。

## 4. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.1、§3.4、§3.6。
