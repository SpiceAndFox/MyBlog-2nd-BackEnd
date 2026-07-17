# Memory Control v2.1 状态契约

本文是 Memory Control v2.1 的静态契约权威来源：只定义数据 shape、枚举、约束、policy 与存储落点。编排见 [写入协议](write-protocol.md)，状态转移见 [算法契约索引](algorithms/README.md)，顶层取舍见 [顶层设计](memory-control-v2-overview.md)。

## 0. 版本选择与开发期替换边界

产品架构仍称 **Memory Control v2**；本次行为协议称 **v2.1**，持久化 `schemaVersion` 与 `memory_state.version` 固定为 **3**。

当前系统仍处开发期，version 3 采用直接、破坏性替换：

1. 保留 `chat_messages` 中仍有效的 user/assistant 原文，以及与 Memory 无关的用户、preset 配置；
2. 停止 Memory worker 后，清空 `chat_preset_memory.memory_state`，drop 并按本文重新 create 全部 Memory v2 authority、task、event、observation、projection 与诊断表；
3. 不读取、迁移或回填 version 2 state、target cursor、task payload、proposal、event、snapshot、tombstone 或 projection checkpoint；
4. 不做双写、兼容 reader、旧 task replay、旧 proposal replay或按 target 扫描的过渡路径；
5. 从保留的 raw source 以 version 3 协议全量重建，再启用在线写入。

因此，本文后续只定义 version 3；任何 `targetCursors`、`cursorBefore/targetMessageId/newBatch`、`lagThreshold`、version 2 schema fallback 或 migration backfill 都不属于现行契约。

## 1. 权威状态

### 1.1 唯一 current authority

`chat_preset_memory.memory_state JSONB` 是当前 Memory 的唯一 authority。snapshot 是恢复锚点，event 是审计/replay 记录，observation 是可重建的控制面；三者都不是第二份 current authority，也不得直接注入主聊天。

```js
{
  version: 3,
  current: {
    scene: {
      epochId: null,
      startedAtMessageId: null,
      location: emptySceneField,
      time: emptySceneField,
      mood: emptySceneField,
      note: emptySceneField
    },
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
    revision: 0,
    sourceGeneration: 1
  }
}
```

`emptySceneField` 固定为：

```js
{ value: null, evidenceRef: null, updatedAtMessageId: null }
```

`meta` 不保存 scan 或 target cursor：

- raw source 机械扫描进度以 `chat_memory_source_scan_status` 为 authority；尚未冻结为 task 的尾部/deadline 以 `chat_memory_source_scan_pending` 为 authority；
- 每条完整有效 source 对应的 canonical semantic boundary 以 immutable `chat_memory_semantic_boundaries` 为 authority；
- observation 对每个 target 的处理状态以 `chat_memory_observation_targets` 为 authority；
- task 的 attempt、not-before、阶段和 proposal 以 `chat_memory_tasks` 为 authority。

普通 raw append 不改变 `sourceGeneration`。编辑、删除、恢复、改变 scope/visibility/order，或改变 `detectorVersion` 时创建新 generation；旧 generation 的 task/cycle/observation 不得写入新 state。

### 1.2 Scene shape

非空 scene field：

```js
{
  value: "Alice 家的厨房",
  evidenceRef: {
    observationId: "uuid",
    messageId: 123,
    contentHash: "sha256:...",
    quote: "在厨房给你做早餐",
    changeKind: "establish"
  },
  updatedAtMessageId: 123
}
```

`previousScene` 为 `null` 或：

```js
{
  epochId,
  startedAtMessageId,
  endedAt,
  endReason: "explicit_end" | "new_epoch" | "field_ttl",
  location, time, mood, note
}
```

`previousScene` 保存一个 epoch 最后一份完整非空快照。同一 epoch 的字段分批 TTL 到期只能归档一次，后续到期不得用残缺快照覆盖；只有更晚的 epoch 才能替换它。scene 字段各自按自己的 evidence message 时间过期，更新一个字段不会给其他字段续期。

`endedAt` 的确定性来源：`explicit_end/new_epoch` 使用对应 epoch transition evidence message 经数据库复核后的 `createdAt`；`field_ttl` 使用该 epoch 第一个实际到期字段的 expiry instant。不得使用 worker wall clock。

### 1.3 Item、证据组与专用字段

所有 item 的公共 shape：

```js
{
  id: "todo:uuid",
  text: "明早为 Alice 做三明治",
  projectionIdentity: "observation-root-uuid",
  sourceProjectionIdentities: ["observation-root-uuid"],
  semanticKey: "meal:breakfast:sandwich",
  currentFieldLineage: {
    text: {
      currentFingerprint: "sha256:...",
      evidenceGroupIds: ["event-group:patch-1"]
    }
  },
  evidenceGroups: [{
    evidenceGroupId: "event-group:patch-1",
    evidenceKind: "assistant_commitment",
    changeKind: "establish",
    assertedValueFingerprints: {
      text: "sha256:...",
      dueAt: "sha256:..."
    },
    observationIds: ["observation-uuid"],
    occasionIds: ["occasion-uuid"],
    refs: [{
      messageId: 696,
      contentHash: "sha256:...",
      quote: "明天一定给你做超好吃的三明治"
    }]
  }],
  createdAtMessageId: 696,
  updatedAtMessageId: 696
}
```

静态约束：

- `id` 由 Reducer 生成；
- 每个非 compaction patch 先把 `observationIds` 解析为排序去重的 root observation ID 集合 `R`。`sourceProjectionIdentities=R`；`|R|=1` 时 `projectionIdentity=R[0]`，`|R|>1` 时使用固定 `projectionSetNamespace` 对 canonical `R.join("\n")` 计算 UUIDv5。compaction 对全部 source item 的 `sourceProjectionIdentities` 做同一函数，不另设身份算法；只有 projectionIdentity 完全相同的跨 section 投影才允许 Renderer 去掉重复表达，集合部分相交不能整项去重；
- `semanticKey` 是检索/关联提示，不是 authority，不设唯一约束，相同 key 不得触发自动合并；
- `evidenceGroups` append-only；update 保留历史 group。只有 `correct` 和 `forget` 可以为旧 source 创建 suppression；
- `evidenceGroupId` 由 accepted patch/event identity 确定性生成；`assertedValueFingerprints` 由 Reducer 对该 group 实际建立/重申/修改的字段和值做 canonical serialization 后计算，Proposer 不输出；
- `currentFieldLineage` 由 Reducer 维护且不得由 Proposer 输出。每个当前可见语义字段都必须有 `currentFingerprint` 和非空、排序去重、可解析到本 item `evidenceGroups` 的 `evidenceGroupIds`：establish 使用新 group；reaffirm/refine 在仍依赖旧值时合并原 lineage 与新 group；supersede/correct 以新 group 替换；compaction 为每个合并后字段取所有实际支持 source field lineage 的并集，并计算合并后 current fingerprint。correction 必须从 pre-state 对应字段的 lineage 精确收集待 suppress source；lineage 为空、悬空或不能证明当前值时 fail closed。forget 才收集 item 全部 groups；
- `createdAtMessageId` 是首个 accepted establish group 的最小 message ID；`updatedAtMessageId` 是当前全部 group ref 的最大 message ID；
- observation 的 waiting/retry 状态不能复制进 item。

`currentFieldLineage` key 集合固定，不能由实现按对象键遍历自行决定：

| section | 必需 lineage keys | 条件 key / 原子性 |
| --- | --- | --- |
| 所有 item | `text` | `semanticKey/projectionIdentity/createdAt/updatedAt` 是派生身份/审计，不建 field lineage |
| `todos` | `actor,requester` | `due` 在 dueAt 非空时必需，fingerprint 原子覆盖 `{dueAt,timeAnchorMessageId}`，不得拆成两个可独立 suppress 的 lineage；`status/becameOverdueAt` 是 lifecycle 派生，不进入 source lineage |
| `standingAgreements` | `agreementKey` | 与 text 分开，但 update/merge 后必须仍有支持 group |
| `recentEpisodes/milestones` | 无额外必需 | 非空 `arcId` 时必须有 `arcId` lineage；null 不建 |
| `userProfile/assistantProfile/relationship` | `facet,canonicalKey,factBasis` | 三者分别维护，不因只改 text 自动替换 |
| `worldFacts` | 无额外 | 只有 text |

普通 correction 只要求被修改字段具有可验证 pre-state lineage；从默认 null/不存在新建立一个条件字段时没有旧 assertion 可 suppress，可以 establish该字段的新 lineage，但不得把其他字段 source当作“旧 null”的证据。corrected retraction要求该 section 当前所有必需及现存条件 lineage均非空，取并集。`assertedValueFingerprints` 和 normalized operation 使用相同 key/`due`原子化规则。

专用字段：

| section | 专用字段 |
| --- | --- |
| `todos` | `actor: user\|assistant\|both`、`requester: user\|assistant`、`status: active\|overdue`、`becameOverdueAt`、`dueAt`、`timeAnchorMessageId` |
| `standingAgreements` | `agreementKey`；默认来自候选 `semanticKey`，不唯一，更新仍须显式选择 `itemId` |
| `recentEpisodes` / `milestones` | 可选 `arcId`；任何 open arc 都不创建 item |
| `userProfile` / `assistantProfile` / `relationship` | `facet`、`canonicalKey`、`factBasis: explicit\|observedPattern` |

profile 枚举：

| section | facet | canonicalKey | multi-value key |
| --- | --- | --- | --- |
| `userProfile` | `identity\|background\|preference\|communicationBoundary\|communicationStyle\|interactionPattern\|interest` | `identity\|background\|location\|expertise\|communicationTone\|responseFormat\|responseLength\|followUpQuestions\|roleplay\|serviceTreatment\|topicSeriousness\|correctionStyle\|emotionalExpression\|humorStyle\|interest\|open` | `background\|expertise\|interest\|open` |
| `assistantProfile` | `identity\|personaTrait\|communicationStyle\|behavioralTendency\|value\|limitation` | `identity\|persona\|communicationTone\|responseFormat\|followUpQuestions\|roleplayIdentity\|emotionalStance\|value\|limitation\|open` | `persona\|value\|open` |
| `relationship` | `status\|address\|trust\|interactionPattern\|sharedBoundary` | `relationshipStatus\|userToAssistantAddress\|assistantToUserAddress\|trust\|roleStructure\|interactionPattern\|sharedBoundary\|open` | `interactionPattern\|open` |

非 multi-value key 在 section 内唯一，multi-value key 仍受 exact duplicate gate。`factBasis=observedPattern` 至少需要 3 个 distinct `occasionId`，并跨至少 2 个 distinct 非空 `arcId`。计数由持久 observation evidence 确定，不按 message 数或 LLM 自报数字。

### 1.4 Section 与 target

正式 section：

```text
scene | todos | standingAgreements | recentEpisodes | milestones |
worldFacts | userProfile | assistantProfile | relationship
```

正式 target 与 writable section：

| targetKey | workerKey | writable sections |
| --- | --- | --- |
| `scene` | `currentStateProposer` | `scene` |
| `todos` | `todoProposer` | `todos` |
| `standingAgreements` | `agreementProposer` | `standingAgreements` |
| `episodes` | `episodeProposer` | `recentEpisodes`, `milestones` |
| `profileRelationship` | `profileRelationshipProposer` | `userProfile`, `assistantProfile`, `relationship` |
| `worldFacts` | `worldFactProposer` | `worldFacts` |

`current/working/longTerm/meta/previousScene` 不是 section 或 target。`semanticSignalObserver` 是 source-scan worker，不是 target。

### 1.5 专业 Proposer state projection

`targetKey` 同时确定唯一 writable projection 和允许出现的 read-only section 集；task 不携带可漂移的 section 清单：

| target | writableState | 允许的 readOnlyContext sections |
| --- | --- | --- |
| `scene` | `current.scene` 与 `current.previousScene` | `userProfile,assistantProfile,relationship,worldFacts` |
| `todos` | `todos` | `scene,standingAgreements,userProfile,assistantProfile,relationship` |
| `standingAgreements` | `standingAgreements` | `scene,todos,userProfile,assistantProfile,relationship` |
| `episodes` | `recentEpisodes,milestones` | `scene,todos,standingAgreements,worldFacts,userProfile,assistantProfile,relationship` |
| `profileRelationship` | `userProfile,assistantProfile,relationship` | `scene,standingAgreements,milestones,worldFacts` |
| `worldFacts` | `worldFacts` | `scene,milestones,userProfile,assistantProfile,relationship` |

`scene` 表示 effective current scene；`current.previousScene` 只作为 scene writer 的 lifecycle state，不是正式 section。read-only todos 默认只含 active；若 candidate 直接关联 overdue item则必须额外保留它。todos writableState 包含全部 active、所有 candidate 直接关联 overdue item，再按 `proposerContext.todosRecentOverdueItems` 取最近 overdue；直接关联项不计入该条数裁剪。取消/完成后已不在 authority state 的 item 不从 event history伪造进 context。

组装顺序固定为：candidate 直接关联的 writable/read-only items → 每个允许 section 的确定性相关项 → 公共背景。直接关联以 observation root/projection identity、现有 evidence observation IDs、arc/occasion、显式 item link 与 canonical entity/action key 的纯代码索引确定，不能靠 text 相似度猜。直接关联项永不因 item/code-point 预算被静默截断；若连同必需 raw evidence 超过 Provider 物理上限，task 进入 `unable_to_decide/missing_context` 或显式 capacity failure，不得调用一个缺必要项的 Proposer。其余内容按 `proposerContext.maxReadOnlyItemsPerSection/maxReadOnlyCodePoints` 稳定裁剪，并在 envelope 写 coverage metadata。

readOnly item 一律移除 `id` 与完整 evidenceGroups，只保留理解背景所需的结构化可见值；它不能成为 patch evidence或 itemId 来源。target 的 writable sections 绝不在 readOnlyContext 重复出现。任何实现额外放入未列 section、遗漏直接关联项，或因 target 调度顺序改变 read-only projection，均为 envelope contract violation。

## 2. 固定枚举

### 2.1 Worker、task 与状态

```text
workerKey = semanticSignalObserver | currentStateProposer | todoProposer |
            agreementProposer | episodeProposer | profileRelationshipProposer |
            worldFactProposer | compactionProposer | systemCleanup

taskType = source_scan | normal | maintenance | system_cleanup
taskStatus = queued | running | retry_wait | succeeded | failed | cancelled

sourceScanStatus = healthy | retry_wait | halted | rebuilding
sourcePendingTrigger = debounce | batch_target | provisional_user_deadline |
  tail_deadline | assistant_complete | flush | drain | recovery | rebuild
semanticBoundaryPlanVersion = single_source_message_v1
cycleStatus = proposing | reducing | retry_wait | completed | superseded | halted
targetHealth = healthy | retry_wait | capacity_blocked | halted | rebuilding
```

`source_scan` task 的 `targetKey` 必须为 `null`；normal/maintenance 必须使用合法 target；system cleanup 可按归属使用 target 或 `null`。所有 task 必须有 `workerKey`。

`stage` 不是自由文本，按 taskType 使用封闭、单调状态图：

```text
source_scan:
  pending -> proposing -> scan_output_persisted -> committing -> committed

normal:
  pending -> proposing -> proposal_persisted -> reducing
  reducing -> context_expansion_pending -> proposing
  reducing -> capacity_blocked -> replaying_original_proposal
  reducing|replaying_original_proposal -> committed|no_state_change
  replaying_original_proposal -> replay_failed

maintenance:
  pending -> proposing -> proposal_persisted -> compacting
  compacting -> compaction_applied
  compacting -> compaction_failed
  proposing|proposal_persisted|compacting ->
    hygiene_applied|hygiene_noop|hygiene_skipped|hygiene_stale

system_cleanup:
  pending -> reducing -> committed|no_state_change

任意非终态 stage -> failed|cancelled
```

Provider/transaction 重试不倒退 stage；`taskStatus=retry_wait` 保留失败时的非终态 stage并要求 `notBefore` 非空，恢复后 CAS 回 running继续该 phase。`status=succeeded` 只允许 source_scan:`committed`、normal:`committed|no_state_change`、maintenance:`compaction_applied|hygiene_applied|hygiene_noop|hygiene_skipped|hygiene_stale`、system_cleanup:`committed|no_state_change`；`status=failed` 只允许 `failed|replay_failed|compaction_failed`，且后两者分别只属于 normal/maintenance；`status=cancelled` 必须 stage=cancelled。queued/running/retry_wait 不得使用终态 stage。进入 `scan_output_persisted|proposal_persisted` 后 `stagePayload.persistedProposal` 必填且 immutable；committed/compaction_applied 中实际改 state 才允许非空 resultRevision，noop/hygiene skipped 等必须为 null。

### 2.2 Observation

```text
observationKind = scene_state | one_time_commitment | recurring_commitment |
  interaction_rule | episode_arc | profile_fact | profile_pattern |
  relationship_fact | relationship_pattern | world_canon |
  memory_correction | memory_forget

signalRelation = establishes | proposes | accepts | rejects | supports |
  contradicts | completes | cancels | corrects | forgets |
  arc_progress | arc_closes

observationStatus = open | superseded | invalidated
observationTargetStatus = ready | processing | waiting | consumed |
  excluded | retryable | dead_letter
subjectRole = user | assistant | both | relationship | world | unknown
factBasisHint = explicit | observedPattern | not_applicable
arcStatus = open | closed | invalidated
occasionStatus = open | closed | invalidated
```

`waiting` 是正常业务状态，不导致 degraded；`retryable/dead_letter` 是故障状态。observation master 不保存 target 结论。

Arc/occasion 状态机固定为 `open -> closed|invalidated`、`closed -> invalidated`；invalidated 终态不可恢复。append/close 只接受 open，invalidate 接受 open 或被 correction dependency 精确带入 mutable catalog 的 closed 对象。closed→invalidated 必须遵守 projected dependency 先收口的规则，不能只改 registry。

observation append 后 version 增长时，纯代码按新增 relation × target 的 material-impact 表重算 target 行。`accepts|rejects|completes|cancels|corrects|forgets|contradicts|arc_progress|arc_closes` 必须把受影响的 consumed/excluded/waiting target 重新置为 ready；完全重复且不改变证据集合的 `supports` 可以保持原状态。不能把 consumed 理解为 observation 永久关闭。

### 2.3 Evidence、changeKind 与 patch op

```text
evidenceKind = user_request | user_commitment | assistant_request |
  assistant_commitment | todo_completion | todo_cancel | todo_expiration |
  scene_change | standing_agreement | agreement_cancel | recent_episode |
  relationship_milestone | user_correction | assistant_correction |
  user_forget | assistant_forget | long_term_fact | memory_compaction

changeKind = establish | reaffirm | refine | supersede | correct | forget | lifecycle

patchOp = setField | clearField | addItem | updateItem | retractItem | forgetItem |
  mergeItems | completeTodo | cancelTodo | expireTodo | cancelAgreement

cleanupType = scene_epoch_archived | scene_field_expired | scene_epoch_emptied |
  previous_scene_evicted | todo_became_overdue | todo_revived_from_overdue |
  recent_episode_evicted
```

自然演化必须使用 `reaffirm/refine/supersede` 并保留旧 source。`correct` 只表示旧事实当时就是错误的；`forget` 只表示明确遗忘/删除意图；`lifecycle` 用于真实完成、取消、过期、scene epoch 与确定性 housekeeping。

### 2.4 Candidate decision

```text
candidateOutcome = proposed | waiting | excluded | already_reflected

proposed reason = meets_write_threshold
waiting reason = insufficient_evidence | awaiting_acceptance | awaiting_outcome |
                 ambiguous_reference | pattern_threshold_not_met
excluded reason = target_mismatch | not_memory_worthy | transient_only |
                  invalid_inference | not_canon | contradicted
already_reflected reason = duplicate_or_existing_state
```

### 2.5 Reject reason

Reducer reject reason 至少包括：

```text
schema_invalid | target_scope_mismatch | observation_not_found |
observation_version_stale | observation_target_mismatch |
candidate_coverage_invalid | evidence_not_registered |
message_id_not_found | evidence_source_mismatch | evidence_role_mismatch |
quote_too_short | quote_too_long | quote_not_found |
policy_not_allowed | change_kind_not_allowed | invalid_state_transition |
item_not_found | duplicate_item | duplicate_profile_key |
pattern_threshold_not_met | stale_cycle | rebase_conflict |
item_protected_by_pending_proposal | capacity_exceeded
```

reject reason 的 retry/terminal 分类以 [Reducer Apply](algorithms/reducer-application.md) 为准；`task=succeeded` 不能把可修复 reject 伪装成 observation 已消费。

## 3. Source scan 与 Observation 契约

### 3.1 Scan envelope

```js
{
  task: {
    taskId, tickId, userId, presetId,
    schemaVersion: 3,
    sourceGeneration,
    workerKey: "semanticSignalObserver",
    taskType: "source_scan",
    scanMode: "incremental" | "rebuild" | "late_discovery",
    contractVersion,
    semanticBoundaryId,
    boundaryOrdinal,
    boundaryPlanVersion: "single_source_message_v1",
    scanCursorBefore,
    sourceBoundaryMessageId,
    detectorVersion,
    semanticNow,
    userTimeZone
  },
  observedMessages: [/* singleton boundary delta + 有界 supporting context */],
  newMessageIds: [/* singleton canonical boundary 的唯一 source message */],
  openObservationCatalog: [/* redacted；仅当前 generation */],
  mutableArcCatalog: [/* open + 本 correction 直接相关 closed；redacted */],
  mutableOccasionCatalog: [/* open + 本 correction 直接相关 closed；redacted */]
}
```

source scan 不包含 writable state，也不能输出 patch。`semanticBoundaryId/boundaryOrdinal/planVersion/range/source key/hash` 必须和 immutable plan row 完全相同；`newMessageIds` 恰有一个 ID 且等于 `sourceBoundaryMessageId`。supporting context 不得冒充未扫描 new message。

### 3.2 Scan output

```js
{
  tickId,
  proposer: "semanticSignalObserver",
  sourceBoundaryMessageId,
  messageAssessments: [{
    messageId,
    outcome: "signals" | "no_relevant_signal",
    signalIndexes: [0],
    arcActionIndexes: [0],
    occasionActionIndexes: [0]
  }],
  arcActions: [{
    action: "open" | "append" | "close" | "invalidate",
    arcId: null,
    expectedVersion: null,
    semanticKey: "outing:night",
    title: "夜间外出",
    evidenceRefs: [{ messageId, quote }]
  }],
  occasionActions: [{
    action: "create" | "append" | "close" | "invalidate",
    occasionId: null,
    expectedVersion: null,
    arcId: null,
    arcActionIndex: null,
    semanticKey: "breakfast-promise",
    evidenceRefs: [{ messageId, quote }]
  }],
  signals: [{
    action: "create" | "append" | "supersede" | "invalidate",
    relatedObservationId: null,
    affectedObservationIds: [],
    expectedVersion: null,
    kind: "recurring_commitment",
    relation: "proposes",
    semanticKey: "care:daily-breakfast",
    subjectRole: "assistant",
    factBasisHint: "explicit" | "observedPattern" | "not_applicable",
    claim: "Assistant 提议以后每天早上做早餐",
    candidateTargets: ["standingAgreements"],
    occasionId: null,
    occasionActionIndex: null,
    arcId: null,
    arcActionIndex: null,
    evidenceRefs: [{ messageId: 729, quote: "以后每天早上都给你做" }]
  }]
}
```

约束：

1. `messageAssessments` 必须逐一且只逐一覆盖 `newMessageIds`，不能漏消息、重复消息或为 supporting-only 消息创建 assessment；`outcome=signals` 时三个 index 数组的并集必须非空，`no_relevant_signal` 时必须全部为空；
2. 每个 signal/arc/occasion action 至少引用一个 new message；旧消息只能作为 supporting ref，且必须已在输入 catalog；
3. observation 的 `append/supersede/invalidate` 必须显式引用同 scope、generation、version 的 `relatedObservationId`；arc/occasion append/close/invalidate 同样必须精确引用输入 catalog 中的 ID/version；相同 `semanticKey` 不能代替引用；
4. `semanticKey/claim/candidateTargets/factBasisHint` 都是候选分类，不是最终记忆；
5. 新 observation、arc、occasion ID 由 `(scanTaskId, outputIndex)` 生成稳定 UUIDv5；三类对象使用各自固定 namespace 防止碰撞，重复 delivery 幂等；
6. `detectorVersion` 是 observer prompt、output schema、routing config 的内容 hash。改变它必须创建新 source generation 并全量重建；
7. scanner false negative 无法由结构绝对消除，必须通过逐消息 assessment、detector version、golden/metamorphic fixture、late discovery 与 rebuild 管理。

Arc/episode coupling 是 strict schema + 本地交叉校验的一部分：每个 `arcActions.open` 必须在同 output 被恰好一个 `kind=episode_arc, action=create, relation=establishes, candidateTargets` 含 `episodes` 的 signal 通过 `arcActionIndex` 引用；每个 `append/close/invalidate` 必须对该 arc 唯一关联的 episode observation 分别输出 `append + arc_progress`、`append + arc_closes`、`invalidate + contradicts`。因此不存在只更新 arc 而不推进 episode observation version 的合法 output，arc evidence 掉出 recent window 后仍由 observation-target GapBridge 覆盖。Coordinator 在同一事务生成两类 ID并建立 `episode_observation_id`，不依赖 semanticKey 猜关联。

Occasion `create` 产生 open occasion；append/close 只能引用 `mutableOccasionCatalog` 中 status=open 的 exact ID/version，invalidate 可引用 open 或本次 correction dependency lookup 明确带入的 closed 对象。close/invalidate 写 `endedAtMessageId`；同一 arc close/invalidate 时，其全部 open occasions 必须在同 output close/invalidate。只有 status=closed 且未 suppression 的 occasion参与 pattern 门槛，open 不提前计数，invalidated 永不计数。Arc 同理：append/close 只允许 open，invalidate 允许 open|closed；closed 只因 correction dependency直接相关才进入有界 mutable catalog，不做无界全历史目录。

Projected-observation invalidation 必须延后到 Reducer：普通 signal 的 `affectedObservationIds=[]`；只有 `kind=memory_correction|memory_forget` 的 create signal可以列出 exact catalog IDs。若 related observation/arc/occasion 已有 consumed target、active state projection，或作为当前 observed-pattern threshold 的有效依赖，Observer 不得直接 supersede/invalidate 它，而必须 create correction/forget observation，列全 dependency closure 并路由所有受影响 targets。旧对象在 correction/forget patch accepted 前保持有效；Reducer 更新、corrected-retract 或 forget 后，才在同事务按实际已处理 target收口旧 observation target，全部 active projection解除后再 invalidated master。arc/occasion 也只有在所有依赖 projection已安全重判后才可最终 invalidate；pattern threshold 因此下降时必须唤醒相关 profile/relationship candidate，必要时使用 `retractItem+correct`。

Create/open action 的对象 ID 与 `expectedVersion` 必须为 null；append/close/supersede/invalidate 必须带 catalog 中的精确对象 ID 与 `expectedVersion`。Coordinator 只在 compare-and-set 命中时提交。

同一 output 内引用尚未持久化的新对象时使用 action index：occasion action 的 `arcId` 与 `arcActionIndex` 二选一；signal 的 `arcId/arcActionIndex` 二选一、`occasionId/occasionActionIndex` 二选一（允许两组都为空）。action index 必须指向本 output 中真实的 `open/create` action，且 evidence/scope 兼容。Coordinator 先用各固定 namespace 解析稳定 UUID，再原子写对象与引用；LLM 不得自报新 UUID。

完整状态机见 [Source Scan 与 Observation](algorithms/source-scan-and-observation.md)。

## 4. 专业 Proposer 与 Patch 契约

### 4.1 Boundary-cycle envelope

一个 boundary cycle 内所有 target 使用同一冻结 snapshot：

```js
{
  task: {
    taskId, tickId, userId, presetId,
    schemaVersion: 3,
    sourceGeneration,
    boundaryCycleId,
    cycleLineageId,
    cycleKind: "boundary" | "semantic_review",
    reviewEpoch,
    reviewTrigger: null | "waiting_stale" | "operator_requeue" | "dead_letter_recheck" | "late_discovery",
    lateDiscoverySourceBoundaryId: null | "uuid",
    retryEpoch,
    asOfRevision,
    contractVersion,
    sourceBoundaryMessageId,
    targetKey,
    workerKey,
    observationVersions: [{ observationId, version }],
    semanticNow,
    userTimeZone
  },
  observations: [/* 分配给本 target 的 ready/retryable candidates */],
  writableState: {/* asOfRevision 中本 target sections 的 redacted view */},
  readOnlyContext: {/* 同一 snapshot 中最小相关背景 */},
  observedMessages: [/* observation 已登记 evidence + 必需支持原文 */]
}
```

`writableState` item 保留 `id`；`readOnlyContext` item 不暴露可写 `id`；两者都不暴露完整 evidenceGroups。原始 evidence 只通过 `observedMessages` 与 observation evidence registry 提供。

### 4.2 Output

普通成功 output：

```js
{
  tickId,
  proposer,
  candidateDecisions: [{
    observationId,
    outcome: "proposed" | "waiting" | "excluded" | "already_reflected",
    reasonCode,
    patchIds: ["patch-1"]
  }],
  sectionResults: {
    todos: {
      status: "patches" | "noop",
      patches: [/* patch */]
    }
  }
}
```

无法组成合法 decision 时只允许 task-level union：

```js
{
  tickId,
  proposer,
  status: "unable_to_decide",
  reasonCode: "missing_context" | "ambiguous_reference",
  requestedContext: { beforeMessageId, afterMessageId }
}
```

它不关闭 observation；有界扩窗耗尽后转 `retryable`，不能用空 proposal 推进任何 cursor。

成功 output 的约束：

- `candidateDecisions` 必须精确覆盖输入 observation/version，每个恰好一次；
- `proposed` 的 `patchIds` 非空，且每个 ID 指向本 output 中真实 patch；其他 outcome 的 `patchIds=[]`；
- patch 的 `observationIds` 非空、去重，并与 decision 的 patchIds 双向一致；
- 所有 writable section 必须有 section result；`noop` 不替代 candidate decision；
- Proposer 不得输出 `consumed/retryable/dead_letter`，最终 lifecycle 由 Reducer 决定。

### 4.3 Patch shape

```js
{
  patchId: "patch-1",
  op: "addItem",
  path: null,
  itemId: null,
  itemIds: null,
  value: { text: "明早做三明治", actor: "assistant", requester: "assistant" },
  dueChange: {
    mode: "set",
    dueAt: { mode: "relative", days: 1 },
    timeAnchorMessageId: 696
  },
  evidenceKind: "assistant_commitment",
  changeKind: "establish",
  observationIds: ["observation-uuid"],
  evidenceRefs: [{ messageId: 696, quote: "明天一定给你做" }]
}
```

字段规则：

- `path` 只用于 scene，值为 `location|time|mood|note`；
- `itemId` 用于单 item 操作（包括 correction-only `retractItem`），`itemIds` 只用于 `mergeItems` 且至少两个；
- `mergeItems` 只由 `compactionProposer` 输出，不带 observation/evidence refs，Reducer 继承 source item 的完整 evidenceGroups；
- 非 compaction patch 至少一个 observationId 与 evidenceRef；每个 evidenceRef 必须登记在这些 observation 的当前版本中并分配给当前 target；
- target patch 可以使用早于本 cycle 的证据，但不能使用任意 overlap/read-only 历史；
- `todos.addItem.value` 必须含 `text/actor/requester`；top-level `dueChange` 可省略（等价于无期限）或为 `{mode:"set",dueAt,timeAnchorMessageId}`，add 不接受 keep/clear；
- `todos.updateItem.value` 可省略或含 text/actor/requester，top-level `dueChange` 必须为 `{mode:"keep"}`、`{mode:"clear"}` 或 `{mode:"set",dueAt,timeAnchorMessageId}`。`keep` 要求非空 value 且至少一个字段实际改变；`clear/set` 可无 value但必须实际改变期限。clear 同时清空 persistent dueAt/timeAnchor；归一化后全 noop 的 update 拒绝；
- relative todo due 的 `timeAnchorMessageId` 必须非空，并是该 observation 中真正承载相对时间表达的 evidence message；absolute 分支必须为 `null`。接受/履约等更晚证据不能替换 relative anchor；
- profile/relationship observed pattern 的 patch 必须列出支撑它的全部 observation IDs，门槛由 Reducer从 occasion/arc registry 计算。

due 表达式：

```text
{mode:absolute,date:YYYY-MM-DD}
{mode:relative,days:N>=0} | {mode:relative,months:N>0} | {mode:relative,years:N>0}
```

解析规则见 [领域生命周期](algorithms/domain-lifecycle.md)。

### 4.4 Scene epoch transition

`scene` section result 可选：

```js
epochTransition: {
  patchId: "scene-transition-1",
  action: "start" | "end",
  evidenceKind: "scene_change",
  changeKind: "lifecycle",
  evidenceRef: { messageId, quote },
  observationIds: ["uuid"]
}
```

`epochTransition` 是带 patchId 的 scene lifecycle operation，参与 candidate decision 的 patchIds 双向覆盖和 candidate atomic unit。`start` 先归档旧 epoch，再创建新 `epochId` 并应用本 result 的字段 patches；`end` 可作为唯一 operation，归档并清空当前 scene。无 transition 的字段 patch 只修改一个字段，不得隐式结束或重启 epoch。

## 5. Policy 与 Evidence 静态约束

### 5.1 Policy table

Reducer 按 `section + op + evidenceKind + changeKind` 校验。未列出的组合拒绝。

| section / op | evidenceKind | changeKind |
| --- | --- | --- |
| `scene.epochTransition` | `scene_change` | `lifecycle` |
| `scene.setField/clearField` | `scene_change` | `establish|refine|supersede|lifecycle` |
| `scene.setField/clearField` | `user_correction|assistant_correction` | `correct` |
| `todos.addItem` | request/commitment 四类 | `establish` |
| `todos.updateItem` | request/commitment 四类 | `reaffirm|refine|supersede` |
| `todos.updateItem` | correction 两类 | `correct` |
| `todos.completeTodo` | `todo_completion` | `lifecycle` |
| `todos.cancelTodo` | `todo_cancel` 或 correction 两类 | `lifecycle|correct`（必须按 evidence 匹配） |
| `todos.expireTodo` | `todo_expiration` | `lifecycle` |
| `standingAgreements.addItem` | `standing_agreement` | `establish` |
| `standingAgreements.updateItem` | `standing_agreement` | `reaffirm|refine|supersede` |
| `standingAgreements.updateItem` | correction 两类 | `correct` |
| `standingAgreements.cancelAgreement` | `agreement_cancel` 或 correction 两类 | `lifecycle|correct`（必须按 evidence 匹配） |
| `recentEpisodes.addItem/updateItem` | `recent_episode` | `establish|refine|supersede` |
| `recentEpisodes.updateItem` | correction 两类 | `correct` |
| `recentEpisodes.retractItem` | correction 两类 | `correct` |
| `milestones.addItem` | `relationship_milestone` | `establish` |
| `milestones.updateItem` | `relationship_milestone` | `reaffirm|refine|supersede` |
| `milestones.updateItem` | correction 两类 | `correct` |
| `milestones.retractItem` | correction 两类 | `correct` |
| long-term sections `addItem` | `long_term_fact` | `establish` |
| long-term sections `updateItem` | `long_term_fact` | `reaffirm|refine|supersede` |
| long-term sections `updateItem` | correction 两类 | `correct` |
| long-term sections `retractItem` | correction 两类 | `correct` |
| long-term sections `forgetItem` | forget 两类 | `forget` |
| 任意允许 compaction 的 item section `mergeItems` | `memory_compaction` | `lifecycle` |

这里的 long-term sections 是 `worldFacts|userProfile|assistantProfile|relationship`。`retractItem` 只用于明确纠正“当前 item 本不应成立”且没有替代 current value 的情形，必须按 currentFieldLineage 执行 correction suppression；自然结束/遗忘不得借用。evidenceKind 带 `user_`/`assistant_` 前缀时必须与数据库真实 role 一致，但 role 不限制哪一方可以维护哪个 profile。

### 5.2 Observation 与 evidence registry gate

每个非 compaction patch 必须通过：

1. observation 存在于当前 generation，版本等于 envelope 冻结版本，且当前 target assignment 为 `processing`；
2. 每个 evidence ref 的 `(messageId, contentHash, quote)` 可在所列 observation 的 evidence registry 中找到；
3. message 仍属于同一 user/preset，role、createdAt、contentHash 与 scan 时一致，messageId 不超过 cycle boundary；
4. source 未被 privacy/suppression gate 排除；
5. quote 通过 [Evidence 校验](algorithms/evidence-validation.md)；
6. proposed decision 与 patch/observation 双向覆盖完整。

version 3 不要求“本 task/new batch 至少一个 evidence”，也不接受“在 overlap 里出现过”作为合法性。旧证据的合法性来自 durable observation registry。

### 5.3 Quote 最小信息量

quote 原文最多 200 Unicode code points。归一化去掉统一配置的 whitespace/标点后：

- 每个 ref 至少 1 个信息字符；零字符为 `quote_too_short`；
- 只有 1–2 个信息字符的短 ref 必须 exact match，不允许模糊匹配；
- 短 ref 只能作为 `accepts|rejects|supports|completes|cancels` 等辅助/终止关系，不能单独建立新事实；
- 一个 observation/patch evidence group 至少包含一条实质 ref：CJK/Hangul/Kana 至少 2 个信息字符，其他文字至少 3 个；
- 因而 `好`、`好吃`、`OK` 可以与一条实质提议证据共同构成接受/支持链，不再因固定三字符门槛丢失；它们不能脱离被接受的提议单独证明长期事实。

### 5.4 Pattern 与 duplicate gate

- `observedPattern`：至少 3 distinct occasion、2 distinct arc，且 observation 都未 invalidated/suppressed；
- exact duplicate：统一 Unicode 规范化后的 `text` 完全相等时拒绝或确认 already-reflected；Reducer 不做 embedding/语义相似度判断；
- `semanticKey` 相同不算 duplicate；只有 Proposer 显式选择已有 `itemId`、或 evidence root/projectionIdentity 确定一致时才可更新；
- profile 的非 multi-value `canonicalKey` 已存在时必须 update，不得 add。

## 6. 持久化 schema

### 6.1 直接替换前置条件

schema 脚本必须在 Memory worker 停止且没有 running task 时执行。脚本先 drop 旧 Memory 派生表/索引，再 create 本节结构；不保留旧列并 backfill。`chat_preset_memory` 是应用共享表，只破坏性重建其 Memory authority 列：

```sql
DROP TABLE IF EXISTS chat_memory_scan_assessment_events CASCADE;
DROP TABLE IF EXISTS chat_memory_scan_assessments CASCADE;
DROP TABLE IF EXISTS chat_memory_observation_target_transition_events CASCADE;
DROP TABLE IF EXISTS chat_memory_candidate_decisions CASCADE;
DROP TABLE IF EXISTS chat_memory_observation_targets CASCADE;
DROP TABLE IF EXISTS chat_memory_observation_evidence CASCADE;
DROP TABLE IF EXISTS chat_memory_occasion_evidence CASCADE;
DROP TABLE IF EXISTS chat_memory_arc_evidence CASCADE;
DROP TABLE IF EXISTS chat_memory_evidence_observations CASCADE;
DROP TABLE IF EXISTS chat_memory_semantic_occasions CASCADE;
DROP TABLE IF EXISTS chat_memory_semantic_arcs CASCADE;
DROP TABLE IF EXISTS chat_memory_tasks CASCADE;
DROP TABLE IF EXISTS chat_memory_boundary_cycles CASCADE;
DROP TABLE IF EXISTS chat_memory_source_scan_pending CASCADE;
DROP TABLE IF EXISTS chat_memory_semantic_boundaries CASCADE;
DROP TABLE IF EXISTS chat_memory_source_scan_status CASCADE;
DROP TABLE IF EXISTS chat_memory_events CASCADE;
DROP TABLE IF EXISTS chat_memory_event_groups CASCADE;
DROP TABLE IF EXISTS chat_memory_snapshots CASCADE;
DROP TABLE IF EXISTS chat_memory_target_status CASCADE;
DROP TABLE IF EXISTS chat_memory_ops_log CASCADE;
DROP TABLE IF EXISTS chat_memory_diagnostic_projection_checkpoints CASCADE;
DROP TABLE IF EXISTS chat_context_quality_diagnostics CASCADE;
DROP TABLE IF EXISTS chat_memory_recovery_notifications CASCADE;
DROP TABLE IF EXISTS chat_context_projection_checkpoints CASCADE;
DROP TABLE IF EXISTS chat_context_suppression_tombstones CASCADE;
DROP TABLE IF EXISTS chat_memory_privacy_operations CASCADE;

ALTER TABLE chat_preset_memory
  DROP COLUMN IF EXISTS rolling_summary,
  DROP COLUMN IF EXISTS rolling_summary_updated_at,
  DROP COLUMN IF EXISTS summarized_until_message_id,
  DROP COLUMN IF EXISTS dirty_since_message_id,
  DROP COLUMN IF EXISTS rebuild_required,
  DROP COLUMN IF EXISTS core_memory,
  DROP COLUMN IF EXISTS memory_state;
ALTER TABLE chat_preset_memory ADD COLUMN memory_state JSONB;
```

这是唯一 cutover schema workflow：v1 rolling/core、v2 authority 和已有 v3 开发期派生数据一起删除后重建，不另设可独立执行的 legacy cleanup/migration。raw `chat_messages` 不在 drop 清单中。

### 6.2 Scan、arc、occasion 与 observation

```sql
CREATE TABLE chat_memory_source_scan_status (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  scanned_through_message_id BIGINT NOT NULL DEFAULT 0,
  stable_boundary_message_id BIGINT NOT NULL DEFAULT 0,
  rebuild_boundary_message_id BIGINT,
  status TEXT NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error_reason TEXT,
  last_task_id UUID,
  next_retry_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id)
);

CREATE TABLE chat_memory_semantic_boundaries (
  semantic_boundary_id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  boundary_ordinal BIGINT NOT NULL,
  source_start_exclusive BIGINT NOT NULL,
  source_boundary_message_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id,preset_id,source_generation,boundary_ordinal),
  UNIQUE (user_id,preset_id,source_generation,source_boundary_message_id),
  CHECK (boundary_ordinal >= 1),
  CHECK (source_boundary_message_id = source_message_id),
  CHECK (source_boundary_message_id > source_start_exclusive),
  CHECK (plan_version = 'single_source_message_v1')
);

CREATE TABLE chat_memory_source_scan_pending (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  pending_through_message_id BIGINT NOT NULL,
  pending_boundary_count INTEGER NOT NULL,
  backlog_started_at TIMESTAMPTZ NOT NULL,
  freeze_deadline_at TIMESTAMPTZ NOT NULL,
  tail_deadline_at TIMESTAMPTZ NOT NULL,
  trigger_reason TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,preset_id),
  FOREIGN KEY (user_id,preset_id,source_generation,pending_through_message_id)
    REFERENCES chat_memory_semantic_boundaries
      (user_id,preset_id,source_generation,source_boundary_message_id),
  CHECK (pending_through_message_id > 0),
  CHECK (pending_boundary_count >= 1),
  CHECK (freeze_deadline_at <= tail_deadline_at),
  CHECK (trigger_reason IN ('debounce','batch_target','provisional_user_deadline',
    'tail_deadline','assistant_complete','flush','drain','recovery','rebuild'))
);

CREATE INDEX idx_memory_source_scan_pending_due
  ON chat_memory_source_scan_pending(freeze_deadline_at,user_id,preset_id);

CREATE TABLE chat_memory_semantic_arcs (
  arc_id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  episode_observation_id UUID NOT NULL UNIQUE,
  semantic_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at_message_id BIGINT NOT NULL,
  ended_at_message_id BIGINT,
  last_source_boundary_message_id BIGINT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_scan_task_id UUID NOT NULL,
  created_output_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (created_by_scan_task_id,created_output_index)
);

CREATE INDEX idx_memory_semantic_arcs_scope
  ON chat_memory_semantic_arcs(user_id,preset_id,source_generation,status,updated_at);

CREATE TABLE chat_memory_arc_evidence (
  arc_id UUID NOT NULL REFERENCES chat_memory_semantic_arcs(arc_id) ON DELETE CASCADE,
  arc_version INTEGER NOT NULL,
  message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  quote TEXT NOT NULL,
  action TEXT NOT NULL,
  source_boundary_message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (arc_id,message_id,content_hash,action)
);

CREATE TABLE chat_memory_semantic_occasions (
  occasion_id UUID PRIMARY KEY,
  arc_id UUID REFERENCES chat_memory_semantic_arcs(arc_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  status TEXT NOT NULL,
  first_message_id BIGINT NOT NULL,
  last_message_id BIGINT NOT NULL,
  ended_at_message_id BIGINT,
  last_source_boundary_message_id BIGINT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_scan_task_id UUID NOT NULL,
  created_output_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (created_by_scan_task_id,created_output_index)
);

CREATE INDEX idx_memory_semantic_occasions_scope
  ON chat_memory_semantic_occasions(user_id,preset_id,source_generation,status,updated_at);

CREATE TABLE chat_memory_occasion_evidence (
  occasion_id UUID NOT NULL REFERENCES chat_memory_semantic_occasions(occasion_id) ON DELETE CASCADE,
  occasion_version INTEGER NOT NULL,
  message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  quote TEXT NOT NULL,
  action TEXT NOT NULL,
  source_boundary_message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (occasion_id,message_id,content_hash,action)
);

CREATE TABLE chat_memory_evidence_observations (
  observation_id UUID PRIMARY KEY,
  root_observation_id UUID NOT NULL,
  parent_observation_id UUID,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  observation_kind TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  subject_role TEXT NOT NULL,
  fact_basis_hint TEXT NOT NULL,
  claim TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  first_source_boundary_message_id BIGINT NOT NULL,
  last_source_boundary_message_id BIGINT NOT NULL,
  created_by_scan_task_id UUID NOT NULL,
  created_output_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (created_by_scan_task_id,created_output_index)
);

CREATE INDEX idx_memory_observations_scope
  ON chat_memory_evidence_observations(user_id,preset_id,source_generation,status,observation_kind,semantic_key);

ALTER TABLE chat_memory_semantic_arcs
  ADD CONSTRAINT fk_memory_arc_episode_observation
  FOREIGN KEY (episode_observation_id)
  REFERENCES chat_memory_evidence_observations(observation_id);

CREATE TABLE chat_memory_observation_evidence (
  observation_id UUID NOT NULL REFERENCES chat_memory_evidence_observations(observation_id) ON DELETE CASCADE,
  observation_version INTEGER NOT NULL,
  message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  quote TEXT NOT NULL,
  relation TEXT NOT NULL,
  occasion_id UUID REFERENCES chat_memory_semantic_occasions(occasion_id),
  arc_id UUID REFERENCES chat_memory_semantic_arcs(arc_id),
  source_boundary_message_id BIGINT NOT NULL,
  mutation_scan_task_id UUID NOT NULL,
  phase_identity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (observation_id,message_id,content_hash,relation)
);

CREATE INDEX idx_memory_observation_evidence_source
  ON chat_memory_observation_evidence(message_id,content_hash,observation_id);

CREATE TABLE chat_memory_scan_assessments (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  first_scan_task_id UUID NOT NULL,
  last_scan_task_id UUID NOT NULL,
  outcome TEXT NOT NULL,
  observation_ids JSONB NOT NULL,
  arc_ids JSONB NOT NULL,
  occasion_ids JSONB NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,preset_id,source_generation,detector_version,message_id,content_hash)
);

CREATE TABLE chat_memory_scan_assessment_events (
  assessment_event_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  scan_task_id UUID NOT NULL,
  scan_mode TEXT NOT NULL,
  outcome TEXT NOT NULL,
  observation_ids JSONB NOT NULL,
  arc_ids JSONB NOT NULL,
  occasion_ids JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scan_task_id,message_id,content_hash)
);

CREATE TABLE chat_memory_observation_targets (
  observation_id UUID NOT NULL REFERENCES chat_memory_evidence_observations(observation_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  target_key TEXT NOT NULL,
  status TEXT NOT NULL,
  observation_version INTEGER NOT NULL,
  last_evaluated_version INTEGER,
  reason_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  last_task_id UUID,
  last_cycle_lineage_id UUID,
  last_review_epoch INTEGER,
  last_reviewed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (observation_id,target_key)
);

CREATE INDEX idx_memory_observation_targets_ready
  ON chat_memory_observation_targets(user_id,preset_id,source_generation,target_key,status,next_retry_at);
```

`chat_memory_semantic_boundaries` 是 canonical `semanticBoundaryPlan` 的 normalized authority。`single_source_message_v1` 固定令每条按 source order 排列的完整、有效 User/Assistant message 恰好形成一个 boundary；`source_start_exclusive` 是前一 boundary endpoint，`source_boundary_message_id=source_message_id`。同 generation 的行只允许按 ordinal 追加且 immutable，ID 使用固定 namespace 对 `(scope,sourceGeneration,sourceMessageId,contentHash)` 生成 UUIDv5。session、turn、时间间隔、debounce、`batchMaxMessages` 和一次 SQL 预取多少消息都不能改变行数或 endpoint；source edit/delete/reorder 通过新 generation 重建整份 plan。

`chat_memory_source_scan_pending` 是 task 冻结前唯一可变的 durable tail accumulator，并在已冻结 boundary 完成前保留 recovery proof。完整 source 到达时，在同一短事务追加 boundary-plan row、提升 `stable_boundary_message_id`，并以 CAS 执行：`pending_through_message_id=GREATEST(old,new)`、重算尚未取得 cycle/no-candidate 终局的 `pending_boundary_count`、`freeze_deadline_at=LEAST(old,newCandidate)`；`backlog_started_at/tail_deadline_at` 在该 backlog 完全排空前不后移。assistant 完成、batch target、flush/drain/rebuild 或已到期 recovery 只能把 deadline 提前并提升 trigger reason，不能延期。pending row 只在 checkpoint 已追到它的 boundary、该 boundary 的 cycle/no-candidate 终局已封存且没有并发 promotion 后删除。

到 `freeze_deadline_at` 后，Coordinator 锁 status/pending，选择 checkpoint 后最早的 immutable boundary row，并在同一事务创建恰好覆盖该 row 的 source-scan task；task payload复制 boundary ID/ordinal/planVersion/source key/hash，之后绝不扩张 endpoint。一个 wake 可以批量预取多个 boundary 的 raw rows，但只能逐 boundary 执行 `freeze task → scan commit → pre-cycle/cycle terminal`，再冻结下一 task。若进程在任意阶段退出，due pending row、immutable boundary row和已冻结 task分别恢复“尚未建 task”“已建未提交”“已提交待 cycle”三种状态。

`semantic_key` 在任何上述表都不设 UNIQUE。

`chat_memory_scan_assessments` 是每条 source message 的当前 assessment master；events 是 append-only 审计。`late_discovery` 不回退或推进 source scan checkpoint：它写 event，并以 compare-and-set 把 master 的 outcome 更新为 signals、对 observation/arc/occasion IDs 做集合并集、version+1。原来的 no-signal 结论仍保留在 event 历史中。

`chat_memory_observation_evidence.observation_version` 表示该 evidence 首次进入 observation 的 resulting version；版本 `v` 的 evidence registry 是同一 observation 中 `observation_version <= v` 且未被 suppression 的稳定并集。`mutation_scan_task_id + phase_identity` 使历史 candidate decision 能直接复核其精确 version，不依赖无限保留整份 Provider proposal。

### 6.3 Boundary cycle、task 与 proposal decision

```sql
CREATE TABLE chat_memory_boundary_cycles (
  boundary_cycle_id UUID PRIMARY KEY,
  cycle_lineage_id UUID NOT NULL,
  semantic_boundary_id UUID NOT NULL REFERENCES chat_memory_semantic_boundaries(semantic_boundary_id),
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  detector_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  source_start_exclusive BIGINT NOT NULL,
  source_boundary_message_id BIGINT NOT NULL,
  cycle_kind TEXT NOT NULL,
  review_epoch INTEGER NOT NULL DEFAULT 0,
  review_trigger TEXT,
  late_discovery_source_boundary_id UUID REFERENCES chat_memory_semantic_boundaries(semantic_boundary_id),
  retry_epoch INTEGER NOT NULL DEFAULT 0,
  as_of_revision BIGINT NOT NULL,
  semantic_now TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  last_error_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cycle_kind IN ('boundary','semantic_review')),
  CHECK (review_epoch >= 0 AND retry_epoch >= 0),
  CHECK ((cycle_kind = 'boundary' AND review_epoch = 0 AND review_trigger IS NULL)
      OR (cycle_kind = 'semantic_review' AND review_epoch > 0
          AND review_trigger IN ('waiting_stale','operator_requeue','dead_letter_recheck','late_discovery'))),
  CHECK ((review_trigger = 'late_discovery' AND late_discovery_source_boundary_id IS NOT NULL)
      OR (review_trigger IS DISTINCT FROM 'late_discovery' AND late_discovery_source_boundary_id IS NULL)),
  UNIQUE (semantic_boundary_id,review_epoch,retry_epoch),
  UNIQUE (cycle_lineage_id,retry_epoch)
);

CREATE TABLE chat_memory_tasks (
  task_id UUID PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  worker_key TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  target_key TEXT,
  task_type TEXT NOT NULL,
  scan_mode TEXT,
  semantic_boundary_id UUID REFERENCES chat_memory_semantic_boundaries(semantic_boundary_id),
  boundary_cycle_id UUID REFERENCES chat_memory_boundary_cycles(boundary_cycle_id),
  parent_task_id UUID,
  resume_epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  source_start_exclusive BIGINT,
  source_boundary_message_id BIGINT,
  as_of_revision BIGINT,
  task_payload JSONB NOT NULL,
  stage_payload JSONB,
  attempt INTEGER NOT NULL DEFAULT 0,
  context_expansion_attempt INTEGER NOT NULL DEFAULT 0,
  not_before TIMESTAMPTZ,
  last_error_reason TEXT,
  result_revision BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id,preset_id,dedupe_key)
);

CREATE INDEX idx_memory_tasks_recovery
  ON chat_memory_tasks(status,not_before,updated_at);

CREATE TABLE chat_memory_candidate_decisions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  boundary_cycle_id UUID NOT NULL REFERENCES chat_memory_boundary_cycles(boundary_cycle_id),
  task_id UUID NOT NULL REFERENCES chat_memory_tasks(task_id),
  observation_id UUID NOT NULL,
  observation_version INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  patch_ids JSONB NOT NULL,
  reducer_outcome TEXT,
  reducer_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id,observation_id,target_key)
);

CREATE TABLE chat_memory_observation_target_transition_events (
  transition_event_id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  observation_id UUID NOT NULL REFERENCES chat_memory_evidence_observations(observation_id) ON DELETE CASCADE,
  observation_version INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  source_task_id UUID REFERENCES chat_memory_tasks(task_id),
  boundary_cycle_id UUID REFERENCES chat_memory_boundary_cycles(boundary_cycle_id),
  candidate_decision_id BIGINT REFERENCES chat_memory_candidate_decisions(id),
  phase_identity TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id,preset_id,source_generation,observation_id,target_key,phase_identity)
);
```

Task 跨字段约束：`source_scan` 必须 `target_key/boundary_cycle_id/as_of_revision=NULL`，且 `scan_mode/semantic_boundary_id/source_start_exclusive/source_boundary_message_id` 非空并与该 immutable boundary row 完全一致；`normal` 必须有 target/cycle/as-of 且 `scan_mode=NULL`；`maintenance` 必须有 target 与 parent task；`system_cleanup` 不拥有 scan progress。`scan_mode` 只允许 `incremental|rebuild|late_discovery`。`task_type/status/stage/not_before/result_revision/stage_payload` 还必须满足 §2.1 状态图。以上约束由数据库 CHECK（封闭 enum/终态组合）与唯一 repository transition validator（有向边/CAS/payload 条件）共同强制，不能只依赖 prompt。

`chat_memory_tasks.resume_epoch` 只用于 source-scan fresh invocation 或 maintenance child resume identity，不表示 normal semantic evaluation 的重试维度；normal task 唯一使用其 boundary cycle 的 `retry_epoch`。实现不得把 `attempt/resume_epoch/retry_epoch/review_epoch` 互相回填或兼容读取。

cycle 是 immutable 审计对象，两个 epoch 维度不得混用：

- `cycle_lineage_id` 表示一次语义 evaluation 的 immutable visibility lineage；其 `retry_epoch=0` 冻结 `as_of_revision`、snapshot identity、source cutoff、semanticNow、candidate set/versions 与 raw refs。同一 boundary 的 Provider/schema/事务等**技术 retry**只创建同 lineage 的 `retry_epoch+1`，完整继承 retry 0 visibility；不得读取同-boundary已经提交的其他 target state。
- 普通 scan boundary cycle 固定 `cycle_kind=boundary, review_epoch=0, review_trigger=NULL`。`waiting_stale`、人工 requeue、dead-letter 根因修复或 late discovery 新候选的**语义重判**不得复用旧 lineage：调度器在当前 generation 最新已封存 `semantic_boundary_id` 上创建 `cycle_kind=semantic_review` 的新 `cycle_lineage_id`，按该 boundary 锁内分配单调 `review_epoch>0`，并从当时最新完整 state 捕获新的 as-of/snapshot、当前 observation versions 与新的 semanticNow；其首轮 `retry_epoch=0`。若没有新 raw source，固定 `source_start_exclusive=source_boundary_message_id`，且不伪造 scan/assessment/checkpoint 进展。late discovery 另以 `late_discovery_source_boundary_id` 保存触发它的历史 singleton boundary，只作为 provenance，不得把 review visibility cutoff 降回该历史位置。
- semantic review 的全部 evidence/ref 仍必须 `messageId <= source_boundary_message_id`，且 observation current version 的 registered evidence 必须在该上界内。最新 boundary 仍 active 或更早 evaluation 尚未封存时只排队 review，不能把候选塞进既有 cycle。

因此，normal task dedupe 至少绑定 `{cycleLineageId}:{retryEpoch}:{targetKey}:{candidateSetDigest}`。技术 retry 不提升 `review_epoch`；语义重判不沿用旧 `cycle_lineage_id/as_of_revision/semantic_now`。v3 不读取或回填旧 `cycle_epoch` 字段。

`candidate_decisions` 只记录专业 Proposer 对候选的判断。每次 `chat_memory_observation_targets` status/version/reason 变化还必须在同一事务追加 transition event：Provider/Reducer 路径关联 decision/task/cycle；source scan observation/occasion mutation、suppression、generation cancellation、retry exhaustion 或人工操作允许 `candidate_decision_id/boundary_cycle_id` 为空，但必须有稳定 `phase_identity`，能关联 task 时必须填写 `source_task_id`。系统 reason 至少包括 `observation_version_advanced | occasion_status_changed | observation_superseded | observation_invalidated | source_suppressed | generation_cancelled | retry_exhausted | operator_requeued | operator_confirmed_exclusion`；不得伪造空 candidate decision 或 semantic event group。

### 6.4 Revision、snapshot 与 event

```sql
CREATE TABLE chat_memory_snapshots (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  revision BIGINT NOT NULL,
  state JSONB NOT NULL,
  task_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,preset_id,revision)
);

CREATE TABLE chat_memory_event_groups (
  event_group_id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  task_id UUID,
  boundary_cycle_id UUID,
  target_key TEXT,
  group_kind TEXT NOT NULL,
  base_revision BIGINT NOT NULL,
  result_revision BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id,preset_id,result_revision)
);

CREATE TABLE chat_memory_events (
  event_id BIGSERIAL PRIMARY KEY,
  event_group_id UUID NOT NULL REFERENCES chat_memory_event_groups(event_group_id) ON DELETE CASCADE,
  event_index INTEGER NOT NULL,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  target_key TEXT,
  section TEXT,
  event_kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  patch_id TEXT,
  op TEXT,
  item_id TEXT,
  result_item_id TEXT,
  observation_ids JSONB,
  evidence_kind TEXT,
  change_kind TEXT,
  reject_reason TEXT,
  patch_summary JSONB,
  normalized_operation JSONB,
  cleanup_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_group_id,event_index),
  UNIQUE (event_group_id,patch_id)
);
```

`decision = accepted|rejected|deferred|noop|system_cleanup`。`decision=system_cleanup` 当且仅当 `cleanup_type` 为 §2.3 的固定枚举之一；其它 decision 的 `cleanup_type` 必须为 null。proposal post-state normalization 产生的 cleanup event 即使与 accepted patch 同 group，也使用 `decision=system_cleanup`。所有实际 patch event 保存有界 `patch_summary`（至少 op/path/item identity，隐私删除时可定位清除）；只有 accepted/system cleanup 携带可 replay 的完整 `normalized_operation`。纯 waiting/excluded/already-reflected 且 state 未变化时写 candidate decision，但不创建空 revision；candidate audit 不依赖 semantic event 冒充。rejected/deferred-only group 可以 `result_revision=NULL`，供诊断/恢复审计，不伪造 state revision。

`revision` 在同一 `(userId,presetId)` 下跨 source generation 全局单调且不重置；generation 初始化使用当前 revision 的下一值。因此 snapshot 主键与 event group 的非空 result-revision 唯一约束都不得包含 generation 来放宽重复。generation 仍是每行必填 fence，replay 先验证 generation transition event/snapshot，再验证全局连续 revision。

`normalized_operation` 使用 strict `operationVersion=1` union；accepted/system-cleanup event 必填，其他 decision 必须为 null：

```js
{
  operationVersion: 1,
  section, targetKey,
  op,                         // canonical patch op 或 cleanup_type 对应内部 op
  patchId: null | "...",
  cleanupType: null | "...",
  precondition: {
    identity: "<section:path|itemId|epochId>",
    expectedFingerprint: null | "sha256:..." // add/首次建立为 null
  },
  mutation:
    { kind: "item_upsert", itemId, postItem } |
    { kind: "item_remove", itemId } |
    { kind: "item_merge", sourceItemIds, resultItem } |
    { kind: "scene_replace", postScene, postPreviousScene },
  dueResolution: null | {
    dueExpression,
    timeAnchorMessageId,
    resolvedDueAt,
    userTimeZone
  },
  postFingerprint: "sha256:..."
}
```

`postItem/resultItem` 是该 event 后完整 schemaVersion 3 item，必须包含全部专用字段、`projectionIdentity/sourceProjectionIdentities/currentFieldLineage/evidenceGroups`；`scene_replace` 同样包含 event 后完整 current scene 与 previousScene。`item_remove` 只需稳定 itemId，因为其完整删除前 provenance 已存在于 pre-state，correction/forget 的 suppression source keys另存 tombstone。merge 的 `sourceItemIds` 就是唯一 canonical `mergedFromItemIds`；maintenance 归属通过 `event_group.task_id → task.parent_task_id` 解析，不增设冗余 event 列。Todo add/update 的 due expression、relative/absolute anchor、冻结时区和 resolved instant 必须同时出现在 `dueResolution` 与 postItem中且交叉一致。

Replayer 按 event group revision、`event_index` 顺序校验 operation schema与 precondition fingerprint，再应用 mutation并校验 `postFingerprint`；任一不匹配即停止恢复，不能跳过或按当前代码重新推导历史 operation。`patch_summary` 不是 replay 输入。

### 6.5 运行健康与 ops log

```sql
CREATE TABLE chat_memory_target_status (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  rebuild_boundary_message_id BIGINT,
  status TEXT NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error_reason TEXT,
  last_task_id UUID,
  next_retry_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,preset_id,target_key)
);

CREATE TABLE chat_memory_ops_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  task_id UUID NOT NULL,
  tick_id BIGINT,
  worker_key TEXT NOT NULL,
  target_key TEXT,
  section TEXT,
  outcome TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_ops_log_health
  ON chat_memory_ops_log(user_id,preset_id,worker_key,target_key,created_at DESC);
```

ops outcome 至少包含 `llm_call_failed|safety_policy_blocked|max_output_truncated|output_schema_invalid_retry|output_schema_invalid|unable_to_decide|unable_to_compact|stale_result|rebase_conflict|reducer_failed|transaction_failed|commit_outcome_unknown`。不得持久化 Provider 非法输出正文或完整 raw prompt。

### 6.6 Suppression、projection、diagnostic 与 privacy

以下 sidecar 仍是 version 3 的必要组成，但在本次开发期替换时同样 drop/recreate，不继承 version 2 行：

```sql
CREATE TABLE chat_context_suppression_tombstones (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_item_id TEXT,
  source_section TEXT,
  created_revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id,preset_id,message_id,content_hash,reason)
);

CREATE TABLE chat_context_projection_checkpoints (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  projection_key TEXT NOT NULL,
  processed_generation BIGINT NOT NULL,
  processed_boundary_message_id BIGINT,
  processed_tombstone_id BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  last_error_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,preset_id,projection_key)
);

CREATE TABLE chat_context_quality_diagnostics (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  diagnostic_type TEXT NOT NULL,
  source_generation BIGINT,
  boundary_message_id BIGINT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_context_diagnostics_one_active
  ON chat_context_quality_diagnostics(user_id,preset_id,subject_kind,subject_key,diagnostic_type)
  WHERE resolved = FALSE;

CREATE TABLE chat_memory_diagnostic_projection_checkpoints (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  projection_key TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  processed_event_id BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  last_error_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,preset_id,projection_key)
);

CREATE TABLE chat_memory_recovery_notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  boundary_message_id BIGINT NOT NULL DEFAULT 0,
  source_generation BIGINT NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id,preset_id,subject_kind,subject_key,notification_type,source_generation,boundary_message_id)
);

CREATE TABLE chat_memory_privacy_operations (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  operation_id UUID NOT NULL,
  operation_mode TEXT NOT NULL,
  source_generation BIGINT,
  boundary_message_id BIGINT,
  status TEXT NOT NULL,
  last_error_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,preset_id)
);
```

诊断 projector 只锁定并读取已经提交的 source events；diagnostic upsert/resolve、recovery notification 与 projection checkpoint 推进必须位于同一个后续投影事务。Privacy hard delete 还必须删除 task payload、observation claim/evidence、scan assessment、arc/occasion、cycle/decision、event/snapshot、RAG/Recall 和受控 debug 副本。

## 7. 容量与集中配置

### 7.1 容量

每个 item section 使用：

```js
{ maxItems, maxRenderedChars }
```

scene 仅使用 `maxRenderedChars`。字符按 Unicode code point 计算，只统计 Renderer 可能输出的语义值，不统计 ID、hash、quote、evidence、标题或模板标点。

- scene 单字段 patch 超限：只拒绝该 patch，`capacity_exceeded`；
- recentEpisodes 超限：确定性滚出最旧项并写 cleanup event；
- todos 容量只统计 active；overdue 使用独立 render 上限；
- previousScene 不参与 scene 容量；
- 其他 item section 超限：进入 compaction + original proposal replay；不得静默截断。

### 7.2 Compaction 字段兼容

`compactionProposer` 只提出 `itemIds + value.text`；Reducer 只有在下表所有 source 字段兼容时才能确定性生成完整 result item。所有 section 都要求 source item `semanticKey` 完全相同；null 与非-null 不相等。

| section | 额外 eligibility | result 专用字段 |
| --- | --- | --- |
| `todos` | 全部 `status=active,becameOverdueAt=null`；`actor/requester/dueAt/timeAnchorMessageId` 分别全等 | 继承这些全等值；status active |
| `standingAgreements` | `agreementKey` 全等 | 继承 agreementKey |
| `recentEpisodes` / `milestones` | `arcId` 必须同一非空值 | 继承 arcId；不同/空 arc 不得把独立事件合并 |
| `worldFacts` | 无其它字段 | 继承 semanticKey |
| `userProfile` / `assistantProfile` / `relationship` | `facet/canonicalKey/factBasis` 分别全等 | 继承三者 |

任一条件不满足即 `invalid_state_transition`，不得让 LLM选择或丢弃冲突字段。result text 使用 patch value；`createdAtMessageId=min(source)`，`updatedAtMessageId=max(all inherited refs)`；evidenceGroups完整继承并按 `(source item stable order,evidenceGroupId)` 去重。projection identity 使用 source root union统一算法。每个 result current field lineage：text 取所有 source text lineage group IDs并集后计算新 text fingerprint；继承专用字段取对应 source lineages并集。任一 source current field lineage缺失/悬空即拒绝。

### 7.3 必填配置

集中配置至少包含：

```text
sourceScan.batchMaxMessages
sourceScan.supportingContextMessages
sourceScan.debounceMs
sourceScan.tailMaxDelayMs
sourceScan.provisionalUserMaxDelayMs
sourceScan.detectorVersion
observation.maxOpenCatalogItems
observation.retryLimit
observation.waitingStaleAgeMs
pattern.minDistinctOccasions = 3
pattern.minDistinctArcs = 2
boundaryCycle.targetOrder
boundaryCycle.retryLimit
boundaryCycle.contractVersion
quote.maxCodePoints = 200
quote.similarityThreshold
各 section 容量、TTL、Provider/adapter、retry、retention、health、projection 配置
```

batch/session/turn/time gap 都不能成为语义资格门。`tailMaxDelayMs` 必须固化为 durable pending `tail_deadline_at/freeze_deadline_at`，到期后才冻结 immutable task；不得只靠进程内 timer或预建可扩张的 not-before task。

`contractVersion` 是 version 3 state schema、专业 Proposer prompts/output schemas、patch policy、candidate reason table、canonical target order 与 lifecycle 规则的内容 hash；它进入 scan status、cycle、task 与 dedupe identity。版本变化使旧未终态 task/cycle stale。若变化会改变既有历史投影资格，必须创建新 source generation 从 raw 全量重建；只改变无语义的日志/渲染措辞时不应提升该版本。

## 8. Provider Adapter

Memory LLM 调用必须通过支持 schema-constrained structured output 的专用 adapter；scan output 与每个 target output 使用独立 schema。adapter 先使用 Provider 原生 JSON schema/tool/function 约束，返回后再做本地完整 schema 校验。

统一结果：

```js
{ status: "ok", output }
{ status: "error", reason: "llm_call_failed" | "safety_policy_blocked" |
  "max_output_truncated" | "output_schema_invalid", detail: {/* 不含原始正文 */} }
```

Provider 未能满足完整 schema 时 fail closed，不从半截 JSON 猜测 observation、decision 或 patch。每次 schema/prompt/routing 变化都必须更新对应内容 hash；observer 的变化还必须更新 `detectorVersion` 并触发全量 source generation rebuild。
