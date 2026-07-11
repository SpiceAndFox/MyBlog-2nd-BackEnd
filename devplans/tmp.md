# Memory Control 重构最终共识清单

本文汇总截至 2026-07-11 已达成的设计共识，作为后续正式修订 Memory Control 文档和实现的基线。讨论中已被推翻的早期方案不再具有约束力。

## 1. 设计方法与总体原则

1. 本次重构采用偏瀑布式设计：设计阶段一次性覆盖 deferred、compaction、snapshot、replay、overdue、expired scene、gapBridge、用户告警、forget/RAG suppression 等完整能力，不以“首版先删除、以后再补”为默认策略。
2. 实现仍按依赖顺序分层推进和验收，但这是工程实施顺序，不代表把已确定功能延期到不明确的未来。
3. 设计在完整性和可落地性之间取平衡：只为明确的故障路径引入机制；能用简单确定性规则解决的问题，不堆叠多套预算、风险分类或 LLM 判断。
4. LLM 负责语义判断和提出候选变更；Reducer 负责纯代码可验证的结构、作用域、权限、证据、容量、并发和事务约束。
5. 接受 LLM 语义判断存在一定偏差。Reducer 不宣称能够证明自然语言 text 一定被 evidence 语义蕴含，也不要求 LLM 判断“高风险事实”。
6. 可恢复性的目标包括：避免静默丢失/重复应用、支持崩溃恢复、追踪错误记忆来源、保证 forget 后不会被自动重建，以及区分模型错误、Reducer 错误和事务错误。

## 2. 权威状态与作用域

1. PostgreSQL 中的结构化 `memory_state` 是新系统唯一的当前 Memory authority。
2. 旧 rolling summary/core memory 不转换为新系统 authority，也不与新 Memory 同时注入。
3. 最终迁移时停止旧 worker/注入并物理删除旧 Memory 数据；新系统从 raw messages 重建。
4. 可以保留数据库级离线备份用于灾难恢复，但备份不进入应用上下文，也不提供给 Agent。
5. user/preset 下的对话跨 session 语义连续。session 只是按天或 UI 划分的存储单元，不是 Memory 或 scene 的语义边界。
6. sessionId 仍保存在消息、evidence、event 和 Recall provenance 中，但不用于 key 当前 scene，也不自动触发 scene reset。

## 3. State 结构

目标 state 至少包含以下语义 section：

```js
{
  currentScene: {/* 固定字段 */},
  expiredScenes: [],
  working: {
    todos: [],
    overdue: [],
    recentEpisodes: [],
  },
  core: {
    milestones: []
    agreements: [],
    worldFacts: [],
    userProfile: [],
    assistantProfile: [],
    relationship: []
  },
  meta: {
    revision,
    sourceGeneration,
    cursors: {}
  }
}
```

具体命名可在 canonical schema 中调整，但以下语义不可改变：

- currentScene 与 session 完全解耦。
- expiredScenes 是与 currentScene 分开的正式 section。
- overdue 与 todos 同级并拥有独立容量。
- recentEpisodes 与 milestones 联合处理但分别存储。
- userProfile 与 assistantProfile 都允许 User 和 Assistant 双方全权 add/update/forget。
- worldFacts 与 relationship 同样允许双方 add/update/forget。
- evidence role 仍按数据库真实消息校验，但不再用 role 限制 User/Assistant 对两个 Profile 的操作权。

## 4. Target、Proposer 与 Cursor

一个 Proposer 联合处理的多个 section 必须共享一个 target cursor，禁止“共享 Proposer + 独立 section cursor”。

| targetKey     | Proposer             | 可写 section                                            | cursor        |
| ------------- | -------------------- | ------------------------------------------------------- | ------------- |
| `scene`       | currentStateProposer | currentScene                                            | `scene`       |
| `commitments` | commitmentProposer   | todos、overdue、agreements                              | `commitments` |
| `episodes`    | episodeProposer      | recentEpisodes、milestones                              | `episodes`    |
| `core`        | coreProposer         | worldFacts、userProfile、assistantProfile、relationship | `core`        |

约束：

1. 一个 normal task 只有一个 cursorBefore、newBatch、targetMessageId 和 proposal。
2. episodeProposer 联合判断普通 episode 和 milestone，可以一次输出两类 patch。
3. commitmentProposer 联合判断 todo、overdue 相关操作和 agreement。
4. cursor 只在该 task 的 proposal 全部形成终局后推进。
5. Compaction task 不拥有独立 raw-message cursor；它是被 capacity-blocked normal task 派生出的维护任务。

## 5. Proposal 持久化与 Compaction 状态机

保留 deferred、LLM compaction 和 compaction 后确定性重放，但禁止 accepted + deferred 的非原子混合提交。

状态机：

```text
pending
→ proposing
→ proposal_persisted
→ capacity_blocked
→ compacting
→ compaction_applied
→ replaying_original_proposal
→ succeeded
```

Compaction 无法完成时进入 target halt，而不是推进 cursor：

```text
compacting
→ compaction_failed/target_halted
```

完整规则：

1. Proposer 输出经结构校验后，为每个 patch 分配稳定 patchId。
2. 在 apply 任何 patch 前，完整持久化原 proposal、source hashes、generation、cursorBefore、targetMessageId、prompt/model/schema 版本。
3. Reducer 先预检整个 proposal bundle。
4. 如果任一 patch 因 section 条数或可渲染字符容量需要 compaction，本轮不 apply proposal 中的其他 patch，避免 partial commit。
5. 创建 durable compaction task，并暂停同一 target 的后续 normal task。
6. Compaction 成功后，从数据库读取原 proposal，在当前 state 上重新做纯代码校验并确定性 replay；不得重新调用原 Proposer。
7. Source generation 在此期间变化时，旧 proposal/compaction task stale，由 rebuild 处理，不能 apply 到新 generation。
8. CompactionProposer 不得 merge/remove 原 proposal 正在引用的 itemId。
9. Compaction 失败时 halt 对应 Memory target，cursor 不推进，原 proposal 保留。
10. Target halt 不等于主聊天 halt：其他 Memory target 和主聊天继续运行，但用户必须持续看到 degraded 告警。
11. 人工清理容量、调整配置、更换模型或修复问题后，可 resume 该 target；resume 先重试 compaction，再 replay 原 proposal。

## 6. CompactionProposer 权限

1. 只有 compactionProposer 可以输出 `mergeItems`。
2. normal Proposer 永远不能输出 mergeItems。
3. compactionProposer 只能输出 mergeItems，不能输出 add/update/forget/complete/cancel。
4. mergeItems 不能跨 section。
5. compaction 是 system maintenance operation，不伪装成普通 message evidenceKind。
6. Merge 后的新 item ID 由 Reducer 生成 UUID/ULID，禁止使用 `itemIds.join(",")`。
7. Merge event 必须记录 `mergedFromItemIds`、resultItemId 和 replay 所需完整 normalized value。
8. 被合并旧 items 从 active state 移除，但历史通过 event chain 保留。
9. Merge 后 evidence 从输入 items 继承，compactionProposer 不能伪造 raw-message evidence。
10. compactionProposer 可以访问 expiredScenes、todos、overdue、agreements、recentEpisodes、milestones 和 core sections。
11. Todo/overdue merge 至少满足：同 section、actor 相同、requester 相同、dueAt 相同，并且相关 item 不受原 deferred proposal 保护。

## 7. Snapshot、Event 与恢复

1. State snapshot/checkpoint 是同一个概念：某个 revision 的完整权威 state，不再为每个 section 设计互不一致的恢复 checkpoint。
2. 每个成功提交的 state revision 都在同一事务写一份完整 post-state snapshot。
3. 一个 task bundle 即使包含多个 patch，也只产生一个 revision 和一份 snapshot。
4. 因为 revision N 已有 post-state snapshot N，所以 revision N+1 修改前天然已有“修改前 snapshot”，不需要额外复制一份 pre-state snapshot。
5. Compaction apply 和原 proposal replay 各自形成明确 revision，并各自同步 snapshot。
6. Source generation seed 必须同步写完整 snapshot。
7. State、events、snapshot、cursor、task 终态和 target health 必须在同一事务提交。
8. Snapshot 包含全部语义 section、全部 target cursors、revision 和 sourceGeneration；不包含 task lease/retry 等瞬时调度状态。
9. Event replay 不重新调用 LLM，只使用 event 中的 normalized applied operation、result item ID 和确定性字段。
10. Add event 的 result item ID 不能为 null。
11. 为解决 eventId/itemId/provenance 的循环依赖，Reducer 在事务中预留 event IDs、生成 item IDs、构造最终 state/hash，再插入完整 events。
12. 自动 overdue 转移、scene expiry、episode 滚出、archive 等持久化变化必须记录 system cleanup event，禁止 silent delete。
13. Event/snapshot replay 必须校验 revision 连续性、cursor 连续性、group task/target 一致性和 state hash。

## 8. Evidence 与 Quote

Reducer 对 evidence 做以下纯代码校验：

1. messageId 必须属于 task observed messages。
2. 数据库中的 user、preset、session、role、createdAt、content hash 必须与 proposal 时一致。
3. 普通 patch 至少一条 evidence 来自 newBatch。
4. quote 必须非空，不能只有空白或纯标点。
5. quote 和 raw content 使用同一套确定性归一化：Unicode NFKC、换行统一、连续空白折叠和 trim；保留否定词等信息字符。
6. 归一化 quote 必须至少包含 3 个非空白、非标点/符号的信息字符，否则拒绝对应 patch，reason=`quote_too_short`。
7. 所有长度的 quote 统一使用模糊匹配，不再设置短文本精确、长文本模糊的双路径。
8. Reducer 在归一化 raw content 中寻找 quote 的最佳匹配片段，使用固定算法计算 normalized similarity；默认接受阈值为 0.8，具体值进入集中配置。
9. 低于阈值时拒绝对应 patch，reason=`quote_not_found`。
10. 每个 quote 最大为 200 个 Unicode code points；Reducer 按 code point 计数，超出时拒绝对应 patch，reason=`quote_too_long`，不自动裁剪。
11. Prompt 明确要求复制“能够支持 patch 的最短连续原文，最多 200 个 Unicode 字符”，但必须接受 LLM 可能无法精确复制；Reducer 的模糊匹配是最终接收规则。
12. 通用模糊匹配不能修复否定词删除、数字/姓名替换等低编辑距离但高语义影响的问题；系统明确接受这一剩余风险，不得在文档中宣称已解决否定翻转。
13. 不引入否定词专项规则、高风险事实识别或自然语言蕴含验证。

## 9. Memory 容量与长度预算

每个会进入主聊天上下文的 Memory section 只使用两个容量维度：

```js
{
  (maxItems, maxRenderedChars);
}
```

规则：

1. `maxRenderedChars` 只计算可能被 Renderer 输出的语义文本，例如 item.text 和 scene value。
2. quote、evidence、hash、ID、provenance、event、task proposal、compaction audit 等不渲染内容不计入 Memory 容量。
3. 超过任一 section 的 maxItems 或 maxRenderedChars 时，proposal 进入 deferred/compaction 状态机。
4. 不设置 Memory 业务层的 Proposer proposal/envelope 总字符上限。
5. 不要求 LLM 自己准确控制 proposal 总字符数。
6. Provider context/output 的物理硬上限仍然存在，但它属于 Adapter/Provider 能力边界，不是 Memory 容量策略。
7. Observer 在请求超过 Provider 能力时缩小 batch；单条消息仍无法处理时进入 degraded 并显式提醒，不能静默丢弃。
8. 各 section 的 maxItems/maxRenderedChars、scene TTL、overdue/archive 时间、lagThreshold、gapBridge 预算等都从集中配置读取，禁止散落硬编码。
9. 除 quote 最大 200 已确定外，其余具体默认数值需结合真实历史分布确定并写入配置文档。

## 10. Scene 生命周期

1. currentScene 是 user/preset 级状态，与 session 完全解耦。
2. currentScene 使用固定字段 shape；clearField 将对应 value 设为 null 并保留清除 event/provenance，不删除字段。
3. currentScene 有配置化过期时间，不得硬编码在业务代码中。
4. Scene 到期后不直接删除，而是作为完整 item 移入 expiredScenes。
5. 移动时保留 scene 值和 provenance，写 `system_cleanup: scene_expired` event，并清空 currentScene 固定字段。
6. expiredScenes 有独立 maxItems/maxRenderedChars，并可由 compactionProposer merge。
7. Renderer 将 expiredScenes 明确标为“已过期场景/上次已知场景”，不得称为当前状态。
8. Renderer 在后台 housekeeping 尚未持久化时先构造 effective view，避免本次请求继续把已到期 scene 标成 current。

## 11. Todo、Overdue 与时间

1. Todo 必须保存结构化 actor 和 requester，而不只保存 text。
2. actor 合法值为 user/assistant/both；requester 表示提出请求或承诺的一方。
3. 相对时间以 evidence message 的 createdAt 为 anchor，不使用 worker/task 执行时间。
4. `dueAt` 表示 deadline，不表示直接删除时间。
5. 当 `now >= dueAt` 时，由纯代码将 todo 从 todos 移入同级 overdue section，保留 itemId、actor、requester、dueAt 和 provenance。
6. 迁移写 `system_cleanup: todo_became_overdue` event。
7. Renderer 在持久化迁移尚未执行时先按 overdue 渲染 effective view。
8. Overdue 可以 complete/cancel，也可以在配置化保留期后 archive。
9. Todos 与 overdue 各自拥有独立 maxItems/maxRenderedChars，不互相占用容量。
10. `updateTodo` 必须显式输出 dueChange union：keep、clear 或 set；字段省略不能同时表示“不修改”和“清空”。

## 12. needsMemory 与 Recent Window

1. 主聊天 recent window 继续保留 user-boundary 裁剪，避免上下文从孤立的 Assistant 回复开始。
2. Memory Observer 不使用 user-boundary 裁剪，必须按 target cursor 读取完整 source。
3. `needsMemory` 采用简单的 Unicode 字符阈值作为主要判断，不同时堆叠 message count、tokenizer 预估和 context 百分比。
4. session 之间语义连续，因此 recent window 可以跨 session；消息必须保留 session provenance/boundary 标记。

## 13. LagThreshold 与尾批

1. 普通聊天中，尾部不足 lagThreshold 不视为 correctness bug。
2. 后续新消息到达后可与旧尾批一起处理；在此之前 recent window 仍提供原文覆盖。
3. 不引入普通 idle flush 或按 session rollover flush。
4. 极长新消息把未处理尾批挤出 recent window 时，由 per-target gapBridge 补齐。
5. Source rebuild 必须忽略 lagThreshold，force drain 到 captured boundary 后才能清 dirty。
6. 一次性迁移/cutover 和管理员排查也可调用相同内部 force-drain 能力。

## 14. GapBridge

1. GapBridge 按每个 target cursor 查询有效 gap，不再依赖 legacy summarizedUntilMessageId。
2. 对 recent window 起点 R 和 target cursor C，gap 是 target scope 中满足 `C < messageId < R` 的有效消息集合。
3. GapBridge 拥有独立逻辑字符预算，不与 Memory Renderer 的 section 容量竞争。
4. Gap 未超预算时直接注入 raw messages。
5. Gap 超预算时不调用 LLM 压缩，而是按 messageId 倒序选择最近 N 条完整 raw messages，再恢复为升序注入；N 和字符预算进入集中配置。
6. 截断结果必须记录 `gapTruncated=true`、省略的消息数量和最早保留 messageId，不能伪装成完整 gap。
7. 发生截断时继续主聊天，但进入 degraded，并向用户明确告警“部分早期对话未在上下文中”；旧 target state 必须标记为可能滞后，不能无提示声称是当前状态。
8. 不允许为了填满预算截断单条 raw message 后仍称其完整；单条消息本身超 gap 预算时跳过该条并计入 omitted，保留可完整容纳的最近消息。
9. GapBridge 的逻辑预算独立，但其最终文本仍计入主模型不可突破的物理 context 上限。
10. 使用 LLM 压缩超预算 gap 的方案推迟到 [Gap Compressor 延后设计](memory-control-v2-deferred/gap-compressor.md)。

## 15. Memory 健康状态与用户告警

用户侧只需要统一的三档状态：

- `healthy`
- `degraded`
- `rebuilding`

共识：

1. 任何可能影响对话质量的问题都必须显式告知用户，包括 Provider/网络失败、target 积压、compaction halt、schema/state/hash 异常、dirty rebuild、gap compression 失败、RAG/Recall 未追平等。
2. 内部仍保存精确 reason、taskId、target、generation、attempt 等诊断信息，但不要求用户理解大量错误枚举。
3. 告警应持续到恢复完成，而不是只弹一次短暂提示。
4. 恢复后应明确提示 Memory 已追平到相应 boundary。
5. 主聊天默认继续；Memory target 可以因 compaction 无法完成而 halt。
6. Target halt 时其他 target 和主聊天继续，但用户必须知道对应记忆类别已暂停且可能滞后。
7. 管理员直接维护、resume/rebuild 等恢复入口不能因 target halt 而不可访问；同一 target 的普通 proposal 仍按顺序等待，不能绕过 halt。

## 16. 自动恢复

至少包含以下恢复路径：

1. Provider/网络临时错误：有限指数退避重试。
2. Lease 过期：sweeper 使用新 lease token reclaim；旧 worker 结果不得提交。
3. Revision/cursor stale：丢弃旧执行结果，按 durable task/proposal 和当前 state 重新校验。
4. Source dirty/generation 变化：启动 source rebuild。
5. State schema/hash 损坏：优先从 snapshot 恢复；必要时从 raw messages rebuild。
6. Compaction 失败：halt 对应 target，保留原 proposal，显式告警，等待 resume。
7. RAG/Recall projection 落后：保持 degraded/rebuilding，追平当前 generation 后恢复。

## 17. Source Generation 与 Rebuild

自动 source rebuild 只在已被 Memory 观察的 source 发生变化时触发：

- 编辑历史消息；
- regenerate 导致截断/删除后续消息；
- 删除历史消息；
- session trash/restore/permanent delete；
- 消息 preset 归属或可见性变化；
- raw source 排序语义变化。

普通追加 User/Assistant message 不增加 sourceGeneration，只唤醒 normal worker。

管理员可因以下原因显式 rebuild：

- state/schema/hash 损坏；
- 更换关键 Proposer prompt/model 后希望全量重新推导；
- Memory schema/compaction 语义发生不兼容变化；
- 人工判断当前 state 无法局部修复；
- v2 初次从 raw history 建立 state。

Rebuild 流程：

```text
sourceGeneration + 1
→ 设置 dirty
→ 取消旧 generation tasks
→ 初始化新 generation state + snapshot
→ 从当前有效 raw messages 重放
→ force drain 所有 target 到 captured boundary
→ 校验 state/snapshot/events/hash/cursors
→ 清 dirty
→ 用户状态 rebuilding → healthy
```

Raw source mutation、generation increment、dirty boundary、旧 task 取消和 Memory/RAG/Recall invalidation outbox 必须在同一数据库事务完成，禁止 controller 在 source 已提交后 best-effort 标 dirty。

## 18. Flush 与 Cutover

1. 不引入独立 Flush 子系统、Flush task type、Flush 状态机或专用持久化表。
2. 只保留 worker 内部的 `forceDrainTo(boundaryMessageId)` 能力，继续使用普通 durable tasks。
3. force drain 仅用于 source rebuild、管理员排查和一次性迁移/cutover。
4. Cutover 不是长期运行时子系统，只是一次性迁移流程。
5. Cutover 简化为：停止旧 worker/注入 → 删除旧 Memory → 部署 v2 → 捕获 boundary → rebuild/force drain → 校验 → 标记 ready → 注入 v2。
6. Cutover 未追平或校验失败时保持 rebuilding/degraded，不能把 v2 标为 ready。

## 19. Forget、Correction 与物理删除

1. Correction：用新 revision 更新错误 item，active state 只渲染新值，event history 保留旧 revision。
2. Forget：从 active state 移除 item，并写 context-suppression tombstone，阻止相同 source 在 rebuild/RAG/Recall 中重新进入上下文。
3. Privacy hard delete：跨 raw/event/snapshot/RAG/Recall/debug 派生存储执行物理清除。
4. “把 text 改成已作废”不是 forget，Renderer 不应继续注入被忘记内容。
5. Forget transaction 从完整 item revision/merge/duplicate event chain 收集相关 source messageId/hash，不能只看当前 revision。

## 20. RAG Suppression

当前阶段不引入 suppressionProposer，不尝试用新的 LLM 调用从一条多事实消息中精确识别应删除的语义片段。

当前确定性方案：

1. RAG chunk 必须能追踪其 source messageId/contentHash。
2. Forget/correction transaction 从被移除或被替换 item 的完整 event chain 收集 evidence messageId/hash，并写 context-suppression tombstone。
3. 与 suppressed message 相交的现有 RAG chunks 全部失效/删除。
4. RAG 重新分块和 embedding 时跳过 suppressed message；raw chat message 本身不修改。
5. RAG 查询再做一次 source suppression 过滤，命中 suppressed message 的 chunk 不返回。
6. Correction 的新消息正常进入 RAG，旧 evidence message 按上述规则排除。
7. 该方案会保守地排除同一消息中的其他无关事实；这是当前明确接受的副作用。
8. 使用 LLM 做片段级精确 suppression 的方案推迟到 [Suppression Proposer 延后设计](memory-control-v2-deferred/suppression-proposer.md)。

## 21. Provider Adapter

1. Memory worker 使用独立 structured-output Adapter，不复用裸文本解析路径。
2. Adapter 使用 Provider 原生 schema/tool/function 能力，并在返回后做本地结构校验。
3. 不支持 structured output 的 Provider/model 不能配置为 Memory Proposer。
4. Adapter 必须区分正常输出、网络失败、refusal/safety block、max-output truncation 和 schema invalid。
5. Prompt 约束用于提高成功率，Reducer/Adapter 代码校验用于保证结构边界；必须接受 LLM 偶尔不遵守 Prompt。
6. Provider 的物理 context/output 上限由 Adapter 处理，不转化为 Memory section 容量规则。

## 22. 并发、Lease 与幂等

1. Durable task 使用稳定 dedupe key，重复 wake-up 不创建重复任务。
2. 每次 claim 使用随机不可复用 lease token；提交前校验 task status、token 和 expiry。
3. Lease 过期并被新 token reclaim 后，旧 worker 即使晚收到 LLM 结果也不得提交。
4. 同一 user/preset 的 Memory Proposer 调用可在进程内串行化，减少共享 revision 导致的无效 LLM 调用；数据库 CAS 仍是最终 correctness 防线。
5. Reducer 校验 generation、cursorBefore 和 expectedRevision，禁止 cursor 回退、跳过 gap 或把旧 state 上的 itemId 决策 apply 到新 revision。
6. 相同 task/patchId 的重复 delivery 只能产生一组 events 和一个 state revision。
7. Compaction、proposal replay、snapshot 和 cursor 更新都必须满足同一幂等原则。

## 23. 运营与指标

需要记录但不直接阻断聊天的指标包括：

- calls/message；
- input/output tokens；
- Provider/model latency 与费用；
- schema failure；
- safety/refusal；
- unable rate；
- quote similarity 分布、quote-too-short/quote-not-found/quote-too-long rate；
- compaction success/failure/halt rate；
- deferred proposal age；
- queue age/backlog；
- revision/cursor stale；
- gapBridge raw/truncated/omitted；
- rebuild duration；
- RAG/Recall projection lag；
- Memory degraded/rebuilding 持续时间。

低价 LLM API 使多次调用成本可以接受，但不能因此忽略延迟、限流、失败率和错误累积。

## 24. 配置原则

下列变量必须进入集中配置并在文档中说明，不得散落硬编码：

- 每个 section 的 maxItems；
- 每个 section 的 maxRenderedChars；
- currentScene 过期时间；
- expiredScenes 保留/容量；
- overdue archive 时间；
- 每个 target 的 lagThreshold；
- gapBridge raw 字符预算；
- gapBridge 截断后保留的最近消息数；
- quote 模糊匹配算法与接受阈值；
- Provider retry/backoff；
- Compaction retry 次数与 target halt 条件；
- Snapshot/event/debug retention；
- 用户 degraded/rebuilding 告警防抖和恢复条件。

Evidence quote 最大 200 Unicode code points、模糊匹配默认阈值 0.8 已确定；其余具体默认值尚未最终固定，应根据真实历史分布和 Provider 能力选择。

---

本文是讨论共识清单，不替代最终拆分后的状态契约、写入协议、Prompt、Renderer、Harness 和迁移文档。正式文档修订时必须逐项映射，并删除与本清单冲突的旧设计。
