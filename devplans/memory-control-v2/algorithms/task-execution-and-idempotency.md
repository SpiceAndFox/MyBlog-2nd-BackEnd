# Task 执行、语义 Cycle 与幂等算法（v2.1）

本文是 source scan、boundary cycle、candidate-driven normal task、proposal collect、Reducer 提交、revision rebase、retry/resume、maintenance/system-cleanup task、phase identity 与 crash recovery 的单一权威来源。Memory v2.1 的持久 `schemaVersion`/`memory_state.version` 为 `3`；静态 shape、枚举与 DDL 见 [状态契约](../state-contract.md) §2–§6；容量恢复见 [Compaction 与 Proposal Replay](compaction-and-replay.md)。

v2.1 明确替换 v2.0 的以下运行语义：per-target raw-message cursor、`newBatch`、`lagThreshold` eligible target、普通 rejected 后推进 cursor、二次 `unable_to_decide` 后 cursor-only success，以及“只因全局 revision 变化就重跑 Proposer”。若其他文档仍保留这些表述，以本文和 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) 为准。v3 schema 是 destructive replacement：旧 cursor/task/snapshot/event 不做兼容读取或转换，保留 raw source 后从空 v3 authority重建。

## 1. 两类进度与基本不变量

同一 `userId/presetId/sourceGeneration` 必须分别维护：

- **source scan progress**：全局 `scannedThroughMessageId` 只回答“截至哪里已经完成信号检查，并把候选或无信号结果持久化”。
- **target consumption progress**：每个 evidence observation 与 candidate target 的关联状态 `ready | processing | waiting | consumed | excluded | retryable | dead_letter` 只回答“该候选是否已经被这个专业 Proposer 和 Reducer 正确处理”。

两者不得用同一 cursor 表达。source scan checkpoint 可以在候选仍为 `waiting`、`retryable`、`dead_letter` 或待消费时前进，因为候选和原始引用已经持久化；反过来，某 target 暂无候选也不允许代替 source scan coverage。

必须满足以下不变量：

1. source scan checkpoint 前进前，本段每条有效已提交消息都已有逐消息 `messageAssessment`：`signals` 指向已持久化 observation，或明确为 `no_relevant_signal`；崩溃不能留下“checkpoint 已前进但候选/assessment 未落库”的窗口。
2. observation 始终引用真实 raw message ID/content hash；摘要、memory item 和另一个 target 的输出不能单独成为新 observation 的事实来源。
3. 一个 observation 可以关联多个 candidate targets；每个 observation-target 关联有独立生命周期，某 target 的成功或失败不关闭其他 target 的关联。
4. normal task 由待消费候选创建，不由距某个 target cursor 的消息条数创建。
5. task `succeeded` 只表示该次工作流有可审计终局；target 是否语义 healthy 由 scan coverage 和候选生命周期共同判断。

## 2. 稳定 Source Boundary、吞吐合并与尾部最大延迟

普通追加消息不等待固定条数才获得观察资格，也不在首次 wake 时预建一个以后会扩张的 task。source scan 使用两个 durable phase：

1. **pending capture/promote**：完整有效 source 一经可见，在短事务追加 `single_source_message_v1` immutable boundary row、提升 scan status 的 stable boundary，并 upsert `chat_memory_source_scan_pending`；
2. **task freeze**：pending deadline/显式 trigger 到达后，锁 status/pending并只为 checkpoint 后最早 boundary row创建 immutable source-scan task。

pending 首次写入时以最老未终结 source 的 durable commit time 固化 `backlogStartedAt` 与 `tailDeadlineAt`。新 source 到来可以令 `pendingThroughMessageId=GREATEST(old,new)` 并增加 pending boundary count，但 `freezeDeadlineAt=LEAST(old,newCandidate)`，同 backlog 的 tail deadline不能后移。以下任一条件只会把 pending deadline提前到 now：

1. 未扫描消息达到配置的 scan batch target；
2. debounce 到期；
3. 自最老未扫描已提交消息起计算的 `sourceScan.tailMaxDelayMs` 到期；仅有已提交 user 消息且 assistant 尚未形成完整回复时，还受更短的 `sourceScan.provisionalUserMaxDelayMs` 保证；
4. 一次 assistant 生成完整结束、调用方显式 flush、受控停服 drain 或启动恢复要求追平。

`sourceScan.batchMaxMessages` 和 `sourceScan.debounceMs` 只合并 wake/raw I/O 预取，不能决定 semantic boundary、消息是否被扫描或候选是否新鲜。两个 max-delay 都必须是有限正值；即使此后再无消息或 assistant 生成中断，已完整提交的尾部也必须在相应期限内进入 scan。启动恢复和周期 reconciliation 必须枚举 due pending row以及已冻结 task，内存 timer 只降低延迟，不是 authority。

pending 可以在 user 等待 assistant期间提升到更晚 stable endpoint，使它们共享一次 wake/prefetch；canonical plan 仍固定每条完整 source message一个 boundary。deadline 到达后一次只能冻结 checkpoint 后最早 boundary；task一旦创建，其 semantic boundary ID/ordinal、`scanCursorBefore/sourceBoundaryMessageId`、source hash与 envelope immutable。后来消息只 promote pending，不能为扩大 batch改写旧 task或 dedupe identity。pending 直到其 endpoint 的每条 boundary 都取得 scan + cycle/no-candidate 终局后才以 CAS删除。

边界只包含已经原子提交且 source 完整性校验通过的 User/Assistant 消息，不读取流式生成中的半条 assistant 内容。session/turn 标识只可帮助判断 source 是否完整，不能决定候选、episode 或长期模式边界。

## 3. Scan 阶段

对 `task_type=source_scan` 的 durable checkpoint `C=scannedThroughMessageId`，Coordinator 只能选择 canonical plan 中 start-exclusive 等于 `C` 的下一 row；令其唯一 `sourceMessageId=B`。scan delta 恰为该一条消息，不能因 I/O batch 合并相邻 rows。为了补全既有 pending observation，它还可以读取已登记的较早 raw refs 和与本 boundary 直接相关的有限支持原文；support 不得越过 `B`，专业 Memory patch 不存在“必须至少引用本段一条新消息”的写入门。

source-scan task 的 immutable envelope固化 `schemaVersion=3`、generation、`detectorVersion/contractVersion`、semantic boundary ID/ordinal/`single_source_message_v1`、`scanCursorBefore=C`、`sourceBoundaryMessageId=B`、source key/hash、`semanticNow`、用户时区、singleton delta与 bounded support catalogs。其 dedupe key至少绑定 scope、generation、detector/contract version、semantic boundary ID/ordinal/planVersion、scanMode和 resume epoch；debounce/max-delay重复 wake-up在 task freeze前命中同一 pending row，freeze后命中同一 task。Provider输出通过完整 schema/quote/source校验后，先在短事务写入 task `stage_payload.persistedProposal`，再允许执行下面的 scan commit；崩溃恢复必须复用，不能重复调用 observer。

一次 scan commit 必须在同一事务完成：

1. 校验 generation/detectorVersion/contractVersion，以及 immutable semantic-boundary row、range、source hash均未失效；
2. 校验每个 signal 至少引用本 singleton boundary raw message；较早 support raw只能补全/关联，不能让 observer在没有新输入的普通 scan中任意重提取历史；
3. 为识别到的信号幂等新增或更新 evidence observation，保存 kind、规范化主题/动作、actor、时间含义、raw refs、candidate targets、首次/本次 source boundary 和 observation version；
4. 对已有 observation 追加接受、拒绝、完成、纠正、反证、语义弧进展等新证据，并只在语义输入确实变化时增加 version；
5. 为新增或变更的 candidate target 建立/更新 observation-target 消费关联；
6. 用唯一一条 `messageAssessment` 覆盖本 boundary 的 singleton delta；有信号时记录 observation/arc/occasion action indexes 的非空并集，无信号时三个 index 数组都为空；
7. 最后把 source scan checkpoint 的 `scannedThroughMessageId` 推进到 `B` 并将 source-scan task 标为 succeeded。

scan 失败、schema/引用校验失败或事务结果不确定时不得先推进 checkpoint。重复 delivery 以稳定 scan task/phase identity 查询原提交；已经提交则返回原 observations/assessments，未提交才重试。新 observation/arc/occasion ID 都由 `(scanTaskId, outputIndex)` 稳定生成，三类对象使用不同固定 UUID namespace；同一 scan output重放必须命中原对象。`semanticKey` 相同但没有显式 `relatedObservationId` 时不得自动语义合并；向已有 observation增补 evidence则使用 observation ID + evidence source key幂等，不能制造重复 evidence或无界候选。

成功 scan commit 必须在上述同一事务把 source-scan task写为 succeeded，并重置 `chat_memory_source_scan_status` 的连续错误与 retry时间；不能先推进 checkpoint再异步修复运行状态。

后续证据也可以产生 **late discovery**。`scanMode=incremental` 时，当前 new message 使 observer 发现较早原文中的遗漏信号，action 仍须至少引用一条本批新消息，再引用较早 raw evidence。没有新消息时，只能创建显式 `scanMode=late_discovery` 的受控 task或通过 detector-version rebuild 重扫指定旧区间；它写 append-only assessment event、以 CAS 更新 assessment master/version，但不回退或推进 source scan checkpoint。普通 normal task 不能偷偷回读并写 observation。late discovery 与普通 observation 使用相同消费、证据和审计规则。

代码编排 authority 是 `SourceScanCoordinator`；需要语义判断时调用 schema-constrained LLM `semanticSignalObserver`，也可以在其前后组合确定性规则。无论具体实现如何，都必须先通过上述引用、幂等和原子提交门；不能把只存在于一次 prompt 中的临时候选当作已扫描。

## 4. Boundary Cycle 与同一 As-of 快照

每次 scan commit 后，调度器先为本 boundary 捕获一个明确的 `semanticNow`：在线处理使用一次捕获的真实当前时间，历史重建使用 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) §3.3 的 `replayNow(Bi)`。它先用该时间运行一次确定性 pre-cycle lifecycle；有变化时按 system-cleanup 契约提交 revision/snapshot，无变化时 noop。只有存在新增/变更且当前可运行的 observation-target 时，才为该 scan boundary 建立 durable **boundary cycle** 与 normal tasks；没有 runnable candidate 时 assessment/ledger 是 no-candidate authority，不创建空 cycle。初次 evaluation 固定 `cycleKind=boundary/reviewEpoch=0/retryEpoch=0` 并创建新的 `cycleLineageId`；identity 至少绑定 scope、generation、semantic boundary、detector/contract version、review epoch 与 retry epoch，重复 wake-up必须返回同一 cycle。

该 boundary 的 no-candidate 终局，或其 cycle terminal，才允许把 pending boundary count减一并考虑 CAS删除 pending row；scan task单独 succeeded 不代表 boundary 已封存。Coordinator 必须完成这一步后才为下一 ordinal冻结 source-scan task，所以一次 raw prefetch包含多条消息也不会让更晚 boundary 提前组装 Observer catalog或 as-of state。

cycle 创建时一次性捕获：

- `sourceGeneration`、`sourceBoundaryMessageId=B`、`cycleKind/reviewEpoch/reviewTrigger` 与 `cycleLineageId/retryEpoch`；
- 当前 `memory_state` 的完整 schema-valid snapshot 及 `asOfRevision=R0`；
- 截至 `B` 可见的 observations、candidate versions 与 raw source hashes；
- 本 cycle 的 `semanticNow`、用户时区以及相对时间所需的消息 `createdAt`；
- cycle 中各 target 的候选集合及确定性 digest。

同一 cycle 的所有专业 Proposer 必须从这一个 immutable as-of snapshot 组装 envelope。它们只能看到 `messageId <= B` 的原文、截至 `B` 的 observation 版本、`R0` 时点的 writable state/read-only context；物理上先完成或先提交的 target 不能把派生 state 泄漏给同 boundary 的后一个 Proposer。`episodes`、`profileRelationship` 等 target 不存在前置调用链。

新消息在 cycle 运行期间到达不会扩张其 envelope；它们属于更晚 boundary。source generation 变化则使整个旧 cycle stale。只有候选版本或其 source refs 在提交前被更晚扫描实质修改时，受影响 task 才 stale 并在新 cycle 重判；单纯追加不相关消息不使已捕获 proposal stale。

在线 source scan为了 max-delay可以机械登记更晚消息，但同 scope更晚 boundary不得在较早 active cycle封存前 freeze as-of/start proposing；它必须在 source-boundary顺序上等待。若更晚 scan实质更新了较早 task的 observation version，旧 task按 stale_result终结，由拥有新 version的更晚 cycle处理，不能把未来 evidence塞回旧 envelope。受控 rebuild则按 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) §3逐 boundary完成 scan→cycle，不提前提交未来 observation version。

## 5. Candidate-driven Normal Task 与 Proposal Collect

### 5.1 创建和幂等键

一个 normal task 只对应一个 target，但可以合并同 cycle 中该 target 的多个候选。其 immutable `task_payload` 至少固化 boundary cycle ID、`cycleLineageId/cycleKind/reviewEpoch/reviewTrigger/retryEpoch`、generation、semantic boundary、as-of revision/snapshot identity、targetKey、排序后的 `(observationId, observationVersion)`、candidate-set digest、raw refs/hashes、writable/read-only view 与完整 envelope；消费行的 claim attempt 属于运行状态，不伪装成 observation version。

normal task 的 `dedupe_key` 固定至少绑定 `{sourceGeneration}:{cycleLineageId}:{retryEpoch}:{targetKey}:{candidateSetDigest}`。相同 evaluation/retry 的重复 wake-up 命中同一 task；纯技术 retry 只有在同 lineage 的 `retryEpoch` 增加后才允许新 task。语义重判必须先创建新的 cycle lineage/review epoch，其新 lineage自然不会撞旧 task；不能靠任意 attempt、wall clock 或重新序列化 envelope 绕过 dedupe。v3 normal task 不包含 `cursor_before`、`target_message_id` 或 `newBatch` 语义。

只有以下情况创建 target task：

- 新 observation 把该 target 列为候选；
- pending observation 获得补充/反证/完成等新证据；
- waiting observation 达到明确的语义晋升或重新判断条件；
- 规则/prompt 修复后显式重排 retryable/dead-letter 候选；
- late discovery 或 open semantic arc 的状态变化要求重判。

固定消息频率只能影响 scan 合并，不能让所有 target 周期性空跑，也不能因过去连续 noop 而停止扫描新信号。

### 5.2 输入要求

每个 task 必须让 Proposer 看到：触发候选及状态、所有直接支持/反证 raw messages、完成提议—接受或建立—完成链路所需的相关原文、该 target 的 as-of writable state、必要的 as-of read-only context、source boundary、消息时间和用户时区。context window 是相关上下文预算，不是证据新鲜度边界；合法 patch 可以引用已登记候选中的较早原文。

### 5.3 先收集、后归约

cycle 在 source scan 完成后分为严格的 `proposing` 与 `reducing` 两阶段（完整 durable status 为 `proposing | reducing | retry_wait | completed | superseded | halted`）。scan 运行状态只属于 source-scan task/status，不在 cycle复制第二份 `scanning` authority：

1. 所有被触发 target 可以并行或任意顺序调用 Proposer，但只把通过完整 schema 校验的输出持久化到各自 task 的 `stage_payload.persistedProposal`；此阶段不调用 Reducer 修改 `memory_state`。
2. Provider/schema 的受限重试仍使用原 immutable envelope。task 创建时把候选从 `ready` 原子 claim 为 `processing`；一个 target 重试耗尽时，把其候选转为有原因的 `retryable`/`dead_letter`，封存该 collection slot；它不伪装为 noop，也不阻止其他已收集 target 最终归约。
3. 当 cycle 每个触发 slot 都已 `proposal_persisted`、明确无任务，或以可审计失败封存后，cycle 才从 `proposing` 进入 `reducing`。进入后候选集合与 slot 顺序不再变化。
4. Reducer 按集中定义且版本化的 canonical target order 顺序处理已持久化 proposals；首版顺序为 `scene → todos → standingAgreements → episodes → profileRelationship → worldFacts`。同 target 内再按 observation ID/version、正式 section 顺序与稳定 patch ID 排序。

运行时完成顺序、worker slot 和 Provider 延迟不得改变归约顺序。canonical 顺序只解决确定性提交和冲突，不改变 Proposer 的 as-of 输入。

Reducer 不得越过仍处于 capacity-blocked/replay/retry/unknown-commit 的 canonical slot去提交后续 slot。当前 slot必须先成功结算，或以保留候选的明确 retryable/dead-letter/halted结果封存，才可继续；maintenance revisions属于该 slot的恢复链。这样 compaction时延和事务重试也不能改变最终 apply顺序。

cycle status 按每个 evaluation lineage 的 active/latest `retryEpoch` 聚合：存在尚未到期的 task backoff时为 `retry_wait`；所有可归约 slot结束且候选无技术 backlog时为 `completed`；自动恢复耗尽或 dead-letter/rebase/capacity缺口尚未被恢复时为 `halted`。创建同 lineage 更高 technical retry epoch时，较低 retry cycle 转为 `superseded`；创建后来 semantic review lineage时，旧 lineage只有在新 review明确接管其 observation-target/version 后才可标记 superseded并保留审计。健康/完成判断不能用旧 halted cycle 永久误报，也不能只改 status 掩盖未处理候选。

## 6. Candidate 消费终局与 Reducer 决策

每个 Proposer 输出必须通过 `candidateDecisions` 逐一覆盖本 task 的每个 observation-target 关联；每项固定为 `{ observationId, outcome: proposed | waiting | excluded | already_reflected, reasonCode, patchIds }`。`outcome=proposed` 的 patchIds 必须非空并与 patch.observationIds 双向一致；其他 outcome 的 patchIds 必须为空。一个 task 级 `noop`、空 patches 或自然语言说明不能批量吞掉未映射候选。

Reducer 对 proposed observations 与 patches 构造二部图；共享 observation/patch 的 connected component 是 candidate atomic unit。unit 内所有 patch 必须全部 accepted、全部 rejected或全部 deferred，不能部分写入后把同一候选留在 retryable。互不相连的 unit 可以独立结算。

candidate decision 经 Reducer 后的合法消费状态为：

| `candidateDecisions[].outcome` / 运行结果 | 消费状态 | 含义 |
| --- | --- | --- |
| `proposed` 且全部关联语义 patch accepted | `consumed`（终局） | 对应变更已落地；重复提交时也可以由同一 candidate/patch identity 证明 effect 已存在 |
| `already_reflected` | `consumed`（终局） | 当前 as-of state 已表达同一事实且无需新增事件；必须保存 `reasonCode=duplicate_or_existing_state`，Reducer 必须以稳定 `projectionIdentity`/field identity做确定性存在性检查，失败则转 `retryable` |
| `excluded` | `excluded`（终局） | 证据明确不应进入该 target 或该模块不匹配；必须保存 reason 与 raw refs，不能用技术失败冒充 |
| `waiting` | `waiting`（非终局、休眠） | 当前确实缺少接受/结果/独立场合等证据；保存缺少什么，只在 observation version/条件变化后重新变为 `ready` |
| Provider/Reducer/rebase 可修复失败 | `retryable`（非终局、可运行） | schema、quote、错误 item/target、时间解析、rebase conflict等失败；保留 proposal/reason/attempt |
| 自动重试耗尽或无法安全判断 | `dead_letter`（非终局、需干预） | 必须可 resume/requeue，target 不得报告语义 healthy |

普通 Reducer `rejected` 不再等于“已经处理”。除非对应候选另有通过校验的 `candidateDecisions.outcome=excluded` 结论，否则 rejection 必须使关联保持 `retryable` 或进入 `dead_letter`。`overlap_only_evidence`/“不在 new batch”不再是合法 reject reason。

一次 proposal 中不同 candidate atomic units 可以分别 accepted/rejected；同一 unit 禁止部分成功。受 rejected unit 影响的候选不能因同 task 另一个 unit accepted 而关闭。容量 `deferred` 是明确例外：任一 unit 需要 compaction 时启用 proposal-wide barrier，本 target proposal 的所有 unit 保持 processing并随完整 pending candidate unit replay；完整规则见 [Compaction 与 Proposal Replay](compaction-and-replay.md)。

含 accepted semantic patch 的正常归约 revision 事务还必须用 cycle 固化的同一个 `semanticNow` 对模拟 post-state运行 post-apply lifecycle；proposal 直接造成的 overdue/revive/episode 滑出等 cleanup 与 proposal decisions 共用事务。事务原子写入 `memory_state` post-state、generation/revision、完整 snapshot、event group/events、candidate consumption transitions、task 终态与 target status。

若本 task 只有 `waiting`/`excluded`/`already_reflected` 且没有 accepted patch或 lifecycle变化，则原子写 candidate decisions、consumption transitions、task终态与 target status，不创建空 semantic event group、不增加 `memory_state.revision`、不写空 snapshot。纯技术失败或 `retryable`/`dead_letter` rejection同样不伪造成功 state revision，但必须以不同 outcome/reason与正常候选结论区分。

normal task成功形成 accepted或合法 `waiting/excluded/already_reflected` 终局时，必须在同一提交事务重置该 target的连续 Provider错误和 retry时间；这只清理运行错误，不得清除该 target其它 observation的 `ready/processing/retryable/dead_letter` backlog，也不自动宣称 semantic healthy。

## 7. Revision、Rebase 与重新排队

提交前必须锁定 task/cycle 和 scope 当前 state，并校验：

- task/cycle generation 等于当前 `memory_state.meta.sourceGeneration`；
- source boundary、raw refs/content hashes 与 suppression gate 仍有效；
- persisted proposal 对应的 observation/observation-target versions 未变化；
- phase identity 尚未提交；
- proposal 的 item references、结构、policy、容量与生命周期前置条件在当前 state 仍成立。

`asOfRevision/baseRevision` 是 Proposer 读取时点和审计依据，不是“任意全局 revision 变化都 stale”的门。前序 canonical target或无关 target导致 revision增长时，Reducer 对 persisted proposal在最新 state上做**确定性 rebase**；普通 normal task只在“该 task 的全部 writable target sections 与 as-of snapshot深度相同”时允许跨 revision安全 rebase：

1. 不重新调用 Proposer；
2. 先验证 writable target sections 与 as-of snapshot深度相同，再用原稳定 patch/candidate identity重跑所有纯代码校验和模拟 apply；
3. 若所需 effect 已由同一 identity 提交，读取并返回原结果；
4. 若 write preconditions 仍成立，在当前最新 revision 上提交下一 revision；
5. writable target section发生任何变化，或引用 item/canonical slot/前置条件不再相同，即记录 `rebase_conflict`，不猜测改写 proposal，把仍有效的 observation-target 关联退回 `retryable`。

maintenance compaction 后 original-proposal replay 是明确例外：它按 [Compaction 与 Proposal Replay](compaction-and-replay.md) 的保护和纯代码完整预检在主动改变过的同 target section上 replay；这不是普通跨 revision rebase，也不得推广成任意 normal proposal的宽松合并。

`SourceScanCoordinator`/cycle reconciler 只为可保持完全相同语义输入的技术失败建立 recovery cycle：沿用原 `cycleLineageId/cycleKind/reviewEpoch/reviewTrigger`，令 `retryEpoch=前一轮+1`，并完整继承 retry 0 的 `semanticNow`、`asOfRevision`、visibility snapshot identity、semantic boundary/source cutoff、candidate versions 与 refs。新 retry cycle创建与较低 retry cycle转 `superseded`必须原子关联；旧 persisted proposal 不跨 retry epoch直接 apply，新 task使用新的 dedupe identity。这样重调 Proposer仍看原共同快照，不会读取同-boundary已经提交的其他 target state。

技术 retry 在 online/rebuild 中都继承原 `semanticNow`，等待时长不能改变领域语义。observation version若已被更晚 boundary改变，则旧 technical lineage stale，由拥有该 version 的常规更晚 boundary处理；current writable section无法对原 snapshot safe rebase时 halt/rebuild，不能伪装为 technical retry后换用新 as-of。在线 technical retry 收敛后幂等唤醒一次使用新 wall clock 的 system housekeeping；rebuild由 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) §4.3 的最终 wall-clock pass统一完成。

generation 不同立即取消旧 normal/maintenance task，不跨 generation replay。更晚但不相关的 source append 不使旧 boundary proposal stale；更晚证据修改了候选 version 时，旧 task取消，当前 version由新 cycle重判。

## 8. Retry、Unable 与手动 Resume

### 8.1 Provider 与 Schema Error

- source-scan task 的失败更新独立 `chat_memory_source_scan_status`、task和 `worker_key=semanticSignalObserver` ops log；它没有 targetKey，不修改某个 target cursor/status，且绝不推进 `scannedThroughMessageId`。scan status retry/halt会使依赖该 boundary coverage的全部 target健康判断降级，但不删除最后稳定 Memory state。
- tick orchestrator 不把 Provider error 交给 Reducer。它在无 revision 事务中写 ops log、task attempt/notBefore/status、相关 candidate attempts 和 target status。
- `llm_call_failed`、`safety_policy_blocked`、`max_output_truncated` 沿用有限指数退避和 target 连续错误 halt 阈值；候选保持 retryable，不能关闭。
- Provider structured output 的本地 schema 校验失败，沿用同 immutable envelope、持久化有限 repair feedback、最多一次完整替代输出的规则；非法输出原文不写日志。次数耗尽后 task failed、候选 dead-letter、target halted。
- input envelope 自身非法直接 fail closed；修复 contract 后通过 candidate resume 创建新 task。
- maintenance child 的 Provider retry 继续保持 target `capacity_blocked`，尊重 durable `notBefore`，不退化为普通 retry_wait。

### 8.2 `unable_to_decide`

首次 unable 时，在同一 task 持久化一次相关原文扩展 envelope；扩展只能读取 `messageId <= sourceBoundary` 的原文，并优先按候选实体、动作、语义弧和已有 item 检索，不把窗口机械翻倍当作唯一策略。恢复与重复 delivery 必须复用已固化 envelope。

Proposer 能明确判断“尚缺接受、结果、独立场合”等证据时，应直接输出 `candidateDecisions.outcome=waiting` 和合法 `reasonCode`，而不是 `unable_to_decide`。受限扩展后仍返回 unable表示本次模型/契约无法形成候选判断，相关关联统一进入 `retryable`，重试耗尽后 `dead_letter`/halt；不能创建 cursor-only revision，也不能把 unable 当作明确“不应记忆”。

### 8.3 手动 Resume

Resume 以 target + candidate/失败原因选择待处理关联，不修改 raw scan checkpoint 或 `memory_state`，不跳过 source：

- retry_wait 原 task可在清除 `notBefore` 后继续使用同 immutable envelope；
- Provider transport、同 contract schema repair 或 COMMIT unknown 等纯技术恢复，通过同 `cycleLineageId/reviewEpoch` 的 `retryEpoch+1` 创建 `trigger=candidateRetry` normal task，严格继承 retry 0 visibility；
- `waiting_stale` 到期、操作者要求重新作语义判断、dead-letter 根因/contract 已修复，或 late discovery 新登记历史候选时，创建 `trigger=candidateReview` 的 semantic review，而不是继续旧 technical lineage：等当前 generation 所有更早 boundary/evaluation 已封存后，引用最新已封存 semantic boundary，分配新 `cycleLineageId/reviewEpoch`、以 `retryEpoch=0` 捕获当时最新 as-of state与 current observation versions。没有新 raw 时使用空 source delta，但 evidence 仍不得越过该 boundary；late discovery 的历史 semanticBoundaryId 只保存为 `lateDiscoverySourceBoundaryId` provenance；
- capacity/compaction/replay 失败按下一节创建新 maintenance child；
- dead-letter 经明确修复/人工 requeue 后只变为“等待 semantic review claim”的 retryable，旧 task、lineage 与 reason 保留审计；不得直接创建沿用旧 as-of 的 candidateRetry。

只有候选进入 `consumed`/`excluded`，或被合法置为 `waiting`，target 才能清除对应 actionable backlog；仅把 task 改成 succeeded 不足以恢复 healthy。

## 9. Compaction、Replay 与 Maintenance Resume

v2.0 的长度预算预检、完整 proposal 原子 deferred、pending item 保护、确定性完全相同文本 merge、maintenance child、`unable_to_compact`、hygiene、遗忘边界和有界 resume 规则继续有效，但其 raw cursor 前置条件作如下替换：

1. capacity-blocked 时 parent normal task 的候选关联保持 `processing`，不进入 `consumed`/`excluded`；maintenance task 不拥有或推进 scan/consume progress。
2. compaction/replay stale 校验使用 generation、parent phase、candidate identities/versions、raw source hashes、item references 与 suppression gate；不再校验 target `cursorBefore`。
3. compaction revision 后，原 persisted proposal在当前 state 上按 §7 确定性 rebase/replay，不重新调用原 Proposer。无关 revision 增长不使其 stale。
4. replay accepted 后，candidate transitions 与最终 replay events/state/snapshot/task/status 同事务提交；replay rejected 或 rebase conflict 时候选保持 retryable/dead-letter，不能伪装为消费成功。
5. `scene capacity_exceeded` 虽不创建 compaction，也只是一次 rejected proposal；相关候选必须 retryable/dead-letter，不能因旧“rejected 推进 cursor”规则丢失。

maintenance task 已终态而 parent 仍 capacity-blocked 时，resume 继续创建新 child：新 task ID，`resume_epoch + 1`，dedupe key 绑定 parent/section/epoch，parent 更新当前 child ID，旧 child 终态保留审计。

## 10. Phase Identity、提交结果与 Crash Recovery

以下 identity 必须稳定且有唯一约束：scan commit、cycle、target collection task、normal reduce、capacity-blocked audit、每次 maintenance apply、original-proposal replay、system cleanup。重复 delivery 或 COMMIT 结果不确定时，先按 phase identity读取既有结果，禁止先改 stage 或覆盖 payload。

同一 proposal/candidate/patch identity 只能产生一次有效 semantic effect。Reducer 生成的 add item ID 和 event group identity必须在事务重试前稳定；重复 apply 返回原 item/event/revision，不能新增第二项。

运行失败 outcome：

- `reducer_failed`：纯代码异常；不增加 revision/snapshot，候选保持 retryable；
- `transaction_failed`：COMMIT 前已确认回滚；回滚后按 phase identity 和最新 state重新 rebase；
- `commit_outcome_unknown`：COMMIT 已发送但结果未知；必须先查询 phase/event/candidate transition，已提交则返回原结果，未提交才重试；
- `stale_result`：generation/source/candidate version 失效；取消旧 task并由新 generation/cycle处理；
- `rebase_conflict`：generation 仍有效但 proposal 无法纯代码安全重放；关联回到 `retryable`，由新 retry epoch/cycle重新排队。

原子性边界：

1. scan 事务：observations、observation-target links、逐消息 assessments、source scan checkpoint与 source-scan task终态同事务；不增加 memory revision。
2. proposal persistence：Provider 输出通过 schema 后，先用短事务写完整 `persistedProposal` 和 stage；之后才可 reduce。恢复必须复用，除非 generation/candidate stale 或显式扩展 envelope。
3. semantic revision：accepted patch或 lifecycle cleanup对应的 state、revision、snapshot、events、candidate transitions、task和 target status同事务。
4. 无 revision 决策/失败：纯 waiting/excluded/already-reflected，或 task/candidate/status/ops log、retryable rejection、capacity-blocked audit/maintenance chain同事务；不同 outcome不得混淆。
5. 语义恢复从当前 generation 的 schema-valid snapshot 按 result revision连续 replay normalized operations；候选运行恢复从 durable scan/cycle/task/observation 状态恢复，不能从 snapshot 或内存队列猜测。

当前仍只支持单实例；同 scope 的 source mutation、scan commit、cycle reduce、maintenance 与 system cleanup 共用串行提交 lane。Provider collection 可以在 lane 外并发，但其 immutable envelope和提交 fence 必须遵守本文件。进程内 lane 不是恢复 authority。

## 11. 语义完成与健康条件

某 target 只有同时满足以下条件才能报告 semantic healthy：

- source scan checkpoint 已覆盖要求的稳定 boundary；
- 该 target 在该 boundary 之前没有 queued/running/retry_wait、未归约 proposal、retryable 或 dead-letter candidate；
- 所有已观察候选均为 `consumed`、`excluded`，或有明确缺失条件且当前不 eligible 的 `waiting`；
- 没有缺失 message assessment、悬空 candidate-to-task 映射、未决 capacity/rebase 链或未知 COMMIT outcome；
- state/schema、generation、snapshot/event/revision 连续性校验通过。

`waiting` 和 open semantic arc 是可解释的领域状态，不等于处理缺口；一旦 observation version变化或等待条件满足，必须重新变为 `ready`。`retryable`/`dead_letter` 则始终使对应 target degraded/halted。

`task.status=succeeded`、某次 Proposer noop、某个 revision 已提交或任意旧 target cursor 追上末尾，都不能单独证明上述完成条件。

## 12. Harness

验收至少覆盖：scan/checkpoint 原子性、尾部 max-delay、candidate 幂等与跨窗口补全、同 boundary cycle/evaluation as-of 隔离、不同 Provider 完成顺序下 canonical reduce 等价、revision 增长 rebase、真正冲突重新排队、rejected 不消费、unable waiting/dead-letter、capacity replay、COMMIT unknown、late discovery 和 task success/semantic health 分离。Source rebuild 的 boundary-major 变形测试见 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) §3、§7。
