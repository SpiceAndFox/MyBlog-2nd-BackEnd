# Suppression、Hard Delete 与 Retention 算法（version 3）

本文是显式 correction/forget source suppression、observation/RAG/Recall/rebuild gate、privacy hard delete 和 snapshot/event/control-plane retention 的单一权威来源。开发期直接使用 version 3 结构，不保留旧 schema、旧 task 或旧派生数据兼容路径。

## 1. Suppression 只属于 `correct | forget`

创建 context-suppression tombstone 的充要语义条件是 Reducer 接受了显式：

- `changeKind=correct` 的 correction；或
- `changeKind=forget` 的 forget。

`refine | supersede | reaffirm | lifecycle` 都是自然演化。即使它们改变当前可见 value、结束 scene epoch、完成 todo 或用新阶段取代旧阶段，也必须保留旧 source 的 provenance 与 RAG/Recall 可见性，不得创建 tombstone。`memory_compaction` 同样只继承 provenance，不得 suppression。

evidenceKind 名称中出现 `correction` 不是绕过 policy 的理由；只有通过 policy/evidence gate 并以 `changeKind=correct` accepted 的 patch 才执行 suppression。Reducer 必须在 apply 前确定 changeKind，禁止提交后根据文本相似度推测“这大概是纠正”。

## 2. Correction 与 Forget 原子边界

### 2.1 Correction

`updateItem`、scene 字段 correction 或 correction retraction accepted 时：

1. active state 保留同一 itemId/field identity，写入修正后可见值；
2. 追加本次已校验 correction evidenceGroup，保留完整 provenance；
3. 对 correction patch 实际修改的每个 item 字段，从 pre-state `currentFieldLineage[field]` 读取与当前 fingerprint 一致的非空 evidenceGroup ID 集合，并只从这些 groups 收集旧 `(messageId,contentHash)`；scene field 只收集被替换字段的旧 evidenceRef。lineage 为空、悬空或 fingerprint 不一致时 fail closed；
4. corrected cancellation/retraction 表示“当前 item 本就不应成立”时，收集所有当前可见字段 lineage 的并集后移除 item；普通 lifecycle cancel/complete/expire 不走此分支。仅为这些明确支撑当前错误投影的旧 source 创建 reason=`correction` tombstones；不在 current lineage 的更早 establish/refine/supersede 历史与本次 correction message都不被 suppress；
5. state、candidate decision、observation-target 终态、event、snapshot、tombstones 与相关 observation invalidation/version update 在同一事务提交。

### 2.2 Forget

`forgetItem` accepted 时先从当前 item 的完整 evidenceGroups 收集所有 source keys，再移除 active item并创建 reason=`forget` tombstones。由于 update/merge 必须继承完整 evidenceGroups，无需遍历 event chain。

active-state 移除、candidate decision、observation-target 终态、event、snapshot、tombstones 和 observation cleanup 同一事务提交。禁止“state 已删但旧 source 可召回”或“source 已 suppress 但 revision 未提交”的半状态。

`forget` 与 corrected retraction 不同：forget 收集 item 全部历史 evidenceGroups；corrected retraction 只收集所有当前字段 lineages 的并集。二者都移除 active item，但 reason、允许 evidenceKind 和 suppression 范围不可互换。

### 2.3 Observation gate

Tombstone 不删除 ordinary raw chat，也不抹掉历史 provenance。它会立即使匹配 source 不能：

- 被 source scanner append 到新 observation；
- 作为 target Proposer/Reducer 的 registered evidence；
- 令旧 waiting/retryable candidate 再次变为 ready；
- 通过 pending proposal replay freshness gate；
- 被 GapBridge、Renderer、RAG 或 Recall 注入。

若 open observation 的有效 evidence 全被 suppress，事务必须将其 invalidated，并把尚未由 corrected projection流程收口的非终态 observation-target 转为 `excluded`，写系统 transition reason=`source_suppressed`；Provider 业务 reason `contradicted|not_canon` 不用于该系统转换。可另在 transition detail 保存 `invalidationCause=correction|forget|privacy`。若仍有未 suppress evidence，则增加 observation version，写 `observation_version_advanced` 并重新路由为 `ready | waiting`，使所有冻结旧 version 的 task stale。已经 consumed 的历史 decision 保留审计事实，但不能重新生成已纠正/遗忘内容。

若被纠正 source 对应 observation/arc/occasion 已有 consumed target或 active projection，Source Scan 不得提前 invalidated。correction/forget observation携带 `affectedObservationIds`；Reducer 只在对应 target 的 current projection已 update/retract/remove 且 tombstone提交后，把旧 target transition为 excluded。只有 dependency closure 中不再存在 active projection，才 finalise observation/arc/occasion invalidation。occasion/arc失效造成 observed-pattern 低于门槛时，相关 profile/relationship correction target必须先重判；无替代 current value时使用 `retractItem+correct`，不能让旧 trait 留在 state。

## 3. Tombstone 与重建终态

Tombstone 是跨 `sourceGeneration` 保留的 durable sidecar。每条至少包含 `(userId,presetId,messageId,contentHash)`、reason、来源 item/section、created revision/time；同 source key/reason 幂等。它只命中特定 content version，不修改 raw message，不改写旧 event/snapshot。

所有普通 scan、candidate、replay、GapBridge 和 projection 查询在读取 evidence 前应用 tombstone gate。受控 rebuild 为解析 `旧表述 → correction` 指代，可以把被 suppress 的原文作为标记为 `suppressedSupportingContext` 的只读上下文交给 observer/Proposer；它不得据此创建有效 observation evidence、patch evidence、GapBridge/RAG/Recall 输出或 active state。修正后的当前值必须由未 suppress 的 correction/后续 raw evidence 支撑。重建仍运行同一 boundary-major pipeline，并在最终 healthy 前做确定性 suppression audit：

1. active item/scene field 不得仅由 suppressed evidence 支撑；
2. correction 后的 item 可保留完整 provenance，但当前可见值必须由更晚、未 suppress 的 correction evidence 支撑；
3. observation catalog 中只有 suppressed evidence 的 observation 必须 invalidated；混合 observation 必须有只含有效 evidence 的当前 version；
4. RAG chunks、Recall join 与 GapBridge 不得返回 suppressed raw source；
5. cleanup 如改变 state，以 `group_kind=system_cleanup` 创建新 revision、semantic cleanup events 和完整 snapshot，同事务提交。

重建从第一条 source 开始就对“可写 evidence 与可见输出”应用同一 gate；上述显式标记的 supporting-context 例外只用于消解 correction 指代，不能先把旧 source 当有效事实写入、最后再补过滤。开发期 destructive replacement 会清空旧 tombstone，并从完整 raw 时间线重放 add→correction/forget 重新生成 version 3 suppression；日常 generation rebuild 则使用已保留的 current tombstone + 受控 supporting context，不恢复被 suppress 的旧事实。

## 4. RAG/Recall 与 Renderer Query Gate

RAG chunk 必须保存组成它的全部 `(messageId,contentHash)`。任一 source key 命中 tombstone，chunk 立即视为无效；projection worker异步删除/重建，在此之前查询末端 gate 仍必须过滤。后续分块与 embedding 跳过匹配 source，correction 新消息按普通 source 建索引。

Recall 在三处执行相同 gate：

- suppressed ref 不能作为 evidenceGroup join key；
- suppressed raw message 不能出现在 recall window；
- group 的有效 refs 全空时跳过该 group。

Renderer 对 current scene、previousScene 和 item provenance 使用同一 gate，不得因 snapshot 或 pending replay 泄漏旧 source。message-level suppression 可能连带排除同一消息中其他内容，这是当前明确接受的保守边界；片段级方案见 [Suppression Proposer（延后）](../../deferred/memory-control-v2/suppression-proposer.md)。

## 5. Privacy Hard Delete

Privacy hard delete 是物理删除，不等同普通 forget。必须清除指定内容在所有已注册 store 的副本，至少包括：

- raw messages；
- current Memory state、events、event groups、snapshots；
- durable tasks 的 `task_payload/stage_payload`、proposal、Provider/debug payload 和引用删除 source 的 task 行；
- source scan status 中需重算的 checkpoint、pending tail/deadline、semantic-boundary plan，以及逐消息 scan assessments；
- semantic arcs、occasions、evidence observations、observation evidence、observation-target rows；
- boundary cycles、candidate decisions、ops log 中的内容副本；
- context-suppression tombstones；
- context-quality diagnostics、diagnostic projection checkpoints、recovery notifications；
- RAG chunks/embeddings、Recall 派生数据与所有受控 debug store。

禁止把完整 prompt、state diff 或 message content 写入无法按 `(user_id,preset_id)` 精确删除的 append-only 应用日志。受控 debug store 必须登记 purge/verify 适配器。

### 5.1 编排

session/preset permanent delete、自动 trash purge 等入口必须调用统一 privacy-hard-delete 编排，并与 source mutation/task 共用同 scope 串行 lane：

1. 在独立于 preset 外键生命周期的 `chat_memory_privacy_operations` 创建/续跑 `purging` operation；
2. 阻止该 scope 新 scan、cycle、candidate、projection 和 context debug 写入；
3. 删除 raw source 后提升 `sourceGeneration`；
4. 清除或重建所有受影响的 version 3 派生对象，尤其是 assessment/observation/arc/occasion/cycle/decision/task payload；
5. 对每个注册 store 执行 source-key-aware verify；通过后进入 `verified`；
6. scope 仍存在时从剩余 raw source执行全量 scan/cycle/projection drain，完成后 `completed`；整个 preset 已删除时可从 `verified` 直接完成。

任一 store 未验证不得进入 drain。verify 必须检查派生 source refs 对应当前 raw `(messageId,contentHash)`，缺失/空 refs 视为不可证明并删除；同时不能把 hard delete 期间合法产生的新 generation 对象误判为残留。

部分消息删除只删除对应 source 的 tombstones；同 scope 其他显式 forget/correction tombstones必须保留。整个 preset 删除才清空 scope 全部 sidecar。启动恢复优先续跑 incomplete privacy operation；普通 rebuild、projection 和 context assembly不得凭 checkpoint/boundary 绕过 purge verification。

## 6. Retention 不变量

Retention 清理必须保持：

1. **Current generation anchor**：每个活跃 generation 至少保留一个 schema-valid 完整 snapshot。
2. **Anchor 提升**：新 anchor 必须等于从旧 anchor连续 replay event groups 的结果；提升与删除旧链在同一维护事务中完成。
3. **连续 event groups**：保留 `result_revision > anchor.revision` 的连续链；`result_revision IS NULL` 审计组不参与语义 replay，可按审计策略独立清理。
4. **Pending candidate unit 完整性**：非终态 normal/maintenance task 及其 cycle、冻结 observation versions、observation evidence、candidate decisions、proposal payload、parent task、`cycleLineageId/cycleKind/reviewEpoch/reviewTrigger/retryEpoch` 和 deferred event group 必须作为原子 retention unit 保留；不能只留下可 replay JSON 而删掉 freshness 依据。
5. **Observation provenance**：任何仍被 active item evidenceGroups、open/nonterminal observation-target、retained event/snapshot、RAG chunk 或 pending task 引用的 observation/arc/occasion/assessment/evidence 不得清理。
6. **Cycle continuity**：活动 cycle、其所有 target tasks 和 proposal decisions在 cycle 完成/终结及 retention 窗口满足前整体保留；同 evaluation lineage 的 `retryEpoch` 链和后来 semantic `reviewEpoch` lineages 都要足以解释 supersede、technical retry 与 semantic reconsideration。
7. **旧 generation**：仅在当前 generation rebuild 校验完成、无 worker/projection/privacy operation读取旧 generation且审计策略允许时清理；跨 generation tombstone不随旧派生数据自动删除。
8. **Task/Ops logs**：保留所有非终态 task、其 parent、retained event引用 task及 commit-outcome reconciliation 需要的幂等记录。
9. **Source boundary continuity**：active generation 的 `single_source_message_v1` plan、非空 pending row及其 deadline、已冻结但尚未取得 cycle/no-candidate 终局的 source-scan task必须保留；不得删 plan后按当前 batch重新切 boundary。
10. **诊断投影先行**：删除 semantic events 前，必须先同步[异常诊断投影](diagnostic-projection.md)到拟删除 event id；失败则终止 retention。checkpoint、diagnostic 与 retention 各自事务边界不得制造虚假恢复。
11. **Privacy 优先**：retention 绝不能延迟或阻止 hard delete；hard delete 可以主动打断并物理删除整个 replay unit，随后从剩余 source 建立新 generation。

## 7. Harness

验收至少覆盖：refine/supersede 不 suppression、correct/forget 原子 tombstone、observation version 失效、pending replay gate、混合有效/无效 evidence、hard delete 各注册 store verify、incomplete operation 启动恢复、candidate unit retention 与 diagnostic projection barrier。详见 [Harness 验收契约](../harness.md)。
