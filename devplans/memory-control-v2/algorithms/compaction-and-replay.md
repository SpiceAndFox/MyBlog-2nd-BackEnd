# Compaction 与 Compiled Proposal Replay 算法

本文是 capacity-blocked、maintenance task、Semantic merge、Compiler、pending proposal 保护和原 compiled proposal replay 的单一权威来源。

## 1. 触发

Compaction 不由 lagThreshold 调度：

- `lengthBudget`：normal compiled proposal 会令 compactable section 超容量；
- `hygiene`：成功 normal revision 后达到高水位和最小 item 增量。

调用 LLM 前继续执行同 section normalized text 完全相同的 deterministic merge。`recentEpisodes` 不参加 compaction，由滑动窗口维护。

## 2. Task 阶段

Normal：

```text
compiled_proposal_persisted
→ capacity_blocked
→ replaying_compiled_proposal
→ status=succeeded,stage=committed | status=failed,stage=replay_failed
```

Maintenance：

```text
pending
→ proposing
├→ changes
│   → semantic_result_persisted
│   → compiling
│   → compiled_proposal_persisted
│   → compacting
│   → status=succeeded,stage=compaction_applied|hygiene_applied
│     | status=succeeded,stage=hygiene_noop|hygiene_skipped
│     | status=failed,stage=compaction_failed
└→ unable_to_compact
    → unable_result_persisted
    → status=failed,stage=compaction_failed（lengthBudget）| status=succeeded,stage=hygiene_noop（hygiene）
```

Hygiene 使用同一 task 类型。正常的 `unable_to_compact`、merge rejection 或容量未改善不改变 healthy target；成功/无操作 stage 可以是 `hygiene_applied/hygiene_noop/hygiene_skipped`，stale 时使用 `status=cancelled,stage=stale`。Provider/schema 重试耗尽和确定性 Compiler error 仍按全局技术失败规则 halt target。

## 3. 权威流程

1. Reducer 对完整 normal compiled proposal 模拟，发现任一 compactable section 超限。
2. 本轮不 apply 任何 normal patch；只为触发阻塞的 patch 写 `deferred`、`result_revision=null` 审计 group。
3. Parent task 保存 `compiledProposal/identities/blockingViolation/maintenanceTaskId`，target 进入 `capacity_blocked`，cursor 不推进。
4. 创建 maintenance child，Renderer 给单个 section items 分配 writable short refs；不显示 raw messages、read-only Memory、真实 ID 或 provenance。
5. compactionProposer 输出 `{action:"merge",refs,text}` 或 `unable_to_compact`；后者持久化为 unable result并按 mode终结，绝不进入 Compiler。
6. 只有 `changes` 结果进入 Compiler；Compiler 将 refs 映射为真实 itemIds，生成 `mergeItems` compiled patch，不从 Proposer读取 sources。
7. Reducer 检查 item 存在、同 section、pending proposal protection 和领域兼容性；merge 后继承所有 source items 的 sourceRefs。
8. Compaction apply 成功形成独立 maintenance revision/snapshot；仍有其他阻塞 section 时创建下一 child。
9. 容量释放后，parent 进入 `replaying_compiled_proposal`，读取已持久化 original compiled proposal，重新做纯代码预检并 replay；不重新调用 normal Proposer 或 Compiler。

## 4. Merge 限制

- refs/itemIds 至少两个、不可重复、同一 patch 之外不复用；
- 不跨 section；
- Todo 仅 active 且 actor/requester/dueAt 分别相同；
- milestones 不跨阶段；
- standingAgreements/worldFacts/Profile/relationship 只能无损合并重复表达；
- Profile/Relationship 不再要求 facet/canonicalKey 相等；
- merge text 不能新增事实、调和冲突或丢失主体/否定/条件/范围；语义完整性由 Prompt/Harness 负责，Reducer 不做 NLU。

## 5. Pending Proposal 保护与 Stale

Compaction itemIds 与同 target 任一 active capacity proposal 引用的 itemId 相交时，以 `item_protected_by_pending_proposal` 拒绝。全部 merge 被保护时视为 compaction_failed。

Replay 条件：

- sourceGeneration 相同；
- target cursor 仍等于原 cursorBefore；
- parent proposal 仍 active；
- 引用 item 仍存在；
- compiled schema/source hashes仍有效；
- 当前容量预检通过。

同 generation 内其他 target 增加全局 revision 不单独令 replay stale。

## 6. Failure 与 Resume

- lengthBudget maintenance 的 `unable_to_compact`、全部 patch rejected 或容量仍不足：halt 对应 target；
- hygiene maintenance 的正常 `unable_to_compact`、merge rejection或容量未改善：以 `status=succeeded, stage=hygiene_noop|hygiene_skipped` 终结并保持 target healthy；不套用 lengthBudget halt语义；
- Provider/schema failure：沿用 task error恢复；
- maintenance ref/source/date/invariant compile failure：先重校 stale；非 stale 时 child failed、target halted并写 ops log，不推进 parent、cursor、revision或event，也不自动重调LLM/Compiler；
- lengthBudget resume 创建新 child、`resume_epoch+1`，不复用终态 child；
- hygiene compiler halt 的 resume 创建同 section 的新 maintenance task，并重新 render/propose/compile；
- 只有 original compiled proposal replay、cursor提交后 target 才恢复 healthy。

## 7. Harness

覆盖 short refs、merge compile、provenance inheritance、pending protection、多 section sequential maintenance、compiled replay、stale、resume epoch、hygiene 隔离和 crash recovery。
