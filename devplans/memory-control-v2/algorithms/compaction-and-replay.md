# Compaction 与 Proposal Replay 算法（version 3）

本文是 capacity-blocked、maintenance task、compaction、pending proposal 保护和原 proposal replay 的单一权威来源。Task、cycle、observation、candidate decision、patch 和 event 的数据 shape 见 [状态契约](../state-contract.md)。本算法只描述 version 3；开发期替换前的控制面记录不会导入新结构。

## 1. 触发边界与状态机

`compactionProposer` 不是事实写入 Proposer，不由 raw source lag 或 observation 到达触发。维护有两个触发模式：

- `lengthBudget`：normal proposal 的完整模拟 post-state 超过 section 的 `maxItems` 或 `maxRenderedChars`，用于解除容量阻塞；
- `hygiene`：成功 normal revision 后达到集中配置高水位且满足最小 item 增量，用于非阻塞整理。

两种模式在调用 LLM 前都先执行同 section、规范化 text 完全相同的确定性 merge。`hygiene` 只把成功 normal task 作为 `parent_task_id` 的审计关联，不改变 parent，也不改变 observation-target lifecycle。Provider/schema 错误、`unable_to_compact` 或全部 patch 被拒只令 hygiene task 终结为 `hygiene_noop | hygiene_skipped | hygiene_stale` 并写 ops log；成功 merge 独立提交 revision/snapshot。只有 `lengthBudget` 进入下述阻塞与 replay 状态机。

`target_halted` 不是 task stage，而是 per-target 运行状态 `capacity_blocked | halted`。maintenance task 必须持久化 `parent_task_id`，normal task 的 `stage_payload` 必须持久化当前 `maintenanceTaskId`。

**Normal task（`task_type=normal`）**：

```text
pending → proposing → proposal_persisted
→ capacity_blocked
→ replaying_original_proposal
├→ committed | no_state_change
└→ replay_failed
```

**Maintenance task（`task_type=maintenance`）**：

```text
pending → proposing → proposal_persisted → compacting
├→ compaction_applied
└→ compaction_failed
```

## 2. Pending candidate 原子单元

一个等待 replay 的 normal 结果不是孤立的 patch JSON，而是以下不可拆分的 `pending candidate unit`：

```text
boundaryCycleId + cycleLineageId + cycleKind + reviewEpoch + reviewTrigger + retryEpoch
+ sourceGeneration + detectorVersion
+ asOfRevision + semanticNow + sourceBoundaryMessageId
+ frozen observationVersions
+ exact candidateDecisions
+ exact section results / patch set
+ task input hashes / schema hashes
```

必须满足：

1. `candidateDecisions` 精确覆盖该 task 冻结的 observation-target 输入；
2. `proposed` decision 与 patch 的 `observationIds/patchIds` 双向一致；
3. proposal、candidate decisions 和 patch set 在 `proposal_persisted` 后 immutable；
4. capacity-blocked 不得提前把任何 observation-target 标为 `consumed`、`excluded` 或 `waiting`；它们保持由该 pending unit 独占的 `processing`；
5. 最终 replay 必须在同一事务中提交 candidate decision 的 reducer 结果、observation-target 终态、events、revision、state 和 snapshot。任一步失败全部回滚。

`sourceBoundaryMessageId` 是该 cycle 的 source 截止审计值，不是某个 writer 独立推进的消息进度。compaction 不读取 raw batch，也不推进 source scan checkpoint。

## 3. 权威流程

1. Reducer 在 apply 前对完整 normal proposal 模拟 post-state。任何会增长渲染结果的 patch 都受容量门约束；只要任一 section 超限，本轮不得先提交其余 patch。
2. normal task 进入 `capacity_blocked`，target status 进入 `capacity_blocked`。完整 pending candidate unit 写入 durable task；可为触发阻塞的 patch 写 `decision=deferred`、`result_revision=null` 的审计 event group，但不得写候选终态或推进 observation lifecycle。同事务创建 maintenance task，并建立双向 parent/child 审计引用。
3. maintenance task 按 [状态契约](../state-contract.md) §1.4 的 `targetKey → writable sections` 固定映射顺序，每次只压缩一个阻塞 section；canonical task 不保存可漂移的 `targetSections` 副本。它与普通 task 共用同一 `(userId,presetId)` 串行 lane；`target_key` 仅说明被整理的 writer，`source_boundary_message_id` 仅关联来源 cycle。trigger 的 `dimension` 记录 `maxItems | maxRenderedChars`。
4. `compactionProposer` 的 section result 只能是 `patches | unable_to_compact`；`patches` 中的 `op` 只能是 `mergeItems`。它不能创建 observation、candidate decision、新事实或 suppression。
5. Reducer 对 merge 继续执行 schema、itemIds、policy、结构化冲突、projection identity 和 source evidence 完整性校验。`memory_compaction` evidenceGroups 由 Reducer 从 source items 完整继承。专用字段兼容严格使用 [状态契约](../state-contract.md) §7.2：todos 的 actor/requester/due/anchor、agreementKey、同一非空 episode arcId、profile facet/canonicalKey/factBasis 以及全部 section semanticKey均按表全等；不兼容直接 `invalid_state_transition`。Proposer 只决定 result text，不能替 Reducer挑选结构化字段。result currentFieldLineage 对每个字段从 source current lineages 重建，任何空洞 fail closed。
6. Pending unit 保护是纯代码 gate：对同 scope 所有 `capacity_blocked | compacting | replaying_original_proposal` unit 收集其 patch 引用的 itemId；compaction patch 与集合相交时拒绝，reason=`item_protected_by_pending_proposal`。同一 maintenance task 的其他独立 merge 仍可 apply；全部 patch 被保护等同 `unable_to_compact`。
7. compaction 成功后独立创建 maintenance revision/snapshot，再以当前 state 重做原 pending unit 的完整容量模拟。仍有阻塞 section 时按固定顺序创建下一个 maintenance child；全部释放后 normal task 进入 `replaying_original_proposal`。
8. replay 只从数据库读取原 pending candidate unit，不重新调用事实 Proposer，不改写 decision、patch、quote 或 observation 选择。通过 §4 的完整 freshness 检查后，使用原稳定 `patchId` 确定性 apply。
9. replay 的最终事务以执行时最新全局 revision 为 base，写最终 `accepted | rejected | noop` events，并原子更新 candidate decisions 和 observation-target lifecycle。成功后 target 才可从 `capacity_blocked` 恢复；source scan checkpoint 不因此变化。

## 4. Replay freshness 与安全 rebase

replay 前必须同时验证：

- pending unit 的 `sourceGeneration` 与当前 state、scan status、cycle 一致；
- `boundaryCycleId` 仍指向活动 cycle，`cycleLineageId/cycleKind/reviewEpoch/reviewTrigger/retryEpoch` 精确相等，且该 cycle 是 lineage 的 latest active retry，未被 `superseded | retry_wait | halted` 取代；
- task 冻结的每个 `(observationId, observationVersion)` 仍存在于同 generation，版本未变，且本 target 行仍为该 task 独占的 `processing`；
- candidate decision coverage、patchIds 和 observationIds 与持久化 unit 精确一致；
- 所有引用 item 仍存在，目标 section 当前内容通过安全 rebase gate；
- evidence 仍登记在对应 observation version，raw `(messageId,contentHash)`、role、scope、boundary 仍有效；
- schema/prompt/policy hash 与 task 冻结值精确相等，且当前 suppression/privacy gate 未移除 source；
- proposal 仍是该 target 的唯一活动 pending unit，normal task 尚未终结。

安全 rebase 只允许忽略由同 cycle 其他 writer 对不相交 section 造成的 revision 增长。必须证明当前 target 的全部 writable sections 与 cycle 的 `asOfRevision` snapshot 深度相等，或只包含本 unit 已登记并允许的 compaction 映射；还必须证明 generation、完整 review/retry identity、observation versions 和 policy hash 未变。仅 `revision` 增长本身不构成 stale，`asOfRevision` 也绝不能被原位改成新值。

任一 freshness 条件失败都不得“尽量 replay”：旧 unit 终结为精确的 stale/rebase reason，仍为 `processing` 的 observation-target 由恢复器原子释放为 `retryable`。纯技术 retry 可用同 lineage/review 的 `retryEpoch+1`，但必须继承 retry 0 visibility snapshot；waiting/manual/dead-letter semantic review 必须使用 latest sealed boundary 的新 lineage/latest as-of/current versions，不能 replay 旧 pending unit。observation version 已变化由更晚 boundary接管，target section 无法对原 snapshot safe rebase则 halt/rebuild。

## 5. 失败、恢复与有界执行

- `unable_to_compact` 或无安全 merge 空间：maintenance `compaction_failed`，target `halted`；pending observations 不得消费。
- compaction 后仍超容量：normal `replay_failed`，reason=`capacity_still_exceeded`，target `halted`。
- generation/cycle/observation version 变化：终结旧 normal/maintenance 链并创建新 generation/cycle 工作，不跨边界 replay。
- Provider/schema/transaction 等技术错误：按 [Task 执行、Cycle 与幂等](task-execution-and-idempotency.md) 的 retry/reconciliation 规则恢复；commit outcome unknown 必须先按 durable idempotency key 查库。

maintenance 尝试上限按 `(parentTaskId, section)` 计算，同一阻塞窗口每个 section 最多尝试一次。人工 resume 创建新的 maintenance child，`resume_epoch` 加一且进入新的 dedupe key；不复用终态 child。resume 只把 target 从 `halted` 改回 `capacity_blocked`，必须等原 pending unit 成功 replay 且所有候选生命周期原子落定后才恢复 `healthy`。

## 6. 遗忘边界

- `recentEpisodes` 的窗口滚出由 Reducer 确定性执行，不需要 compactionProposer。
- `todos` 和 `standingAgreements` 不能因容量压力静默删除；只允许符合领域 lifecycle 的合并。
- `milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship` 不能自动遗忘；只能在同 section 合并确实重叠的 items。
- `refine | supersede` 是自然演化，merge 必须保留完整 evidence/projection identity 历史；只有显式 `correct | forget` 可创建 suppression，compaction 永远不能。

## 7. Harness

验收至少覆盖：pending candidate unit 不可拆分、跨 writer 安全 rebase、reviewEpoch/retryEpoch/observationVersion stale、受保护 item、连续多 section compaction、replay 原子回滚、suppression gate 与 generation 切换。详见 [Harness 验收契约](../harness.md)。
