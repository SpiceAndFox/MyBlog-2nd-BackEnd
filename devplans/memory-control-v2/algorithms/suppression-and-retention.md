# Suppression、Hard Delete 与 Retention 算法

本文是 correction/forget source suppression、RAG/Recall/rebuild 查询过滤、privacy hard delete 和 snapshot/event retention 的单一权威来源。Tombstone、diagnostic、diagnostic projection checkpoint、notification、snapshot 和 event DDL 见 [状态契约](../state-contract.md) §9。

## 1. Correction 与 Provenance

`updateItem + user_correction/assistant_correction` accepted 时创建新 revision：active state 中目标 item 只保留修正后的可见 value，但保留 itemId，并把本次已校验的 correction evidence 作为新 `evidenceGroup` 追加到既有完整 `evidenceGroups`。旧 event/revision/snapshot 不改写；Renderer 只渲染当前 revision 的新值，不渲染旧值或把旧值写成“已作废”。

在 apply 前，Reducer 从 pre-update item 的全部 `evidenceGroups` 收集每个 ref 的 `messageId + contentHash`；scene 的 correction `setField/clearField` 同样收集被替换字段的旧 `evidenceRef`。本次 correction 的 state/event/snapshot 与旧 source 的 context-suppression tombstones 必须同一事务提交；任一写入失败则 correction 整体 rollback。Tombstone 提交后立即成为查询过滤的 correctness gate，相交 RAG chunks 由 projection worker 异步失效/删除。Correction 消息自身的新 evidence 正常进入 RAG，只有被替换 item/field 的旧 source 被 suppress。Renderer 的 current scene 与 previousScene 都必须应用同一 gate，禁止过期场景重新泄漏旧 source。

## 2. Forget 与 Tombstone

`forgetItem` accepted 时，Reducer 必须先读取当前 item 的完整 `evidenceGroups`，直接收集所有 ref 的 `messageId + contentHash`，再从 active section 移除该 item。无需建立 provenance graph，也不遍历完整 event chain；update 追加和 merge 继承 evidenceGroups 的规则保证当前 item 已覆盖全部历史来源。

Context-suppression tombstone 是独立于 `memory_state`、跨 `sourceGeneration` 保留的 durable sidecar。每条至少包含 `(userId, presetId, messageId, contentHash)`、reason=`forget|correction`、来源 item/section、创建 revision 与时间；同一 source key 重复写入必须幂等。

`forgetItem` 的 active-state 移除、accepted event、snapshot 与 tombstones 必须同一事务提交，禁止出现“item 已删但 source 可重新召回”或“已 suppress 但 revision 未提交”的半状态。相交 RAG chunks 随后由 projection worker失效/删除；在此之前查询末端的 tombstone 过滤仍阻止其返回。

## 3. Rebuild 终态过滤

Tombstone 只抑制匹配的 `messageId + contentHash` 版本，不修改 raw chat message，也不删除历史 event/snapshot。

Source rebuild 可以按时间顺序重放 raw messages 以重建 correction 链，但在清除 dirty 前必须以 tombstones 做确定性终态过滤：

1. 任何 evidenceGroups 含 suppressed source 的候选默认从 active state 移除；
2. 唯一例外是它同时含 messageId 更晚、未 suppressed 的 `user_correction/assistant_correction` evidenceGroup；
3. 满足例外时保留修正后 item 及完整 provenance；
4. RAG/Recall 及主聊天 context 仍不得注入其中匹配的旧 source。

普通增量 task 在 Reducer evidence 查询前应用 tombstone gate；带 `trigger.type=forceDrain` 的受控历史重放 task 是唯一例外，它必须能读取旧 source 才能先复原 add→correction 链。该例外不允许把旧 source 直接注入主聊天，也不等于终态接受：每个 target 到达 captured boundary 后，必须把上述过滤结果作为一个 `group_kind=system_cleanup` 的新 revision、semantic cleanup events 与完整 snapshot 同事务提交，再执行 event/snapshot 连续性校验。只在内存中比较过滤结果、或发现残留后直接把 target 标 healthy，均不合格。

这样既能重建修正后的 item，又不能让已 forget 的旧事实因 rebuild 或与其他 evidence 合并而再次出现。

## 4. RAG/Recall Query Gate

当前不引入 `suppressionProposer`。

RAG chunk 必须保存组成它的全部 source `messageId + contentHash`；任一 source key 命中 tombstone，现有 chunk 即失效/删除。后续分块和 embedding 跳过整条匹配消息，查询返回前再做一次 source suppression 过滤，防止 checkpoint 延迟或残留 chunk 泄漏。Correction 的新消息按普通 source 建索引。

Recall 在选择 evidenceGroup、拉 raw window和拼合 context 三处应用相同 source-key 过滤：

- suppressed ref 不能作为候选 join key；
- suppressed raw message 不能出现在 recall 文本；
- 一个 group 的 refs 全被过滤后跳过该 group。

该 message-level 方案可能连带排除同一消息中的其他无关事实，这是当前为降低复杂度明确接受的保守副作用。片段级方案见 [Suppression Proposer（延后）](../../deferred/memory-control-v2/suppression-proposer.md)。

## 5. Privacy Hard Delete

Privacy hard delete 与普通 forget 不同：它必须物理清除指定内容在以下位置的副本：

- raw messages；
- Memory state/events/snapshots；
- durable task/proposal payload；
- context-suppression tombstones；
- context-quality diagnostics；
- diagnostic projection checkpoints；
- recovery notifications；
- RAG/Recall；
- 受控 debug 存储。

禁止将完整 raw prompt、完整 state diff 或完整 message content 写入 append-only 应用日志，因为这些日志无法按用户精确删除。如需持久化完整调试 payload，必须使用可按 `(user_id, preset_id)` 索引和删除的受控 debug 存储表，并在 privacy hard delete 时一并清除。

删除会使旧 revision/source 不再可 replay，因此 session permanent delete、preset permanent delete、自动 trash purge 等生产入口必须调用 runtime 的 privacy-hard-delete 编排，并与普通 task/source mutation 共用同一 `(userId,presetId)` 串行 lane：在受控事务中删除 raw source、增加 `sourceGeneration`、删除受影响的旧派生历史，再从剩余 raw source rebuild/force drain。部分 source 删除只能移除已不存在 raw message 对应的 tombstone，不得清空同 scope 内仍有 raw source 的无关 durable suppression；整个 preset 删除才清空该 scope 的全部 tombstone，且无需为已不存在的 scope 重建。

编排必须在独立于 preset 外键生命周期的 `chat_memory_privacy_operations` 中持久化 `purging → verified → draining → completed`（整个 scope 删除或 v2 关闭时重置 authority 可从 `verified` 直接完成）及 generation/boundary。完成所有已注册 store 的 purge + verify 前保持 operation incomplete，不得 force drain；任一 store 仍有删除对象残留时停在 `purging`。Store verification 必须证明每个派生对象的 source refs 仍对应当前 raw message 的 `(messageId,contentHash)`，不能简单把并发产生的合法新对象也当作残留；缺失/空 source refs 必须视为不可证明并清除。启动恢复先续跑 incomplete privacy operation，普通 rebuild reconciler 与 projection drain 发现同 scope 有 incomplete operation 时都必须跳过，禁止仅凭 target boundary 或 checkpoint 绕过 purge verification。v2 当前关闭也必须清除旧 v2 authority/派生副本，不能只删除 raw source。普通 forget 不执行物理删除。

## 6. Retention 不变量

Snapshot/event/task/ops log 的 retention 清理必须保证以下不变量：

1. **当前 generation anchor snapshot**：每个活跃 `sourceGeneration` 必须至少保留一个 schema-valid 的完整 snapshot 作为 replay anchor。generation 初始化 snapshot 是初始 anchor，但不是永久固定 anchor。
2. **Anchor 提升**：retention 可以把同 generation 内较新的完整 snapshot 提升为新 anchor。提升前必须验证该 snapshot 的 generation/revision 与 state 内容合法，并确认它等于从旧 anchor 连续 replay 到该 revision 的结果。新 anchor 与清理旧 anchor/旧 events 必须在同一维护事务中完成；事务失败时继续保留旧 anchor 链。
3. **连续 event groups**：只需保留 `result_revision > anchor.revision` 的连续 event groups，且不得出现 revision 断层；`result_revision <= anchor.revision` 的 groups 已被完整 snapshot 吸收，可按审计策略清理。`result_revision IS NULL` 的审计 group 不参与语义 replay，可独立按 retention 清理。
4. **旧 generation 清理**：只有当前 generation 已完成 rebuild 校验、相关 targets/projections 已不再读取旧 generation，且旧数据不再因审计或 privacy hard delete 策略要求保留时，才可清理旧 generation 的 snapshot/events。
5. **Task/Ops log retention**：durable task 和 ops log 可按时间窗口清理，但必须保留所有非终态 task、被当前 active task 引用的 predecessor/parent task，以及任何仍 retained（包括 `result_revision IS NULL` 审计 group）的 event group 所引用的 task。终态 task 清理不得破坏 retained event group 的审计关联。
6. **诊断投影先行**：任何可能删除 `chat_memory_events` 的 retention 必须先按[异常诊断投影](diagnostic-projection.md)同步本 scope；同步失败时本轮 retention 终止，不得越过 `processed_event_id` 删除尚未投影的 event。投影成功后才可进入独立 retention 事务。

## 7. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.6、§3.9、§3.10、§4。
