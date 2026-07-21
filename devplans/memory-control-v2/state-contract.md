# Memory Control 2.01 状态契约

本文是 Memory Control 2.01 持久化 state、compiled patch、event、task、sidecar DDL 和静态枚举的单一权威来源。Semantic IR 与 Compiler 见 [Semantic 写入契约](semantic-write-contract.md)，执行算法见 [算法契约索引](algorithms/README.md)。

## 1. 版本与权威状态

- 协议版本是字符串 `"2.01"`，不是浮点数；所有 `schema_version` 数据库列使用 `TEXT`。
- `chat_preset_memory.memory_state JSONB` 是唯一当前 Memory authority。
- `chat_messages` 的有效 User/Assistant raw content 是 rebuild authority。
- snapshot/event 是恢复记录，不是第二份当前状态。
- 2.01 不读取或 replay 旧 2.0 state/task/event/snapshot；开发环境切换时清理旧派生数据并 rebuild。

概念形态：

```js
{
  version: "2.01",
  current: {
    scene: {
      location: { value: null, sourceRefs: [], updatedAtMessageId: null },
      time:     { value: null, sourceRefs: [], updatedAtMessageId: null },
      mood:     { value: null, sourceRefs: [], updatedAtMessageId: null },
      note:     { value: null, sourceRefs: [], updatedAtMessageId: null }
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
    sourceGeneration: 0,
    targetCursors: {}
  }
}
```

`current/working/longTerm/meta` 是物理容器，不是 section 或 target。正式 section：

```text
scene, todos, standingAgreements, recentEpisodes, milestones,
worldFacts, userProfile, assistantProfile, relationship
```

## 2. Source Ref 与 Provenance

持久化 source ref 固定为：

```js
{ messageId: 121, contentHash: "sha256:<64 lowercase hex>" }
```

规则：

1. `messageId` 是当前 scope 中真实 User/Assistant raw message；
2. `contentHash` 是 raw content UTF-8 SHA-256；
3. state 不保存 quote、evidenceKind、Memory support ref 或 Memory-to-Memory 图；
4. `sourceRefs` 非空、按 `messageId ASC, contentHash ASC` 稳定排序，并按二元 key 去重；
5. support ref 只存在于 task artifact，Compiler 在写入前展开成 raw source refs；
6. source ref 与当前数据库不一致时不能生成 compiled patch；
7. source mutation 通过 `sourceGeneration + 1` 和 rebuild 处理，而不是 context-suppression tombstone。

每个 item：

```js
{
  id: "episode:uuid",
  text: "双方在冲突后暂停并恢复沟通。",
  sourceRefs: [
    { messageId: 121, contentHash: "sha256:..." },
    { messageId: 124, contentHash: "sha256:..." }
  ],
  createdAtMessageId: 121,
  updatedAtMessageId: 124
}
```

- `createdAtMessageId`：item 首次 add sources 的最小 messageId；update 不改变；merge 取 source items 的最小值；
- `updatedAtMessageId`：当前 item 全部 `sourceRefs` 的最大 messageId；
- update/correct 合并旧 sources 与本 change sources；
- merge 合并 source items 的 sources；
- Profile/Relationship item 与普通 text item 同形，不含 facet/canonicalKey/factBasis；
- 所有 itemId 全局唯一，由 Reducer 生成。

Scene field：

```js
{ value: "屋顶", sourceRefs: [{ messageId: 118, contentHash: "sha256:..." }], updatedAtMessageId: 118 }
```

- populated field 的 `sourceRefs` 非空，`updatedAtMessageId=max(sourceRefs.messageId)`；
- empty field 固定为 `{value:null,sourceRefs:[],updatedAtMessageId:null}`；
- set/correct 使用 Compiler 展开的全部 sources；
- clear/forget 清空当前 field，动作来源只保留在 event normalized operation；
- `previousScene` 保存四个同形 field 与 `expiredAt`。

## 3. Section 与领域字段

| Section | 存储位置 | 语义 |
| --- | --- | --- |
| `scene` | `current.scene` | 当前地点、时间、氛围与备注 |
| `todos` | `working.todos` | 可完成/取消/过期的一次性事项 |
| `standingAgreements` | `working.standingAgreements` | 未来反复适用的约定/边界 |
| `recentEpisodes` | `working.recentEpisodes` | 有意义的近期互动弧 |
| `milestones` | `longTerm.milestones` | 长期关系/剧情转折 |
| `worldFacts` | `longTerm.worldFacts` | 持续成立的世界设定 |
| `userProfile` | `longTerm.userProfile` | 用户跨场景信息 |
| `assistantProfile` | `longTerm.assistantProfile` | Assistant 跨场景信息 |
| `relationship` | `longTerm.relationship` | 持续关系状态/模式 |

Todo 在公共 item 字段之外固定包含：

```js
{
  actor: "user" | "assistant" | "both",
  requester: "user" | "assistant",
  status: "active" | "overdue",
  becameOverdueAt: null | ISO8601,
  dueAt: null | ISO8601
}
```

`status/becameOverdueAt` 只由 Reducer lifecycle 写入。`previousScene` 和 overdue 不是独立 section，不拥有 cursor。

## 4. Target

```js
{
  scene: { proposer: "currentStateProposer", sections: ["scene"] },
  todos: { proposer: "todoProposer", sections: ["todos"] },
  standingAgreements: { proposer: "agreementProposer", sections: ["standingAgreements"] },
  episodes: { proposer: "episodeProposer", sections: ["recentEpisodes", "milestones"] },
  profileRelationship: {
    proposer: "profileRelationshipProposer",
    sections: ["userProfile", "assistantProfile", "relationship"]
  },
  worldFacts: { proposer: "worldFactProposer", sections: ["worldFacts"] }
}
```

每个 target 一个 `coveredUntilMessageId`。联合处理的 sections 共享 cursor。所有 normal/maintenance/system-cleanup/source-mutation 操作共用同一 scope 串行 lane。

## 5. Semantic 与 Renderer Artifact

Renderer artifact、ref map、Semantic IR、source selectors、action 权限与日期 anchor 的完整 shape 以 [Semantic 写入契约](semantic-write-contract.md) 为权威。

静态要求：

- Provider 只接收 artifact 的 `publicInput`；
- private `refMap/messageMeta` 固化在 immutable task payload；
- normal output 的 section status 为 `changes | noop | unable_to_decide`；
- compaction output 为 `changes | unable_to_compact`；
- `sectionResults` 恰好覆盖 target sections；
- normal change 至少有 direct message 或 read-only support source；
- compaction merge 不输出 sources；
- Profile/Relationship change 只含 text，不含 typed metadata；
- Semantic IR 不含真实 ID、op、evidenceKind、quote 或 contentHash。

## 6. Persistent Patch

Compiled proposal 仍使用 per-section `sectionResults`，但只有 Compiler 能生成。每个 section 为 `patches` 或 `noop`；Reducer 不接收 `unable_to_decide` 或 Compiler error。

合法 op：

```text
setField, clearField,
addItem, updateItem, forgetItem, mergeItems,
completeTodo, cancelTodo, expireTodo,
cancelAgreement
```

字段规则：

- `setField`：`path + value + sourceRefs`；
- `clearField`：`path + sourceRefs`；
- `addItem`：`value + sourceRefs`；
- `updateItem`：`itemId + value + sourceRefs`；
- `forgetItem`：`itemId + sourceRefs`，所有 item sections 合法；
- Todo terminal 与 `cancelAgreement`：`itemId + sourceRefs`；
- `mergeItems`：`itemIds + value`，无 sourceRefs；
- item operation 不使用 path；scene operation 不使用 itemId；
- patch 不包含 evidenceKind、quote、supportRefs 或 Semantic `correct` 标记。

Section/op 权限：

| Section | op |
| --- | --- |
| `scene` | `setField`, `clearField` |
| `todos` | `addItem`, `updateItem`, `forgetItem`, `completeTodo`, `cancelTodo`, `expireTodo`, `mergeItems` |
| `standingAgreements` | `addItem`, `updateItem`, `forgetItem`, `cancelAgreement`, `mergeItems` |
| `recentEpisodes` | `addItem`, `updateItem`, `forgetItem` |
| `milestones` | `addItem`, `updateItem`, `forgetItem`, `mergeItems` |
| `worldFacts` | `addItem`, `updateItem`, `forgetItem`, `mergeItems` |
| `userProfile` | `addItem`, `updateItem`, `forgetItem`, `mergeItems` |
| `assistantProfile` | `addItem`, `updateItem`, `forgetItem`, `mergeItems` |
| `relationship` | `addItem`, `updateItem`, `forgetItem`, `mergeItems` |

不在表中的组合以 `policy_not_allowed` 拒绝。Policy 不读取 source role 或语义原因枚举。

Todo value/dueAt union 沿用既有日历契约，但 relative expression 的 Semantic change 必须带直接 `anchorMessageId`；Compiler 输出 Patch 前已经将其转换为 ISO timestamp。Reducer 不再接收相对表达式。

## 7. Reducer Reject Reason

静态合法值至少包括：

- `schema_invalid`；
- `source_invalid`；
- `policy_not_allowed`；
- `item_not_found`；
- `invalid_state_transition`；
- `duplicate_item`；
- `item_protected_by_pending_proposal`；
- `capacity_exceeded`（仅 scene）；
- `cross_section_merge`。

以下旧 reason 在 2.01 删除：

```text
message_id_not_found
evidence_source_mismatch
evidence_role_mismatch
quote_too_short
quote_too_long
quote_not_found
overlap_only_evidence
duplicate_profile_key
insufficient_pattern_evidence
```

Source/ref/date 错误应在 Compiler 阶段失败，不伪装成 Reducer patch rejection。

## 8. 容量

每个 item section：

```js
{ maxItems, maxRenderedChars }
```

- `maxItems` 统计当前受容量约束的 items；
- `maxRenderedChars` 统计 Renderer 会输出的语义文本；
- provenance、ID、event、artifact、Semantic IR 和 compiled proposal 不计入 section 容量；
- scene 只有 `maxRenderedChars`；
- Todo active items 占 section 容量，overdue 使用独立 render budget；
- recentEpisodes 超限时按 `createdAtMessageId/itemId` 淘汰最旧项并写 cleanup event；
- 其他 item section 超限进入 deferred/compaction/replay；
- previousScene 不参与 scene 容量。

## 9. Revision 与 Snapshot

```sql
CREATE TABLE chat_memory_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  preset_id         TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  revision          BIGINT NOT NULL,
  schema_version    TEXT NOT NULL,
  state             JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, revision)
);
```

规则：

- revision 跨 generation 单调递增；
- 初始化 state 同事务写完整 snapshot；
- 一个 task bundle 至多形成一个 state revision；
- accepted patch、cleanup 或 cursor 推进形成 revision；
- Provider/schema/compile error、retry/halt 和 `result_revision=null` deferred 不形成 revision；
- snapshot 包含完整 state/cursors，不包含运行状态。

## 10. Event Group 与 Event

```sql
CREATE TABLE chat_memory_event_groups (
  event_group_id    UUID PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  preset_id         TEXT NOT NULL,
  task_id           UUID NOT NULL,
  target_key        TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  schema_version    TEXT NOT NULL,
  base_revision     BIGINT NOT NULL,
  result_revision   BIGINT,
  cursor_before     BIGINT,
  cursor_after      BIGINT,
  group_kind        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, result_revision)
);

CREATE TABLE chat_memory_events (
  id                   BIGSERIAL PRIMARY KEY,
  event_group_id       UUID NOT NULL REFERENCES chat_memory_event_groups(event_group_id),
  event_index          INTEGER NOT NULL,
  user_id              BIGINT NOT NULL,
  preset_id            TEXT NOT NULL,
  task_id              UUID NOT NULL,
  tick_id              BIGINT,
  target_key           TEXT NOT NULL,
  section              TEXT NOT NULL,
  event_kind           TEXT NOT NULL,
  decision             TEXT NOT NULL,
  patch_id             TEXT,
  op                   TEXT,
  item_id              TEXT,
  result_item_id       TEXT,
  merged_from_item_ids JSONB,
  reject_reason        TEXT,
  maintenance_task_id  UUID,
  patch_summary        JSONB,
  normalized_operation JSONB,
  cleanup_type         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_group_id, event_index)
);

CREATE UNIQUE INDEX idx_memory_events_group_patch
  ON chat_memory_events(event_group_id, patch_id)
  WHERE patch_id IS NOT NULL;
```

2.01 events 不含 `evidence_kind`，也不保留 Semantic `correct` 与普通 update 的区别。

`decision`：`accepted | rejected | deferred | noop | system_cleanup`。

- accepted/system_cleanup 必须携带完整 deterministic `normalized_operation`；
- `patch_summary` 是 compiled patch 的有界摘要；
- normalized operation 的 sources 使用 raw sourceRefs；
- clear/forget/terminal action 的 sources 保留在 event，即使 active object 已移除；
- merge event 保存 `merged_from_item_ids/result_item_id`，normalized operation 包含合并后 item 的完整 provenance；
- deferred group 的 `result_revision=null`；
- 二次 unable 的 cursor-only revision 可以有零条 event；
- replay 不调用 LLM 或 Compiler。

Cleanup type 至少包括：

```text
scene_expired
expired_scene_evicted
todo_became_overdue
todo_revived_from_overdue
recent_episode_evicted
```

2.01 不存在 suppression cleanup type。

## 11. Durable Task

```sql
CREATE TABLE chat_memory_tasks (
  task_id                   UUID PRIMARY KEY,
  dedupe_key                TEXT NOT NULL,
  user_id                   BIGINT NOT NULL,
  preset_id                 TEXT NOT NULL,
  target_key                TEXT NOT NULL,
  source_generation         BIGINT NOT NULL,
  schema_version            TEXT NOT NULL,
  task_type                 TEXT NOT NULL,
  parent_task_id            UUID,
  predecessor_task_id       UUID,
  resume_epoch              INTEGER NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL,
  stage                     TEXT NOT NULL,
  cursor_before             BIGINT,
  target_message_id         BIGINT,
  base_revision             BIGINT NOT NULL,
  task_payload              JSONB NOT NULL,
  stage_payload             JSONB,
  attempt                   INTEGER NOT NULL DEFAULT 0,
  context_expansion_attempt INTEGER NOT NULL DEFAULT 0,
  not_before                TIMESTAMPTZ,
  last_error_reason         TEXT,
  result_revision           BIGINT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_memory_tasks_scope_dedupe
  ON chat_memory_tasks(user_id, preset_id, dedupe_key);
```

`task_payload` 创建后不可变，保存 task metadata 和完整 Renderer artifact（public input + private ref map/message metadata）。`stage_payload` 至少可保存：

```text
semanticResult
compiledProposal
expandedPublicInput
schemaInvalidAttempts
schemaRepairFeedback
maintenanceTaskId
identities
blockingViolation
```

Artifact、Semantic IR 和 compiled proposal 属于受控敏感派生数据，不能写入 append-only 应用日志，privacy hard delete 必须清除。

## 12. Per-target Status 与 Ops Log

```sql
CREATE TABLE chat_memory_target_status (
  user_id                    BIGINT NOT NULL,
  preset_id                  TEXT NOT NULL,
  target_key                 TEXT NOT NULL,
  source_generation          BIGINT NOT NULL,
  rebuild_boundary_message_id BIGINT,
  status                     TEXT NOT NULL,
  consecutive_errors         INTEGER NOT NULL DEFAULT 0,
  last_error_reason           TEXT,
  last_task_id                UUID,
  next_retry_at               TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, target_key)
);

CREATE TABLE chat_memory_ops_log (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  preset_id         TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  task_id           UUID NOT NULL,
  tick_id           BIGINT,
  target_key        TEXT NOT NULL,
  section           TEXT,
  proposer          TEXT,
  outcome           TEXT NOT NULL,
  attempt           INTEGER NOT NULL,
  detail            JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Target status：`healthy | retry_wait | capacity_blocked | halted | rebuilding`。

Ops outcome 至少包括：

```text
llm_call_failed
safety_policy_blocked
max_output_truncated
output_schema_invalid_retry
semantic_schema_invalid
unable_to_decide
unable_to_compact
ref_resolution_failed
source_validation_failed
date_anchor_invalid
compile_invariant_failed
stale_result
reducer_failed
transaction_failed
commit_outcome_unknown
```

Ops detail 只保存有界结构化诊断，不保存完整 raw prompt、完整 provider response、完整 artifact、Semantic IR 或 compiled proposal。

## 13. RAG Projection Checkpoint

```sql
CREATE TABLE chat_context_projection_checkpoints (
  user_id                       BIGINT NOT NULL,
  preset_id                     TEXT NOT NULL,
  projection_key                TEXT NOT NULL,
  processed_generation          BIGINT NOT NULL,
  processed_boundary_message_id BIGINT,
  status                        TEXT NOT NULL,
  last_error_reason             TEXT,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, projection_key)
);
```

2.01 没有 `processed_tombstone_id`。Projection 只处理 generation/boundary 与 privacy hard delete；correction/forget 不触发 RAG invalidation。

## 14. Context-quality Diagnostics

```sql
CREATE TABLE chat_context_quality_diagnostics (
  id                            BIGSERIAL PRIMARY KEY,
  user_id                       BIGINT NOT NULL,
  preset_id                     TEXT NOT NULL,
  subject_kind                  TEXT NOT NULL,
  subject_key                   TEXT NOT NULL,
  diagnostic_type               TEXT NOT NULL,
  source_generation             BIGINT,
  request_id                    TEXT,
  target_cursor                 BIGINT,
  processed_boundary_message_id BIGINT,
  omitted_upper_message_id      BIGINT,
  recent_window_start           BIGINT,
  original_gap_count            INTEGER,
  original_gap_chars            INTEGER,
  retained_boundary             BIGINT,
  retained_count                INTEGER,
  omitted_count                 INTEGER,
  omitted_chars                 INTEGER,
  truncated                     BOOLEAN NOT NULL DEFAULT FALSE,
  detail                        JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved                      BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at                   TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_context_diagnostics_one_active
  ON chat_context_quality_diagnostics(user_id, preset_id, subject_kind, subject_key, diagnostic_type)
  WHERE resolved = FALSE;

CREATE TABLE chat_memory_diagnostic_projection_checkpoints (
  user_id            BIGINT NOT NULL,
  preset_id          TEXT NOT NULL,
  projection_key     TEXT NOT NULL,
  processed_event_id BIGINT NOT NULL DEFAULT 0,
  last_error_reason  TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, projection_key)
);
```

GapBridge、projection lag、scene capacity 和 state/schema 诊断语义不变。Diagnostic projection 只消费已提交 events，失败不改写正常 task 结果。

## 15. Recovery Notification

```sql
CREATE TABLE chat_memory_recovery_notifications (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL,
  preset_id           TEXT NOT NULL,
  subject_kind        TEXT NOT NULL,
  subject_key         TEXT NOT NULL,
  notification_type   TEXT NOT NULL,
  boundary_message_id BIGINT NOT NULL DEFAULT 0,
  source_generation   BIGINT NOT NULL,
  delivered           BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, subject_kind, subject_key, notification_type, source_generation, boundary_message_id)
);
```

恢复事务同事务 resolve active diagnostic/status 并创建 notification。响应成功后 best-effort 标记 delivered；语义仍是 best-effort once，不是 exactly once。

## 16. Privacy Operation

```sql
CREATE TABLE chat_memory_privacy_operations (
  user_id             BIGINT NOT NULL,
  preset_id           TEXT NOT NULL,
  operation_id        UUID NOT NULL,
  operation_mode      TEXT NOT NULL,
  source_generation   BIGINT,
  boundary_message_id BIGINT,
  status              TEXT NOT NULL,
  last_error_reason   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id)
);
```

Privacy hard delete 必须覆盖 raw messages、state、events、snapshots、task artifact、Semantic IR、compiled proposal、diagnostics、notifications、RAG/Recall 和受控 debug store。2.01 不再有 tombstone store，但不能因此削弱 privacy purge verification。

## 17. Provider Adapter

Memory Proposer 必须使用原生 schema/tool/function structured output，并在 Provider 返回后做本地 Semantic Schema 校验。未知 adapter 或 schema preflight 失败时拒绝启动。

Adapter 成功：

```js
{ status: "ok", output: { /* Semantic IR */ }, usage, model }
```

Adapter admission deferred：

```js
{ status: "deferred", reason: "provider_queue_full" }
```

`deferred` 表示本地 Provider admission backpressure，不表示 Provider/model 调用失败，也不同于 capacity proposal 的 `decision=deferred`。它不消耗 Provider attempt 或 schema-repair 次数，不写错误 ops outcome，不改变 target status，不推进 cursor，也不产生 revision/event/snapshot。当前 durable task 保持非终态并返回 queued，随后由正常 worker/recovery 调度重新投递。

Adapter 错误：

```js
{
  status: "error",
  reason: "llm_call_failed" | "safety_policy_blocked" | "max_output_truncated" | "semantic_schema_invalid",
  detail: { /* bounded metadata */ }
}
```

首次 Provider 输出边界 schema 错误可使用同一 immutable public input 和持久化 repair feedback 重试一次。非法输出原文不得持久化或回传。Compiler error 不属于 Provider Adapter result。

## 18. Retention 不变量

1. 每个 active generation 至少保留一个 schema-valid 完整 anchor snapshot；
2. anchor 提升前验证从旧 anchor 连续 replay 的结果；
3. 保留 `result_revision > anchor.revision` 的连续 event groups；
4. 非终态 task、被 active task 引用的 parent/predecessor 和 retained event group 引用的 task 不得清理；
5. 删除 events 前先同步 diagnostic projection；
6. task payload/stage payload 的 retention 与 privacy hard delete 必须覆盖 Renderer artifact、Semantic IR 和 compiled proposal；
7. 旧 2.0 数据不参与 2.01 retention/replay，切换时按明确开发数据库重建步骤清理。
