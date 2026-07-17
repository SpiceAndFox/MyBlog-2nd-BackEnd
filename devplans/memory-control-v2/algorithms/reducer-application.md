# Reducer Apply 算法

本文是 version 3 专业 proposal 的校验、candidate-atomic apply、observation lifecycle、event/snapshot 与 revision 提交顺序的单一权威来源。静态 patch/policy/reason/DDL 见 [状态契约](../state-contract.md)。

## 1. 职责边界

Reducer 是纯代码 Policy Gate + State Applier。它不调用 LLM，不做开放式语义冲突检测、embedding 相似、NLI 或 semantic-key 自动合并。

Reducer 必须同时决定两类结果：

- patch/event 对 current `memory_state` 的影响；
- 每个输入 observation-target 的 `consumed|waiting|excluded|retryable|dead_letter` lifecycle。

task `succeeded` 只是 workflow 终结，不代表所有候选语义成功。

## 2. 提交前 guard

事务开始后依次锁定 task、boundary cycle、current state、相关 observation-target 行，并校验：

1. task 是当前 phase 的 stable identity，status/stage 允许 reduce；
2. task/cycle/state 的 scope 与 sourceGeneration 完全相同；
3. cycle 未 completed/superseded/halted，task 的 semantic boundary/asOf、`cycleLineageId/cycleKind/reviewEpoch/reviewTrigger/retryEpoch` 与 cycle 相同；
4. canonical output 的 `tickId/proposer` 与 task 及本次 worker 一致；output 本身不存在 `target/schemaVersion` 字段，target 由 task 路由固定，schemaVersion 由该 task 选定的 v3 target output schema 保证，Reducer 不要求或读取这两个非契约字段；
5. task 的 observationVersions 精确覆盖被冻结候选，master version 未变化；
6. 每个候选 target row 仍为本 task 的 `processing`；
7. 当前 revision 等于 `asOfRevision`，或满足 §3 safe rebase；
8. source mutation、housekeeping 或更晚 cycle 没有插入本 cycle。

不满足 generation/observation/cycle guard 的旧结果写 `stale_result`，不得 apply。技术 retry 可创建同 lineage/review 的 `retryEpoch+1`，但必须继承 retry 0 visibility snapshot；不得把旧 proposal应用到新 snapshot，也不得让 recovery Proposer读取同-boundary未来派生 state。semantic review 使用新 lineage/latest sealed boundary/latest as-of/current versions，不能伪装成 technical retry。无法对原 snapshot safe rebase时 halt/rebuild。

## 3. Safe rebase

同 cycle target 按固定顺序提交，前一个 target 会提升全局 revision。后一个 target 只有在以下条件全部满足时可 rebase 到当前 revision：

- 当前 target 的全部 writable sections 与 `asOfRevision` snapshot 深度相等；
- sourceGeneration、cycle lineage/review/retry identity、sourceBoundary 与 observation versions 未变；
- 前序 revision 只修改其他 target 的不相交 sections；
- 没有 source mutation、lifecycle housekeeping、compaction 或人工操作穿插；
- proposal 没有读取 boundary 后的 raw source。

readOnlyContext 的其他 section 发生同 cycle 预期写入不构成冲突，因为所有 Proposer 本来就只允许基于 as-of snapshot 推理；但任何 cycle 外修改都构成冲突。

## 4. Candidate coverage 与原子单元

成功 output 先做完整性验证：

1. candidateDecisions 对输入 observation 各一次且仅一次；
2. proposed decision 的 patchIds 非空，其他 outcome 的 patchIds 为空；
3. 每个 patchId 唯一并存在；patch.observationIds 与 decision.patchIds 双向一致；
4. 所有 sectionResult 恰好覆盖 target writable sections；
5. patch section/op 未越过 target scope。

违反任一项是 `candidate_coverage_invalid`，整份 output 不进入业务 Reducer；task 按 schema-repair retry，耗尽后相关 observation-target 进入 retryable/dead-letter。

对 `proposed` observation 与 patch 构造二部图；通过共享 patch/observation 相连的 connected component 是一个 **candidate atomic unit**。一个 unit 内所有 patch 要么全部 accepted，要么全部 rejected/deferred，不允许先写一半再把 observation 标 retryable。互不相连的 unit 可以独立成功或失败。

`waiting/excluded/already_reflected` 各自是零 patch unit：

- waiting：reason 必须来自固定 waiting enum，target row 变 waiting；
- excluded：reason 必须来自固定 excluded enum，target row 变 excluded；
- already-reflected：Reducer 必须以 projectionIdentity/root observation、现有 item ID 或其他确定性 identity 验证；文本相似或 semanticKey 相同不足以通过。验证成功才 consumed，否则 retryable。

## 5. 每个 proposed unit 的验证顺序

顺序固定：

1. **Schema 与字段**：op/path/itemId/itemIds/value、todo due union、scene epochTransition、profile 字段完整；
2. **Observation gate**：observation scope/generation/version/target assignment 与 patch 双向覆盖；
3. **Evidence registry/source/quote**：按 [Evidence 校验](evidence-validation.md)；不使用 new-batch/overlap 规则；
4. **Policy gate**：查 section + op + evidenceKind + changeKind；自然演化不得使用 correct；
5. **Identity 与结构冲突**：item 存在、同 unit 操作顺序合法、canonicalKey、exact duplicate、projectionIdentity；semanticKey 不参与唯一判断；
6. **Pattern gate**：observedPattern 从 registry 计算至少 3 distinct occasions / 2 distinct arcs；
7. **领域生命周期**：relative due anchor、todo state、scene epoch/字段 TTL、episode arc 状态按 [领域生命周期](domain-lifecycle.md)；
8. **模拟 apply**：在 unit-local state 上按稳定 patch 顺序 apply，生成 evidenceGroups/tombstone/cleanup；
9. **容量**：在生命周期归一化后的 unit post-state 检查预算；任一 proposed unit 需要 compaction 时触发 proposal-wide capacity barrier，本 target proposal 的其他 semantic unit 本轮也不提交；
10. **跨 unit 合并**：按 proposal patch 顺序把成功 unit 合并到 target post-state；若两个 unit 修改同一 item/scene path，后一个以 `invalid_state_transition` 拒绝，不能依赖 LLM 输出顺序偷偷覆盖。

任何验证失败时，unit 内不改变 state；每个 patch 写 rejected audit，observation lifecycle 按 §7 分类。

## 6. Apply 规则

### 6.1 Evidence 与 item identity

- add item：Reducer 把 patch 的 observation IDs 解析为排序去重的 root 集合；单 root 直接作为 `projectionIdentity`，多 root 用固定 namespace 对 canonical root set 计算 UUIDv5，并把完整集合保存为 `sourceProjectionIdentities`，再生成 item ID；
- update item：保留 item ID/projectionIdentity/既有 evidenceGroups，追加新 group；
- reaffirm 可只追加 evidenceGroup而不改 text；refine/supersede 可以更新 text/专用字段但保留历史 group；
- 每个 add/update/reaffirm 都同步维护 `currentFieldLineage`：字段 fingerprint 必须等于 canonical current value，group IDs 必须非空且存在于本 item。refine/reaffirm 可把原 lineage 与新 group 合并，supersede 以新 group 替换；
- correct 更新可见值、追加 correction group；对每个实际被修正字段，Reducer 从 pre-state `currentFieldLineage[field].evidenceGroupIds` 精确收集旧 source 写 tombstone，再以 correction group 替换该字段 lineage。lineage 为空、悬空或 fingerprint 不等于 pre-state current value 时以 `invalid_state_transition` fail closed；更早但不在当前 lineage 的 establish/refine/supersede 历史不得连带 suppression；
- forget 先从 pre-state 收集完整 evidence source，写 tombstone，再移除 item；
- correction 型 `cancelTodo/cancelAgreement/retractItem` 先校验所有当前可见字段 lineage，取其 evidenceGroup ID 并集写 correction tombstone，再移除 item；普通 lifecycle cancel/complete/expire 不 suppress。任一 current lineage 无法解析时 fail closed；
- mergeItems 继承每个 source item 的 evidenceGroups 与 source projection roots，不制造新 observation。merged item 对 source roots 使用与普通 patch相同的 single-root/UUIDv5 set 算法；对每个合并后字段重建 `currentFieldLineage`，其 group IDs 是实际支持该字段的 source current lineages 的排序并集，fingerprint 是合并后 current value。任一 source lineage 悬空或合并结果无法对应非空支持集合时拒绝 merge。Renderer 不得因集合部分相交把其他 section 误判为同一投影。

所有 accepted patch 的 registry hash/quote 而非 LLM 自报元数据写入 state/event。

### 6.2 Todo

- add 强制 `status=active,becameOverdueAt=null`；
- relative due 使用 patch 的 `timeAnchorMessageId`，该 ID 必须是 observation registry 中的 evidence，不能默认取最大 messageId；
- complete/expire 与 `changeKind=lifecycle` 的 cancel 是真实 lifecycle 移除，不 suppress 当时真实 source；`changeKind=correct` 的 cancel 按 §6.1 current lineage 执行 corrected retraction；
- correction 使用 `changeKind=correct` 才 suppress 旧错误 source；
- overdue/revive 由同一 lifecycle 函数生成 cleanup event。

### 6.3 Scene

- `epochTransition.start` 先归档旧 epoch，再创建稳定 epochId；
- `epochTransition.end` 归档并清空；
- 普通 set/clear 只改目标字段；
- correction 只 suppress 被替换字段的旧 source；
- 字段过期不会给同 epoch 重复写 previousScene；具体见 [领域生命周期](domain-lifecycle.md)。

### 6.4 Capacity 与 compaction

- scene patch 超 `maxRenderedChars`：该 atomic unit rejected `capacity_exceeded`，不创建 compaction；
- recentEpisodes：按 lifecycle 滚出最旧 item，写 cleanup event；
- todos 只统计 active；
- 其他 item section 超限：整个 target proposal 进入 `deferred/capacity_blocked`，所有 candidate atomic unit 保持 processing，创建 maintenance task；original proposal replay 必须复核 cycle/generation/observation version 和完整 pending candidate unit，不得绕过 observation lifecycle。proposal-wide barrier 避免先提交独立 unit 后，使原 proposal 的 as-of item identity 与容量模拟发生漂移。

## 7. Candidate lifecycle 决策

| 结果 | observation-target 结果 |
| --- | --- |
| proposed unit 全部 accepted | `consumed`, reason=`meets_write_threshold` |
| already-reflected 且确定性 identity 成立 | `consumed`, reason=`duplicate_or_existing_state` |
| waiting | `waiting`；该 observation version 未变化前不重复调度 |
| excluded | `excluded` |
| capacity deferred | 保持 `processing`，等待 compaction/replay |
| transient Provider/transaction/commit-unknown | 保持 `processing` 或 task retry_wait，不提前改 candidate 终态 |
| stale observation version | 旧 task 取消；按新 version 的 material relation 路由 ready/waiting |
| 可修复 evidence/ref/item/identity/rebase 问题 | `retryable`，带固定 reason 与 not-before |
| 明确 target mismatch/not canon 且 Proposer 已正确 excluded | `excluded` |
| contract/policy/schema repair 次数耗尽 | `dead_letter`，target degraded/halted |

业务 reject 不能一概 consumed，也不能无限 retry。每个 reason 的 `retryable|maxAttempts|terminal` 映射由集中配置中的固定表给出；只有 source/observation 新版本或人工修复才能唤醒 dead letter。

一个 observation 的 atomic unit accepted 后，其同 target 行 consumed。它若后来 append material evidence 并 version+1，Source Scan 算法可把该行重新 ready；consumed 不是 master observation 的永久关闭。

## 8. Lifecycle normalization 与容量顺序

Cycle 创建前先以 `semanticNow` 对 as-of state 做 pre-cycle housekeeping并单独提交必要 revision，随后冻结 cycle。Reducer apply 时再对 proposal post-state运行同一函数，以处理“新增后立即到期”“overdue 设置未来 due”“episode 超窗口”等变化。

proposal 直接触发的 cleanup 与 accepted patch 共用 event group/revision；无 proposal 的 housekeeping 使用独立 system-cleanup group。无 state 变化不创建空 revision。

## 9. Event、revision 与事务

一个 target proposal reduce 使用一个稳定 event-group phase identity：

1. 预留 event IDs、生成 item/epoch IDs；
2. 为 accepted/rejected/deferred/noop patch 写 event；candidate decision 另写 `chat_memory_candidate_decisions`；
3. 写 observation-target lifecycle 与 task/target health；
4. 若 state 有变化，设置 `meta.revision=currentRevision+1`，同事务写 current state、完整 snapshot、event group/events、tombstone、cleanup；
5. 若只有 waiting/excluded/already-reflected 且 state 不变，提交 decision/task/target 行但不创建 revision 或空 semantic event；若存在 rejected/deferred patch，则写 `result_revision=NULL` 的非空 audit group/events，仍不创建 snapshot；
6. 标记本 target task 终态；最后一个 target 完成后由 coordinator 复核 cycle completeness 再标 completed。

COMMIT 前明确失败：全部 rollback，task 根据 phase identity 重试。COMMIT 结果未知：先查 stable event group/candidate decision/task result，确认未提交后才能重试。重复 delivery 返回既有结果，不能再次 append evidence group、提升 revision 或消费 candidate。

## 10. 不变量

- 一个 boundary cycle 的 Proposer 永远只看一个 as-of snapshot；
- candidate decision 精确覆盖 input observation；
- consumed 必须有 accepted atomic unit或确定性 already-reflected 证明；
- rejected/deferred patch 不改变该 unit 的 state；
- observation registry 外的历史永远不能写 memory；
- semanticKey 相同永远不能触发代码自动合并；
- correct/forget 才产生 source suppression，自然演化不产生；
- state mutation、snapshot、accepted event、candidate lifecycle 与 tombstone 不出现半提交。

## 11. Harness

至少覆盖 candidate graph 原子性、跨 target safe rebase、reviewEpoch/retryEpoch conflict、registered old evidence、短 acceptance chain、pattern threshold、todo anchor、scene epoch、partial target success、capacity replay、COMMIT unknown 与重复 delivery。完整清单见 [Harness](../harness.md)。
