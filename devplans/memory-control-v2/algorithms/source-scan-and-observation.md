# Source Scan 与 Observation Ledger 算法（v2.1）

本文是 Memory v2.1 的稳定 source boundary、连续原文扫描、`SourceScanCoordinator`、LLM `semanticSignalObserver`、observation ledger、per-target candidate consumption、失败恢复与重建交互的单一权威来源。Memory v2.1 的持久 `schemaVersion` / `memory_state.version` 为 `3`。静态 shape、枚举、DDL 与索引由[状态契约](../state-contract.md)统一收录；boundary cycle、专业 Proposer collect/reduce 与 revision 规则见 [Task 执行、语义 Cycle 与幂等](task-execution-and-idempotency.md)。

本文按 destructive replace 设计，明确替换 v2.0 的 per-target raw cursor、`lagThreshold` eligibility、`newBatch/overlap` evidence 新鲜度和 target-major rebuild。开发期不提供旧 task/snapshot/event/sidecar 的读取兼容或 backfill；切换时清空旧 v2 派生 authority，从保留的 raw source 重建 v3。

## 1. 目的与非目标

本算法必须保证：

1. 每条已稳定提交的 User/Assistant 原文最终都有逐消息、可审计的语义扫描结论，包括不足任意固定阈值的尾部。
2. 跨窗口的提议—接受、建立—完成、纠正、反证和长期模式样本以 durable observation 保存，不因 scan batch、session 或 Proposer 频率丢失。
3. 专业 Proposer 由 observation-target candidate 驱动，始终回读原文；observation 只负责发现、关联和路由，不成为最终事实来源。
4. 全局 source scan progress 与每个 target 的 candidate consumption 生命周期彼此独立。task 成功、section noop、Reducer rejected 或旧 cursor 前进都不能掩盖未完成候选。
5. online 与 rebuild 使用同一 detector、ledger、candidate decision 和 Reducer 语义，并按稳定 boundary / as-of snapshot 防止未来状态泄漏。

`semanticSignalObserver` 不是第七个写入 Proposer。它无权产生 patch、item ID、最终 dueAt、profile/relationship 晋升结论、最终 episode 文案或 Renderer 文本。没有信号时输出逐消息 no-signal assessment 是正确结果。

LLM false negative 无法由 schema 从数学上消除；逐消息 assessment 只证明“该 detector version 已判断”，不证明判断绝对正确。质量保证由固定 detectorVersion、golden/Alice fixture、batch/session metamorphic 测试、可审计 late discovery 和必要时新 generation rebuild共同承担。

## 2. Authority 与系统不变量

| Authority | 回答的问题 | 不能代替 |
| --- | --- | --- |
| `chat_messages` | 原文说了什么、角色与发生时间 | 是否值得进入某个 Memory section |
| semantic-boundary plan + pending tail | 尚未冻结的稳定尾部何时触发、下一语义 cutoff 是什么 | 已完成 scan coverage |
| source scan task + checkpoint + assessments | 哪些稳定消息已经完成信号检查 | 某 target 是否已处理候选 |
| observation master/version/evidence | 发现了什么信号、后续证据如何扩充它 | 当前 Memory state |
| normalized observation-target row + decisions | 每个 target 对当前 observation version 的处理状态 | 原始事实或最终 patch |

必须始终满足：

- **连续扫描**：同一 generation/detectorVersion/contractVersion 的 incremental scan checkpoint 无洞单调推进；较晚成功 task 不能越过较早失败 range。
- **逐消息回执**：checkpoint 前进前，本 range 每条有效 source 必须恰有一条 current assessment；它要么关联至少一个 observation/arc/occasion action，要么明确 `no_relevant_signal`。
- **原文溯源**：每个 observation 至少有一条关系化的 `messageId + contentHash + quote` evidence；最终 patch 仍重新读取原文并执行正式 Evidence 校验。
- **非替代性**：`claim`、`semanticKey`、arc/occasion metadata 和现有 Memory 只帮助检索/路由，不能单独证明新事实。
- **候选不丢失**：每条 observation-target row 只使用 `ready | processing | waiting | consumed | excluded | retryable | dead_letter`；不能因 task `succeeded`、scan checkpoint 或 raw watermark 前进而删除。
- **显式关联**：`semanticKey` 不是唯一键，不触发自动合并。只有 Observer 明确输出输入中存在的 `relatedObservationId`，才能给该 observation append evidence/contradict/resolve。
- **批次不变量**：scan batch/debounce 只能改变 pending wake与 raw I/O 预取，不能改变 `single_source_message_v1` 的 task/cycle 切分。support window和 target 调度顺序可以改变成本，不能改变最终候选资格、模块归属、状态流转和 evidence coverage。
- **同边界快照**：同一 boundary cycle 的专业 Proposer 读取同一 as-of snapshot；物理上先完成的 target 不能向同 boundary 的另一个 target 泄漏派生 state。
- **版本一致**：一个 source generation 的 active scanner 只允许一个 detectorVersion/contractVersion；prompt/model/schema/taxonomy/semantic normalizer 改变时必须新 generation full rebuild。
- **渲染隔离**：scan task、assessment、observation、candidate status/reason 和内部 semantic/arc key 不进入 Renderer 或主聊天。

## 3. Stable Source Boundary

### 3.1 定义

稳定 source boundary 是：

```text
(sourceGeneration, sourceBoundaryMessageId)
```

`sourceBoundaryMessageId` 是一个短数据库快照中，当前 scope / generation 下所有有效且**完整提交**的 User/Assistant source 的最大 message ID；无 source 时为 `0`。有效性/可见性规则与 [Source Rebuild](source-rebuild-and-projection.md) 相同。

一条消息只有在正文最终提交、不会再被 streaming 原位改写时才进入 boundary。若聊天实现逐段生成，必须先写非 source buffer，再一次性发布最终消息；发布后的编辑、删除、恢复、归属或排序变化都是 source mutation，增加 generation。禁止扫描半截 assistant 内容后在同 generation 静默覆盖。

`sessionId`、session 日期和 turn 数不参与 boundary。`turnId` / `parent_user_message_id` 只用于源完整性、回复归属与幂等：

- 已完整提交的 user 消息不因 assistant 尚未到达而永久等待；它本身可成为 boundary。
- assistant 稍后提交时形成更大 boundary，并可通过 `relatedObservationId` 为早先候选补证。
- reply 关系不表示 episode、独立行为场合或重要性。

source 权威顺序是当前 generation 的 `messageId ASC`。任何会让较小 ID 的有效 source 在 checkpoint 之后才出现的导入/排序变化都必须新 generation，不能在旧 checkpoint 前插入。

### 3.2 捕获与吞吐合并

每条完整 source 提交或 reconciliation 发现新 source 时，`SourceScanCoordinator` 先执行 **pending capture**，此时不创建 task。在一个短事务中：

1. 按 §3.3 为尚未规划的有效 source 追加 immutable semantic-boundary rows；
2. 把 scan status 的 `stableBoundaryMessageId` 提升到本次可见最大完整 source；
3. 插入或 CAS-promote `chat_memory_source_scan_pending`：`pendingThroughMessageId=GREATEST(old,new)`，重算尚未取得 cycle/no-candidate 终局的 `pendingBoundaryCount`；`freezeDeadlineAt=LEAST(old,newCandidate)`；同一 backlog 的 `backlogStartedAt/tailDeadlineAt` 不后移。

首次 pending 的 `backlogStartedAt` 使用最老未扫描 source 的 durable finalized/committed time；`tailDeadlineAt=backlogStartedAt+sourceScan.tailMaxDelayMs`。`freezeDeadlineAt` 是 debounce、provisional-user deadline 与 tail deadline 中最早适用者。之后新消息、debounce wake、重复通知或 pending boundary 提升都不能把它向后推。

以下任一条件只负责把 pending 变为立即可冻结（deadline `LEAST(old, now)`），不直接改写已有 task：

1. 未扫描消息达到 `sourceScan.batchMaxMessages`；
2. debounce 到期；
3. 最老未扫描消息等待达到有限的 `sourceScan.tailMaxDelayMs`；
4. assistant 生成完成、受控 flush/drain、启动恢复或 rebuild 要求追平。

到 `freezeDeadlineAt` 后进入 **task freeze**。Coordinator 锁 scan status/pending，确认 generation/detectorVersion/contractVersion、checkpoint 与更早 boundary 终局，选择 checkpoint 后最早的 semantic-boundary row，在同一事务创建恰好覆盖该 row 的 immutable source-scan task。task 创建后其 boundary ID/ordinal/range/source hash/envelope/dedupe identity 均不可扩张；后来消息只提升 pending row，不能塞进旧 task。

pending row 在已冻结 task 运行时仍保留；scan commit、no-candidate 或 cycle terminal 后若 checkpoint 尚未追到 `pendingThroughMessageId`，由于原 deadline 已到，Coordinator继续冻结下一 boundary。只有 checkpoint 已追到 pending endpoint、对应 boundary 终局已封存且 CAS确认没有并发 promotion 时才删除。启动与周期 recovery 按 `freezeDeadlineAt` 索引枚举 pending，并同时恢复已有 scan task，因此进程内 timer 丢失不会漏掉尾部。

完整 user 消息一经提交就是稳定 source；Coordinator 可以在 assistant 正常生成期间最多等待 `sourceScan.provisionalUserMaxDelayMs`，让 user/assistant 共享一次 wake/raw prefetch，但该值不得超过 `sourceScan.tailMaxDelayMs`，也不合并两条 semantic boundaries。assistant 失败、连接中断或始终没有回复时，user 消息在期限到达后单独扫描，不能等待一个不存在的 pair。

user 后在 deadline 前到达的 assistant 可以提升同一 pending endpoint并共享一次 wake/raw prefetch；它们仍是两个 canonical semantic boundaries，严格逐 boundary 调用 Observer/cycle。受控 `flushTo(B)` 只是把 pending endpoint 至少提升到 `B` 并提前 deadline，复用相同 freeze 机制，不新增 Flush task type 或第二套 progress。

### 3.3 Semantic boundary 与物理 batch

v3 canonical `semanticBoundaryPlan` 固定为 `single_source_message_v1`：当前 generation 中每条按 source authority 排列的完整、有效 User/Assistant message 恰好形成一条 immutable `chat_memory_semantic_boundaries` row。其 endpoint 就是该 message ID，start-exclusive 是前一 boundary endpoint；boundary UUID 由固定 namespace 对 `(scope,sourceGeneration,sourceMessageId,contentHash)` 生成。session/turn/reply/time gap 不参与切分。

`stableBoundaryMessageId/pendingThroughMessageId` 只是“当前最多可追到哪里”；它们可以一次覆盖多个 canonical boundaries。一次 SQL/raw I/O 可以预取多条 boundary，但必须按 ordinal 重建当时 catalogs，逐条执行 `freeze task → Observer → scan commit → pre-cycle lifecycle → cycle/no-candidate terminal` 后才进入下一条。禁止把相邻 boundary 合成一个 Observer envelope，也禁止把一个 boundary按 `batchMaxMessages` 拆开；不存在“变形测试通过即可运行时合并”的例外。batch/debounce/support budget 只能改变 wake、预取和成本，不能改变 task/cycle 数、source cutoff、observation eligibility 或最终 projection。

## 4. Durable Source Scan Task

### 4.1 复用统一 task 表

source scan 复用 `chat_memory_tasks`：

- `task_type = source_scan`；
- `worker_key = semanticSignalObserver`；代码编排 authority 仍是 `SourceScanCoordinator`；
- `target_key = NULL`，因为它不是六个专业 target；
- `semantic_boundary_id` 必须引用 checkpoint 后最早的 immutable plan row；
- `task_payload` 固化 scan mode、generation、detectorVersion/contractVersion、semantic boundary ID/ordinal/planVersion、range/source key/hash、用户时区、完整 Observer envelope 和 source metadata；
- `stage_payload.persistedProposal` 保存通过 strict schema 的完整 canonical Observer 输出；统一沿用现有 task inspect 字段名，不另造 source-scan 专用 payload key。

pending 的首次 debounce/tail 等待不使用预建 `queued + notBefore` task表达；deadline authority 只在 `chat_memory_source_scan_pending`。deadline 到达后才冻结 task。task 的 `notBefore` 只用于已冻结 task 的 retry/backoff，不能反向延期 pending deadline或扩张 envelope。

scan task 沿用统一 task status：

```text
queued | running | retry_wait | succeeded | failed | cancelled
```

建议的 scan stage：

```text
scan_input_persisted
→ scan_running
→ scan_output_persisted
→ scan_committing
→ succeeded
```

`failed` 表示自动恢复耗尽；对应 source scan status 进入 `halted` 且 `lastErrorReason=dead_letter`，checkpoint 不推进。不要给 `chat_memory_tasks.status` 另造第二个 `dead_letter` 值。

### 4.2 Task identity 与恢复

增量 task dedupe identity 至少绑定：

```text
source-scan:{scope}:{sourceGeneration}:{detectorVersion}:{contractVersion}:
            {semanticBoundaryId}:{boundaryOrdinal}:{planVersion}:{scanMode}:{resumeEpoch}
```

`resumeEpoch=0` 是首次执行；普通 retry/restart 复用同 task/epoch，不按最新窗口重组 envelope。只有旧 task 已明确 cancelled/terminal 后的受控 fresh invocation 才增加 epoch，例如 catalog version stale 后重组输入，或操作者再次对同一历史 boundary 发起 late discovery。同 scope/generation/detectorVersion/contractVersion 同时最多一个可推进连续 checkpoint 的 active incremental scan task。

Provider 输出通过本地 strict schema 后，先用独立短事务写 `stage_payload.persistedProposal` 和 `scan_output_persisted`，再提交 ledger。恢复遇到该 stage 必须复用输出，不再次调用 LLM。COMMIT outcome unknown 时先按 task phase identity、assessments 和 checkpoint 查询是否已提交；不得直接重复写入。

### 4.3 Scan mode

固定 mode：

- `incremental`：处理 checkpoint 后下一 canonical boundary，成功时推进 checkpoint；
- `rebuild`：新 generation 从 ordinal 1 到 captured boundary 逐 boundary 使用同一算法；
- `late_discovery`：经诊断/人工入口重新检查 checkpoint 以前的一个或多个历史 canonical boundaries；每个 task仍只绑定一条既有 plan row，多个 boundaries 按 ordinal 建多个 task，不得临时合并 range。它不回退也不推进 checkpoint，但产生普通 observation、target rows 和 append-only assessment audit。其新增 ready rows 不得在历史 visibility 下直接消费；scan commit 只记录历史 `lateDiscoverySourceBoundaryId` provenance，candidate reconciler随后在当前最新已封存 boundary 创建新的 semantic review。

`late_discovery` 不能成为常规漏扫补丁。detector contract 改变必须新 detectorVersion + generation rebuild，不能长期靠随机回看修复旧 prompt。

## 5. `semanticSignalObserver` 输入

每次调用只读 immutable version 3 envelope：

```js
{
  task: {
    taskId: "uuid",
    tickId: 123,
    userId: 1,
    presetId: "Alice",
    schemaVersion: 3,
    sourceGeneration: 4,
    workerKey: "semanticSignalObserver",
    taskType: "source_scan",
    scanMode: "incremental",
    contractVersion: "sha256:...",
    semanticBoundaryId: "uuid",
    boundaryOrdinal: 42,
    boundaryPlanVersion: "single_source_message_v1",
    scanCursorBefore: 715,
    sourceBoundaryMessageId: 716,
    detectorVersion: "sha256:...",
    semanticNow: "...",
    userTimeZone: "Asia/Shanghai"
  },
  observedMessages: [
    {
      messageId: 715,
      role: "assistant",
      createdAt: "...",
      contentKind: "raw",
      contentHash: "sha256:...",
      replyToMessageId: null,
      content: "我们继续往家走。以后每天早上给你做早餐"
    },
    {
      messageId: 716,
      role: "user",
      createdAt: "...",
      contentKind: "raw",
      contentHash: "sha256:...",
      replyToMessageId: 715,
      content: "好呀"
    }
  ],
  newMessageIds: [716],
  openObservationCatalog: [
    {
      observationId: "uuid",
      version: 2,
      kind: "recurring_commitment",
      semanticKey: "care:daily-breakfast",
      claim: "Assistant 提议以后每天早上做早餐",
      candidateTargets: ["standingAgreements"]
    }
  ],
  mutableArcCatalog: [
    { arcId: "uuid", version: 1, semanticKey: "outing:night", title: "夜间外出" }
  ],
  mutableOccasionCatalog: [
    { occasionId: "uuid", version: 1, semanticKey: "breakfast-conversation", arcId: null }
  ]
}
```

输入约束：

1. `newMessageIds` 恰有一个 ID，等于本 task immutable boundary row 的 `sourceMessageId/sourceBoundaryMessageId`；`scanCursorBefore` 等于该 row 的 start-exclusive。incremental/rebuild 只能选择 durable checkpoint 后最早 boundary，late-discovery 也逐条绑定历史 plan row。`observedMessages` 同时包含该 delta 与 bounded support，严格 `id ASC`，不做 session/角色裁剪。
2. support 只来自 recent context、catalog evidence refs、reply links 和实体/动作检索，且 `messageId <= sourceBoundaryMessageId`。它帮助消歧，不单独触发普通 incremental signal。
3. `openObservationCatalog/mutableArcCatalog/mutableOccasionCatalog` 是 Observer 唯一允许通过 ID 关联的既有对象集合；mutable arc/occasion catalog 包含全部 open，以及由本次 correction dependency lookup直接命中的 closed 对象，不能扫描无界终态历史。它们使用 redacted claim/metadata，不复制 raw quote body。catalog 超预算时可对 catalog 做 durable、互斥分区并在同一 boundary assessment 前确定性汇总，不能缩小 singleton delta或静默截断后宣称覆盖。若分区仍会让关联判断不完整，task 必须 capacity-block/halt而不是提交 no-signal。
4. source scan envelope 不含 writable Memory state。已有 state/摘要不是 observation evidence，也不能使 detector凭空建立候选。
5. 默认不传 session 名称/ID 或无语义 turn 标识。reply parent 只帮助回复归属，不能分割 episode/模式样本。
6. 普通输入应用 suppression gate；受控 rebuild 读取 suppressed history 的唯一例外见 §12.1。
7. `semanticNow` 与运行 `createdAt` 分离：online 由 Coordinator 在 boundary 开始时捕获一次，后续 cycle 原样复用；rebuild 使用确定性 replay clock。Observer只保存源表达/anchor，不自行把“明天”解析为 `days: 0/1`。

## 6. Strict Observer 输出

Provider 必须使用 schema-constrained structured output；顶层和所有嵌套对象均 `additionalProperties=false`，required 字段不得省略。Canonical output：

```js
{
  tickId: 123,
  proposer: "semanticSignalObserver",
  sourceBoundaryMessageId: 716,
  messageAssessments: [
    {
      messageId: 716,
      outcome: "signals",
      signalIndexes: [0],
      arcActionIndexes: [],
      occasionActionIndexes: [0]
    }
  ],
  arcActions: [],
  occasionActions: [
    {
      action: "append",                 // create | append
      occasionId: "uuid",
      expectedVersion: 1,
      arcId: null,
      arcActionIndex: null,
      semanticKey: "breakfast-conversation",
      evidenceRefs: [
        { messageId: 716, quote: "好呀" }
      ]
    }
  ],
  signals: [
    {
      action: "append",                 // create | append | supersede | invalidate
      relatedObservationId: "uuid",
      affectedObservationIds: [],
      expectedVersion: 2,
      kind: "recurring_commitment",
      relation: "accepts",
      semanticKey: "care:daily-breakfast",
      subjectRole: "both",
      factBasisHint: "explicit",
      claim: "双方接受以后每天早上准备早餐的持续约定",
      candidateTargets: ["standingAgreements"],
      occasionId: "uuid",
      occasionActionIndex: null,
      arcId: null,
      arcActionIndex: null,
      evidenceRefs: [
        { messageId: 715, quote: "以后每天早上给你做早餐" },
        { messageId: 716, quote: "好呀" }
      ]
    }
  ]
}
```

### 6.1 逐消息 assessment

1. 输出必须恰有一条 assessment并覆盖 singleton delta source；不能漏项、重复或为 support message写 assessment。
2. `outcome=signals` 时 `signalIndexes/arcActionIndexes/occasionActionIndexes` 的并集非空、各自去重，且每个 index 指向 evidenceRefs 确实含该 messageId 的对象。反过来，每个 signal/arc/occasion action 的每条 task-delta evidence 也必须在对应 message assessment 中登记其 index，不能产生没有 assessment 归属的 action。`no_relevant_signal` 时三组 indexes 都必须为空。
3. `signals=[]` 合法，但这时每条 assessment 都必须是 no-signal；它只证明 source 已扫描，不等价于任意专业 target noop。
4. `late_discovery` task 把其显式历史 boundary 的 singleton message 当作本 task delta；它追加 assessment event，并把 current assessment 从 no-signal 幂等升级为 signals、对 observation/arc/occasion IDs 作稳定并集，但不抹掉首次 assessment audit，也不推进 checkpoint。

### 6.2 受控枚举

Observation kind：

```text
scene_state | one_time_commitment | recurring_commitment | interaction_rule |
episode_arc | profile_fact | profile_pattern | relationship_fact |
relationship_pattern | world_canon | memory_correction | memory_forget
```

Signal relation：

```text
establishes | proposes | accepts | rejects | supports | contradicts |
completes | cancels | corrects | forgets | arc_progress | arc_closes
```

`subjectRole` 使用受控 `user | assistant | both | relationship | world | unknown`；`factBasisHint` 固定为 `explicit | observedPattern | not_applicable`。candidateTargets 只使用六个正式 targetKey并按 canonical target order 去重。

### 6.3 Signal identity 与显式关联

- `action=create` 必须令 `relatedObservationId=null, expectedVersion=null`。持久层用 `UUIDv5(fixedObservationNamespace, scanTaskId + ":" + signalIndex)` 生成 observation ID；重试/重复 delivery稳定。supersede 产生 replacement observation 时同样使用该 signal output index；固定 namespace 将 observation 与 arc ID 空间隔离。
- `append | supersede | invalidate` 必须引用 input catalog 中同 scope/generation 的 exact `relatedObservationId + expectedVersion` 并 compare-and-set；不得猜测 ID。一个 output 对同一 related ID 最多一个 mutation。
- `semanticKey` 是非唯一检索/聚类提示，不建 UNIQUE、不自动选择 related observation。不同 scan task 即使 key/claim 相同，只要没有显式 related ID 就各自 create；后续专业 Proposer可用 `already_reflected` 安全终结重复投影。
- 每个 signal 至少引用一条 task delta evidence；关联既有 observation 时可同时引用旧原文。late-discovery task 的历史选择就是该 task delta，因此不绕过逐消息 assessment。
- 旧 message 只有在其 source key 已登记到本次显式 related observation/arc/occasion catalog 时才能作为追加 evidence；其他 supporting raw message只用于消歧，不能借当前 delta 把任意旧事实写入新 observation。真正过去漏检走 late_discovery audit。
- evidence 必须来自 input 且不晚于 boundary；quote 逐字复制并通过统一信息量/长度/source-hash 校验。Observer quote 成功不替代最终 patch校验。
- `claim/semanticKey/factBasisHint` 是候选分类，不是最终事实。`profile_pattern/relationship_pattern` 记录一份行为 occasion，不直接宣称稳定结论；session/turn不能制造独立 occasion。
- `factBasisHint=observedPattern` 的 signal 必须提供一个有效 occasion reference：既有 occasion 用非空 `occasionId`，本 output 新建 occasion 用非空 `occasionActionIndex`。真正独立的新行为场合必须 create 新 pattern observation + occasion（semanticKey 可相同），不得 append 后把 message 数误计为 occasion 数。
- signal 引用既有 occasion/arc 时填 `occasionId/arcId`，对应 `occasionActionIndex/arcActionIndex=null`；引用本 output 新建对象时令 ID 为 null，并用零基 `occasionActionIndex/arcActionIndex` 精确指向 `create/open` action。ID 与同类 action index 必须二选一；不关联时两者都为 null。Coordinator 在本地校验后先由 task/index 解析稳定 ID，再写 observation evidence，禁止用 semanticKey 或数组相邻位置隐式关联。
- 输出不含 confidence、patch、最终日期或 item。

### 6.4 Arc action

状态机为 `open -> closed|invalidated`、`closed -> invalidated`，invalidated 终态；append/close 只作用于 open。

- `open` 的 `arcId=null, expectedVersion=null`，持久层用 `UUIDv5(fixedArcNamespace, scanTaskId + ":" + arcActionIndex)` 生成稳定 UUID；
- `append/close` 必须引用 `mutableArcCatalog` 中 status=open 的 exact `arcId + expectedVersion`；invalidate 可引用 status=open，或本 correction dependency直接相关的 closed exact object；
- 每个 open 必须由同 output 恰好一个 `episode_arc` create signal 通过 `arcActionIndex` 引用，且包含 `episodes` target；该 observation 成为 arc 的固定 `episodeObservationId`。每个 append/close/invalidate 也必须分别伴随对这个 exact observation 的 `append+arc_progress`、`append+arc_closes`、`invalidate+contradicts` mutation。任一配对缺失、多重或指向其他 observation 都是 output schema invalid；
- semanticKey 相同不自动合并 arc。session、turn、固定消息数和单纯时间间隔不能独立 open/close；
- arc evidence 与 signal evidence使用相同 raw/source/quote 门。arc 只支持 episode continuity 和 pattern occasion independence，不进入 Renderer；它通过固定 episode observation 的 waiting evidence 进入 GapBridge，不能形成“纯 arc、无 observation”的覆盖洞。

### 6.5 Occasion action

状态机为 `open -> closed|invalidated`、`closed -> invalidated`，invalidated 终态；append/close 只作用于 open。

- `create` 的 `occasionId=null, expectedVersion=null`；持久层用 `UUIDv5(fixedOccasionNamespace, scanTaskId + ":" + occasionActionIndex)` 生成稳定 ID；
- `append/close` 必须引用 `mutableOccasionCatalog` 中 status=open 的 exact `occasionId + expectedVersion`；invalidate 可引用 open，或本 correction dependency直接相关的 closed exact object；不能把不同 arc 的行为追加成同一 occasion；
- occasion 归属既有 arc 时填 `arcId` 且 `arcActionIndex=null`；归属本 output 新 open 的 arc 时 `arcId=null` 并以 `arcActionIndex` 精确引用；无 arc 时两者都为 null。`arcId` 与 `arcActionIndex` 不能同时非空。
- 同一场合的后续 evidence append 既有 occasion；独立行为场合 create 新 occasion。semanticKey 相同不自动合并 occasion；
- occasion create 后 status=open；close/invalidate 以 action evidence 的最大 messageId 写 endedAtMessageId。同一 arc close/invalidate 时，所有仍 open 的关联 occasion 必须在同 output 分别 close/invalidate；session、turn、固定时间间隔不能单独终结 occasion。只有 closed 且有效的 occasion参与 `minDistinctOccasions` 计数；
- occasion action 不能只改 registry而不唤醒 pattern：Coordinator 对每个引用该 occasion 的 active `profile_pattern|relationship_pattern` observation执行确定性派生 mutation。append/close 把 action evidence以 `relation=supports` 首次登记到 observation、version+1，并写 target transition reason=`occasion_status_changed` 回 ready；close 后新 version 才可把该 occasion计入门槛。invalidate 在无 current projection依赖时以 `contradicts` invalidates该单-occasion pattern observation；已有 consumed/current projection时必须先走 §8.1 的 memory_correction/retract 流程，完成前 occasion保持有效。派生 mutation与 occasion action、assessment、checkpoint同事务且使用稳定 phase identity；
- observedPattern signal 的 occasion/arc ID 或同-output action index 必须与关联 action/catalog一致。至少 3 occasions / 2 arcs 的门槛由持久 registry 计算，不信 LLM 自报数量。

### 6.6 默认路由

| kind | 默认必须包含 | 可增加的独立投影 |
| --- | --- | --- |
| `scene_state` | `scene` | 高显著性时 `episodes` |
| `one_time_commitment` | `todos` | 事件显著时 `episodes` |
| `recurring_commitment` / `interaction_rule` | `standingAgreements` | 独立模式样本时 `profileRelationship` |
| `episode_arc` | `episodes` | 明确关系变化时 `profileRelationship` |
| `profile_fact` / `profile_pattern` | `profileRelationship` | 无；不依赖 episode 先生成 |
| `relationship_fact` / `relationship_pattern` | `profileRelationship` | 构成里程碑时 `episodes` |
| `world_canon` | `worldFacts` | 无 |
| `memory_correction` / `memory_forget` | 至少一个明确受影响 target | 可多 target |

## 7. 本地校验与原子 Scan Commit

### 7.1 校验顺序

Provider 输出先经纯代码校验：

1. strict schema、tick/proposer/boundary echo、enum、canonical ordering、字符/数组上限和逐消息 assessments；
2. task payload 与数据库 source 的 scope/role/createdAt/contentHash；
3. quote、至少一条 delta evidence、relation/kind/route/factBasis compatibility；
4. relatedObservationId / arcId / occasionId 属于对应 input catalog，既有对象 `expectedVersion` 与 task 捕获一致；同-output reference index 必须在范围内、指向 `open/create` action，并与 ID 互斥；arc action 与固定 episode observation mutation、arc close/invalidate 与全部 open occasion 终结必须完整双向覆盖；
5. 同 output 不存在重复 source ref、重复 target 或对同一 related object 多次 mutation。

首次输出边界错误可在同 immutable task 上执行一次配置化 schema repair；feedback 只含裁剪后的 path/reason，不保存非法输出原文。refusal、截断、空响应或解析失败不能转换成 no-signal。

related object version stale 时取消旧 scan task，基于最新 catalog 和新的 dedupe/resume epoch 创建 fresh scan task并重新调用；不得强行 rebase persisted output，也不建立 predecessor/successor 兼容链。输入契约错误或 repair 耗尽时 task `failed`、source scan status `halted/lastErrorReason=dead_letter`，checkpoint 不推进。

### 7.2 原子 commit

一次 incremental/rebuild scan commit 在同一事务：

1. 锁 task、scope scan status，重校 generation/detectorVersion/contractVersion，以及 semantic boundary ID/ordinal/planVersion/range/source hash；
2. 解析同-output ID 后，幂等 apply arc/occasion actions，并把每条已校验 raw ref 写入对应 arc/occasion evidence 表及 resulting object version；open arc 与 episode observation 的固定关联、occasion status/ended boundary 同时写入；
3. 按 signal action create/append/supersede/invalidate observation master，写带 resulting observation version/scan task phase 的关系化 evidence并校验 arc/occasion FK；arc action 的配对 observation mutation必须落到同一 resulting version；
4. 为 candidateTargets 幂等创建/更新 normalized observation-target rows；每次 status/version/reason 变化同时写 append-only target transition event，source-scan supersede/invalidate 使用内部 reason且不伪造 candidate decision/cycle；
5. 按每条 messageAssessment 写 current `chat_memory_scan_assessments` 与 append-only assessment event；
6. 写 scan phase identity 和 durable boundary-ready reconciliation trigger；cycle/asOf 只能在后续 pre-cycle lifecycle 完成后创建；
7. `scannedThroughMessageId` 精确推进到 sourceBoundaryMessageId；
8. task 置 `succeeded`，清 scan retry/halt状态。

任一步失败整体 rollback。不存在“checkpoint 已推进但 assessment/observation 未写”或“observation 已写却重调 LLM 生成另一 ID”的窗口。late-discovery commit 不改 checkpoint；current assessment 通过 CAS version+1、对 observation/arc/occasion IDs 作稳定并集，并保留独立 task event。

scan checkpoint 可以在 observation-target 仍 `ready/waiting/retryable/dead_letter` 时前进，因为候选和 source refs 已 durable；target healthy 由 consumption ledger 独立判断。

## 8. Scan Status、Arc、Observation 与版本

静态 shape 由状态契约定义；算法依赖以下字段语义：

```js
SourceScanStatus = {
  userId, presetId,
  sourceGeneration, detectorVersion, contractVersion,
  scannedThroughMessageId,
  stableBoundaryMessageId,
  rebuildBoundaryMessageId,
  status,                         // healthy | retry_wait | halted | rebuilding
  consecutiveErrors,
  lastErrorReason, lastTaskId, nextRetryAt,
  updatedAt
}

SemanticBoundary = {
  semanticBoundaryId,
  userId, presetId, sourceGeneration,
  boundaryOrdinal,
  sourceStartExclusive, sourceBoundaryMessageId,
  sourceMessageId, contentHash,
  planVersion,                    // single_source_message_v1
  createdAt
}

SourceScanPending = {
  userId, presetId,
  sourceGeneration, detectorVersion, contractVersion,
  pendingThroughMessageId, pendingBoundaryCount,
  backlogStartedAt, freezeDeadlineAt, tailDeadlineAt,
  triggerReason, version,
  createdAt, updatedAt
}

SemanticArc = {
  arcId, userId, presetId, sourceGeneration, detectorVersion,
  semanticKey, title,
  status,                         // open | closed | invalidated
  startedAtMessageId, endedAtMessageId,
  lastSourceBoundaryMessageId,
  version,
  createdByScanTaskId, createdOutputIndex
}

ArcEvidence = {
  arcId, arcVersion,
  messageId, contentHash, quote,
  action, sourceBoundaryMessageId
}

ObservationMaster = {
  observationId, rootObservationId, parentObservationId,
  userId, presetId, sourceGeneration, detectorVersion,
  observationKind, semanticKey, subjectRole, factBasisHint, claim,
  status,                         // open | superseded | invalidated
  version,
  firstSourceBoundaryMessageId, lastSourceBoundaryMessageId,
  createdByScanTaskId, createdOutputIndex
}

ObservationEvidence = {
  observationId, observationVersion,
  messageId, contentHash, quote,
  relation, occasionId, arcId,
  sourceBoundaryMessageId,
  mutationScanTaskId, phaseIdentity
}

SemanticOccasion = {
  occasionId,
  userId, presetId, sourceGeneration, detectorVersion,
  semanticKey, arcId,
  status,                         // open | closed | invalidated
  firstMessageId, lastMessageId,
  endedAtMessageId, lastSourceBoundaryMessageId,
  version,
  createdByScanTaskId, createdOutputIndex
}

OccasionEvidence = {
  occasionId, occasionVersion,
  messageId, contentHash, quote,
  action, sourceBoundaryMessageId
}

ScanAssessment = {
  userId, presetId, sourceGeneration, detectorVersion,
  messageId, contentHash,
  firstScanTaskId, lastScanTaskId, version,
  outcome,                         // signals | no_relevant_signal
  observationIds, arcIds, occasionIds,
  assessedAt
}

ScanAssessmentEvent = {
  scanTaskId, scanMode,
  userId, presetId, sourceGeneration, detectorVersion,
  messageId, contentHash,
  outcome, observationIds, arcIds, occasionIds,
  createdAt
}
```

current assessment 是 checkpoint coverage 的快速 authority；append-only event 是 incremental 原判断、late discovery 和重复恢复的审计 authority。同一 task/message phase 具有唯一约束。late discovery 只能把 current outcome 从 no-signal 单调升级为 signals并对 observationIds/arcIds/occasionIds 作稳定并集，不得把 signals 降级为空。

### 8.1 Action 语义与幂等

- `create`：生成稳定新 ID，`rootObservationId=self`、`parentObservationId=null`、status open、version 1。
- `append`：CAS related row 的 version，追加幂等 evidence并更新 current claim/last boundary/version；observation ID/root/parent 不变。
- `supersede`：只对尚无 consumed/current projection依赖的 related row，CAS 标 superseded/version+1，再以稳定 output ID 建 open replacement；replacement `rootObservationId=related.rootObservationId`、`parentObservationId=relatedObservationId`。
- `invalidate`：只对尚无 consumed/current projection或有效 pattern依赖的 related row，CAS 标 invalidated/version+1并保存 invalidating evidence；不因同 semanticKey 连带 invalidate 其他 observations。
- 已投影 observation、arc 或 occasion 不能由 scan commit 先失效再等待 state 追赶。Observer 必须 create `memory_correction|memory_forget` signal，`affectedObservationIds` 精确列出 dependency closure并路由全部受影响 targets；其它 signal 的该数组必须为空。Reducer 接受 update/corrected retraction/forget 后才对已解除的 target写 transition，所有 active projection均解除后在同一事务 finalise observation invalidation。arc/occasion invalidation还必须先重算依赖它的 observed-pattern items；门槛跌落且无替代值时输出 `retractItem+correct`。
- evidence PK/幂等 identity 至少绑定 `(observationId,messageId,contentHash,relation)`；重复 delivery不得增加 version或 target row。
- semanticKey只建普通 catalog index，绝不建 UNIQUE或作为 conflict target。
- observedPattern 晋升按 distinct persisted occasionId 与 arcId 计数；同一 occasion 的多条 evidence 仍只算一份。occasion/arc 都使用关系化 scope/generation 校验，不能只信 LLM 的 occasionKey 字符串。

append/supersede/invalidate 后，受影响 current observation 的 candidate target 集只增不减。新 target 插入 `ready`；已有 target 若本次 version 有相关新 evidence则更新 observationVersion并回 `ready`，旧 decision audit保留。无新 evidence 的 unrelated row 不因纯文案变化空跑。

### 8.2 DetectorVersion

`detectorVersion` 是 prompt、strict schema、model/adapter protocol、kind/relation taxonomy、routing/semantic normalizer 的 content fingerprint。只影响吞吐的 batch/debounce/poll/retry不进入 fingerprint。

active generation fingerprint 不匹配时停止新 scan，并通过新 source generation清空 v3 当前派生 authority、从 raw source full rebuild。禁止同 generation 混用两版 detector、从旧 observations转换新 observations或只重跑专业 Proposer。

## 9. Normalized Per-target Consumption

每个 `(observationId,targetKey)` 恰有一条 normalized current row，携带当前 `observationVersion`。固定状态：

```text
ready
  ├─→ processing
  │     ├─→ consumed
  │     ├─→ excluded
  │     ├─→ waiting ──(new evidence/condition)──→ ready
  │     ├─→ retryable ──(retry/resume)─────────→ processing
  │     └─→ dead_letter ──(manual requeue)─────→ retryable
  └─(observation version advances)→ ready
```

Normalized row 至少保存：

```js
ObservationTarget = {
  observationId, targetKey,
  userId, presetId, sourceGeneration,
  observationVersion, lastEvaluatedVersion,
  status,                         // exact enum above
  reasonCode,
  lastTaskId, attempt, nextRetryAt,
  lastCycleLineageId, lastReviewEpoch, lastReviewedAt,
  updatedAt
}
```

状态语义：

| 状态 | 当前 version 是否结算 | 健康含义 |
| --- | --- | --- |
| `ready` | 否 | 超过 backlog SLA 后 degraded |
| `processing` | 否 | durable normal task/lease 过期后 degraded |
| `waiting` | 否、休眠 | 合法缺证，不自动 degraded；到复核期限必须重判 |
| `consumed` | 是 | patch 已全部接受，或 state 已等价表达 |
| `excluded` | 是 | 对该 target 明确不合格，保留 reason/evidence |
| `retryable` | 否 | degraded；技术/Reducer/rebase 可修复失败 |
| `dead_letter` | 否 | degraded；需人工修复/requeue，rebuild 不得 healthy |

新 observation version 不覆盖旧 decision audit。Coordinator 按 relation 对 target 做 material-impact 判定：`accepts/rejects/completes/cancels/corrects/forgets/contradicts/arc_progress/arc_closes`，以及确实增加已关闭、独立长期模式 occasion 的 `supports`，都会让受影响 row 更新到新 `observationVersion` 并回 `ready`；完全重复的 supports 不重跑已 consumed row。waiting 在获得其缺失条件相关 evidence 后回 ready。supersede/invalidate 时旧 observation 的非终态 rows 以内部 reason `observation_superseded/observation_invalidated` 转 excluded，replacement target rows 从 ready 开始。每次 status/version/reason 变化写 append-only target transition event；generation/suppression/retry/operator 路径分别使用固定系统 reason，这些事件不要求存在 candidate decision 或 boundary cycle。

新 evidence 到来前不按固定频率重跑 waiting。

normal task 创建事务必须以 compare-and-set 将所含 rows 从 `ready/retryable` claim 为 `processing`，写同一个 `lastTaskId`；重复 wake-up 命中既有 task。`processing` row 没有对应可恢复 task、task candidate set不含该 row，或 processing 超 lease/SLA 时是持久化不变量损坏，不能直接改 consumed；reconciler 将其恢复为 retryable并记录诊断。

waiting 唤醒条件包括：显式 related observation version 增长、相关 item 被纠正/forget、同 semanticKey/actor 的新 pattern sample 到达、open arc 得到 resolve evidence、人工 rescan。semanticKey 只用于找出“应重新判断哪些 waiting rows”，不能自动合并 observations；profile/relationship sweep 超过 page size 时 durable 分页，不得截断。

`observation.waitingStaleAgeMs` 是强制复核期限，不是删除期限。年龄只从 `lastReviewedAt` 计算，不能用会被无关 bookkeeping 改写的 `updatedAt` 代替。到期时即使没有新 raw message，也不能创建旧 boundary 的 technical retry；它排入 `reviewTrigger=waiting_stale` 的 semantic review，在当前 generation 最新已封存 semantic boundary 下捕获最新 as-of 与 current observation version。仍真实缺证可再次 waiting，并原子写 `lastCycleLineageId/lastReviewEpoch/lastReviewedAt`；明确不合格才 excluded。Retention job 无权直接把 waiting 改终态。

## 10. Candidate-aware 专业 Proposer

### 10.1 调度与 envelope

专业 Proposer 不按 raw lag 调用。`ready/retryable` rows 由 boundary cycle 按 target claim 为 `processing`，同 target 可合并多个 candidate，但达到 batch 上限时 durable 分页。

immutable envelope 至少包含：

- 排序后的 observation ID/current version、kind/relation/semantic/arc/occasion metadata和历史 decision；
- 每个 observation 的全部直接支持/反证 raw messages，以及提议—接受、建立—完成所需的相关原文；
- cycle 的 source generation/boundary/as-of revision/snapshot identity；
- 该 target 的 as-of writable state、必要 read-only context、用户时区和 evidence createdAt。

Observation 文本只帮助定位。普通 patch 的 evidenceRefs 从 raw messages 选择并重新校验；不要求 evidence 位于任意 `newBatch`，`overlap_only_evidence` 不再是合法 reject reason。

同 cycle 所有 Proposer先 collect persisted proposals，再按 canonical target order reduce；具体步骤以 [Task 执行、语义 Cycle 与幂等](task-execution-and-idempotency.md) 为准。

### 10.2 Canonical candidateDecisions

每个输入 observation-target row 必须恰好有一条：

```js
{
  observationId: "uuid",
  outcome: "proposed",             // proposed | waiting | excluded | already_reflected
  reasonCode: "meets_write_threshold",
  patchIds: ["patch-1"]
}
```

固定 reason：

| outcome | 合法 reasonCode |
| --- | --- |
| `proposed` | `meets_write_threshold` |
| `waiting` | `insufficient_evidence | awaiting_acceptance | awaiting_outcome | ambiguous_reference | pattern_threshold_not_met` |
| `excluded` | `target_mismatch | not_memory_worthy | transient_only | invalid_inference | not_canon | contradicted` |
| `already_reflected` | `duplicate_or_existing_state` |

约束：

1. `proposed` 的 `patchIds` 必须非空，并与普通 patch/scene epochTransition 的 `patchId + observationIds` 双向一致；其他 outcome 的 `patchIds=[]`。每个 operation 也至少引用一个本 task observation ID。
2. section `noop` 仍必须逐候选输出 waiting/excluded/already_reflected；不能用一个 noop 吞掉整批。
3. 只要有 proposed decision，相应 section 必须有引用它的 patch。漏 candidate、重复 candidate、非输入 ID 或 proposed 无 patch 均为 output schema invalid。
4. target mismatch 只排除当前 target，不修改同 observation 的其他 normalized rows。
5. `already_reflected` 需要 Reducer 确定性关联当前 item/field identity；若存在新的 reaffirm provenance 应使用 proposed patch，不得借此丢证据。
6. 没有 ready candidate 的 target 不调用 Proposer；诊断性空调用使用 task outcome `no_candidates`，不伪造 decision。

### 10.3 Reducer 后结算

| Proposer/运行结果 | normalized target status |
| --- | --- |
| proposed 且该 observation 关联的全部语义 patches accepted | `consumed` |
| already_reflected 且确定性校验通过 | `consumed` |
| excluded | `excluded` |
| waiting | `waiting` |
| Provider/schema/quote/item/time/policy/rebase 等可修复失败 | `retryable` |
| 自动恢复耗尽/无法安全判断 | `dead_letter` |

普通 Reducer `rejected` 不等于已消费。除非同 candidate 有独立、合法的 excluded decision，技术/策略 rejection 必须 retryable/dead-letter。一个 candidate 关联多个 patch 时，只要任一必要 patch rejected/deferred，该 candidate 就不能 consumed；按 patch `observationIds` 分别结算，不因同 task 其他 patch accepted 而关闭。

candidate decision 必须有 append-only audit，关联 observation/version、task、reason 与 patch IDs；存在实际 patch event 时还可关联 event group/result revision。waiting/excluded/already_reflected 即使不改变业务 section也必须持久化到 candidate decision 表，不能只留在 Provider payload。纯 waiting/excluded/already_reflected 不创建 event group、revision 或 snapshot；只有实际 rejected/deferred patch 才可创建 `result_revision=NULL` 的非空审计 group，只有 accepted semantic patch 或 lifecycle cleanup 增加 revision。

系统状态变化使用额外内部 reason（不属于 Provider candidateDecisions enum）：`observation_version_advanced | occasion_status_changed | observation_superseded | observation_invalidated | source_suppressed | generation_cancelled | retry_exhausted | operator_requeued | operator_confirmed_exclusion`。每次变化写 append-only observation-target transition event；纯系统 transition 不创建 candidate decision、event group或 revision。

## 11. Failure、Dead-letter 与 Health

### 11.1 Source scan failure

- pending capture 事务失败：不产生半条 plan/pending 更新；启动/周期 reconciliation 从 raw source重做。due pending 没有对应 active/frozen task 时按原 boundary row冻结 task，不能重新计算更晚 deadline。
- Provider/network/safety/truncation：同 immutable scan task 有界退避，task `retry_wait`，checkpoint 不推进。
- schema invalid：最多一次配置化 repair；耗尽后 task `failed`，source scan status=`halted`、`lastErrorReason=dead_letter`。
- generation/progress/source hash stale：旧 task `cancelled`；由当前 checkpoint/new generation 重建正确 task。
- transaction 明确回滚：同 phase identity 重试；COMMIT outcome unknown 先查 assessments/checkpoint/task 终态。

source scan status 因 dead-letter reason 进入 `halted` 后，阻塞该连续 range 之后的 incremental scan；可以记录更晚 wake-up，但不得越过缺口提交或宣称 coverage。

### 11.2 Candidate failure

Provider/Reducer failure 只影响关联 target rows；其它 targets 和 source scan 可以继续。task 保存 attempt/notBefore/repair feedback/persisted proposal，normalized row 保存 `retryable/dead_letter`、last reason/task 用于恢复和健康聚合。

技术 reason 至少稳定区分：

```text
llm_call_failed | safety_policy_blocked | max_output_truncated |
output_schema_invalid | unable_after_expansion | observation_version_stale |
evidence_source_mismatch | quote_too_short | quote_too_long | quote_not_found |
policy_not_allowed | invalid_state_transition | item_not_found |
capacity_blocked | rebase_conflict | reducer_failed |
transaction_failed | commit_outcome_unknown
```

这些 reason 只能进入 retryable/dead-letter/ops audit，不能冒充 Provider 的 `excluded` reason。达到上限时保留原 reason并追加系统 `retry_exhausted`，以便 inspect 区分模型、evidence、policy、capacity和事务故障。

dead-letter 不是 semantic noop。自动上限耗尽后 evidence/observation/task/decision 均保留，target 持续 degraded。修复后显式 requeue 只把 row 标为等待 `reviewTrigger=dead_letter_recheck` 的 semantic review；它不得沿用失败 lineage 的 boundary/as-of/semanticNow。semantic detector 改变则新 generation rebuild。人工要求重新判断使用 `operator_requeue` review；人工确认不应记忆时可写 `operator_confirmed_exclusion` audit 后转 excluded，必须记录操作者/时间/原 reason，禁止直接删 row 或改 healthy。

### 11.3 健康

Source scan health：

- `rebuilding`：新 generation 从 0 追 captured boundary；
- `healthy`：detectorVersion/contractVersion 匹配，plan 连续，checkpoint 在 `sourceScan.tailMaxDelayMs` 内覆盖 stable boundary，且没有逾期 pending、无主 frozen task或 boundary terminal 缺口；scan status=healthy；
- `degraded`：scan lag 超 SLA、pending 逾期未冻结、boundary/task/cycle 链断裂、status=retry_wait，或 status=halted/dead-letter reason；rebuild 时单独为 rebuilding。

Target semantic healthy 必须满足：

1. 无 `retryable/dead_letter` rows；
2. 无超过 backlog SLA 的 `ready/processing`；
3. 到期 waiting 已完成复核；
4. scan generation/detector/checkpoint 正常；
5. 既有 capacity/rebuild/context-quality 门满足。

合法 waiting 是明确的休眠状态，不单独 degraded，但必须展示数量/最老年龄/等待 reason。task `succeeded` 不能单独恢复 target healthy。

`inspect:memory-v2` 至少显示 stable boundary、canonical plan ordinal/version、pending through/count/deadline/age/trigger、checkpoint/detector/contract/scan lag、逐消息 assessment 统计、observation/version/evidence IDs、按 target status/reason 聚合的 rows、最新 candidate decision/patch/event/rejection，以及“无候选、waiting、excluded、technical failure、suppressed”五类空结果区别。默认不重复打印完整敏感正文。

指标至少按 detectorVersion/target/model/result 统计 calls、tokens、latency、assessment、observations/message、append、waiting/excluded/consumed/retry/dead-letter age。标签不得包含 raw content、claim、semanticKey、observationId 或 userId。

## 12. Suppression、Privacy 与 Retention

### 12.1 Context suppression

普通 scan input、candidate selection、专业 Proposer raw fetch和 Reducer apply 都按 `(messageId,contentHash)` 执行 tombstone gate：

- 新 tombstone 立即使命中 evidence 的未消费 candidate 失去写 active state 资格；后台 reconciler 把相应 normalized rows 转 `excluded`，内部 reason=`source_suppressed`。
- consumed state 的 correction/forget 仍按 [Suppression 与 Retention](suppression-and-retention.md) 原子修改 state/tombstone；observation excluded 不能替代 active-state 终态过滤。
- correction 消息自身若未被 suppress，正常建立 observation。
- master 当前 version/evidence 与 decision audit 保留到 retention；不能把 suppressed 原文重新放入普通 detector/Proposer。
- 一个 open observation 的全部有效 evidence 都被 suppress 时，reconciler 以系统 action 将 master `invalidated`，并将其非终态 target rows按 `source_suppressed` 排除；部分 evidence 被 suppress 时，后续 candidate envelope只使用未 suppressed refs，若不足则 waiting/excluded，不得偷偷回读旧 quote。

受控 rebuild 是 detector 读取 suppressed history 的唯一例外：旧原文必须标记为 `suppressedSupportingContext`，只用于消解 correction 指代，不能写成有效 observation/patch evidence或进入主聊天。修正后投影必须由未 suppressed 的 correction/后续 evidence 支撑；captured boundary 后仍执行 suppression 终态 reconciliation。

### 12.2 Privacy hard delete

privacy store registry 必须纳入：

- `chat_memory_tasks` 中 source-scan/candidate/cycle 的 task/stage payload；
- source scan status、pending tail、semantic-boundary plan、assessment master 与 events；
- observation master/version 字段/evidence；
- normalized observation-target rows与 candidate decision audit；
- scan/observation diagnostics、受控 debug 与关联 cycle payload。

部分 source hard delete 时，任何含该 `messageId + contentHash` 的 boundary row、pending引用、payload/observation/evidence/assessment 必须物理删除；不能只标 excluded 后保留 quote。操作增加 generation，并从剩余 raw source重建。整个 preset 删除则物理删除该 scope 的全部上述数据。

privacy verify 通过关系化 evidence/assessment 和受控 JSON payload scan 证明无残留；缺失 source refs、无法证明来源的 observation/debug payload 一律清除。incomplete privacy operation 存在时，scanner、candidate worker、cycle 和 rebuild reconciler 均跳过该 scope。

### 12.3 Retention

Retention 必须保留：

1. active generation checkpoint/detectorVersion/contractVersion、canonical boundary plan 与非空 pending row；
2. active generation 的 current scan assessments及 late-discovery audit events；
3. 所有非终态 scan/candidate/cycle task和因 dead-letter reason 失败的 source scan task；
4. open observation、waiting/retryable/dead-letter rows及其 evidence；
5. active Memory provenance、retained event/snapshot/task/decision引用的 observation及当时 version；
6. rebuild/privacy/diagnostic 未完成所需对象。

终态 scan task 只有在 checkpoint 已覆盖其 range、assessments/ledger 可证明完整且超过 retention 后才能清理。superseded/invalidated observation master 只有在无 provenance/task/decision 引用且超过 terminal retention 后才能清理；open master 与其 current evidence 不得按普通终态清理。waiting 不能因年龄直接删除，必须先复核并形成 consumed/excluded 或继续 waiting decision。

当前 DDL 的 observation/arc/occasion master 是 current-version projection，不单独复制每版 claim/title。因而任何 create/append/supersede/invalidate/close 所对应的 source-scan task `stage_payload.persistedProposal`，在该 object/version 仍被 evidence、target row、candidate decision或 retained event引用时不得清理；它是版本变化 audit。若实现要缩短 scan task retention，必须先在状态契约增加等价的 append-only normalized object-mutation/version history，并完成引用迁移，不能同时删除 task 输出和历史版本依据。

Privacy hard delete 优先于 retention/audit。

## 13. Rebuild、Event Time 与 Detector 升级

### 13.1 Boundary-major rebuild

新 generation 从 checkpoint 0 按时间线循环：

```text
capture stable boundary Bi
→ SourceScanCoordinator / semanticSignalObserver
→ atomically commit assessments, observations, target rows, checkpoint
→ run pre-cycle lifecycle with semanticNow(Bi)
→ if runnable target rows exist, create boundary cycle reviewEpoch=0/retryEpoch=0 and freeze asOfRevision Ri
→ collect all triggered target proposals against Ri
→ reduce in canonical target order and settle target rows
→ continue with Bi+1
```

若该 boundary 没有 runnable target row，scan assessments/ledger 已是它的 durable no-candidate 证明，不创建空 cycle或空 Proposer task，完成 pre-cycle lifecycle 后直接继续下一 boundary。

scan checkpoint 可以先于 target consumption 前进；boundary cycle/rebuild completion 仍必须追踪每个 candidate。一个 cycle 的 waiting 是合法结论；retryable/dead-letter 阻止相应 target/rebuild 宣告 healthy。更晚 raw source 可以被预取，不能出现在较早 cycle envelope。

同 cycle 的 target 可并行调用 Provider，但都读取一个 snapshot。`episodes`、`profileRelationship` 等没有前置链，物理完成顺序不改变语义。

durable cycle 只在 scan commit 与 pre-cycle lifecycle 完成、asOfRevision 已确定后创建，初态为 `proposing`；source scan task/status 独占扫描运行 authority，cycle 不另设 `scanning` 状态。普通 boundary cycle 固定 `cycleKind=boundary/reviewEpoch=0/reviewTrigger=null/retryEpoch=0` 并创建新的 `cycleLineageId`。Provider/schema/事务等技术 retry 保持同 lineage/review，使用 `retryEpoch+1`；较低 retry cycle 原子转 `superseded` 并 immutable 保留审计。

Technical retry 必须继承 retry 0 的 `asOfRevision`、visibility snapshot identity、source cutoff、`semanticNow`、candidate versions 与 source refs；不能因 Provider 延迟看到同-boundary retry 0 已提交的其他 target state。任一 observation version 已被更晚 boundary改变时，旧 lineage不重组“最新” envelope，而由拥有 current version 的更晚 boundary接管。旧 persisted proposal 不跨 retry epoch直接 apply。

### 13.2 Semantic review boundary

`waiting_stale`、人工重新判断、dead-letter 修复与 late discovery 新候选属于后来发生的语义 evaluation，不属于上段 technical retry。调度器必须等待当前 generation 的所有更早 semantic boundary/evaluation 封存，再引用最新已封存 `semanticBoundaryId/sourceBoundaryMessageId=B_latest`，在锁内分配该 boundary 的下一个 `reviewEpoch>0`，创建新的 `cycleLineageId` 与 `cycleKind=semantic_review/retryEpoch=0`。它先按当前模式捕获新的 semanticNow、运行确定性 pre-review lifecycle，然后冻结当时最新完整 state/asOf 与本轮触发 rows 的 current observation versions。late discovery review 使用 `reviewTrigger=late_discovery`，并把被重扫的历史 singleton boundary 另存为 `lateDiscoverySourceBoundaryId`；该字段只解释触发来源，不是 evidence/visibility cutoff。

没有新 raw message 时 semantic review 使用 `sourceStartExclusive=B_latest/sourceBoundaryMessageId=B_latest` 的空 source delta；它不创建 assessment、不改变 canonical boundary plan/pending、不推进 scan checkpoint。所有 candidate evidence 仍必须已经登记且 `messageId <= B_latest`。最新 boundary/evaluation 尚 active 时 review 只能 durable 排队，不能并入或扩张旧 cycle。重复 review wake-up 以 `{scope,generation,semanticBoundaryId,reviewEpoch}` 命中同一 lineage；normal task 再以 `{cycleLineageId,retryEpoch,targetKey,candidateSetDigest}` 去重。

### 13.3 Event time

- relative time 以 patch evidence source `createdAt` + 用户时区为 anchor；rebuild wall clock 不参与。
- online boundary 的 `semanticNow` 是该 boundary 一次性捕获的当前时间；rebuild 使用不倒退的 `replayNow(Bi)`。同 cycle 的 pre-lifecycle、全部 proposal和 post-lifecycle只使用这一值。
- scene/todo lifecycle 在每个 replay boundary 使用事件时间；追平 captured boundary 后，以显式捕获的 final evaluation time 做一次 wall-clock housekeeping。technical retry 继承 retry 0 semanticNow；online semantic review 捕获 review 创建时的新 semanticNow，rebuild 内的 review 使用 `replayNow(B_latest)`。
- session 日期不能代替 message time。

### 13.4 初始化与完成门

新 generation 原子取消旧 generation 非终态 scan/candidate/cycle tasks，建立 v3 空 state、checkpoint 0、空 assessment/observation namespace和 rebuilding controls，并按剩余 raw source从 ordinal 1 重建 `single_source_message_v1` plan/pending。旧 generation observations 与 boundary rows 不复制。

Rebuild 完成除 state/snapshot/event/projection 校验外还要求：

- canonical plan 对 captured 有效 source 一一覆盖且 ordinal/range 连续，checkpoint 到 captured boundary、detectorVersion/contractVersion 匹配且逐消息 assessments 完整；
- source scan status 非 retry_wait/halted，且无 coverage 缺口；
- 无 pending row、无已冻结未终结的 source-scan task；
- boundary 以前所有 normalized rows 为 `consumed | excluded | waiting`，无 `ready | processing | retryable | dead_letter`；
- suppression 终态 reconciliation 已提交；
- 每个 cycle/candidate decision/patch mapping 完整。

合法 waiting 不阻塞 rebuild 完成，但必须进入报告。任何 dead-letter 都不能因 checkpoint/raw cursor 到末尾被忽略。

detectorVersion 改变强制新 generation full rebuild；不得原地重写 observation 或仅重跑 candidate consumers。

## 14. 集中配置

统一 Memory 配置入口至少提供并校验：

- observer adapter/model/timeout/output 上限和 `sourceScan.detectorVersion`；该值由 prompt/strict schema/routing 等自动计算或在启动时校验为同一 fingerprint，禁止人工保留旧值却改变语义；
- `sourceScan.batchMaxMessages/supportingContextMessages/debounceMs/tailMaxDelayMs/provisionalUserMaxDelayMs` 和 worker poll；
- `observation.maxOpenCatalogItems` 以及 catalog 字符预算/open-arc/open-occasion budget；
- scan Provider retry/backoff/schema-repair 上限与 halted/dead-letter-reason 门；
- `observation.retryLimit/waitingStaleAgeMs`、per-target candidate batch、waiting sweep page、backlog SLA、terminal retention和 Provider dead-letter；
- `pattern.minDistinctOccasions=3`、`pattern.minDistinctArcs=2` 与 `boundaryCycle.targetOrder/retryLimit`；
- claim/semanticKey/arc/quote/每 task signals/evidence refs 的上限；
- task/assessment/observation/version/decision/debug retention 与健康告警防抖。

约束：

1. `sourceScan.batchMaxMessages >= 1`，`tailMaxDelayMs/provisionalUserMaxDelayMs` 有有限正上界，且 provisional 不大于 tail；这些值只计算 pending deadline/wake/prefetch，不得参与 boundary endpoint。
2. 任一 output/候选上限触发时必须 durable 拆分/分页或失败，不得裁剪后推进 checkpoint。
3. 改变 detector 语义的配置必须改变 detectorVersion并 rebuild；纯吞吐配置不得改变 observation 资格/ID规则。
4. 旧六组 lagThreshold/contextWindow 不再控制 scan/eligibility；专业 Proposer context 预算只控制候选相关原文检索，不控制候选是否存在。
5. 配置缺失/越界在加载边界 fail fast，不在运行路径猜默认值。

## 15. Harness 入口与必测用例

离线入口继续统一为：

```bash
npm run test:memory-v2
```

fixture 放在 `modules/memory/harness/fixtures/`，增加 `sourceScan`、`observationLifecycle`、`candidateConsumption` / boundary cycle 场景；不建立第二套 runner。真实 detector schema preflight/smoke 扩展既有 Provider probe/smoke 入口。

至少覆盖：

1. **Boundary/尾部**：单条 user、稍后 assistant、assistant 失败、debounce 崩溃、周期恢复与 flush 都连续覆盖；pending endpoint 只提升、deadline 只提前，重启从 due row冻结原 boundary；session 重分组不改变结果。
2. **逐消息 strict schema**：assessment 漏项/重复/乱序、signal/arc/occasion index 不匹配 evidence、未知字段/enum、错误 echo/quote/target/related ID/expectedVersion 均不推进；existing ID 与同-output action index 互斥，new occasion/new arc 引用必须可确定性解析；合法全 no-signal 写 assessments并推进。
3. **稳定 ID/显式关联**：各固定 namespace 中同 scanTaskId/outputIndex 重投得到同 observation/arc/occasion UUID；相同 semanticKey 的独立对象不自动合并；只有显式 related ID append 并增加 version。
4. **Crash/幂等**：Provider 后、output persisted 后、assessment/observation/target insert、checkpoint update 和 COMMIT unknown 逐点故障不重复 ID/version/row。
5. **跨窗口**：提议—接受、todo 建立—完成相隔多个 batch 时 append 同 master；target row version 增长并回到 ready，旧 decision audit 保留。
6. **Candidate decisions**：逐候选覆盖；outcome/reason 精确枚举；proposed 与 patch.observationIds 双向映射；noop 不吞 candidate；Reducer rejection 不得 consumed。
7. **长期模式**：三份行为样本至少覆盖两个 semantic arcs 才晋升；同一微事件三条消息保持 waiting；profile/relationship 不等待 episode。
8. **批次变形**：不同合法 scan batch/debounce 只能改变 wake/raw prefetch，产生完全相同的 singleton boundary rows、Observer task envelopes和逐 boundary cycle顺序；support/candidate batch、1/8/更多 session和 target 完成顺序变化后，模块归属/状态/evidence coverage 仍语义等价。
9. **同边界快照**：一个 target 先 reduce 后，另一 target 的 envelope 仍来自 frozen as-of snapshot；早期 cycle 看不到未来 episode/profile。
10. **失败恢复**：scan failed 使 source scan status halted/dead-letter reason并阻止越过；candidate retryable/dead-letter 保留 evidence且 target degraded；修复/requeue 不重复 item。
11. **Suppression/privacy**：tombstone gate 立即阻止消费；force rebuild 只为 correction 链并执行终态过滤；partial/preset hard delete 清除所有 payload/assessment/evidence/quote。
12. **Retention**：非终态/dead-letter/waiting/current/provenance 引用对象不可清理；旧 version 清理不破坏 current/inspect。
13. **Rebuild/version**：boundary-major event-time replay与 online 语义等价；detectorVersion 变化新 generation；任一 dead-letter 不得 healthy。
14. **Alice 基线**：`528/529`、`729/730` 形成 recurring agreement observations；`684/687/696→724/727/728` 是同一 todo 生命周期并完成；`975–1076` 作为连续 episode arc；`1078–1080` 的“明天”保留 source anchor并解析为下一自然日；无 canon 时 worldFacts 可为空。

## 16. Destructive Cutover 完成定义

实现/测试完成后，停服并冻结 raw boundary，清空旧 v2 state、snapshots/events/tasks/status/diagnostics 等派生 authority，初始化 `version=3`，再从 raw source 运行本算法 full rebuild。不存在旧 task/snapshot/event 的兼容读取、双写或 backfill。

只有 source scan checkpoint/assessments、observation ledger、normalized target rows、candidate decisions、专业 Proposer、Reducer、健康/inspect、suppression/privacy/retention 和 boundary-major rebuild 全部接通并通过 §15，才能启服。旧 per-target lag eligibility、overlap-only gate 或 target-major rebuild 不得保留为 fallback。
