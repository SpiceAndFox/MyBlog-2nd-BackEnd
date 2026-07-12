# Memory Control 重构最终共识清单

> **归档说明（2026-07-12）**：本文是 12 批修订的历史执行清单，不再是当前设计的算法权威来源。静态契约以 `memory-control-v2/state-contract.md` 为准，算法与状态机以 `memory-control-v2/algorithms/README.md` 所列文档为准；后续不再把算法改动反向同步到本文。

本文汇总截至 2026-07-11 已达成的设计共识，作为后续正式修订 Memory Control 文档和实现的基线。讨论中已被推翻的早期方案不再具有约束力。

## 0. 应用顺序

修复意见按依赖关系分 12 批应用。每批是一个可独立审阅的内聚修改单元；批内修改紧密耦合，批末必须做跨文档一致性检查。依赖总序：State → Proposer/Cursor → Evidence/Capacity → Persistence/Recovery → Compaction → Domain Lifecycle → Context → Health → Rebuild/Projection → Forget/Suppression → Cross-cutting → Overview。

---

### 第 1 批：State 语义结构与权威状态（tmp.md §2、§3）

- **tmp.md 章节**：§2 权威状态与作用域、§3 State 结构
- **目标文档**：state-contract.md §1 §2、overview.md §5、`memory-control-v2-deferred/scene-snapshot-recall.md` §2.2 §5 §6.3（该文档已 defer，仍单向同步本批变更以保持一致性，但不影响当前实现）
- **关键变更**：
  - 确立 PostgreSQL `memory_state` 是唯一当前 Memory authority，旧 rolling/core 不再作为 v2 authority 或同时注入。
  - 正式 section 固定为 `scene`、`todos`、`standingAgreements`、`recentEpisodes`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`；不保留协议层 `core`。Todo overdue 使用同一 item 的 status，scene 历史使用单值 `current.previousScene`，两者均不是 section。
  - current.scene 与 session 完全解耦；sessionId 不 key scene、不触发 scene reset，也不复制到 evidence、event 或 Recall provenance。
  - 声明 userProfile/assistantProfile/worldFacts/relationship 允许 User 和 Assistant 双方维护；add/update policy 在第 3 批落地，forget 的 tombstone/suppression 语义在第 10 批同批落地。
  - 本批不定义 snapshot 事务、Recovery 替代机制或一次性迁移，分别留给第 4、9 批。
- **依赖**：无，首批。

### 第 2 批：Proposer 重组与 Target Cursor（tmp.md §4、§4.1）

- **tmp.md 章节**：§4 Target、Proposer 与 Cursor、§4.1 新 Proposer 的 readOnlyContext
- **目标文档**：state-contract.md §1 §3.1 §5.3、write-protocol.md §1.2 §2 §3、proposer-prompt.md §1 §2.3 §3 §4、overview.md §5 §8、harness.md §3.3 §3.5
- **关键变更**：
  - `coreProposer` 拆分为 `profileRelationshipProposer`（userProfile + assistantProfile + relationship）和 `worldFactProposer`（worldFacts）；normal Proposer 从 5 增至 6。
  - 用 `targetCursors` 替换 per-section cursor：todos / standingAgreements / episodes / profileRelationship / worldFacts / scene。
  - 联合处理的 sections 共享一个 cursor；maintenance task 不拥有 raw-message cursor。
  - 更新六个 Proposer 的 writable target、evidenceKind 派生枚举、envelope 和 readOnlyContext 固定范围。
- **依赖**：第 1 批的 section 结构。

### 第 3 批：Evidence、Quote 与基础容量规则（tmp.md §8、§9）

- **tmp.md 章节**：§8 Evidence 与 Quote、§9 Memory 容量与长度预算
- **目标文档**：state-contract.md §3 §4 §6 §7 §8、proposer-prompt.md §2.2 §3、harness.md §3.1 §3.2 §3.4
- **关键变更**：
  - 将双方对 userProfile/assistantProfile/worldFacts/relationship 的 add/update 权限落到 evidenceKind 和 section+op policy table；forget policy 留给第 10 批与 suppression 事务一起定义。
  - quote 上限改为 200 Unicode code points；归一化后至少 3 个信息字符；所有 quote 统一使用默认阈值 0.75 的 Levenshtein 模糊匹配。
  - 明确模糊匹配不能修复否定翻转等低编辑距离高语义影响，不引入否定词专项规则/NLI。
  - 基础容量统一为 `maxItems + maxRenderedChars`，只计 Renderer 可输出的语义文本；不设 Memory 业务层 proposal/envelope 总字符上限。
  - 本批只定义“超容量需维护”的基础语义；recentEpisodes、todo 中的 overdue 状态和 previousScene 的确定性例外在第 6 批完成。
- **依赖**：第 1 批的 sections、第 2 批的 Proposer/target 映射。

### 第 4 批：Snapshot、Event、Durable Task 与 per-target Recovery 基础（tmp.md §7、§16）

- **tmp.md 章节**：§7 Snapshot、Event 与恢复、§16 自动恢复
- **目标文档**：state-contract.md §1 §9、write-protocol.md §1.3 §3 §3.1 §8、harness.md §3.5 §3.10
- **关键变更**：
  - 在 `memory_state.meta` 落地单调 `revision`；snapshot/checkpoint 统一为每个成功 revision 的完整 post-state snapshot，与 state/events/cursor/task 终态同事务提交；不额外复制 pre-state snapshot。
  - 建立通用 revision/event group、durable task、ops log 和 per-target status，并定义通用 system cleanup event 机制。
  - 在替代机制同批落地时删除 `memory_state.meta.halted/recovery`；Recovery authority 迁到 durable task/per-target status/ops log。
  - Crash recovery 分为 snapshot/events 恢复语义 state，durable task/per-target status/ops log 恢复运行状态。
  - 本批不提前写 compaction/replay 的专用 revision 规则，也不列举 scene/todo 具体 cleanup event，分别留给第 5、6 批。
- **依赖**：第 1 批的 state，第 2 批的 target keys，第 3 批的 event/policy 字段语义。

### 第 5 批：Compaction 状态机与权限（tmp.md §5、§6）

- **tmp.md 章节**：§5 Proposal 持久化与 Compaction 状态机、§6 CompactionProposer 权限
- **目标文档**：write-protocol.md §2.1 §3 §3.1、state-contract.md §4 §6 §8 §9、proposer-prompt.md §2.3 §2.4 §3 §4、harness.md §3.5 §3.6
- **关键变更**：
  - 拆分 normal task 与 maintenance task 两条独立状态链：normal task stage（`proposal_persisted → capacity_blocked → replaying_original_proposal → succeeded | replay_failed`）和 maintenance task stage（`pending → compacting → compaction_applied | compaction_failed`）；`target_halted` 只是 per-target status，不是 task stage。maintenance task 必须持久化 `parent_task_id`，parent task 必须持久化当前 `maintenance_task_id`。
  - 禁止 accepted + deferred 非原子混合提交；capacity-blocked 时只为触发容量阻塞的 patch 写 `deferred` event（`result_revision=null`），其余 patch 暂不写最终 decision，完整 proposal 保存在 parent task；replay 时使用原稳定 `patchId` 写全部最终 `accepted/rejected/noop` events。一个多阶段 normal task 允许拥有"capacity-blocked 审计 group"和"最终 replay group"。
  - compaction 后从数据库确定性 replay 原 proposal，不重新调原 Proposer；compaction apply 和成功 replay 各自形成 revision+snapshot；replay_failed 只更新 task/status/ops log，不写语义 revision。
  - replay 的 stale 判定只看 target cursor 仍等于原 `cursorBefore`、proposal 仍是该 target 的活动 proposal、引用 item 仍存在并通过当前 state 的纯代码预检、schema/source hashes 仍兼容；其他 target 导致的全局 revision 增长不使 proposal stale；原始 `baseRevision` 只用于审计。replay revision 基于执行时最新全局 revision 创建。
  - `mergeItems` 只允许 compactionProposer；normal Proposer 删除主动去重权限；compactionProposer 只能同 section merge。Todo merge 的 `actor/requester/dueAt` 附加约束移到第 6 批随字段引入后落地；第 5 批只规定"仅 active todo、同 section 合并"。
  - Merge ID 由 Reducer 生成，evidenceGroups 从 source items 继承，pending proposal 引用的 itemIds 受硬保护；merge event 新增 `merged_from_item_ids` 列存储完整 source item IDs，不再使用 `itemIds.join(",")`。
  - per-target status 新增 `capacity_blocked` 值；capacity-blocked 期间 Observer 不为该 target 创建新 normal task；resume 不立即设 healthy，只有成功 replay、cursor 推进并提交 snapshot 后才恢复 healthy。
  - 多 section proposal 超容量时按 `task.targetSections` 固定顺序逐 section 压缩，每次只压缩一个阻塞 section，每次 compaction revision 后重新预检完整 proposal；仍有阻塞 section 时继续创建下一个 maintenance task，而不是立即 `replay_failed`；尝试上限按 `(parentTaskId, section)` 计算。
  - compaction/replay 无法完成时只 halt 对应 target，保留 proposal/cursor，其他 targets 和主聊天继续；resume 复用原 maintenance task 重新进入 compaction，不创建新 child task。
  - `sourceGeneration` 变化时 compaction/replay proposal 的 stale 分支移到第 9 批随 `sourceGeneration` 引入后落地；第 5 批依靠 cursor、source hashes、schema version 和 item 校验判定 replay 可行性。
- **依赖**：第 2 批的 targets，第 3 批的 capacity/policy，第 4 批的 durable task/snapshot/per-target status。

### 第 6 批：Scene 与 Todo/Overdue 领域生命周期（tmp.md §10、§11）

- **tmp.md 章节**：§10 Scene 生命周期、§11 Todo、Overdue 与时间
- **目标文档**：state-contract.md §1 §2 §4 §6 §8、write-protocol.md §1.3 §5、proposer-prompt.md §2.3 §3 §4、rendering-and-context.md §1 §5、harness.md §3.6 §3.8、`memory-control-v2-deferred/scene-snapshot-recall.md` §2 §3 §5 §6（该文档已 defer，仍单向同步本批变更以保持一致性，但不影响当前实现）
- **关键变更**：
  - Scene 到期写入单值 `current.previousScene` 并写 `scene_expired`；替换旧 previousScene 时写 `expired_scene_evicted`，不使用 compaction。
  - Renderer 将 previousScene 标记为过期/上次已知场景，housekeeping 未持久化时使用 effective view。
  - Todo 新增 actor/requester；dueAt 以 evidence message createdAt 为相对时间 anchor；`updateTodo.dueChange` 必须显式 keep/clear/set；todo merge 的 actor/requester/dueAt 相同约束在本批随字段引入后落地（从第 5 批移入）。
  - 到期 todo 留在 `working.todos`，原位更新 `status=overdue` 并保留 provenance，写 `todo_became_overdue`；overdue todo 可 complete/cancel，当前不 archive/compaction。
  - recentEpisodes 滑动窗口滚出、scene 和 todo 自动变化全部使用第 4 批的 system cleanup event 机制。
  - 完成 recentEpisodes、previousScene、todo overdue 状态对第 3 批基础容量规则的确定性例外。
- **依赖**：第 1 批的 sections，第 3 批的 capacity，第 4 批的 events，第 5 批的 compaction 边界。

### 第 7 批：上下文接入——needsMemory、LagThreshold、GapBridge（tmp.md §12、§13、§14）

- **tmp.md 章节**：§12 needsMemory 与 Recent Window、§13 LagThreshold 与尾批、§14 GapBridge
- **目标文档**：write-protocol.md §1.1 §2 §3、rendering-and-context.md §2、overview.md §6
- **关键变更**：
  - Memory Observer 不使用 user-boundary 裁剪，按 target cursor 读取完整 source。
  - `needsMemory` 采用简单 Unicode 字符阈值，不堆叠 message count/tokenizer/context 百分比。
  - recent window 可跨 session，不注入会改变语义处理的 session boundary 控制标记。
  - 尾部不足 lagThreshold 非 correctness bug；不引入 idle flush 或 session rollover flush。
  - 极长新消息挤出未处理尾批时由 per-target gapBridge 补齐。
  - GapBridge 按 target cursor 查询有效 gap（C < messageId < R），独立逻辑字符预算。
  - Gap 超预算时不调用 LLM 压缩，按 messageId 倒序选最近 N 条完整 raw messages 再恢复升序注入。
  - 截断必须持久化记录，进入 degraded 并向用户告警；单条超预算计入 omitted 并告警。
  - Source rebuild 必须忽略 lagThreshold，force drain 到 captured boundary。
- **依赖**：第 2 批的 target cursor，第 6 批的 Renderer/effective-view 领域规则。

### 第 8 批：Memory 健康状态与用户告警（tmp.md §15）

- **tmp.md 章节**：§15 Memory 健康状态与用户告警
- **目标文档**：write-protocol.md §3.1 §8、rendering-and-context.md §1 §5、overview.md §8、harness.md §3.7
- **关键变更**：
  - 用户侧统一三档状态：healthy / degraded / rebuilding。
  - per-target status 到用户侧状态映射表。
  - 任一 target 非 healthy 即整体显示对应告警；所有 target 恢复 healthy 后整体回到 healthy。
  - 告警必须持续到恢复完成，不只弹一次；恢复后明确提示 Memory 已追平。
  - Compaction/replay 无法完成时只 halt 对应 target，不设全局 chatBlocked 或 user/preset 级 halt（推翻原设计 halt 后聊天接口拒绝新消息）。
  - Renderer 继续渲染 halted target 最后一次成功提交的稳定 state，但标记"该类记忆可能滞后"。
  - resume/rebuild 等服务器维护脚本不受 target halt 限制。
- **依赖**：第 4 批的 per-target status，第 5 批的 compaction/replay halt 语义，第 7 批的 Renderer/GapBridge 接入。

### 第 9 批：Source Generation、Rebuild 与 Force Drain（tmp.md §17、§18）

- **tmp.md 章节**：§17 Source Generation 与 Rebuild、§18 Force Drain 与一次性迁移
- **目标文档**：write-protocol.md §7 §8、state-contract.md §1 §9、rendering-and-context.md §3、overview.md §8、harness.md §3.10、`memory-control-v2-deferred/scene-snapshot-recall.md` §3.5 §6.4（该文档已 defer，仍单向同步本批变更以保持一致性，但不影响当前实现）
- **关键变更**：
  - 自动 source rebuild 触发条件：编辑历史、regenerate 截断、删除、session trash/restore、preset 归属变化、排序语义变化。普通追加不增 sourceGeneration。
  - 在 `memory_state.meta` 落地单调 `sourceGeneration`，并将它作为 Memory/RAG/Recall source invalidation 的共享权威世代；`sourceGeneration` 变化时 compaction/replay proposal 的 stale 分支在本批随字段引入后落地（从第 5 批移入）。
  - Rebuild 流程：generation+1 → 设置 dirty → 取消旧 tasks → 初始化新 state+snapshot → 从 raw messages 重放 → force drain → 校验 → 清 dirty → healthy。
  - Raw source mutation、generation increment、dirty boundary、旧 task 取消必须同事务；不引入通用 outbox。
  - RAG/Recall 各自持久化独立 projection checkpoint（processedGeneration + processedBoundaryMessageId）；不因 Memory target 追平就推定 RAG/Recall 追平。
  - 不引入独立 Flush 子系统/task type/状态机/持久化表；只保留 worker 内部 `forceDrainTo(boundaryMessageId)`。
  - 一次性迁移简化为：停服 → 更新 schema/代码 → 物理删除旧 Memory → rebuild/force drain → 校验 → 启服。
  - Rebuild 未追平或校验失败时不得启动对外聊天服务。
- **依赖**：第 1 批的 authority/state，第 2 批的 target cursors，第 4 批的 snapshot/recovery，第 8 批的 degraded/rebuilding 告警语义。

### 第 10 批：Forget、Correction 与 RAG Suppression（tmp.md §19、§20）

- **tmp.md 章节**：§19 Forget、Correction 与物理删除、§20 RAG Suppression
- **目标文档**：state-contract.md §4、write-protocol.md §5、rendering-and-context.md §3、overview.md §8、harness.md、`memory-control-v2-deferred/scene-snapshot-recall.md` §4 §6.4（该文档已 defer，仍单向同步本批变更以保持一致性，但不影响当前实现）
- **关键变更**：
  - Correction：新 revision 更新错误 item，active state 只渲染新值，event history 保留旧 revision。
  - Forget：从 active state 移除 item + 写 context-suppression tombstone，阻止相同 source 在 rebuild/RAG/Recall 重新进入上下文。
  - 在本批完整落地 User 和 Assistant 双方对 userProfile/assistantProfile/worldFacts/relationship 的 forget policy，不在早期批次先定义一个没有 tombstone 语义的删除 op。
  - Privacy hard delete：跨 raw/event/snapshot/RAG/Recall/debug 物理清除。
  - "把 text 改成已作废"不是 forget；Renderer 不应继续注入被忘记内容。
  - Active item evidenceGroups 必须完整覆盖历史来源：update 只追加 evidenceGroup，merge 继承所有 source items 的 evidenceGroups。
  - Forget 直接从当前 item 完整 evidenceGroups 收集 source messageId/hash 生成 suppression tombstone，不新增 provenance graph。
  - RAG chunk 必须追踪 source messageId/contentHash；forget/correction 写 tombstone 后相交 RAG chunks 失效/删除；RAG 重新分块跳过 suppressed message；RAG 查询再做 source suppression 过滤。
  - 不引入 suppressionProposer；保守排除同一消息中其他无关事实是当前接受的副作用。
- **依赖**：第 3 批的 evidence/policy，第 5 批的 mergeItems/evidenceGroups 继承，第 9 批的 rebuild/projection drain。

### 第 11 批：Provider Adapter、串行幂等、指标、配置、延后清单（tmp.md §21、§22、§23、§24、§25）

- **tmp.md 章节**：§21 Provider Adapter、§22 单实例串行与幂等、§23 运营与指标、§24 配置原则、§25 明确延后的问题
- **目标文档**：state-contract.md §10、write-protocol.md §3 §8、overview.md §3 §8、harness.md §3.7
- **关键变更**：
  - Adapter 必须区分：正常输出、网络失败、refusal/safety block、max-output truncation、schema invalid（新增 truncation 区分）。
  - 不支持 structured output 的 Provider/model 不能配置为 Memory Proposer。
  - Provider 物理上限由 Adapter 处理，不转化为 Memory section 容量规则。
  - Durable task 使用稳定 task identity/dedupe key；Reducer 提交前校验 generation、cursorBefore、当前 revision。
  - 相同 task/patchId 重复恢复只产生一组 events 和一个 state revision。
  - 指标清单：calls/message、tokens、latency、费用、schema failure、safety/refusal、unable rate、quote 分布、compaction success/failure、replay_failed、target halt rate、deferred proposal age、queue age、revision/cursor stale、gapBridge raw/truncated/omitted、rebuild duration、RAG/Recall projection lag、degraded/rebuilding 持续时间。
  - normal Proposer 从 5 增至 6，分 target 监控；如拆分导致成本/延迟不可接受再根据真实指标调整。
  - 集中配置变量清单；quote 200 code points 已确定，模糊匹配阈值 0.75 可配置，其余默认值待真实分布确定。
  - 延后清单：LLM Suppression Proposer、Gap Compressor、长期 overdue todo 的归档/检索/清理。
- **依赖**：第 2 批的 Proposer 数量，第 3 批的 quote/capacity 配置，第 5 批的 compaction/replay 指标，第 7 批的 gapBridge 指标，第 9 批的 rebuild/projection 指标。

### 第 12 批：总体原则与 overview 收尾（tmp.md §1、§1.1）

- **tmp.md 章节**：§1 设计方法与总体原则、§1.1 原设计继承原则
- **目标文档**：overview.md（全局）、所有子文档（一致性检查）
- **关键变更**：
  - overview.md 反映瀑布式设计方法：设计阶段一次性覆盖 deferred/compaction/snapshot/replay/overdue/expired scene/gapBridge/用户告警/forget/RAG suppression 完整能力。
  - 实现按依赖顺序分层推进，但已确定功能不延期。
  - LLM 负责语义判断和候选变更；Reducer 负责纯代码可验证的结构/作用域/权限/证据/容量/并发/事务约束。
  - 接受 LLM 语义判断偏差；Reducer 不宣称能证明 text 被 evidence 蕴含，不要求 LLM 判断"高风险事实"。
  - 可恢复性目标：避免静默丢失/重复应用、崩溃恢复、追踪错误记忆来源、forget 后不被自动重建、区分模型/Reducer/事务错误。
  - 原设计继承原则：未明确修改的契约继续有效；省略不代表删除；讨论稿实现细节非已定规范。
  - 全文档一致性检查：确保 overview §8 决策清单、§3 非目标、§9 成功标准与各子文档修订一致。
- **依赖**：第 1-11 批全部完成。

---

## 1. 设计方法与总体原则

1. 本次重构采用偏瀑布式设计：设计阶段一次性覆盖 deferred、compaction、snapshot、replay、overdue、expired scene、gapBridge、用户告警、forget/RAG suppression 等完整能力，不以“首版先删除、以后再补”为默认策略。
2. 实现仍按依赖顺序分层推进和验收，但这是工程实施顺序，不代表把已确定功能延期到不明确的未来。
3. 设计在完整性和可落地性之间取平衡：只为明确的故障路径引入机制；能用简单确定性规则解决的问题，不堆叠多套预算、风险分类或 LLM 判断。
4. LLM 负责语义判断和提出候选变更；Reducer 负责纯代码可验证的结构、作用域、权限、证据、容量、并发和事务约束。
5. 接受 LLM 语义判断存在一定偏差。Reducer 不宣称能够证明自然语言 text 一定被 evidence 语义蕴含，也不要求 LLM 判断“高风险事实”。
6. 可恢复性的目标包括：避免静默丢失/重复应用、支持崩溃恢复、追踪错误记忆来源、保证 forget 后不会被自动重建，以及区分模型错误、Reducer 错误和事务错误。

### 1.1 原设计继承原则

1. 本文是对原 Memory Control v2 设计的变更共识，不是通过省略内容重新定义全部契约。
2. 未在本文中明确修改、替换或延后的原设计契约继续有效；本文省略不代表删除。
3. item/evidenceGroups/evidenceKind/op/policy table、Proposer envelope/readOnlyContext、Prompt、Renderer、Scene Snapshot/Recall 等未在本文完整重述的契约，默认继承原正式文档。
4. 未经明确确认的实现细节不得因为出现在讨论稿中就被视为已定规范；明确推迟的问题统一记录在 `memory-control-v2-deferred`。

## 2. 权威状态与作用域

1. PostgreSQL 中的结构化 `memory_state` 是新系统唯一的当前 Memory authority。
2. 旧 rolling summary/core memory 不转换为新系统 authority，也不与新 Memory 同时注入。
3. 最终迁移时停止旧 worker/注入并物理删除旧 Memory 数据；新系统从 raw messages 重建。
4. 每个成功提交的 Memory revision 都保存 state snapshot。当前不强制额外生成数据库外部备份；如果运维层自行备份，备份不得进入应用上下文或提供给 Agent。
5. user/preset 下的对话跨 session 语义连续。session 只是按天或 UI 划分的存储单元，不是 Memory 或 scene 的语义边界。
6. `sessionId` 不复制到 evidence、event 或 Recall provenance；这些结构通过 messageId/source messageIds 追溯来源。

## 3. State 结构

目标 state 至少包含以下语义 section：

```js
{
  version: 2,
  current: {
    scene: {/* 固定字段 */},
    previousScene: null
  },
  working: {
    todos: [],
    standingAgreements: [],
    recentEpisodes: []
  },
  longTerm: {
    milestones: [],
    worldFacts: [],
    userProfile: [],
    assistantProfile: [],
    relationship: []
  },
  meta: {
    revision,
    sourceGeneration,
    targetCursors: {}
  }
}
```

正式 section 固定为 `scene`、`todos`、`standingAgreements`、`recentEpisodes`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`。`core` 只可作为产品文案中的“长期核心记忆”概念，不得作为 patch、sectionResults、event、policy 或 compaction 的协议 section。以下语义不可改变：

- current.scene 与 session 完全解耦。
- `current.previousScene` 是 Reducer 维护的单值衍生字段，不是正式 section，也不拥有 cursor。
- overdue 是 `working.todos` item 的 lifecycle status，不是独立 section 或数组。
- recentEpisodes 与 milestones 联合处理但分别存储。
- userProfile 与 assistantProfile 都允许 User 和 Assistant 双方全权 add/update/forget。
- worldFacts 与 relationship 同样允许双方 add/update/forget。
- evidence role 仍按数据库真实消息校验，但不再用 role 限制 User/Assistant 对两个 Profile 的操作权。
- `memory_state.meta` 不再保存旧 `recovery: {}`；Recovery 能力没有删除，而是迁移到 durable task、per-target status 和 ops log，详见 §16。

## 4. Target、Proposer 与 Cursor

一个 Proposer 联合处理的多个 section 必须共享一个 target cursor，禁止“共享 Proposer + 独立 section cursor”。

| targetKey             | Proposer                    | 可写 section                                         | cursor                |
| --------------------- | --------------------------- | ---------------------------------------------------- | --------------------- |
| `scene`               | currentStateProposer        | current.scene                                        | `scene`               |
| `todos`               | todoProposer                | working.todos；overdue 为同一 item 的 Reducer 状态   | `todos`               |
| `standingAgreements`  | agreementProposer           | working.standingAgreements                           | `standingAgreements`  |
| `episodes`            | episodeProposer             | working.recentEpisodes、longTerm.milestones          | `episodes`            |
| `profileRelationship` | profileRelationshipProposer | longTerm.userProfile、assistantProfile、relationship | `profileRelationship` |
| `worldFacts`          | worldFactProposer           | longTerm.worldFacts                                  | `worldFacts`          |

约束：

1. 一个 normal task 只有一个 cursorBefore、newBatch、targetMessageId 和 proposal。
2. episodeProposer 联合判断普通 episode 和 milestone，可以一次输出两类 patch。
3. todoProposer 和 agreementProposer 保持独立，不共享 Proposer 或 cursor。
4. overdue 由 Reducer 根据 todo 的 dueAt 确定性原位更新，不新增 section、cursor 或 commitmentProposer。
5. cursor 只在该 task 的 proposal 全部形成终局后推进。
6. Compaction task 不拥有独立 raw-message cursor；它是被 capacity-blocked normal task 派生出的维护任务。
7. profileRelationshipProposer 联合判断 User Profile、Assistant Profile 和 Relationship，三个 section 共享一个 cursor。
8. worldFacts 由独立 worldFactProposer 处理，不与 Profile/Relationship 共享 cursor。
9. 相比原设计的 5 个 normal Proposers，所有 targets 同时 eligible 时的最大 LLM 调用数增至 6；Observer 仍只调用达到触发条件的 target，不得每 tick 无条件调用全部 Proposers。

### 4.1 新 Proposer 的 readOnlyContext

| Proposer                    | writableState                                        | readOnlyContext                                                                                                                              |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| profileRelationshipProposer | longTerm.userProfile、assistantProfile、relationship | current.scene、working.recentEpisodes、working.standingAgreements、longTerm.milestones、longTerm.worldFacts                                  |
| worldFactProposer           | longTerm.worldFacts                                  | current.scene、working.recentEpisodes、working.standingAgreements、longTerm.milestones、longTerm.userProfile、assistantProfile、relationship |

两者继承原 envelope 边界：writableState item 可保留 ID 以供 update/forget；readOnlyContext item 不暴露 ID 或 evidenceGroups，只作语义背景，不能单独证明新事实或作为 evidenceRefs 来源。

## 5. Proposal 持久化与 Compaction 状态机

保留 deferred、LLM compaction 和 compaction 后确定性重放，但禁止 accepted + deferred 的非原子混合提交。

状态分属两类 task 和 per-target status，不是单条链：

**Normal task stage**（`task_type=normal`）：

```text
pending → proposing → proposal_persisted
→ capacity_blocked
→ replaying_original_proposal
├→ succeeded
└→ replay_failed
```

**Maintenance task stage**（`task_type=maintenance`）：

```text
pending → compacting
├→ compaction_applied       # 至少一个 patch apply 成功（其他可能因保护而 reject，见规则 12）
└→ compaction_failed        # 全部 patch 被保护或无安全合并空间
```

`target_halted` 只是 per-target status（`capacity_blocked` 或 `halted`），不是 task stage。maintenance task 必须持久化 `parent_task_id` 指向 normal task；normal task 的 `stage_payload` 持久化当前 `maintenance_task_id`。

完整规则：

1. Proposer 输出经结构校验后，为每个 patch 分配稳定 patchId。
2. 在 apply 任何 patch 前，完整持久化原 proposal、source hashes、cursorBefore、targetMessageId、prompt/model/schema 版本到 normal task 的 `task_payload`。`sourceGeneration` 在第 9 批引入后加入持久化范围。
3. Reducer 先预检整个 proposal bundle（schema、evidence、policy、结构化冲突、容量）。
4. 如果任一 patch 因 section 条数或可渲染字符容量需要 compaction，本轮不 apply proposal 中的任何 patch，避免 partial commit。normal task 进入 `capacity_blocked`，per-target status 进入 `capacity_blocked`。
5. capacity-blocked 事务只为真正触发容量阻塞的 patch 写 `decision=deferred`、`result_revision=null` 的 event group（"capacity-blocked 审计 group"）；其他 patch 暂不写最终 decision，完整 proposal 保存在 parent task。同事务创建 maintenance task（`task_type=maintenance`、`parent_task_id` 指向 normal task），normal task 的 `stage_payload` 持久化 `maintenance_task_id`。
6. maintenance task 按 `task.targetSections` 固定顺序，每次只压缩一个阻塞 section。每次 compaction revision 后重新预检完整 proposal 的模拟 post-state；仍有其他阻塞 section 时继续创建下一个 maintenance task，而不是立即 `replay_failed`。尝试上限按 `(parentTaskId, section)` 计算，同一 section 对同一阻塞窗口最多尝试 1 次。
7. Compaction 成功释放容量后，normal task 从 `capacity_blocked` 进入 `replaying_original_proposal`。从数据库读取原 proposal，在当前 state 上先对完整 proposal 重做纯代码预检，预检通过后才确定性 replay；不得重新调用原 Proposer。
8. Replay 时使用原稳定 `patchId` 为全部 patch 写最终 `accepted/rejected/noop` events（"最终 replay group"）。普通 rejected 仍允许与 accepted 在最终 replay revision 中共存，禁止的只是 `accepted + capacity-deferred` 混合提交。replay revision 基于执行时最新全局 revision 创建。
9. Compaction 已提交但 replay 预检仍因容量不足而失败时，进入 `replay_failed`，reason=`capacity_still_exceeded`；原 proposal 保留、cursor 不推进、replay 不产生部分 state 变更。
10. Replay 的其他非 stale 确定性失败同样进入 `replay_failed`，并记录精确 reason。`sourceGeneration` 在此期间变化的 stale 分支由第 9 批定义；第 5 批的 replay stale 判定只看以下条件：
    - 当前 target cursor 仍等于原 `cursorBefore`；
    - proposal 仍是该 target 的活动 proposal（normal task 非终局）；
    - 引用 item 仍存在并通过当前 state 的纯代码预检；
    - schema/source hashes 仍兼容。

    其他 target 导致的全局 revision 增长不使 proposal stale；原始 `baseRevision` 只用于审计。
11. `replay_failed` 终局只原子更新 durable task、per-target status 和 ops log；因为 replay 尚未产生语义变更，不增加 Memory revision，不写新 state snapshot。
12. Pending proposal 保护：Reducer 对 compaction patch 的 `itemIds` 与该 target 所有 pending（capacity_blocked/compacting）proposal 引用的 itemId 集合做交集校验——这是纯代码硬校验，不是 prompt 约束。相交的 compaction patch 被 reject，reason=`item_protected_by_pending_proposal`；该 compaction patch 不 apply，同一 maintenance task 的其他 patch 仍可正常 apply。一个 maintenance task 的全部 patch 均因保护而 reject 时，视同 `unable_to_compact`，进入 `compaction_failed`。
13. Compaction/replay 必须记录实际释放的 item 数和 rendered chars，以便诊断 replay 为何仍然超容量。
14. Compaction 或 replay 失败时只 halt 对应 Memory target：该 target 的 cursor 不推进，原 proposal 保留，后续 normal proposals 暂停。
15. 其他 Memory targets 和主聊天继续运行；系统不设置由 Memory target halt 派生的全局 `chatBlocked` 或 user/preset 级 halt。
16. Halt 时必须显式告知用户受影响的 Memory 类别、暂停原因和滞后边界，不得只写后台日志。
17. 通过服务器维护脚本清理容量、调整配置、更换模型或修复问题后，只 resume 对应 target。resume 复用原 maintenance task 重新进入 compaction，不创建新 child task。resume 不立即设 healthy：per-target status 从 `halted` 变为 `capacity_blocked`，只有原 proposal 成功 replay、cursor 推进并提交 snapshot 后才恢复 `healthy`。maintenance 脚本可绕过 halt，普通 Observer 不可绕过。

## 6. CompactionProposer 权限

1. 只有 compactionProposer 可以输出 `mergeItems`。
2. normal Proposer 永远不能输出 mergeItems。
3. compactionProposer 只能输出 mergeItems，不能输出 add/update/forget/complete/cancel。
4. mergeItems 不能跨 section。
5. compaction 是 system maintenance operation，不伪装成普通 message evidenceKind。
6. Merge 后的新 item ID 由 Reducer 生成 UUID/ULID，禁止使用 `itemIds.join(",")`。
7. Merge event 必须记录 `mergedFromItemIds`（完整 source item ID 数组，按持久化 patch 中的稳定顺序）、resultItemId 和 replay 所需完整 normalized value。event 表新增 `merged_from_item_ids` 列存储该数组，merge event 的 `item_id` 列为 null。`normalized_operation` 同时包含 source IDs、resultItemId 和完整最终 merged item。删除所有 `itemIds.join(",")` 规则。
8. 被合并旧 items 从 active state 移除，但历史通过 event chain 保留。
9. Merge 后 evidence 从输入 items 继承，compactionProposer 不能伪造 raw-message evidence。
10. compactionProposer 可维护 todos 的 active items、standingAgreements、milestones、userProfile、assistantProfile、relationship 和 worldFacts；recentEpisodes 仍由 Reducer 的滑动窗口处理。
11. previousScene 和 overdue todo 不使用 compactionProposer：previousScene 是单值替换字段，overdue todo 仅限制 Renderer 注入的最新 N 条和可渲染字符数。
12. Merge 的前置约束对所有 section 通用：被合并的 item 不得被任何 pending proposal 引用（§5 规则 12 的 Reducer 硬校验）。Todo merge 额外要求同 section、仅限 active items；`actor/requester/dueAt` 相同约束移到第 6 批随字段引入后落地。

## 7. Snapshot、Event 与恢复

1. State snapshot/checkpoint 是同一个概念：某个 revision 的完整权威 state，不再为每个 section 设计互不一致的恢复 checkpoint。
2. 每个成功提交的 state revision 都在同一事务写一份完整 post-state snapshot。
3. 一个 task bundle 即使包含多个 patch，也只产生一个 revision 和一份 snapshot。
4. 因为 revision N 已有 post-state snapshot N，所以 revision N+1 修改前天然已有“修改前 snapshot”，不需要额外复制一份 pre-state snapshot。
5. Compaction apply 和原 proposal replay 各自形成明确 revision，并各自同步 snapshot。
6. sourceGeneration 初始化或递增时必须同事务写完整 snapshot。
7. State、events、snapshot、cursor、task 终态和 target health 必须在同一事务提交。
8. Snapshot 包含全部语义 section、全部 target cursors、revision 和 sourceGeneration；不包含 task retry/错误计数等运行恢复状态。这些状态必须在专用表中持久化，并非只保存在进程内。
9. Event replay 不重新调用 LLM，只使用 event 中的 normalized applied operation、result item ID 和确定性字段。
10. Add event 的 result item ID 不能为 null。
11. 为解决 eventId/itemId/provenance 的循环依赖，Reducer 在事务中预留 event IDs、生成 item IDs、构造最终 state，再插入完整 events。
12. 自动 overdue 状态更新、scene expiry、recentEpisodes 滑动窗口滚出等持久化变化必须记录 system cleanup event，禁止 silent delete。
13. Event/snapshot replay 必须校验 schema、revision 连续性、cursor 连续性和 group task/target 一致性。当前不引入 state hash。

## 8. Evidence 与 Quote

Reducer 对 evidence 做以下纯代码校验：

1. messageId 必须属于 task observed messages。
2. 数据库中的 user、preset、role、createdAt、content hash 必须与 proposal 时一致。
3. 普通 patch 的 evidence 可来自 task 的 observed messages（包括 newBatch 和 overlap）；不增加“至少一条必须来自 newBatch”的硬校验。
4. quote 必须非空，不能只有空白或纯标点。
5. quote 和 raw content 继承原设计的同一套确定性归一化：转小写并去除空白和配置中明确列出的标点差异。正式 schema 必须固定具体函数和标点集，不得由各 Provider 或调用点自行实现。
6. 归一化 quote 必须至少包含 3 个非空白、非标点/符号的信息字符，否则拒绝对应 patch，reason=`quote_too_short`。
7. 所有长度的 quote 统一使用模糊匹配，不再设置短文本精确、长文本模糊的双路径。
8. Reducer 在归一化 raw content 中寻找 quote 的最佳等长匹配窗口，继承原设计的 Levenshtein normalized similarity 算法；默认接受阈值为 0.75，具体值进入集中配置。
9. 低于阈值时拒绝对应 patch，reason=`quote_not_found`。
10. 每个 quote 最大为 200 个 Unicode code points；Reducer 按 code point 计数，超出时拒绝对应 patch，reason=`quote_too_long`，不自动裁剪。
11. Prompt 明确要求复制“能够支持 patch 的最短连续原文，最多 200 个 Unicode 字符”，但必须接受 LLM 可能无法精确复制；Reducer 的模糊匹配是最终接收规则。
12. 通用模糊匹配不能修复否定词删除、数字/姓名替换等低编辑距离但高语义影响的问题；系统明确接受这一剩余风险，不得在文档中宣称已解决否定翻转。
13. 不引入否定词专项规则、高风险事实识别或自然语言蕴含验证。

## 9. Memory 容量与长度预算

除下文明确的确定性例外外，每个会进入主聊天上下文的 Memory item section 只使用两个容量维度：

```js
{
  (maxItems, maxRenderedChars);
}
```

规则：

1. `maxRenderedChars` 只计算可能被 Renderer 输出的语义文本，例如 item.text 和 scene value。
2. quote、evidence、hash、ID、provenance、event、task proposal、compaction audit 等不渲染内容不计入 Memory 容量。
3. 普通 item section 超过 maxItems 或 maxRenderedChars 时，proposal 进入 deferred/compaction 状态机；recentEpisodes、previousScene 和 overdue todo 使用下述确定性例外，不调用 compactionProposer。
4. 不设置 Memory 业务层的 Proposer proposal/envelope 总字符上限。
5. 不要求 LLM 自己准确控制 proposal 总字符数。
6. Provider context/output 的物理硬上限仍然存在，但它属于 Adapter/Provider 能力边界，不是 Memory 容量策略。
7. Observer 在请求超过 Provider 能力时缩小 batch；单条消息仍无法处理时进入 degraded 并显式提醒，不能静默丢弃。
8. 各 section 的容量、scene TTL、overdue todo 渲染条数、lagThreshold、gapBridge 预算等都从集中配置读取，禁止散落硬编码。
9. 除 quote 最大 200 已确定外，其余具体默认数值需结合真实历史分布确定并写入配置文档。
10. recentEpisodes 超限时滚出最旧 item 并记录 system cleanup event。
11. `current.previousScene` 是单值字段；新 scene 过期时替换旧值并记录 `system_cleanup: expired_scene_evicted` event。
12. `todos` 的容量门只统计 `status=active` 的 items；overdue todo 不阻塞写入或触发 compaction，Renderer 只按 `becameOverdueAt DESC` 注入配置的最新 N 条，并受独立 maxRenderedChars 约束。

## 10. Scene 生命周期

1. current.scene 是 user/preset 级状态，与 session 完全解耦。
2. current.scene 使用固定字段 shape；clearField 将对应 value 设为 null 并保留清除 event/provenance，不删除字段。
3. current.scene 有配置化过期时间，不得硬编码在业务代码中。
4. Scene 到期后不直接丢弃，而是把完整旧值写入单值 `current.previousScene`。
5. 写入时保留 scene 值和 provenance，写 `system_cleanup: scene_expired` event，并清空 current.scene 固定字段。
6. 新 scene 过期时替换旧 previousScene，写 `system_cleanup: expired_scene_evicted` event，不调用 compactionProposer。
7. Renderer 将 previousScene 明确标为“已过期场景/上次已知场景”，不得称为当前状态。
8. Renderer 在后台 housekeeping 尚未持久化时先构造 effective view，避免本次请求继续把已到期 scene 标成 current。

## 11. Todo、Overdue 与时间

1. Todo 必须保存结构化 actor 和 requester，而不只保存 text。
2. actor 合法值为 user/assistant/both；requester 表示提出请求或承诺的一方。
3. 相对时间以 evidence message 的 createdAt 为 anchor，不使用 worker/task 执行时间。
4. `dueAt` 表示 deadline，不表示直接删除时间。
5. 当 `now >= dueAt` 时，由纯代码在 `working.todos` 内原位将 item 的 `status` 从 `active` 更新为 `overdue`，保留 itemId、actor、requester、dueAt 和 provenance，并记录确定性 `becameOverdueAt`。
6. 状态更新写 `system_cleanup: todo_became_overdue` event。
7. Renderer 在持久化状态更新尚未执行时先按 overdue 渲染 effective view。
8. Overdue todo 可以 complete/cancel。当前不自动 archive，更精细的归档、检索和清理策略推迟处理。
9. Todos 的 maxItems/maxRenderedChars 只约束 active items；overdue todo 只为 Renderer 设置独立 maxRenderedItems/maxRenderedChars，不占用 active todo 容量。
10. `updateTodo` 必须显式输出 dueChange union：keep、clear 或 set；字段省略不能同时表示“不修改”和“清空”。

## 12. needsMemory 与 Recent Window

1. 主聊天 recent window 继续保留 user-boundary 裁剪，避免上下文从孤立的 Assistant 回复开始。
2. Memory Observer 不使用 user-boundary 裁剪，必须按 target cursor 读取完整 source。
3. `needsMemory` 采用简单的 Unicode 字符阈值作为主要判断，不同时堆叠 message count、tokenizer 预估和 context 百分比。
4. session 之间语义连续，因此 recent window 可以跨 session；不向 Proposer 注入会改变语义处理的 session boundary 控制标记。

## 13. LagThreshold 与尾批

1. 普通聊天中，尾部不足 lagThreshold 不视为 correctness bug。
2. 后续新消息到达后可与旧尾批一起处理；在此之前 recent window 仍提供原文覆盖。
3. 不引入普通 idle flush 或按 session rollover flush。
4. 极长新消息把未处理尾批挤出 recent window 时，由 per-target gapBridge 补齐。
5. Source rebuild 必须忽略 lagThreshold，force drain 到 captured boundary 后才能清 dirty。
6. 一次性迁移和服务器维护脚本排查也可调用相同内部 force-drain 能力。

## 14. GapBridge

1. GapBridge 按每个 target cursor 查询有效 gap，不再依赖 legacy summarizedUntilMessageId。
2. 对 recent window 起点 R 和 target cursor C，gap 是 target scope 中满足 `C < messageId < R` 的有效消息集合。
3. GapBridge 拥有独立逻辑字符预算，不与 Memory Renderer 的 section 容量竞争。
4. Gap 未超预算时直接注入 raw messages。
5. Gap 超预算时不调用 LLM 压缩，而是按 messageId 倒序选择最近 N 条完整 raw messages，再恢复为升序注入；N 和字符预算进入集中配置。
6. 截断结果必须持久化记录“已截断”、省略规模和保留边界，不能伪装成完整 gap。
7. 发生截断时继续主聊天，但进入 degraded，并向用户明确告警“部分早期对话未在上下文中”；旧 target state 必须标记为可能滞后，不能无提示声称是当前状态。
8. 单条 raw message 本身超预算时，当前回退只能将其计入 omitted 并显式告警，不截断后伪装成完整原文；压缩或其他精细处理与 Gap Compressor 一并推迟。
9. GapBridge 的逻辑预算独立，但其最终文本仍计入主模型不可突破的物理 context 上限。
10. 使用 LLM 压缩超预算 gap 的方案推迟到 [Gap Compressor 延后设计](memory-control-v2-deferred/gap-compressor.md)。

## 15. Memory 健康状态与用户告警

用户侧只需要统一的三档状态：

- `healthy`
- `degraded`
- `rebuilding`

下表是 per-target status（§16.1）到用户侧状态的概念映射，用于说明语义，不锁定最终数据库枚举或 schema：

| per-target status | 用户侧状态   | 说明                                                                            |
| ----------------- | ------------ | ------------------------------------------------------------------------------- |
| `healthy`         | `healthy`    | 该 target 正常运行                                                              |
| `retry_wait`      | `degraded`   | 瞬时错误退避重试中，记忆可能滞后                                                |
| `capacity_blocked`| `degraded`   | 容量阻塞，等待 compaction/replay，记忆可能滞后                                  |
| `halted`          | `degraded`   | compaction/replay 无法完成，该 target 已暂停且可能滞后，需服务器维护脚本 resume |
| `rebuilding`      | `rebuilding` | source rebuild 进行中                                                           |

任一 target 非 healthy 即整体显示对应 degraded/rebuilding 告警；所有 target 恢复 healthy 后整体回到 healthy。

共识：

1. 任何可能影响对话质量的问题都必须显式告知用户，包括 Provider/网络失败、target 积压、compaction halt、schema/state 异常、dirty rebuild、gap 超预算截断导致的上下文覆盖不完整、RAG/Recall 未追平等。
2. 内部仍保存精确 reason、taskId、target、generation、attempt 等诊断信息，但不要求用户理解大量错误枚举。
3. 告警应持续到恢复完成，而不是只弹一次短暂提示。
4. 恢复后应明确提示 Memory 已追平到相应 boundary。
5. Compaction 或原 proposal replay 无法完成时必须 halt 对应 Memory target；其他 targets 和主聊天继续运行。
6. Halt 时用户必须知道对应记忆类别已暂停、原因、cursor/处理边界和需要人工恢复，不得只写后台日志。
7. Renderer 继续渲染 halted target 最后一次成功提交的稳定 state，但必须在 Memory context 中明确标记“该类记忆可能滞后”；recent window 和该 target 的 GapBridge 仍可提供未写入 Memory 的 raw-message 覆盖。
8. resume/rebuild 等服务器维护脚本不受 target halt 限制；在 resume 完成前，只有该 target 的普通 proposal 不得绕过 halt。
9. 对应 target 成功完成 compaction 并 replay 原 proposal 后恢复 `healthy`；不要求其他 targets 同步 resume。

## 16. 自动恢复

### 16.1 Recovery 状态归属

旧设计中的 `memory_state.meta.recovery` 不再作为语义 state 字段，但其中能力必须完整迁移，不能静默丢弃。

字段归属：

| 旧 recovery 字段/语义      | 新持久化位置                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `consecutiveErrors`        | per-target status                                            |
| `awaitingContextExpansion` | 当前 durable task/proposal 的 `contextExpansionAttempt`      |
| `lastErrorReason`          | per-target status，同时写 ops log                            |
| `lastErrorTickId`          | ops log 的 taskId/attempt；per-target status 保存 lastTaskId |
| halt 状态与原因            | per-target status                                            |
| retry attempt/notBefore    | durable task                                                 |
| 完整错误历史               | ops log                                                      |

建议的 per-target status 概念结构：

```js
{
  userId,
  presetId,
  sourceGeneration,
  targetKey,
  status: "healthy" | "retry_wait" | "capacity_blocked" | "halted" | "rebuilding",
  consecutiveErrors,
  lastErrorReason,
  lastTaskId,
  nextRetryAt,
  updatedAt
}
```

持久化规则：

1. Recovery 状态必须保存在数据库，进程内计数器不能成为 authority。
2. Provider/schema 等未产生语义 patch 的失败，只原子更新 task、per-target status 和 ops log；不增加 memory revision，也不写完整 state snapshot。
3. 成功提交语义 patch 时，state/event/snapshot/cursor/task 终态和对应 target status 的错误计数重置必须在同一事务完成。
4. `unable_to_decide` 首次扩窗口的状态属于该 proposal/window，不属于长期 target state，因此记录在 durable task 的 `contextExpansionAttempt` 中。
5. Compaction halt、deferred proposal 和 replay 阶段属于 durable task/target status，不写进语义 memory_state。
6. Renderer 和用户告警同时读取语义 memory_state 与 per-target status；删除 recovery 字段不能导致 degraded/rebuilding/halted 状态不可见。
7. Crash recovery 分两条：语义 state 从 snapshot/events 恢复，运行恢复状态从 durable task/per-target status/ops log 恢复。

### 16.2 旧 `meta.recovery` 处理

一次性迁移会物理删除旧 Memory，并从 raw messages 重建新 state，因此不实现旧 `meta.recovery` 的 in-place 迁移，也不继承旧错误计数、halt 或 context-expansion flag。新 generation 的 per-target status 从 healthy/0 初始化。

至少包含以下恢复路径：

1. Provider/网络临时错误：有限指数退避重试。
2. 进程重启：单实例 worker 从数据库重读非终态 durable task，按已持久化阶段继续；不为此引入多实例 lease 协议。
3. Revision/cursor stale：丢弃旧执行结果，按 durable task/proposal 和当前 state 重新校验。
4. Source dirty/generation 变化：启动 source rebuild。
5. State/schema 损坏：优先从 snapshot 恢复；必要时从 raw messages rebuild。
6. Compaction/replay 失败：保留原 proposal，只 halt 对应 target，显式告警并等待服务器维护脚本 resume；其他 targets 和主聊天继续运行。
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

服务器维护脚本可因以下原因显式 rebuild：

- state/schema 损坏；
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
→ 校验 state/snapshot/events/cursors
→ 清 dirty
→ 用户状态 rebuilding → healthy
```

Raw source mutation、generation increment、dirty boundary 和旧 Memory tasks 取消必须在同一数据库事务中持久化，禁止 controller 在 source 已提交后 best-effort 标 dirty。当前不引入通用 outbox；RAG/Recall invalidation 由各自 checkpoint 与权威 sourceGeneration 的不一致确定性派生，进程内 wake-up 只负责降低延迟。

### 17.1 RAG/Recall projection drain

1. RAG 和 Recall 各自持久化独立 projection checkpoint，至少包含 `processedGeneration` 和 `processedBoundaryMessageId`；不得因 Memory target 已追平就推定 RAG/Recall 也已追平。
2. Worker 在进程启动、周期轮询和进程内 wake-up 时，比较 projection checkpoint 与权威 `memory_state.sourceGeneration` 及当前 source boundary。
3. `processedGeneration !== sourceGeneration` 时，projection 进入 degraded/rebuilding，按当前 generation 失效并重建相关 RAG/Recall 派生数据；normal append 未改变 generation 时，仍按 `processedBoundaryMessageId` 增量追平。
4. 每轮 drain 先捕获 generation 和 boundary；提交 projection 结果前必须重新校验 generation。期间 generation 再次变化时，本轮结果 stale，不得把 checkpoint 推进到旧 generation。
5. 只有 projection 追平 captured boundary 且 generation 仍一致后，才能原子更新自身 checkpoint 并恢复 healthy。
6. 进程内 wake-up 只用于降低延迟；启动/周期轮询时的 generation/boundary 比较是不依赖 outbox 的 correctness 保证。
7. 任何实际参与当前 context compile 的 projection 未追平时，用户告警必须持续，不得把落后 projection 标记为当前状态。

## 18. Force Drain 与一次性迁移

1. 不引入独立 Flush 子系统、Flush task type、Flush 状态机或专用持久化表。
2. 只保留 worker 内部的 `forceDrainTo(boundaryMessageId)` 能力，继续使用普通 durable tasks。
3. force drain 仅用于 source rebuild、服务器维护脚本排查和一次性迁移。
4. 一次性迁移不是长期运行时子系统，不新增 task type、状态机或持久化表。
5. 迁移流程简化为：停止服务 → 更新 schema/代码 → 物理删除旧 Memory → 从 raw messages rebuild/force drain → 校验 → 启动服务。
6. Rebuild 未追平或校验失败时不得启动对外聊天服务。

## 19. Forget、Correction 与物理删除

1. Correction：用新 revision 更新错误 item，active state 只渲染新值，event history 保留旧 revision。
2. Forget：从 active state 移除 item，并写 context-suppression tombstone，阻止相同 source 在 rebuild/RAG/Recall 中重新进入上下文。
3. Privacy hard delete：跨 raw/event/snapshot/RAG/Recall/debug 派生存储执行物理清除。
4. “把 text 改成已作废”不是 forget，Renderer 不应继续注入被忘记内容。
5. Active item 的 evidenceGroups 必须完整覆盖历史来源：update 只追加 evidenceGroup，merge 继承所有 source items 的 evidenceGroups 并保留 group 边界。
6. Forget 直接从当前 item 的完整 evidenceGroups 收集 source messageId/hash 并生成 suppression tombstone，不新增 provenance graph，也不要求遍历完整 event chain。

## 20. RAG Suppression

当前阶段不引入 suppressionProposer，不尝试用新的 LLM 调用从一条多事实消息中精确识别应删除的语义片段。

当前确定性方案：

1. RAG chunk 必须能追踪其 source messageId/contentHash。
2. Forget/correction transaction 从被移除或被替换 item 的完整 evidenceGroups 收集 evidence messageId/hash，并写 context-suppression tombstone。
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

## 22. 单实例串行与幂等

1. 继承原设计的部署假设：当前只支持单实例，由进程内 per-user/preset 队列保证 Memory 写入串行；不引入 lease、多实例 claim 或数据库 CAS 协议。
2. Durable task 使用稳定 task identity/dedupe key，重复 wake-up 不创建重复任务。
3. Reducer 提交前校验 generation、cursorBefore 和当前 revision，禁止 cursor 回退、跳过 gap 或把旧 state 上的 itemId 决策 apply 到新 revision。这是进程重启和 stale result 防护，不代表多实例并发支持。
4. 相同 task/patchId 的重复恢复或 delivery 只能产生一组 events 和一个 state revision。
5. Compaction、proposal replay、snapshot 和 cursor 更新都必须满足同一幂等原则。
6. 未来如改为多实例部署，需单独设计数据库锁/lease/fencing 协议，不属于当前共识。

## 23. 运营与指标

需要记录但不直接阻断聊天的指标包括：

- calls/message；
- input/output tokens；
- Provider/model latency 与费用；
- schema failure；
- safety/refusal；
- unable rate；
- quote similarity 分布、quote-too-short/quote-not-found/quote-too-long rate；
- compaction success/failure、replay_failed 和 target halt rate；
- deferred proposal age；
- queue age/backlog；
- revision/cursor stale；
- gapBridge raw/truncated/omitted；
- rebuild duration；
- RAG/Recall projection lag；
- Memory degraded/rebuilding 持续时间。

低价 LLM API 使多次调用成本可以接受，但不能因此忽略延迟、限流、失败率和错误累积。

相比原设计，normal Proposer 从 5 个增至 6 个。必须分 target 监控 calls/message、eligible rate、输入/输出 tokens、延迟和费用；如果 profileRelationship/worldFacts 拆分导致成本或延迟明显不可接受，再根据真实指标调整拆分粒度，不凭预测提前合并。

## 24. 配置原则

下列变量必须进入集中配置并在文档中说明，不得散落硬编码：

- 每个 section 的 maxItems；
- 每个 section 的 maxRenderedChars；
- current.scene 过期时间；
- overdue todo 的 maxRenderedItems/maxRenderedChars；
- 每个 target 的 lagThreshold；
- gapBridge raw 字符预算；
- gapBridge 截断后保留的最近消息数；
- quote 模糊匹配算法与接受阈值；
- Provider retry/backoff；
- Compaction retry 次数与 target halt 条件；
- Snapshot/event/debug retention；
- 用户 degraded/rebuilding 告警防抖和恢复条件。

Evidence quote 最大 200 Unicode code points 已确定；模糊匹配继承原设计的默认阈值 0.75，可通过集中配置调整。其余具体默认值尚未最终固定，应根据真实历史分布和 Provider 能力选择。

## 25. 明确延后的问题

当前已明确延后、不进入本轮实现的问题统一记录在 [Memory Control v2 延后设计](memory-control-v2-deferred/readme.md)，包括：

1. LLM Suppression Proposer。
2. Gap Compressor 及单条超大 gap message 的精细处理。
3. 长期 overdue todo 更精细的归档、检索和清理策略。

---

本文是讨论共识清单，不替代最终拆分后的状态契约、写入协议、Prompt、Renderer、Harness 和迁移文档。正式文档修订时必须逐项映射，并删除与本清单冲突的旧设计。
