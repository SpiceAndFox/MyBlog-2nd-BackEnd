# Source Rebuild、Event-time Replay 与 Projection 算法（v2.1）

本文是 source mutation、sourceGeneration、boundary-major rebuild、`forceDrainTo`、最终 wall-clock housekeeping 以及 RAG projection drain 的单一权威来源。Memory v2.1 的持久 `schemaVersion`/`memory_state.version` 为 `3`。Recall/Scene Recall 是继承 RAG cutoff 的查询时 enrichment。静态 state、scan/cycle/observation/task、target status 与 projection checkpoint shape 见 [状态契约](../state-contract.md) §1、§3、§6；单个 boundary cycle 的执行见 [Task 执行、语义 Cycle 与幂等](task-execution-and-idempotency.md)。

v2.1 的 rebuild authority 是 **global source scan progress + observation lifecycle + boundary cycle completion**，不是六个 per-target raw cursor。本文明确禁止 target-major 全历史重建和“所有 target cursor 到末尾即完成”。v3 不创建或兼容读取旧 cursor 字段。

## 1. Source Generation

`memory_state.meta.sourceGeneration` 是 Memory 与 RAG 共享的 raw-source 世代，查询时 Recall 继承 RAG 对该世代的覆盖。普通追加完整 User/Assistant message 不增加 generation，而是追加 singleton boundary row并 capture/promote durable pending；它受 `sourceScan.tailMaxDelayMs` / `sourceScan.provisionalUserMaxDelayMs` 尾部保证。消息尚在流式生成时不形成稳定 assistant boundary，已经完整提交的 user 消息仍受 provisional deadline保护。

任何有效 source 的编辑、删除、恢复、改变归属/可见性或排序语义变化都自动 `sourceGeneration + 1` 并 rebuild，即使变化触及的 source 尚未扫描，因为 observation、Memory、RAG 或 Recall 都可能已引用它：

- 编辑历史消息；
- regenerate 导致截断或删除后续消息；
- 删除历史消息；
- session trash、restore 或 permanent delete；
- 消息 preset 归属或可见性变化；
- raw source 排序语义变化。

服务器维护脚本还可因 state/schema/observation ledger 损坏、scanner/Proposer prompt 或 model 的关键语义版本变化、不兼容的 Memory schema/compaction/路由语义、人工判断无法局部修复，或首次从 raw history 建立 v2.1 state 而显式 rebuild。只调整吞吐 batch/debounce/context retrieval 上限，不应改变 observation 资格；若实现无法证明兼容，则必须提升语义 contract version并 rebuild。

## 2. Source Mutation 原子事务

自动 source mutation 必须进入同一 `userId/presetId` 串行提交 lane（与 scan、cycle reduce、maintenance、system cleanup 共用），禁止在 lane 外先修改消息再 best-effort 使 Memory dirty。

source mutation 在一个数据库事务中完成：

1. 提交 raw source 变化并捕获变化后的有效 source boundary `B`；
2. `sourceGeneration + 1`；
3. 取消旧 generation 的全部非终态 scan/cycle/normal/maintenance/system-cleanup task；旧 observation/target行即使按 retention保留，也因 generation fence不再 eligible，禁止跨世代 replay，且不写入未定义的伪状态；
4. 初始化新 generation 的 `version: 3` 空 `memory_state`、global source scan status/checkpoint（含 captured rebuild boundary）、按有效 raw source生成的 `single_source_message_v1` plan、`freezeDeadlineAt=LEAST(now,tailDeadlineAt)/trigger=rebuild` 的 pending row、scan assessments和 observation namespace；
5. 写下一个全局 revision 的完整空 state snapshot；
6. 将六个 target status 置为同 generation 的 `rebuilding`、清除旧 retry/error authority，并保存同一个 captured boundary `B`。

Generation 初始化 revision 不伪造正式 section/target 的 semantic event group。任一步失败都整体 rollback。旧 generation observations/events/snapshots 的保留和删除服从 [Suppression 与 Retention](suppression-and-retention.md)，不得为了方便 rebuild 而提前破坏审计或 privacy hard-delete verification。

Source mutation 事务不伪造或抢先推进 RAG projection checkpoint；§5 worker 通过 checkpoint 与新 `sourceGeneration` 不同确定性进入 projection rebuild。

当前 generation 的 source scan status只要仍保存未完成 rebuild boundary、pending row未排空，或任一 target仍为 `rebuilding`，就是 durable dirty状态，不另设仅存在内存的 dirty flag。

## 3. Boundary-major Event-time Rebuild

### 3.1 `forceDrainTo(B)` 的含义

`forceDrainTo(capturedBoundaryMessageId=B)` 是受控 worker 能力：它绕过普通 `sourceScan.debounceMs`、`sourceScan.batchMaxMessages` 和 live tail 延迟，也允许为 `rebuilding` target 创建 candidate-driven task；但不得绕过 generation fence、durable retry/backoff、schema/evidence 校验、candidate lifecycle、capacity/rebase 链或 privacy-operation gate。

该能力只对 source rebuild、受控迁移和服务器维护排查开放。它把 durable pending endpoint 至少提升到 `B`、把 freeze deadline提前到 now，再复用逐 singleton-boundary task freeze；不会创建覆盖 `(checkpoint,B]` 的合并 task。普通在线尾部由同一 pending/flush/max-delay机制处理；`forceDrainTo` 不新增 Flush task type、长期状态机或第二套消费进度。

Force drain 的目标不是让六个 target 分别扫描到 `B`，而是按 raw source 时间线完成以下闭环：

```text
source boundary B1
  → scan / observation commit
  → event-time pre-cycle lifecycle
  → freeze one as-of state
  → collect all triggered target proposals
  → canonical deterministic reduce
  → event-time post-apply lifecycle
source boundary B2
  → ...
最终 boundary B
  → semantic completion validation
  → suppression cleanup
  → one wall-clock housekeeping pass
  → rebuild completion validation
```

同一 scope 的 canonical plan 固定为 `single_source_message_v1`：每条按 source authority 稳定排序的完整有效消息恰好对应一条 immutable semantic-boundary row。只有 `Bi` 的 cycle/no-candidate 终局已封存后，才可为 `Bi+1` 冻结 semantic task。物理数据库读取可以一次预取多条消息，但必须按 boundary ordinal逐条重建 catalogs/envelope，不得把未来 observation/state放进更早 boundary。

相邻 semantic boundaries 不得因 batch/debounce、导入 page、Provider slot或变形测试结果而合并，一个 boundary 也不得按吞吐配置拆分。online/rebuild 都读取或重建同一 singleton plan，因此 I/O batch变化只能改变 wake/query次数，不能改变 Observer cutoff、task/cycle 数或最终投影。

### 3.2 每个 Boundary 的权威步骤

对 singleton boundary row `Bi`（`sourceStartExclusive=Bi-1 endpoint`，唯一 delta message ID=`Bi`）：

1. `SourceScanCoordinator` 从上一个 durable source scan checkpoint 开始扫描；需要语义判断时调用 `semanticSignalObserver`，再原子提交 observations、逐消息 `messageAssessments`、checkpoint和 source-scan task终态。它可以关联更早 pending observation，但不能读取 `messageId > Bi`。
2. 计算本 boundary 的 `replayNow(Bi)` 并将其作为 cycle/task 的 `semanticNow`，先对上一个 boundary 的 current state运行 pre-cycle lifecycle。到此时已过期的 scene/todo 必须先形成 system-cleanup revision，不能作为仍有效状态泄漏进本 boundary Proposer；无变化则 noop。
3. pre-cycle lifecycle 后，若存在 runnable observation-target，捕获当前完整 state 的 `asOfRevision`/snapshot，建立 `Bi` 的 `cycleKind=boundary/reviewEpoch=0/retryEpoch=0` cycle并固化同一个 `semanticNow=replayNow(Bi)`；没有候选时 assessment/ledger 已证明该 boundary，无需空 cycle。
4. 只为新增、变更或当前重新 eligible 的 observation-target 关联创建 normal tasks；无候选 target 不调用 Proposer。
5. 同一 `Bi` 的全部 Proposer读取同一个 as-of snapshot、同一 source cutoff 和各自相关 raw messages。不得让先 reduce 的 episode、scene 或 todo 成为同 boundary 后运行 target 的“已存在过去”。
6. 先持久收集所有 triggered target proposals，再按 [Task 执行、语义 Cycle 与幂等](task-execution-and-idempotency.md) §5 的 canonical target/patch 顺序在最新 state 上确定性 rebase/reduce。
7. proposal 的 `candidateDecisions` 与 patches 通过 `observationIds` 对齐，并把 consumption 状态结算为 `consumed | excluded | waiting | retryable | dead_letter`；task succeeded、noop 或 rejected 都不能替代候选完成校验。
8. 每次 proposal 模拟 post-state继续使用 cycle 固化的同一个 `replayNow(Bi)` 执行 post-apply lifecycle；proposal 直接造成的 overdue/revive/episode 滑出等 cleanup 与 proposal decisions 共用 revision。所有 target 归约结束后再做一次同时间确定性 noop/check，不能把执行期间的真实 wall clock混入历史 cycle。

这套顺序是 **boundary-major**：先完成同一时间点所有 target 的观察和判断，再进入下一时间点。以下 target-major 顺序被禁止：

```text
scene 扫完整段历史 → todos 扫完整段历史 → episodes 扫完整段历史 → ...
```

因为它会让早期 target 看不到本应存在的同时间状态，或让晚运行 target 读取未来的 scene/episode/profile。

### 3.3 Replay Clock 与相对时间

历史重建期间禁止把 worker 执行时的 wall clock 填进 Proposer 或 Reducer 作为事实发生时间。

- 每条 raw message 保留数据库 `createdAt` 和该 scope 固化的用户时区。
- “明天/今晚”等相对 deadline 始终以真正包含该时间表达的 raw message作为 `timeAnchorMessageId`，Reducer验证它属于对应 observation evidence，再用该消息 `createdAt` 与用户时区解释；后续接受/履约消息更晚也不能移动 anchor。批次、task 创建时间、proposal返回时间和 rebuild开始时间都不能作 anchor。“每天早上”等 recurring表达保留自己的时间语义，但同样不能按 rebuild wall clock重写。
- boundary lifecycle 的 `replayNow(Bi)` 由 source 数据确定：取上一 boundary replay clock 与截至 `Bi` 新纳入完整消息的最大有效 `createdAt` 的较大者，保证时间不倒退。异常/缺失时间必须 fail closed 或走显式数据修复，不能退回当前 wall clock。
- scene TTL、todo overdue/revive 等在历史 cycle 内使用 `replayNow(Bi)`；因此 2025 年的 todo 可以先按当时状态建立，再由后续事件完成，而不会因 2026 年执行 rebuild 在建立事务中立即过期。
- lifecycle 函数、event type、revision/snapshot 原子性和重复 noop 规则继续服从 [领域生命周期](domain-lifecycle.md)。

### 3.4 Batch、Session 与 Target-order 不变量

对相同 generation/source 与相同 scanner/Proposer contract version，下列变化不得改变 observation 资格、默认 target、候选状态流转、evidence coverage和最终 Memory 语义：

- scan I/O batch、proposal grouping或 context overlap 大小；其中 boundary rows与 Observer task envelopes 必须逐 source完全相同；
- session 的拆分、合并或日期名称；
- Provider 完成顺序或 worker slot；
- target 实际调用先后。

模型文本措辞可以有受控差异；模块归属、canonical item identity、todo/agreement/episode/profile lifecycle及关键验收断言必须稳定。任何依赖“本批至少一条新 evidence”、session boundary 或 target cursor 的实现都不满足该不变量。

## 4. Reconciliation、最终 Housekeeping 与完成条件

### 4.1 Durable Reconciliation

captured rebuild boundary 是独立于 task 是否 pending 的 durable reconciliation trigger。runtime 启动、周期轮询和受控迁移必须枚举已初始化 scope：只要 rebuild control 或 target rows仍保存当前 generation 的非空 boundary，就重新进入 `forceDrainTo(B)`，即使崩溃前最后一个 task 已终态、当前没有 pending row/active task或 scan checkpoint 已到 `B`。

task recovery 负责恢复某个 scan/collect/reduce/maintenance phase；boundary reconciliation 负责证明整个时间线闭环，二者缺一不可。尚未到期的 `retry_wait/notBefore` 原样返回 incomplete；halted/dead-letter/rebase/capacity 缺口必须报告并停在 rebuilding/degraded，不能绕过后标 healthy。

同一 evaluation 的 Provider/schema/事务技术恢复保持原 `cycleLineageId/reviewEpoch`，只增加 `retryEpoch` 并继承 retry 0 的 event-time visibility。`waiting_stale`、人工/dead-letter 复核或 late discovery 候选若在 rebuild 期间被明确调度，则必须在当前已完成的最新 singleton boundary 上建立新 semantic review lineage：冻结当时最新 replay state/current observation versions，使用 `replayNow(B_latest)`，并保持全部 evidence `<= B_latest`。它不能用新的 as-of 冒充旧 lineage retry，也不能创建/推进 source scan boundary；未封存的 review 与 technical retry 都使 reconciliation incomplete。

rebuild 期间 source generation 再次变化时，本轮尚未提交的结果全部 stale，旧 cycles/tasks取消，由 §2 新 generation 事务从空 authority 重启。普通 append 不改变 generation：`messageId > B` 的消息属于 rebuild 完成后的 live scan tail；不得偷偷扩张既有 task envelope。受控 cutover若要求冻结到最新末尾，应在校验前重新捕获并显式 force drain 新 boundary。

### 4.2 Suppression 终态过滤

受控历史重放可以按 [Suppression 与 Retention](suppression-and-retention.md) 的例外读取旧 source 以复原 add→correction 链，但在完成前必须执行该文档规定的 tombstone 终态过滤。若过滤改变 state，使用 `group_kind=system_cleanup` 的 semantic cleanup events、revision和完整 snapshot 原子提交；只在内存比较或直接把 target 标 healthy 不合格。

scope 存在未完成 privacy hard-delete operation 时，rebuild reconciliation 必须暂停；完成所有注册 store 的 purge + verify 前不得 force drain，也不得用新 observations重新导出待删除 source。

### 4.3 最终 Wall-clock Housekeeping

所有 boundary cycles 到达 `B`、candidate 语义 drain 和 suppression cleanup 完成后，worker 必须捕获一次 `housekeepingNow`（真实当前 wall clock），再调用与在线 Renderer/effective view 相同的纯代码 lifecycle 函数：

1. 按字段级 TTL 清理重建结束时已到期的 current scene 字段，并在该 epoch 首次字段到期前归档一次完整 last-known snapshot；
2. 把截至 `housekeepingNow` 已到期且仍 active 的 todo 原位标为 overdue；
3. 应用其他已定义的确定性 lifecycle/滑动窗口 cleanup；
4. 有变化时写一个或按既有规则合并的 `system_cleanup` revision、events和完整 snapshot，无变化时 noop。

这个步骤只把历史 event-time state推进到真实当前视图；它不能重新解释相对日期、触发专业 Proposer、修改 observation 结论或用 wall clock伪造历史 evidence。恢复时重复执行是幂等的；每次 reconciliation捕获一个新的单一 `housekeepingNow`，已经持久化的首次过期时间不得重写。

### 4.4 Rebuild 完成条件

只有同时证明以下条件，才能在一个完成事务中清除 source scan/target rows 的 rebuild boundary，把 source scan status和六个 target从 `rebuilding` 恢复为 `healthy`：

1. global source scan checkpoint 精确覆盖 captured `B`，且 `(start, B]` 的每条有效消息都有 `signals` observation coverage或 `no_relevant_signal` assessment；
2. 所有 `sourceBoundary <= B` 的普通 `reviewEpoch=0` cycles、已创建 semantic review lineages 及各自 technical `retryEpoch` 都已完成 collection、canonical reduce和 event-time lifecycle，没有缺失 slot或未知 COMMIT outcome；同 lineage 较低 retry epoch 只能是 `completed/superseded`，旧 semantic lineage只有在新 review/current-version boundary明确接管其 observation-target 后才能 superseded；每个 current lineage 的 latest retry cycle 必须 completed，不得 retry_wait/halted；
3. 所有截至 `B` 的 observation-target 关联均为 `consumed`、`excluded`，或有明确缺失条件且当前不 eligible 的 `waiting`；不存在 `ready`、`processing`、queued/running/retry_wait、`retryable`、`dead_letter`、未归约 proposal或悬空 candidate-task 映射；
4. capacity/compaction/replay/rebase 链均已收敛，任何 halted target 都使完成失败；
5. open episode/semantic arc若保留，必须是显式可解释的 open/waiting 领域状态，而不是漏跑 task；
6. tombstone suppression 终态过滤和最终 wall-clock housekeeping 已提交或确定性 noop；
7. `memory_state` schema、source refs/content hashes、generation、state snapshot、event/result revision连续性及 candidate幂等唯一约束全部通过；
8. RAG projection 是否追平由独立 checkpoint报告，不可拿 Memory 完成条件代替；正式 cutover若要求完整查询覆盖，还必须另外满足 §5 checkpoint gate。

完成事务本身不伪造 semantic revision；它只在上述 state revisions 已成功后更新 durable rebuild/target status。任一校验失败都保持可恢复 authority和精确 reason，不能以“scan 到末尾”“task succeeded”或旧 target cursor 相等降级通过。

## 5. RAG Projection Drain

RAG invalidation 不依赖通用 outbox，并持久化唯一的派生 projection checkpoint，至少包含 `processedGeneration`、`processedBoundaryMessageId` 与 `processedTombstoneId`；不得从 Memory scan checkpoint、observation 状态或旧 target cursor 推定 projection 进度。Recall/Scene Recall 不创建空操作 checkpoint，其 coverage 与 tombstone gate直接继承 RAG 查询边界。

worker 在启动、周期轮询和进程内 wake-up 时，把 checkpoint 与权威 `sourceGeneration` 和当前 source boundary比较：

1. generation 不同：projection 进入 rebuilding，失效旧派生数据并重建当前 generation；
2. generation 相同：普通追加按 `processedBoundaryMessageId` 增量追平；
3. 每轮先捕获 generation/boundary；
4. 提交 projection结果前再次校验 generation；
5. generation 再次变化时，本轮结果 stale，不得推进旧 generation checkpoint；
6. 只有 generation仍一致且追平 captured boundary，才能原子推进 checkpoint并恢复 projection worker healthy。

Suppression tombstone 的消费与 raw-source boundary独立。即使 generation/boundary均未变化，只要最新 tombstone ID 大于 `processedTombstoneId`，worker 就必须在 projection提交事务中物理失效/删除命中的派生数据并推进 tombstone水位；失败时两者一起 rollback。查询时 source-key gate仍必须保留，不能以物理删除完成替代 correctness gate。

进程内 wake-up只降低延迟；启动与周期 checkpoint比较才是 correctness保证。主聊天查询的 `requiredBoundary`、有效检索上界与告警算法见 [Context Coverage](context-coverage.md)。

## 6. 开发期 Destructive v3 切换

当前处于开发期，不提供 v1/v2 派生数据兼容。切换到 `memory_state.version=3` 必须：

- 保留 `chat_messages` 中有效 User/Assistant 原文及其归属；独立、明确授权的 privacy/source mutation除外，切换不得改写或删除 raw source。
- 停用 v1/v2 worker和 context injection后，破坏式清除旧 rolling/core、v2 memory state、target cursors、tasks、target status、ops log、events、snapshots、旧 projection checkpoint及其他可由 raw source重建的派生 authority。
- 建立全新的 v3 tables/constraints/empty state、source scan checkpoint、boundary cycle和 observation namespace；不得转换旧 task payload、cursor、snapshot/event revision或用旧 succeeded/noop/rejected结果预填 consumption 状态。
- 从 raw source开始 boundary-major rebuild；只有 [Suppression 与 Retention](suppression-and-retention.md) 明确要求独立保留且不属于旧派生兼容的数据，才按其隐私/审计契约处理。

destructive schema migration 本身只完成 authority替换，不自动证明 v3 可启服。

正式切换流程：

```text
停止对外服务并冻结 raw boundary
→ 备份、更新 schema/代码、停用旧 worker
→ 清空旧派生 authority并建立空 v3 schema
→ 初始化新 generation 的空 v2.1 authority
→ boundary-major forceDrainTo(frozen boundary)
→ candidate/suppression/wall-clock housekeeping/revision 校验
→ RAG projection checkpoint 校验
→ 仅在 §4.4 全部满足后启动服务
```

生产命令、备份点、停启服证明、报告归档和失败处置仍以 [Memory v2 生产切换执行手册（Deferred）](../../deferred/memory-v2-production-migration-runbook.md) 为准，不得用未验证临时命令代替正式 runbook。

## 7. Harness

除 projection generation/tombstone/retry 用例外，rebuild验收必须覆盖：

- 任意 scan I/O batch/debounce 下 boundary plan、Observer envelope和逐 boundary顺序完全相同；proposal grouping、context overlap与 session重分组下语义等价；
- 改变 Provider完成顺序时，同一 boundary cycle/evaluation仍读取同一 as-of snapshot并按 canonical顺序归约；
- 早期 profile task无法读取未来 episode/state；
- 2025 历史 todo/scene先按 event time建立和演化，最终才由 wall-clock housekeeping过期；
- pending capture后/task freeze前、task freeze后/scan commit前、无 pending row或active task但 boundary未完成、COMMIT outcome unknown均能reconcile；
- retryable rejection/dead-letter/capacity链阻止 rebuild完成，waiting evidence/open arc能被明确区分；
- technical retry保持原 boundary/as-of/candidate versions/semanticNow且只增加 retryEpoch；waiting-stale、operator/dead-letter recheck及 late-discovery candidate使用最新已封存 boundary的新 review lineage/latest as-of/current versions，二者 dedupe 不碰撞；
- 尾部不足 scan batch仍能由 force drain或 live `sourceScan.tailMaxDelayMs` / `sourceScan.provisionalUserMaxDelayMs`覆盖；
- Alice 行为基线和 batch/session/target-order变形测试全部通过。
