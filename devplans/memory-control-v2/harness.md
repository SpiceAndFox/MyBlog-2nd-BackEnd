# Memory Control v2.1 / schemaVersion 3 Harness 验收契约

本文定义 Memory Control v2.1（仅 `schemaVersion=3`）的最小可验收测试边界。Harness 的目标不是证明 LLM 永远正确，而是证明 LLM 即使输出不稳定、局部错误或被 provider 拦截，semantic observation、候选决策与最终 memory state 仍然可控、可审计、可恢复。开发期不测试或保留 v2 envelope/output/state 兼容；旧派生数据清空后从 raw messages 重建。

顶层设计见 [memory-control-v2-overview.md](memory-control-v2-overview.md)。状态契约见 [state-contract.md](state-contract.md)，写入协议见 [write-protocol.md](write-protocol.md)，渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. Harness 原则

- **Reducer 优先**：大多数 golden case 应直接测试 Reducer，不依赖真实 LLM。
- **Fixture 可读**：每个 case 明确给出 initial state/observations、input envelope、Provider output、expected events/state、source-scan progress 与 candidate lifecycle。
- **拒绝路径一等公民**：`rejected` / `error` 的测试数量不能少于 happy path。
- **维护路径可回放**：`deferred` / compaction / 最终预算拒绝必须能从 fixture 中复现。
- **渲染回归基线**：Renderer 是纯代码模板，同一 `memory_state` 在同一版 Renderer 下产生确定性输出。golden snapshot 锁定完整 rendered text，Renderer 代码变更时 golden test 失败以提示回归。
- **真实 LLM 只做 smoke**：少量端到端 smoke 用真实 provider；可靠性判断主要靠结构化 fixture。
- **候选生命周期一等公民**：每个专业 Proposer fixture 都断言 `candidateDecisions`，每个 proposed operation（普通 patch 或 scene transition）都断言 `observationIds`，Reducer 拒绝不能被伪装成候选已消费。
- **变形不变量**：相同原始时间线在合法 batch/context/overlap、session 分组和 target 调度变化下，模块归属、状态流转、证据集合与候选终态必须语义等价；LLM 自然文案允许非逐字一致。

## 2. Fixture 形态

规范 Reducer/Pipeline fixture 使用一个 JSON 文件表达，支持单 tick 和多 tick 场景。单 tick 即 `ticks` 数组只有一个元素。`fixtureKind=reducer|pipeline` 的文件必须通过统一 catalog 校验和断言 matcher；Context/Recovery 可使用具名的 suite-support fixture，但必须声明 `fixtureKind` 并由对应测试显式消费，catalog 不得静默遗漏文件。

```json
{
  "name": "todo-add-with-valid-evidence",
  "initialState": {
    "version": 3,
    "current": {
      "scene": {
        "epochId": null,
        "startedAtMessageId": null,
        "location": { "value": null, "evidenceRef": null, "updatedAtMessageId": null },
        "time": { "value": null, "evidenceRef": null, "updatedAtMessageId": null },
        "mood": { "value": null, "evidenceRef": null, "updatedAtMessageId": null },
        "note": { "value": null, "evidenceRef": null, "updatedAtMessageId": null }
      },
      "previousScene": null
    },
    "working": { "todos": [], "standingAgreements": [], "recentEpisodes": [] },
    "longTerm": { "milestones": [], "worldFacts": [], "userProfile": [], "assistantProfile": [], "relationship": [] },
    "meta": { "revision": 0, "sourceGeneration": 0 }
  },
  "initialSourceScanStatus": {
    "sourceGeneration": 0,
    "detectorVersion": "fixture-detector-v1",
    "contractVersion": "fixture-contract-v3",
    "scannedThroughMessageId": 1,
    "stableBoundaryMessageId": 1,
    "status": "healthy"
  },
  "initialSemanticBoundaries": [
    {
      "semanticBoundaryId": "018f2f5e-7f2a-7b11-9c31-bbbbbbbbbbbb",
      "sourceGeneration": 0,
      "boundaryOrdinal": 1,
      "sourceStartExclusive": 0,
      "sourceBoundaryMessageId": 1,
      "sourceMessageId": 1,
      "contentHash": "sha256:45ed11fd247a2257e8721fb25c6bbe0202f441464567c4b15d35a4c47bc3eca9",
      "planVersion": "single_source_message_v1"
    }
  ],
  "initialTargetStatuses": {
    "scene": { "sourceGeneration": 0, "status": "healthy", "consecutiveErrors": 0 },
    "todos": { "sourceGeneration": 0, "status": "healthy", "consecutiveErrors": 0 },
    "standingAgreements": { "sourceGeneration": 0, "status": "healthy", "consecutiveErrors": 0 },
    "episodes": { "sourceGeneration": 0, "status": "healthy", "consecutiveErrors": 0 },
    "profileRelationship": { "sourceGeneration": 0, "status": "healthy", "consecutiveErrors": 0 },
    "worldFacts": { "sourceGeneration": 0, "status": "healthy", "consecutiveErrors": 0 }
  },
  "initialObservations": [
    {
      "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
      "rootObservationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
      "parentObservationId": null,
      "detectorVersion": "fixture-detector-v1",
      "observationKind": "one_time_commitment",
      "version": 1,
      "semanticKey": "todo:return-eraser:user",
      "subjectRole": "user",
      "factBasisHint": "explicit",
      "claim": "用户承诺明天归还橡皮",
      "status": "open",
      "sourceGeneration": 0,
      "firstSourceBoundaryMessageId": 1,
      "lastSourceBoundaryMessageId": 1,
      "createdByScanTaskId": "018f2f5e-7f2a-7b11-9c31-444444444444",
      "createdOutputIndex": 0
    }
  ],
  "initialObservationEvidence": [
    {
      "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
      "messageId": 1,
      "contentHash": "sha256:45ed11fd247a2257e8721fb25c6bbe0202f441464567c4b15d35a4c47bc3eca9",
      "quote": "我明天会把橡皮还给她",
      "relation": "establishes",
      "occasionId": null,
      "arcId": null,
      "sourceBoundaryMessageId": 1
    }
  ],
  "initialObservationTargets": [
    {
      "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
      "observationVersion": 1,
      "targetKey": "todos",
      "status": "ready"
    }
  ],
  "ticks": [
    {
      "description": "User asks to be reminded about returning an eraser",
      "input": {
        "task": {
          "taskId": "018f2f5e-7f2a-7b11-9c31-111111111111",
          "tickId": 12345,
          "userId": 1,
          "presetId": "default",
          "schemaVersion": 3,
          "sourceGeneration": 0,
          "semanticBoundaryId": "018f2f5e-7f2a-7b11-9c31-bbbbbbbbbbbb",
          "boundaryCycleId": "018f2f5e-7f2a-7b11-9c31-222222222222",
          "cycleLineageId": "018f2f5e-7f2a-7b11-9c31-aaaaaaaaaaaa",
          "cycleKind": "boundary",
          "reviewEpoch": 0,
          "reviewTrigger": null,
          "lateDiscoverySourceBoundaryId": null,
          "retryEpoch": 0,
          "asOfRevision": 0,
          "contractVersion": "fixture-contract-v3",
          "targetKey": "todos",
          "workerKey": "todoProposer",
          "sourceBoundaryMessageId": 1,
          "observationVersions": [{ "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333", "version": 1 }],
          "semanticNow": "2026-07-06T22:30:00Z",
          "userTimeZone": "UTC"
        },
        "writableState": { "working": { "todos": [] } },
        "readOnlyContext": {
          "current": {
            "scene": {
              "epochId": null,
              "startedAtMessageId": null,
              "location": { "value": null, "updatedAtMessageId": null },
              "time": { "value": null, "updatedAtMessageId": null },
              "mood": { "value": null, "updatedAtMessageId": null },
              "note": { "value": null, "updatedAtMessageId": null }
            }
          },
          "working": { "standingAgreements": [], "recentEpisodes": [] },
          "longTerm": { "userProfile": [], "assistantProfile": [] }
        },
        "observations": [
          {
            "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
            "rootObservationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
            "observationKind": "one_time_commitment",
            "version": 1,
            "semanticKey": "todo:return-eraser:user",
            "subjectRole": "user",
            "factBasisHint": "explicit",
            "claim": "用户承诺明天归还橡皮",
            "status": "open",
            "evidenceMessageIds": [1]
          }
        ],
        "observedMessages": [
          {
            "messageId": 1,
            "role": "user",
            "createdAt": "2026-07-06T22:30:00Z",
            "contentKind": "raw",
            "content": "我明天会把橡皮还给她",
            "contentHash": "sha256:45ed11fd247a2257e8721fb25c6bbe0202f441464567c4b15d35a4c47bc3eca9"
          }
        ]
      },
      "databaseMessages": [
        {
          "id": 1,
          "userId": 1,
          "presetId": "default",
          "role": "user",
          "createdAt": "2026-07-06T22:30:00Z",
          "content": "我明天会把橡皮还给她",
          "contentHash": "sha256:45ed11fd247a2257e8721fb25c6bbe0202f441464567c4b15d35a4c47bc3eca9"
        }
      ],
      "adapterMock": {
        "status": "ok",
        "output": {
          "tickId": 12345,
          "proposer": "todoProposer",
          "candidateDecisions": [
            {
              "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
              "outcome": "proposed",
              "reasonCode": "meets_write_threshold",
              "patchIds": ["patch-1"]
            }
          ],
          "sectionResults": {
            "todos": {
              "status": "patches",
              "patches": [
                {
                  "patchId": "patch-1",
                  "op": "addItem",
                  "value": { "text": "归还橡皮", "actor": "user", "requester": "user" },
                  "dueChange": { "mode": "set", "dueAt": { "mode": "relative", "days": 1 }, "timeAnchorMessageId": 1 },
                  "observationIds": ["018f2f5e-7f2a-7b11-9c31-333333333333"],
                  "changeKind": "establish",
                  "evidenceKind": "user_commitment",
                  "evidenceRefs": [{ "messageId": 1, "quote": "我明天会把橡皮还给她" }]
                }
              ]
            }
          }
        }
      },
      "expected": {
        "eventGroup": {
          "task_id": "018f2f5e-7f2a-7b11-9c31-111111111111",
          "target_key": "todos",
          "boundary_cycle_id": "018f2f5e-7f2a-7b11-9c31-222222222222",
          "base_revision": 0,
          "result_revision": 1,
          "group_kind": "proposal"
        },
        "events": [
          {
            "event_kind": "proposal_decision",
            "decision": "accepted",
            "patch_id": "patch-1",
            "op": "addItem",
            "observation_ids": ["018f2f5e-7f2a-7b11-9c31-333333333333"],
            "evidence_kind": "user_commitment",
            "result_item_id": { "_match": "notNull" },
            "normalized_operation": { "_match": "notNull" }
          }
        ],
        "statePatch": {
          "working": {
            "todos": [
              {
                "id": { "_match": "string", "prefix": "todo:" },
                "text": "归还橡皮",
                "createdAtMessageId": 1,
                "updatedAtMessageId": 1,
                "actor": "user",
                "requester": "user",
                "status": "active",
                "becameOverdueAt": null,
                "dueAt": "2026-07-08T00:00:00.000Z",
                "timeAnchorMessageId": 1,
                "projectionIdentity": "018f2f5e-7f2a-7b11-9c31-333333333333",
                "sourceProjectionIdentities": ["018f2f5e-7f2a-7b11-9c31-333333333333"],
                "semanticKey": "todo:return-eraser:user",
                "currentFieldLineage": { "_match": "object" },
                "evidenceGroups": [
                  {
                    "evidenceGroupId": { "_match": "string" },
                    "evidenceKind": "user_commitment",
                    "changeKind": "establish",
                    "assertedValueFingerprints": { "_match": "object" },
                    "observationIds": ["018f2f5e-7f2a-7b11-9c31-333333333333"],
                    "occasionIds": [],
                    "refs": [{ "messageId": 1, "contentHash": "sha256:45ed11fd247a2257e8721fb25c6bbe0202f441464567c4b15d35a4c47bc3eca9", "quote": "我明天会把橡皮还给她" }]
                  }
                ]
              }
            ]
          }
        },
        "snapshot": { "revision": 1 },
        "task": {
          "task_id": "018f2f5e-7f2a-7b11-9c31-111111111111",
          "status": "succeeded",
          "result_revision": 1
        },
        "observationTargets": [
          {
            "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
            "observationVersion": 1,
            "targetKey": "todos",
            "status": "consumed",
            "lastReasonCode": "meets_write_threshold"
          }
        ],
        "candidateDecisions": [
          {
            "observationId": "018f2f5e-7f2a-7b11-9c31-333333333333",
            "observationVersion": 1,
            "targetKey": "todos",
            "outcome": "proposed",
            "reasonCode": "meets_write_threshold",
            "patchIds": ["patch-1"],
            "reducerOutcome": "accepted"
          }
        ],
        "targetStatus": { "target_key": "todos", "source_generation": 0, "status": "healthy", "consecutive_errors": 0 },
        "opsLog": [],
        "meta": { "revision": 1 },
        "renderEquals": null,
        "renderContains": ["归还橡皮"]
      }
    }
  ]
}
```

Fixture 不应保存长篇聊天全文。证据 quote 保持短片段，长对话可用最小复现场景。

Fixture runner 默认用 `initialState` 写 generation 0 / revision 0 完整 schemaVersion 3 snapshot，并按 `initialObservations` 初始化 durable candidates；revision 0 fixture 的 source-scan progress 与 target-consumption progress 必须处于初始位置。需要模拟已扫描 source、待消费 candidate 或后续 generation 的 fixture，必须分别提供匹配的 scan progress、observation lifecycle、全局 revision 与 generation-boundary/anchor snapshot。测试不得只在内存中构造 state 而跳过 snapshot/observation repository。`initialTargetStatuses` 独立于 `memory_state` 初始化，且必须为全部六个 normal target 各提供一行相同 generation 的合法初始 status；普通 Reducer fixture 通常从 healthy/0 开始，resume/recovery fixture 可以从 retry_wait/capacity_blocked/halted/rebuilding 开始。全局 source scan checkpoint 追上末尾不能代替“所有 candidates 已有明确 lifecycle 结果”的断言。

### Fixture 断言匹配规则

- **statePatch 深合并**：patch 值与 `initialState` 深合并，只覆盖 fixture 中列出的字段。Reducer 生成的字段（`id`）用 matcher 表达。确定性字段（`dueAt`、`status`、`becameOverdueAt`、`createdAtMessageId`、`updatedAtMessageId`）必须显式列出。
- **events 子集字段匹配**：只检查 fixture 中列出的字段，忽略自增列（`id`、`user_id`、`preset_id`、`tick_id`、`created_at`）。行数必须精确匹配。按插入顺序逐行匹配。`rejected` 行必须包含 `reject_reason`。merge 的 source IDs 在 `normalized_operation.mutation.sourceItemIds`，maintenance 通过 event group task 的 parent 关联断言；不得假设不存在的冗余 event 列。可用 `{ "_match": "notNull" }` 匹配任意非 null 值。
- **eventGroup/snapshot/task/targetStatus**：分别校验 revision group、完整 post-state snapshot、durable task 终态和 per-target status；snapshot.state 必须深等于同事务最终 `memory_state`。涉及语义提交时，state/event/snapshot、task 终态与 observation-target lifecycle 必须来自同一事务；Observer fixture 则另断言 observation changes 与 source scan checkpoint 同事务。
- **observations/candidate decisions**：精确校验每个输入 observation 的 `outcome/reasonCode`、Reducer 最终接受/拒绝结果和 lifecycle 状态。`proposed` 不能直接匹配 `consumed`；只有关联原子单元内的全部普通 patches/scene transition operations 被 Reducer 接受后才允许消费，waiting/excluded/already_reflected 与 retryable rejection 各自保持规定状态。
- **opsLog**：按插入顺序精确匹配 fixture 中列出的字段。
- **sourceScanProgress**：只在 Observer fixture 中精确匹配 `detectorVersion/scannedThroughMessageId/stableBoundaryMessageId/status`；专业 target task 不能伪造推进。
- **meta**：只比较语义 state 元数据 `revision/sourceGeneration`；不得出现 source-scan/target cursor、halted/recovery/retry 字段。
- **renderEquals**：完整 rendered text 的 golden snapshot 路径，为 `null` 时跳过。Renderer 代码变更时 golden test 失败以提示回归。
- **renderContains**：宽松子串检查，用于 smoke test。
- **Matcher 语法**：`{ "_match": "string", "prefix": "todo:" }` 匹配以 `"todo:"` 开头的字符串；`{ "_match": "notNull" }` 匹配任意非 null 值。

## 3. 必测用例组

### 3.1 Schema 与 patch op

- state/task/Observer/Proposer/fixture 只接受 `schemaVersion=3`；版本 2 或缺失版本显式拒绝，不走兼容转换。
- `semanticSignalObserver` task 必须携带与 scan status 一致的 `contractVersion`；strict schema 覆盖 `messageAssessments`、`arcActions(open|append|close|invalidate)`、`occasionActions(create|append|close|invalidate)` 与 `signals(create|append|supersede|invalidate)`。assessment 必须逐一且只逐一覆盖 input `newMessageIds`，并携带 `signalIndexes/arcActionIndexes/occasionActionIndexes`；signals outcome 的三组 indexes 并集非空，无信号时三者都为空；每个被引用 action 的 evidence 必须包含对应 new message。create/open 的对象 ID 与 `expectedVersion` 必须为 null，append/close/supersede/invalidate 必须携带 catalog 精确 ID/version；同 output 新对象只能通过合法 `arcActionIndex/occasionActionIndex` 引用，ID/index 同时出现、index 指向非 create/open 或 evidence/scope 不兼容时拒绝。输出 durable UUID、memory patch/itemId、最终 section 文案或越过 boundary 时拒绝。
- 每个 arc open 必须与同 output 唯一 `episode_arc create + episodes` signal 双向关联；arc append/close/invalidate 必须分别与固定 episode observation 的 `arc_progress/arc_closes/contradicts` mutation 双向关联。缺配对、重复配对、close 未唤醒 waiting episodes row 都 schema-invalid；不得产生 scan 后掉出 recent window却无 observation evidence 的纯 open arc。
- occasion create 后为 open；append 只延续同一语义场合，close/invalidate 写 ended boundary。arc close/invalidate 必须在同 output 终结全部关联 open occasions；只有 closed occasion参与 3 occasions/2 arcs 门槛，open 不提前计数，invalidated 永不计数。catalog/retention 不得随时间无界保留已终结 occasion。
- occasion append/close/invalidate 必须由 Coordinator在同事务确定性推进所有关联 pattern observation version并写 `occasion_status_changed` transition：waiting→close 可达到门槛并 ready，consumed→invalidate 必须先建立 correction/retract candidate且在 state收口前不得失效 occasion。不得出现 registry已变而 pattern target永不唤醒。
- direct supersede/invalidate 只允许没有 consumed target、active projection或有效 pattern依赖的对象。已有投影时必须 create `memory_correction|memory_forget` observation并列出 exact `affectedObservationIds`/全部受影响 targets；旧对象在 update/retract/forget accepted 前保持有效。fixture 覆盖 episode arc invalidation与 pattern occasion失效：先重判/移除 active episode/trait，再原子终结旧 dependency，不能留下 invalidated provenance支撑的 current item。
- 每个专业 Proposer output 必须逐一覆盖 `task.observationVersions[{observationId,version}]`，输入 `observations` 的 id/version 集合必须与它精确相同；`candidateDecisions` 只接受 `proposed|waiting|excluded|already_reflected` 及对应 reasonCode。遗漏、重复、版本过期、未知 observation 或 outcome/reason 不匹配时 `output_schema_invalid`。
- 普通成功 output 的所有 writable section status 只接受 `patches|noop`。Task-level `unable_to_decide` union 只接受 `reasonCode=missing_context|ambiguous_reference` 与合法 `requestedContext`，不得同时带 candidateDecisions/sectionResults；缺字段或混合两种 union 时拒绝。
- `proposed` 只接受 `meets_write_threshold` 与非空 `patchIds`；每个 patchId 指向本 output 唯一普通 patch 或 scene `epochTransition` lifecycle operation，且 decision/operation `observationIds` 双向一致。waiting reason 覆盖 `insufficient_evidence|awaiting_acceptance|awaiting_outcome|ambiguous_reference|pattern_threshold_not_met`，excluded reason 覆盖 `target_mismatch|not_memory_worthy|transient_only|invalid_inference|not_canon|contradicted`，already_reflected 只接受 `duplicate_or_existing_state`；后三种 outcome 的 `patchIds=[]`。
- 普通 patch 或 scene transition 缺少/重复 `patchId`，或缺少/伪造 `observationIds` 时拒绝；关联 observation 不属于 task version、target 或 source generation时拒绝。Proposer output 不得包含 `consumed` 状态，candidate 只有在 Reducer 接受关联原子单元后才消费。
- 合法 `setField` / `clearField` / `addItem` / `updateItem` / `retractItem` / `forgetItem` / `mergeItems` / `completeTodo` / `cancelTodo` / `expireTodo` / `cancelAgreement` 被接受。
- normal Proposer 输出 `mergeItems` 时拒绝（`mergeItems` 只允许 `compactionProposer`）；`compactionProposer` 输出 `addItem`/`updateItem` 等非 `mergeItems` op 时拒绝。
- 缺少该 op 按 [state-contract.md](state-contract.md) §4 应必填的字段时拒绝。
- 非法 section + op 组合拒绝。
- item section patch 使用 `sectionResults` key 直接寻址；携带多余 `path` 时 schema 拒绝。只有 scene 字段操作允许 `path`。
- `current`、`working`、`longTerm`、`meta` 作为 `sectionResults` key 或 event/policy `section` 时拒绝；它们只是存储容器。
- todo patch 顶层 `dueChange.set.dueAt` 符合 absolute/relative union 时接受；relative add/update 必须同时给出属于当前 observation evidence、真实承载时间表达的非空 `timeAnchorMessageId`，absolute 分支必须为 `null`。Todo update 无论是否修改期限都必须显式给出 keep/clear/set 之一；把 dueAt/dueChange 塞回 value 的 v2 shape 拒绝。
- scene section result 的 `epochTransition:{patchId,action:start|end,evidenceKind:scene_change,changeKind:lifecycle,evidenceRef,observationIds}` 按条件 schema 校验：它参与 output 级 patchId 唯一性、candidate decision 双向覆盖与原子 apply；start 先归档旧 epoch、创建新 epoch再应用字段 patches；end 可作为 `patches=[]` 时的唯一 operation，归档并清空且不与设置新字段混用；无 transition 时字段独立更新。缺固定 kind、observation evidence，或用 session/turn 证明 transition 时拒绝。
- 普通 patch 缺少自然 `changeKind` 时拒绝；changeKind 覆盖 `establish|reaffirm|refine|supersede|correct|forget|lifecycle`，并测试自然深化/细化不被强制编码为 correction。Proposer 自报 `projectionIdentity` 时 schema 拒绝；该字段只由 Reducer 从 observation root 派生。

### 3.2 Evidence 与 quote

- messageId 不存在时 `rejected: message_id_not_found`。
- messageId 属于专业 envelope 的 `observedMessages`，但数据库中的 userId/presetId/role/createdAt/contentHash 任一项与 proposal-time task payload 不一致时 `rejected: evidence_source_mismatch`。
- evidence 可以早于当前 scan delta、batch、overlap 或 context window。只要 messageId 属于 patch `observationIds` 对应 observation 的 raw evidence、同 user/preset/source generation、未超过 `sourceBoundaryMessageId`、未被 suppression 且 quote/hash 复核通过，就必须接受；不得以 `overlap_only_evidence` 或“缺少本批新证据”拒绝。
- 覆盖 pending proposal 在早期消息、接受/完成在当前消息，模式晋升引用多个旧 semantic arcs，以及 late-discovery 只引用旧消息的合法用例；也覆盖引用 observation 未登记旧消息、未来消息或 boundary 外消息时拒绝。
- quote 精确命中时接受。
- 达到实质长度的 quote 走统一归一化 + exact-substring + 等长窗口 bounded Levenshtein；轻微改写且达到阈值时接受。只有 1–2 个信息字符的短 quote 使用 exact-only 专用分支，禁止模糊 fallback。一般 exact 路径不受模糊预算影响；模糊路径超过 content 或 candidate-window 预算时 fail closed，并覆盖对抗性重复输入不会造成无界同步 CPU 占用。
- 大小写、Unicode whitespace 和 `QUOTE_IGNORABLE_PUNCTUATION` 明列标点的差异按统一归一化移除；未列入该集合的字符不得由调用点自行忽略，symbol 不作为信息字符。
- quote 为空或纯 whitespace/punctuation/symbol 时 `rejected: quote_too_short`。1–2 个信息字符只有在 registry relation 为 `accepts|rejects|supports|completes|cancels`、exact 命中且同一 observation root 另有实质 ref 时才接受；否则拒绝。覆盖 `好`、`好吃`、`OK` 参与提议接受链成功，但它们单独建立长期事实失败。
- quote 恰好 200 个 Unicode code points 时可进入匹配；201 个时 `rejected: quote_too_long`。用非 BMP 字符覆盖 code point 与 UTF-16 code unit 的差异，Reducer 不得自动裁剪。
- quote 与消息不匹配时 `rejected: quote_not_found`。
- 默认阈值读取为 0.75；阈值配置改变时 matcher 使用配置值，不在调用点硬编码。
- 否定词删除、数字/姓名替换不走专项规则或 NLI；是否接受只由统一相似度阈值决定，测试和文档不得宣称已解决否定翻转。
- provider/LLM 输出伪造 messageId 时不推进错误写入。
- 普通写入 patch 引用 `readOnlyContext` 中 item 的历史 messageId，但该 messageId 未通过 observation 登记且不在专业 `observedMessages` 中时拒绝；read-only state 本身永远不能证明新事实。
- 普通 add/update patch accepted 后，Reducer 为 `evidenceRefs` 补入数据库复核的 `contentHash`，再连同 `patch.evidenceKind` 包装为一个 `evidenceGroup`（携带 `evidenceKind` + `refs`）；forget evidence 不追加到已移除 item。
- 普通写入 patch 带多个 `evidenceRefs` 时，`updatedAtMessageId` 取该 group 内最大的 `messageId`。
- read-only context 可以影响 noop/patch 判断，但不能单独支撑新增事实。

### 3.3 Proposer 输入 envelope

- pending `triggerReason` 只接受 `debounce|batch_target|provisional_user_deadline|tail_deadline|assistant_complete|flush|drain|recovery|rebuild`；source-scan task 使用 `scanMode=incremental|rebuild|late_discovery` 并精确绑定下一条 singleton `semanticBoundaryId/ordinal/planVersion`。normal 专业 Proposer task trigger 只接受 `candidateReady|candidateRetry|candidateReview`：三者分别对应初次 boundary evaluation、同 lineage 技术 retry 与新 semantic review lineage；maintenance 只接受 `lengthBudget` 或 `hygiene`。旧 `stableBoundary|tailMaxDelay|forceRebuild|lateDiscovery|lagThreshold` 不再冒充 task trigger。
- normal task 必须携带 durable UUID `taskId`、`schemaVersion=3`、`semanticBoundaryId/boundaryCycleId/cycleLineageId/cycleKind/reviewEpoch/reviewTrigger/retryEpoch/asOfRevision/contractVersion/sourceBoundaryMessageId` 与非空 `observationVersions`；只有 `reviewTrigger=late_discovery` 时 `lateDiscoverySourceBoundaryId` 非空。提交前关联 task/observation versions 必须存在，并重新校验 revision、generation、boundary 和 target routing。技术 `candidateRetry` 保持同 cycleLineage/review 且 `retryEpoch+1`，必须继承 retry 0 visibility snapshot/asOf/candidate versions/semanticNow；fixture 证明 retry target 看不到同 evaluation 已提交的其他 target state。version 已变化交给更晚 boundary，无法 safe rebase则 halt/rebuild。
- `candidateReview` 必须使用新的 `cycleLineageId`、单调 `reviewEpoch>0` 与 `retryEpoch=0`。waiting stale、operator requeue、dead-letter recheck 和 late discovery 分别使用对应 reviewTrigger，在当前 generation 最新已封存 semantic boundary 上冻结当时最新 asOf/current observation versions/semanticNow；没有新 raw 时 source start 等于 boundary。latest boundary/evaluation 尚 active 时只排队，不得并入旧 cycle；所有 evidence 仍不得越过 review boundary。
- maintenance task 不读取 raw messages 或推进 source scan；它继承来源 normal task 的 boundary/identities，仅用于关联、幂等和后续 replay。
- maintenance task 的 `parent_task_id` 必须指向来源 normal task，并持久化 `resume_epoch`；normal task 在 `capacity_blocked` 阶段的 `stage_payload` 必须至少持久化 `persistedProposal`、`maintenanceTaskId` 和 `resumeEpoch`。
- 四种 taskType 的 stage 只接受 [state-contract.md](state-contract.md) §2.1 封闭状态图与合法有向边；status/stage/notBefore/resultRevision/persistedProposal 交叉条件逐一覆盖。重启从 persisted stage继续，不允许倒退到 proposing后重复 Provider 调用；非法自由文本、终态 status配非终态 stage、retry_wait缺 notBefore 均拒绝。
- normal/maintenance task 的 proposal-time envelope 与 evidence metadata 必须写入 immutable `task_payload`；normal payload 固化 `observations + observedMessages（相关原文）+ writableState + readOnlyContext + asOfSnapshotIdentity`。普通 retry/restart 不得从变化后的 recent window 临时重组同一个 task input。Provider 返回并通过 schema 校验后的原始 proposal 写入可变的 `stage_payload.persistedProposal`；`patchId` 由 Proposer 输出并经 schema 校验，新增 item 的 authority `itemId` 由 Reducer 生成。进入 capacity/deferred 链时把这些 replay identities 与 proposal 一起持久化。
- 同一 `boundaryCycleId/cycleLineageId/reviewEpoch` 的多个 targets 先基于同一 as-of snapshot 建立 intents/envelopes；物理提交顺序不得让先生成的 episode/profile 等派生状态泄漏给另一个 target。technical retry 继承该 snapshot；后来 semantic review 以新 lineage冻结最新 snapshot，不得把两者当作同一 cycle。
- 每个 normal envelope 的 `observations` id/version 集合必须精确覆盖 `task.observationVersions`，并包含最小充分相关 `observedMessages`；后者可按 candidate/entity/action/semantic arc/现有 item 检索较早原文，不受当前 batch/context/overlap 边界限制。缺任一 observation 的 raw evidence 时不能调用 Proposer。
- `readOnlyContext` 只提供 source boundary 时点的必要消歧投影；目标 section 的相关 writable items 必须完整，不得因 last N 或字符串相似度漏掉可能的 update/complete/cancel 对象。`todoProposer` 可按集中配置限制无关 overdue items，但被 observation 直接引用的 item 永远必须输入。
- source scan 每个 task 只组装 checkpoint 后下一条 `single_source_message_v1` semantic-boundary row，delta 恰好一条消息；batch/debounce 只合并 pending wake与 raw prefetch，不能合并 Provider envelope/task/call。Observer output 与 assessment/observation changes 同事务持久化后才推进该 singleton checkpoint；专业 Proposer 不再从 raw scan range 推断候选。
- normal task 的 `sourceBoundaryMessageId` 是 as-of 上界；专业 `observedMessages` 中全部 ID 不得超过它。session 划分不进入语义 envelope，reply/turn 元数据只用于源完整性。
- `working.todos` 同时包含 active 与 overdue items；fixture 应覆盖 wall-clock 到期后 item 原位变 overdue，以及 complete/cancel/expire 终止后才从数组移除。非 todo Proposer 的 readOnlyContext 按 [state-contract.md](state-contract.md) §1.5 默认只接收 active，candidate 直接关联的 overdue item例外且永不因普通预算截断。
- `working.standingAgreements` 全集即 active 子集（取消的 agreement 已从数组移除，见 [state-contract.md](state-contract.md) §1.3/§5.1）；fixture 应覆盖 active item 出现、已取消 item 不再出现在数组中的行为。
- target sections 的当前状态只出现在 `writableState`；`readOnlyContext` 不重复提供 target 作为只读证据来源。
- `writableState` item 含 `id` 字段；`readOnlyContext` item 不含可写 `id` 字段（[state-contract.md](state-contract.md) §4.1）。
- `profileRelationshipProposer` 只能写 `userProfile`/`assistantProfile`/`relationship`，`worldFactProposer` 只能写 `worldFacts`；两者的 read-only sections 与公共背景严格使用 [state-contract.md](state-contract.md) §1.5 映射，不得把对方的 writable section 放入自己的 `writableState`。
- 每个 target 的 state projection 覆盖固定映射、active/overdue 筛选、直接关联优先与稳定预算裁剪。直接关联的 existing item无论位于 writable/read-only section都必须保留；若物理上限容不下则显式 missing_context/capacity failure，不得静默丢项后调用 Provider。
- `profileRelationshipProposer` 与 `episodeProposer` 可消费同一 observations/raw evidence，但不得互相等待或把对方的摘要当唯一事实源；交换其调度顺序必须得到语义等价结果。

### 3.4 Policy table

- `scene.setField + scene_change` 接受。
- `todos.addItem + user_request/user_commitment/assistant_request/assistant_commitment` 接受。
- `standingAgreements.addItem + standing_agreement` 接受。
- `standingAgreements.cancelAgreement + agreement_cancel` 接受。
- `milestones.addItem + recent_episode` 拒绝。
- `milestones.addItem + relationship_milestone` 接受，并写入 `longTerm.milestones`。
- `worldFacts`/`userProfile`/`assistantProfile`/`relationship` 的 `addItem + scene_change` 拒绝。
- 上述四个 section 的 `addItem + long_term_fact + changeKind=establish` 接受；行为推断只在 profile/relationship 中允许。
- 上述四个 section 的自然重申/细化/取代允许 `updateItem + long_term_fact + changeKind=reaffirm/refine/supersede`；只有旧事实确实错误时才使用 `user_correction/assistant_correction + changeKind=correct`。op、evidenceKind 与 changeKind 不合法的组合拒绝。
- 上述四个 section 的 `forgetItem + user_forget/assistant_forget` 接受；其他 section 的 forgetItem、通用 removeItem、`forgetItem + correction` 均拒绝。
- `recentEpisodes/milestones` 与上述四个长期 section 的 `retractItem + user_correction/assistant_correction + correct` 在明确证明当前 item 本不应成立且无替代值时接受，并只 suppress current field lineages；todos/agreement 使用各自 correction cancel，forget/lifecycle/自然 supersede 不得借用 retractItem。
- 对 `worldFacts`/`userProfile`/`assistantProfile`/`relationship` 分别覆盖 User 与 Assistant 消息支持 `addItem + long_term_fact` 的接受用例；不得按 role 把任一方限制为只能维护 userProfile 或 assistantProfile。
- 上述四个 section 分别覆盖 user 消息支持 `updateItem + user_correction + correct`、assistant 消息支持 `updateItem + assistant_correction + correct`；evidenceKind 与数据库真实 role 不符时 `rejected: evidence_role_mismatch`。另覆盖 relationship 逐渐加深、偏好增加限定和 agreement 重申不会误标 correction。
- 上述四个 section 分别覆盖 user 消息支持 `forgetItem + user_forget`、assistant 消息支持 `forgetItem + assistant_forget`；两种 forget kind 与真实 role 不符时同样 `rejected: evidence_role_mismatch`。

### 3.5 Source scan checkpoint 与候选生命周期推进

- source-scan progress 与 observation-target lifecycle 分开断言。Observer 只有在同事务持久化全部 observation changes 或明确 `no_relevant_signal` 后才能把 scan progress 推到 `sourceBoundaryMessageId`；专业 task 完成、全局 source scan checkpoint 到末尾或 task status=succeeded 都不能代替 candidate lifecycle 断言。每次 target status/version/reason 变化还必须有同事务、幂等的 transition event；source scan/suppression/generation 等系统变化不得伪造 candidate decision 或空 cycle。
- `candidateDecisions.outcome=proposed` 只有在所有关联普通 patches/scene transition operations 被 Reducer 接受并持久化后才能把对应 target candidate 标成 consumed。schema/policy/evidence/Reducer rejection、capacity deferred、Provider error 和进程崩溃都保留同一 observation 为 retryable/pending，不得因 task boundary 或 source scan checkpoint 前进而静默丢失。
- `waiting` 保持 candidate 可被后续 observation 补证并记录 reason；`excluded` 和 `already_reflected` 在 reason/identity 经本地校验后才形成明确终局。section `noop` 必为每个 observation 写可审计 outcome/reason event，不再用无法解释的单行 noop 占位。
- normal task 没有独立 writer cursor；只有当所有输入 observations 已分别进入 consumed、waiting、excluded、already_reflected 或显式 retryable/dead-letter，才算该 cycle 的候选处置有完整解释。target 只有在没有未说明/可重试处理缺口时才可报告语义 healthy。
- `deferred` 阻止 proposed candidates 消费：同 target 有任一 `deferred` 行则不把关联 observations 标为 consumed，无论是否存在其他 accepted patch。
- 混合 `accepted`+`deferred` 的非原子混合提交已被禁止：capacity-blocked 时本轮不 apply 任何 operation，只为触发容量阻塞的 operation 写 `deferred`（`result_revision=null` 审计 group），其他 operations 的最终 decision 延迟到 replay group；任何实际提交的 state revision 都必须拥有同号完整 snapshot，未提交 state/observation lifecycle 时不得伪造 revision。
- Provider/schema `error` 由 tick orchestrator 截获，只原子更新 durable task、per-target status 与 ops log；不落 semantic events、不交 Reducer、不增加 revision/snapshot。
- `unable_to_decide` 首次把当前 task 的 `context_expansion_attempt` 置 1，并原子持久化完整 `expandedEnvelope`；下一 attempt 复用该 envelope。二次仍无法判断时 observations 进入 retryable/dead-letter 并使 target degraded/halted，不能伪造无 state 写入的语义成功。可识别的指代不清应走 `waiting + ambiguous_reference`。
- 二维 cycle identity 必须成对测试：Provider/schema/COMMIT technical retry 命中同 `cycleLineageId/reviewEpoch`、增加 `retryEpoch` 并逐字段深等 retry 0 envelope；waitingStale/operator/dead-letter review 则在 latest sealed boundary 使用新 lineage/新 asOf/current versions，且旧/新 task dedupe key 不碰撞。把 semantic review 错做旧 lineage retry，或让 technical retry读取最新 state，均 fail。
- late discovery 重扫历史 singleton boundary 后，新 ready candidate 的 review 绑定当前最新已封存 visibility boundary，并另存历史 `lateDiscoverySourceBoundaryId`；测试证明它不在历史 as-of 消费、不创建重复 boundary/assessment、不推进 checkpoint，且 `(semanticBoundaryId,reviewEpoch,retryEpoch)` 并发分配不冲突。
- 瞬时 error 连续 3 次后只把对应 target status 置为 halted；`memory_state` 不出现 halt/recovery 字段，其他 targets 的 status 与 observation lifecycle 不变。
- 长度预算首次阻塞时只为触发容量阻塞的 patch 写 `deferred`（`result_revision=null` 审计 group），触发 maintenance task，per-target status 进入 `capacity_blocked`，且不消费关联 observations；一个 target `capacity_blocked` 不阻塞同 boundary 其它 target。
- compaction 成功释放容量后，replay 原 proposal（不重新调 Proposer），使用原稳定 `patchId` 写最终 replay group。
- compaction 返回 `unable_to_compact`，或 merge 后 replay 仍超限时，maintenance/normal task 失败并 halt 对应 target；关联 observations 保持 retryable，不能消费或增加伪 state revision。
- 可 compaction item section 的容量超限不产生终局消费；首次阻塞为 `deferred`。`scene` 超限字段虽写 `rejected: capacity_exceeded` 审计 event，关联 candidate 仍保持 retryable；同 bundle 的其他独立 candidate 可提交。
- 缺少 target section、包含非 target section或 candidateDecisions 覆盖不完整属于 `output_schema_invalid`；当前 observations 不消费，其他 target 不受影响。
- `recentEpisodes/milestones` 共享 `episodes` target queue，`userProfile/assistantProfile/relationship` 共享 `profileRelationship` target queue，但 consumption 按 observation/section decision 记录；一个 section waiting 或 retryable 不能被另一个 section accepted 掩盖。
- profile/relationship add/update 缺少 facet/canonicalKey/factBasis 时 schema 拒绝。`observedPattern` 未达到至少三个独立行为场合并跨两个 semantic arcs 时，正常输出应是 `waiting + pattern_threshold_not_met`；若错误 proposed，Reducer 同样以正式 reason `pattern_threshold_not_met` 拒绝且 candidate 留待重试。旧证据不因只位于 overlap 而拒绝。
- 同 section `projectionIdentity` 完全相同的 establish 应走 `already_reflected` 或合法 reaffirm，不依赖 Unicode text 恰好相同；非 multi-value canonicalKey 冲突仍拒绝，multi-value/open key 允许语义不同的多值项。
- maintenance task 的 `targetKey` 仅关联来源 normal target；它不读取或推进 raw-message scan progress，也不拥有独立 candidate queue。它完成后仍由被阻塞原 task 的 Reducer 结果决定 observation lifecycle。
- ops_log 的 `task_id/worker_key` 必填；normal/maintenance outcome 的 `target_key` 必填，source-scan outcome 的 `target_key` 为 null，system-cleanup 按实际归属填写。可明确归属某个 `sectionResults` 的 outcome 填对应正式 section；task 级 outcome 的 `section` 必须为 null，且不得用 targetKey 代填。

### 3.6 Reducer 状态安全

- 同一 itemId 的合法局部更新只改目标字段。
- 指向不存在 itemId 的操作拒绝。
- 普通 patch accepted 后，持久化 evidence ref 包含数据库复核后的 `messageId + contentHash + quote`；Proposer 伪造 contentHash 无法写入 state。
- 普通 patch accepted 后，item evidenceGroup/event 持久化经校验的 `observationIds`；Reducer 将排序去重的全部 root IDs 保存为 `sourceProjectionIdentities`，单 root 直接成为 `projectionIdentity`，多 root 使用固定 namespace UUIDv5。重试相同 projection 不重复创建；compaction root union 使用同一算法。跨 section 的合法投影保留共同 observation 来源，供 Renderer identity 去重。
- correction fixture 断言 active item 保留 itemId、只渲染新 value、追加新的 correction evidenceGroup，旧 event/snapshot 不变；只把实际修正字段 pre-state `currentFieldLineage[field].evidenceGroupIds` 指向的 source 写 tombstone，更早但不在当前 lineage 的真实 establish/refine/supersede 历史与新 correction message不被 suppress。lineage 为空、悬空或 fingerprint 不匹配时 fail closed。另以 reaffirm/refine/supersede fixture 证明自然演化保留历史但不创建 correction tombstone。
- compaction fixture 合并多个不同 text/source lineages 后再 correction，必须能从 merged item 的非空 `currentFieldLineage.text` 精确收集当前合并值的支持 groups；不得因 merged text 没有同值 `assertedValueFingerprints` 而漏 suppress，也不得退化为 suppress 全部历史 groups。
- forget fixture 先经过多次 update 和 merge，再断言 Reducer 只读取当前 item 的完整 evidenceGroups 即可收齐全部 `messageId + contentHash`；item 移除、accepted event、snapshot 与 tombstones 同事务，逐故障点均整体 rollback。
- 同一 source tombstone 重复提交幂等；日常 rebuild 只能把 suppressed source 作为显式标记的 correction 指代 supporting context，不能作为有效 observation/patch evidence或输出。修正后 current value 必须由未 suppressed correction/后续 evidence 支撑；最终 suppression audit 不得恢复旧错误投影。
- 每个 item section 都从测试注入的集中配置读取 `maxItems` 与 `maxRenderedChars`，不得使用散落硬编码值。
- `maxItems` 未超但 apply 后 `maxRenderedChars` 超限，以及 `maxRenderedChars` 未超但 `maxItems` 超限，均进入 `deferred` 并触发 maintenance task；maintenance trigger 分别记录正确的 `dimension` 和 `limit`。
- `updateItem` 等非 add patch 扩大语义文本并导致 `maxRenderedChars` 超限时同样经过容量门，不得只在 `addItem` 上检查。
- `maxRenderedChars` 按 Unicode code points 只统计 Renderer 可能输出的语义文本；普通 item 计 text，todo 还计 actor/requester/非 null dueAt 的渲染值。quote/evidenceGroups/hash/ID/provenance 与 Renderer 标题、字段标签、连接词、模板标点不计。
- scene 只校验语义 values 的 `maxRenderedChars`，不虚构 `maxItems`。
- proposal/envelope 即使很大也不因 Memory 业务层“总字符上限”被拒绝；Provider context/output 硬上限由 Adapter 测试覆盖，不映射成 section capacity reject reason。
- `recentEpisodes` apply 后超出 `maxItems` 或 `maxRenderedChars` 时，Reducer 按确定性顺序滚出最旧 items 直至两项均满足；不 deferred、不创建 maintenance task。每个滚出项写 `recent_episode_evicted` event，同 revision snapshot 可完整 replay。
- open semantic arc 只能存在于 observation repository；任何 `recentEpisodes` item 带 open/pending 状态或 Proposer 在 arc 未关闭时 proposed 都拒绝。跨 batch/session 的 arc append evidence 不增加 final state revision，明确关闭后最多建立一条 final episode。
- item section 超出长度预算时 normal task 进入 `capacity_blocked`，只为触发容量阻塞的 patch 写 `deferred` 并创建 maintenance task。compaction 返回 `unable_to_compact`（`compaction_failed`）或 replay 预检仍因容量不足（`replay_failed`）时只 halt 对应 target。
- `compactionProposer` 的 section `status` 为 `patches` 或 `unable_to_compact`；`status` 为 `patches` 时 patch 的 `op` 只能是 `mergeItems`，输出 `addItem`、跨 section 合并、通用删除时拒绝。
- `agreementProposer` 输出 `completeTodo`/`cancelTodo`/`expireTodo` 时拒绝。
- `memory_compaction` 的 patch 必须 `changeKind=lifecycle`；输出 observationIds/evidenceRefs/candidateDecisions 时拒绝。
- `memory_compaction` accepted 后，Reducer 将 source items 既有 `evidenceGroups` 完整继承到 merged item，并保留 group 边界。
- compaction 逐 section 覆盖结构化兼容表：todos actor/requester/due/anchor、agreementKey、episode/milestone同一非空 arcId、profile facet/canonicalKey/factBasis及全部 semanticKey全等时继承；任一冲突 `invalid_state_transition`。Proposer只能给 result text，不能决定这些字段；result currentFieldLineage从各 source current lineage非空并集重建。
- `memory_compaction` accepted 后，merge event 的 `item_id` 为 null，`normalized_operation.mutation.sourceItemIds` 存储完整 source item ID 数组（按 canonical 稳定顺序），`result_item_id` 与 `normalized_operation.mutation.resultItem.id` 存储同一新 merged item ID。
- accepted/system-cleanup 的 `normalized_operation` 必须通过 operationVersion 1 strict union：item upsert/remove/merge 保存可 replay 的完整 post item或稳定删除 identity，scene 保存完整 post scene/previousScene，Todo dueResolution 与 post item 交叉一致。rejected/deferred/noop 的 normalized_operation 必须为 null；从 anchor replay 逐 event 校验 pre/post fingerprint，任何断层 fail closed。
- `memory_compaction` accepted 后，merged item 的 `updatedAtMessageId` 取所有 source evidenceGroups refs 的最大 `messageId`。
- `memory_compaction` 的 `value.text` 不得引入 source items 未表达的新事实——此约束由 compactionProposer prompt 承担（[proposer-prompt.md](proposer-prompt.md) §2.4/§4.7），Reducer 不做语义检测，仅 LLM smoke 覆盖。
- Proposer 输出非 target section 时记 `output_schema_invalid`；若这是首次 Provider 输出边界错误则持久化一次 retry 后重新调用，第二次仍非法才 halt 对应 target。item patch 携带 `path` 时同样由 schema 拒绝；错误只影响本 task 的 `targetKey`、task status 与 observation lifecycle，其他 target 不受影响。
- Todo add 缺 actor/requester 或输出非法枚举时 schema 拒绝；合法 add 初始化 `status=active`、`becameOverdueAt=null`，dueAt 缺省为 null。
- Todo update 的 dueChange 分别覆盖 keep/clear/set；dueChange 缺失或分支混合时 schema 拒绝。纯改 deadline/revive允许省略 value；keep 时 value 必须非空且实际改变字段，空 value+keep 或归一化全 noop 拒绝。relative dueAt 必须以 evidence message createdAt 为 anchor，absolute 必须持久化 `timeAnchorMessageId=null`；fixture 故意令 `task.semanticNow` 与 message.createdAt 不同，证明实现未误用执行时间。absolute date 和 relative 运算必须使用 task 创建时从 User 字段固化的用户时区（默认 UTC），并统一落到目标日期结束后的首个日界线；fixture 覆盖 `days=0` 在当天结束前保持 active、到日界线后 overdue，以及非 UTC 时区和月末截断（如 1 月 31 日 + 1 个月 = 2 月 28/29 日）。
- 已计算 dueAt 早于 housekeeping now 时不拒绝历史事实：同一 apply/cleanup 或下一次 housekeeping 将 item 原位改为 overdue，写 `todo_became_overdue`，`becameOverdueAt=dueAt`，并保留 itemId、actor、requester、dueAt、evidenceGroups。
- overdue todo 仍可由 `completeTodo`/`cancelTodo` 终止；active 容量只统计 active items，overdue items 不触发 compaction、不得 merge。
- overdue todo 通过 `updateItem` 设置 `dueChange.mode=set` 且新 dueAt 在未来时，Reducer 原位将 `status` 从 `overdue` 改回 `active`、清空 `becameOverdueAt`，并写 `system_cleanup: todo_revived_from_overdue` event；保留 itemId、actor、requester、dueAt 和全部 evidenceGroups。
- Todo compaction 仅接受 actor/requester/dueAt 分别相同的 active source items；任一字段不同或包含 overdue item 时拒绝。
- scene `epochTransition.start` 原子执行“归档旧 current epoch（若存在）→建立新 epoch→应用字段 patches”；`end` 原子归档并清空且不应用新字段。逐故障点整体 rollback；previousScene 只保留 latest archived epoch，替换时审计 evicted。
- scene location/time/mood/note 的 TTL 与 evidence anchor 分别测试：仅更新 mood 不刷新 location；某 epoch 第一个字段到期时先以 `endReason=field_ttl` 把最后完整非空快照归档为 previousScene，再只清该 current 字段；同 epoch 后续字段到期不得用残缺快照覆盖 previous，全部字段失效后清空 current epoch。session/turn 变化不触发 epoch transition，明确到家/离开/活动结束才可触发。
- Scene/Todo housekeeping 重复执行必须幂等：状态/字段已转换时不新建空 revision，不重写 `previousScene.endedAt`/`becameOverdueAt`；epoch start/end 重放也不得重复归档。
- `todos`、`standingAgreements`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship` 均需各自的同 section compaction 测试。

### 3.7 Provider Adapter 与 per-target recovery

- 配置加载覆盖已实现/未实现的 structured-output adapter：未知 adapter 必须启动失败，不能回退到裸文本 + `JSON.parse`；已实现 adapter 使用原生 schema/tool/function 并对返回值再做本地完整 schema 校验。真实 Provider preflight 顺序覆盖 schemaVersion 3 的 `semanticSignalObserver`、六个专业 Proposer 与 Compaction schema，任一 schema 被端点拒绝、返回错误分支或本地验证失败均不通过。
- mock adapter 返回合法 `status: "ok"` → output 交 Reducer；成功提交时 task/status/events/state/snapshot 同事务完成。
- proposer/tickId 不匹配、`candidateDecisions` 未覆盖 observationVersions、patch `observationIds` 非法或 `sectionResults` 残缺 → 首次输出边界错误写 ops log=`output_schema_invalid_retry`，并持久化计数与经过裁剪的 schema 修复反馈；第二次调用必须收到该反馈并返回完整替代结果，进程中断恢复后也必须复用反馈。第二次仍非法才 task failed、对应 target halted、ops log=`output_schema_invalid`。日志和 stage payload 不保存非法输出原文；所有错误路径都不交 Reducer、不消费候选、不增加 revision/snapshot。
- `unable_to_decide` 首次 → task `context_expansion_attempt=1`，写 ops log，并持久化完整 `stage_payload.expandedEnvelope`；恢复和下一 attempt 必须复用该 envelope。二次仍 unable 时 observations 保持 retryable/dead-letter 并令 target degraded/halted，不得在没有 state 写入和候选终局的情况下伪造语义成功 revision。
- compactionProposer 返回 `unable_to_compact` → maintenance task failed、对应 target halted、写 ops log；不增加 revision/snapshot。
- `safety_policy_blocked` / `llm_call_failed` → task `retry_wait`、attempt 递增、写 notBefore，target status=`retry_wait` 且 `consecutive_errors + 1`；第三次只 halt 对应 target。
- provider 明确因最大输出长度停止时归类 `max_output_truncated`，不得落为 `output_schema_invalid`，即使响应残片可解析也不交 Reducer；它按有界 retry/backoff 处理并单独计数，且不得因此缩小 section 容量。
- 输入 envelope 的 `output_schema_invalid` 不重试；Provider 输出的 `output_schema_invalid` 最多立即重试一次，计数跨重启保持，第二次失败后 task failed、对应 target halted，且不得发生第三次 Provider 调用。
- 任一 target halted 时，其他 target 仍可创建/提交 task；halted target 的最后稳定 state 保留。全局 `memory_state.meta.halted` 不得重新出现。
- resume 指定 target：未耗尽的 `retry_wait` 原 task只清 `notBefore` 并复用 immutable envelope；需要新 technical task时创建同 lineage 的 `candidateRetry/retryEpoch+1`。容量/compaction/replay 失败仍创建 maintenance child。已 dead-letter 或操作者要求重新作语义判断时，修复根因后保持 degraded并排入 `candidateReview`，在 latest sealed boundary 新 lineage冻结最新 asOf/current versions；不得用旧 observations/asOf 创建 candidateRetry。旧 task保留审计，其他 targets不变，只有 review/恢复 task收敛后才恢复 healthy。
- 任一成功 revision 在同事务终结本 task并按实际 candidate outcomes 更新错误计数；只有该 target 无未说明/可重试处理缺口时才恢复 healthy，不能仅凭一次成功 revision 清除其他 retryable candidates。
- Reducer 永远只收到 `status: "ok"`、candidateDecisions 完整且 section 为 `patches`/`noop` 的 output，不处理空输出、Provider error、unable 或伪造输出。
- 健康聚合表驱动覆盖全部 per-target status 和 candidate lifecycle：全 healthy 且无未说明/retryable gap → `healthy`；任一 retry_wait/capacity_blocked/halted 或 retryable/dead-letter candidate → `degraded`；任一 rebuilding → `rebuilding`，且 rebuilding 与 degraded 同时存在时整体仍为 `rebuilding`。合法 waiting candidate 单独计数并保留最老年龄，但不伪装成已消费。
- active `gap_bridge_truncated`、`scene_capacity_exceeded` 或其他 context-quality 诊断也使整体进入 `degraded`/`rebuilding`；只有全部 target healthy 且无 active 诊断时才能恢复 `healthy`。
- 新异常在 `alertDebounceMs` 内可暂不进入响应 health alert；越过防抖后，非 healthy 告警在连续响应中持续返回，包含受影响记忆类别和“可能滞后/正在重建”语义。恢复事务完成后 active 告警消失，并为该恢复事件恰好创建一行包含已追平 boundary 的 notification。正常路径只投递一次；fixture 还必须允许“响应已包含通知、`delivered` 更新提交前崩溃”后再次投递，不能把 best-effort once 误测为 exactly-once delivery。target、projection、system 三类恢复分别断言正确的 `subject_kind/subject_key`。
- 任一 target halted 不产生全局 `chatBlocked` 或 user/preset 级 halt；主聊天和其他 targets 的任务继续。resume/rebuild 维护入口可操作 halted target，普通 Observer 不可绕过。
- halted target 的 Renderer golden 继续包含最后稳定 state：相邻的同 target sections 可在组前只出现一次“该类记忆可能滞后”，不相邻的 sections 必须分别出现。`episodes` 的 milestones 与 recentEpisodes 不相邻，因此两处各出现一次且文案状态一致；rebuilding 使用“该类记忆正在重建”。不得把这些标记写回 `memory_state.meta`。
- scene `capacity_exceeded` event 由独立 diagnostic projector 转换为 active `target + scene + scene_capacity_exceeded`；同 group 其他字段 accepted 时告警仍存在，只有 `detail.rejectedPaths` 中对应字段后续 accepted 才移除，全部恢复后在同一投影事务 resolve 并创建 recovery notification。重复投影不重复 diagnostic/notification；故障时 checkpoint 不推进、normal task 成功结果不回滚，runtime/context 后续可重试。
- 重复 wake-up 使用相同 observation/task dedupe key 时只存在一个 durable task；模拟“事务已提交但 worker 未收到确认”后再次 delivery 相同 task/patchId，必须返回既有终态，observations、events、revision、snapshot、compaction/replay 结果均不重复。
- 提交前分别制造 generation、sourceBoundary、observation set 和当前 revision 失配：generation/boundary/observation 失配时 proposal 不得 apply；revision 失配且 generation/boundary 仍匹配时创建 successor 并重用同一 candidate identities。compaction/replay 按持久化 stage identities 执行，不能因其他 target 的合法 revision 增长丢失候选。
- 指标断言至少验证 Observer singleton scans/raw-message coverage/no-signal、per-target candidateReady/candidateRetry/candidateReview calls、reviewTrigger、review/retry epoch、candidate outcomes/reasonCodes、waiting/retryable 最老年龄、tokens/latency、Adapter 结果、quote 失败、compaction/replay/halt/deferred、late-discovery、跨窗口补全、模式晋升、GapBridge 与 rebuild/projection lag；指标使用稳定标签且不含原始消息正文等高基数字段。
- 配置测试证明 capacity、scene field TTL/epoch、overdue、Observer batch/debounce、`tailMaxDelay`、相关原文检索/context budgets、GapBridge、quote threshold、retry/backoff、compaction/halt、hygiene high-water/min-item-delta、retention 和告警参数均从同一入口注入。scan batch/debounce 只影响 pending wake/raw prefetch，context/overlap只影响成本；它们都不是 boundary或证据资格。固定 quote 上限仍为 200 code points，默认相似度阈值为 0.75，缺失/越界配置显式失败。

### 3.8 Renderer 稳定性（渲染回归基线）

- 空 section 使用稳定占位符。
- 当前状态和长期记忆分区清晰。
- requestNow 首次越过某个 scene field TTL、但 cleanup 尚未持久化时，effective view 把对应 current 字段显示为未知、保留其他仍有效字段，并在 `[已过期场景 / 上次已知场景]` 显示该 epoch 最后一份完整快照；同 epoch 后续字段过期不把 previous 降级成残缺版本。
- requestNow 已越过 todo dueAt、但 cleanup 尚未持久化时，effective view 只在 overdue 组渲染该 item。overdue 组按 becameOverdueAt DESC/itemId 稳定排序并同时满足独立条数/字符预算。
- Todo render 包含 actor/requester，存在 dueAt 时包含 deadline；recentEpisodes 不再硬编码只取最近 3 条。
- Renderer 用固定语法组织自然、简洁文本，不展示 Proposer 的内部 `+|→` 编码；open episode observations、candidate reason、scan/lifecycle checkpoint 或置信度不进入 memory segment。
- 构造同一 `projectionIdentity` 的重复/跨 section 投影：纯重复只展示一次，组内独有结构化语义被确定性合成而不丢失；不同 projectionIdentity 即使共享 observation root 或 text 相似也不得互删。语义不同的 todo/agreement 可分别展示，结果不随 text 改写、target 调度或 item 插入顺序变化，且不使用字符串相似度。
- golden snapshot 锁定完整 rendered text，Renderer 代码变更时 golden test 失败以提示回归。
- render 不包含 patch log、event log、reject reason 或 reducer 内部细节。

### 3.9 Context 接入

- 候选历史 raw content 的 Unicode code point 总数不超过集中配置阈值时 `needsMemory=false`，recent window 保留全部消息且不注入 `memory`；不得叠加 message count、tokenizer 或 context 百分比门控。
- `needsMemory=true` 且 `memory_state` 存在、schema 校验通过时，注入单一 `memory` segment，并由 Renderer 实时生成文本。
- `needsMemory=true` 但 `memory_state` 不存在、`version` 不支持或 schema 校验失败时，`memory` segment 不注入，debug payload 记录明确原因，不得静默跳过。
- recent window 可跨 session 且保留 user-boundary 裁剪；Memory Observer fixture 必须证明 Assistant 开头的 source 未被同一规则裁掉，且不注入 session boundary 控制标记。
- GapBridge 分别构造两类集合再按 `(messageId,contentHash)` 合并：A 为全局 `scannedThroughMessageId < messageId < recentWindowStartMessageId` 的未扫描有效 raw source；B 为 recent window 外、observation-target lifecycle 仍为 `ready|processing|waiting|retryable|dead_letter` 的 registered evidence。覆盖 scan status 缺失、provisional tail 掉出 recent window、A/B 重叠、多 target evidence，并断言 session/batch/target 调度不改变语义集合。
- 预算选择先公平保留各 active observation 的最近实质证据及最新未扫描 raw，再按 messageId 倒序填充并恢复升序；单条超预算整体 omitted，不得截断或调用 LLM 压缩。任何 omission 都产生 active `gap_bridge_truncated`，subject 使用 `sourceScan` 或 `<observationId>:<targetKey>`，携带单调 `boundaryMessageId` 及 `detail.scannedThroughMessageId/observationVersion/observationTargetStatus/omittedMessageIds`。恢复必须分别证明 scan checkpoint 越过完整 active boundary，或对应 observation version 已 consumed/excluded/invalidated/完整覆盖；GapBridge 不推进 scan checkpoint、不改变 observation lifecycle、不写 patch/event。
- Context assembly 在读取 active diagnostics 前 best-effort 同步 diagnostic projection；active scene capacity diagnostic 令 `[当前状态]` 出现“该类记忆可能滞后”，并在通过 `alertDebounceMs` 后令响应 `memory_health.alerts` 包含“长度超限未写入”。同步失败只记录 debug error 并继续使用最后成功投影状态，不阻断主聊天。
- RAG context 与 `memory` segment 并列存在，不互相覆盖。
- RAG chunk 保存全部 source `messageId + contentHash`；任一 source 命中 tombstone 时，已有 chunk 即使尚未异步删除也被查询末端过滤，重新分块跳过整条消息。多事实消息被整条排除的保守副作用应有固定 fixture。
- Recall 候选 refs、raw window 和最终文本分别覆盖 suppression 过滤；全部 refs 被过滤的 group 不注入，suppressed raw message 不因落在相邻窗口而泄漏。
- correction 后 Renderer 只出现新值；forget 后既不出现原 item，也不出现“已作废”占位文本。

### 3.10 清空旧派生数据与 v3 恢复

- 旧 `rolling_summary` / `core_memory`、schemaVersion 2 state/task/proposal/fixture 不转换为 v3 权威状态；旧派生数据清空后只从保留的 raw messages 语义重建，不存在双读、字段 fallback 或 adapter 兼容测试。
- 唯一 cutover 在停用全部 Memory worker后同一 destructive schema workflow 删除 v1 rolling/core及运行列、v2 authority 和已有开发期 v3派生表，再创建 fresh v3；不存在可独立执行、保留已初始化 v3 authority 的 legacy cleanup路径。SQL 测试必须证明不对 `chat_messages` 执行 `DELETE`/`UPDATE`。
- 首次初始化 generation 0 state 时写 revision 0 完整 snapshot；revision 跨 generation 单调递增，每个成功 revision N 恰好一份带 generation 的同号完整 post-state snapshot，不额外写 pre-state snapshot。
- 一个 task bundle 含多个 accepted patch 时只增加一次 revision、写一个 event group 和一份 snapshot；add event 的 `result_item_id` 非 null，accepted event 含完整 normalized operation。
- `excluded/already_reflected/waiting` 等无 memory state 变更的候选终态/等待态写 observation audit，不伪造 accepted memory revision；纯 error/retry/halt/deferred 且 state 未变化时不增加 revision、不写 snapshot。
- 二次 unable 或普通 rejected 不创建没有 state 写入/候选终局的 semantic success；candidate 保持 retryable/dead-letter 并记录原因。section noop 必须由完整 candidate outcomes/reasonCodes 解释。
- deferred 的 `result_revision` 为 null；其 event group/events、原 task stage、派生 maintenance task 和 target status 必须同事务提交，不能只留下 deferred event 而没有可恢复 task。
- 注入事务故障点覆盖 state、event group/events、snapshot、source scan checkpoint、observation-target lifecycle、task 终态和 target status 的每个适用写入位置；任一点失败都整体 rollback，不得出现半提交。
- system cleanup 修改持久化 state 时必须写 `decision=system_cleanup`、具体 cleanup_type 和完整 normalized operation；覆盖 scene 单字段过期、epoch 归档/previous eviction、`todo_became_overdue`、`todo_revived_from_overdue`、`recent_episode_evicted`。Proposal post-state 触发的 cleanup 与 proposal decisions 同 group/revision；独立后台 housekeeping 才断言 `group_kind=system_cleanup`。
- 从当前 generation 最新合法 v3 snapshot replay 后续具有 `result_revision` 的 event groups，可恢复相同 memory state/revision；replay 不调用 LLM，并拒绝 generation/revision 断层、非 v3 schema 或 operation/source identity 不一致的 event group。source scan status、pending tail、semantic-boundary plan、assessment、observation lifecycle、task 与 target status 由各自 durable control tables 恢复；这些状态损坏时走完整 raw rebuild，不能从 semantic state events 推定。
- Retention 清理必须保证每个活跃 generation 至少保留一个 schema-valid v3 完整 anchor snapshot；覆盖“校验新 snapshot → 原子提升 anchor → 清理旧 snapshot/events”的成功与逐故障点 rollback。从新 anchor replay 后续 groups 必须恢复相同 memory state/revision；control-plane 表按各自引用关系和 retention 契约独立保留，终态 task 清理不得删除 active task、candidate decision，或 retained event groups 仍引用的 parent task / cycleLineageId / reviewEpoch / retryEpoch / task identity。
- Retention 在删除任何 event 前先同步 diagnostic projection；同步失败时 retention 不进入清理事务，checkpoint 之后的 event 必须保留供后续重放。
- snapshot/state 损坏时优先恢复当前 generation 最新合法 snapshot；必要时从 raw messages rebuild。
- 进程重启会从数据库读取 queued/running/retry_wait task 并从持久化 stage 继续；进程内队列、计数器或 flag 丢失不影响恢复。
- stale generation/revision/boundary/observation 执行结果写 `stale_result` ops log 并丢弃，不得覆盖新 state；replay 必须先匹配 generation，再检查 source boundary、candidate 活动性、引用 item 与 schema/source hashes；同 generation 的其他 target revision 增长不单独构成 stale。
- 语义恢复只依赖 snapshot/events；运行状态恢复只依赖 durable task/per-target status/ops log，不能互相推定。
- 任何非 v3 `meta.recovery/halted` 不做 in-place 迁移；清空派生状态后初始化 v3 target status、source scan status/pending/singleton boundary plan 与 observation repository。
- 普通 append 不增加 `sourceGeneration`；编辑历史、regenerate 截断、删除、session trash/restore/permanent delete、preset/可见性变化和排序语义变化各自覆盖 generation `+1` 路径。
- source mutation、generation `+1`、captured boundary、旧 generation 全部非终态 Memory task 取消、新 generation 空 state、下一个全局 revision snapshot 和六个 target `rebuilding` 必须同事务；逐写入点故障均整体 rollback，revision 不得因 rebuild 重置为 0。Generation 初始化不伪造 section event group，恢复从该 snapshot 开始。
- generation 变化后，旧 normal/maintenance/compaction/replay 结果一律 stale 且不能提交；同 generation 内其他 target 导致的 revision 增长仍不单独使 replay stale。
- rebuild 从当前有效 raw messages 按事件顺序生成 `single_source_message_v1` plan，rebuild trigger 把 pending endpoint提升到 captured boundary并立即触发，再逐 boundary运行 Observer；专业任务使用 `candidateReady`，同 visibility 技术恢复使用 `candidateRetry`，显式语义复核使用 `candidateReview`。scan progress、pending排空、全部 review/retry lineages、candidate lifecycle、六 target state/snapshot/events 校验完成前保持 rebuilding，未追平或仍有 retryable gap不得 healthy。
- rebuild 期间再次改变 source 时，旧 rebuild 结果不得推进新 generation 的 state、scan checkpoint、observation lifecycle 或 status；worker 转而处理最新 generation/boundary。
- RAG checkpoint 断言 `processedGeneration + processedBoundaryMessageId`；Recall/Scene Recall 不建立空操作 checkpoint并继承该 cutoff。Memory targets 追平不代表 projection 追平。告警条件只基于 `requiredBoundary`（= `recentWindowStartMessageId - 1`）：`processedGeneration != sourceGeneration` → rebuilding；`processedBoundary < requiredBoundary` → degraded；`processedBoundary >= requiredBoundary` 且 generation 一致 → healthy（落后范围在 recent window 内不告警）。projection 只部分覆盖 requiredBoundary 时仍注入已处理部分并标记不完整，不因部分落后完全跳过。
- 一次性切换 smoke 按“停服并冻结 raw boundary → 更新 → 清空所有旧派生状态/task → 从 raw messages 建 singleton plan并执行 v3 rebuild/tail drain → 校验 → 启服”执行；校验失败断言聊天服务保持关闭。tail drain 使用 pending deadline提升，不建立 legacy Flush table/type或合并 range task。
- rehearsal 必须可重复执行且不读取/恢复旧派生数据。报告至少记录 raw/source scan coverage、observation establish/append/late-discovery 数、各 outcome/reasonCode、waiting/retryable 最老年龄、专业 Proposer/Provider 调用与 tokens、九个正式 section itemCount/textChars、schema/code/config 指纹和 source inventory hash。
- 切换不做 v2→v3 state 转换；发现任何旧派生 residue 就失败或幂等清空。后续 rebuild/校验失败必须返回 `canStartService=false`。
- 最终校验逐 scope 覆盖：raw boundary 未变化、singleton plan逐有效 source一一覆盖、source scan 追平且 pending为空、所有 observations 有明确 lifecycle、没有未处理 retryable gap、六个 target 同 generation 语义 healthy、authority state 与当前 v3 snapshot 完全一致、event/snapshot revision chain 连续、RAG/Recall checkpoint 同 generation 且追平 captured boundary。
- context-suppression tombstone 跨 source generation 保留；rebuild 最终 active state、RAG 和 Recall 都不能重新引入匹配的 `messageId + contentHash`。
- privacy hard delete 覆盖 raw、state、events、snapshots、durable task/proposal payload、tombstones、context-quality diagnostics 及其 RAG projection checkpoint、recovery notifications、RAG 派生数据与受控 debug 存储（统一落点见 [state-contract.md](state-contract.md) §6.6）；从剩余 source rebuild 校验完成前保持 rebuilding，任一存储仍残留时不得恢复。禁止将完整 raw prompt/完整 state diff 写入 append-only 应用日志。

## 4. Alice 行为基线与 metamorphic 验收

Alice 数据用于验证 v3 修复的是语义覆盖而不是某一组 prompt 文案。fixture/rehearsal 必须保留下列 message IDs、role、createdAt、raw content/hash 与 reply 关系，并在每个 source boundary 只暴露当时已存在的 state/observations；最终自然 text 可以不同，但 section、`projectionIdentity`、状态流转、原始证据集合、相对日期和候选 outcome/reason 必须满足断言。

| Alice 原始消息 | 必须成立的行为断言 |
| --- | --- |
| `528/529` “以后经常做草莓大福”及响应 | Observer 建立 recurring commitment observation 并关联接受；agreement Proposer proposed 后建立或更新同一 standing agreement。不得因未达到旧 16-message 周期、跨 batch 或只引用旧候选证据而 noop/丢失。 |
| `684/687/696` 三明治一次性承诺；`724/727/728` 后续完成 | 两段原文关联同一个 todo observation/projection，先建立再 complete；最终 active/overdue todos 都不再展示该事项，历史事件保留建立与完成证据，不能重复创建两个 todo。 |
| `729/730` “以后每天早上做早餐”及接受 | 建立 daily-breakfast agreement；反复适用语义不能只落 scene 或被误判为一次性 todo。若提议与接受分属不同 batch/session，前者先 `waiting + awaiting_acceptance`，后者到达后 proposed。 |
| `975–1076` 夜间外出至回家 | 作为同一 semantic arc observation 跨窗口追加关键进展；arc open 期间 final `recentEpisodes` 不出现“进行中”条目，回家/活动结束后若达到显著性门槛只形成一条包含关键进展和结果的 episode，不按 batch/session/动作拆分。 |
| `1078–1080` “明天三明治/草莓大福” | 建立相应一次性 todo；relative due schema 为 `days:1`，锚定源消息当地日期/用户时区，不能因重建执行日或 batch 延迟变成 `days:0`。 |
| 多次草莓大福相关行为 | 以共享模式主题、不同 semantic arc identity 累计 assistant-profile 候选。未达到三个独立行为场合且至少两个 semantic arcs 时保持 `waiting + pattern_threshold_not_met`；达到门槛才晋升，三条相邻消息、三个 turn 或三个 session 不算三份独立证据。 |
| 当前数据没有明确虚构 canon | `worldFacts=[]`，相关 candidates 为 `excluded + not_canon/invalid_inference` 或根本无信号；空集合是正确结果。 |
| 最后 scene 字段超过各自 TTL | expired effective current 字段为空/未知；`previousScene` 指向最近一个有 raw evidence 的已结束/全部过期 epoch，而非较早偶然存活场景。只更新某个字段不得续期其他字段。 |

### 4.1 等价比较器

Metamorphic suite 不逐字比较非确定 LLM 的自然 text，而比较规范化语义结果：

- observations 按 `observationIdentity + rawMessageIds + semanticArcIdentity` 归一化；投影按 `section + projectionIdentity + lifecycle state` 归一化；生成的数据库 ID 映射为稳定 identity。
- 比较 candidate outcome/reason、accepted/rejected/deferred 结果、evidence message/hash 集合、todo actor/requester/dueAt/status、scene epoch/字段有效性以及 worldFacts 空集合。
- 文案允许同义差异，但 Renderer 的 identity 去重数量、section ownership 和“不扩大事实”断言必须一致。任何变体出现 missing/extra projection、重复 item、未来状态泄漏或未说明 candidate 都失败。

### 4.2 必须执行的变形矩阵

1. **session repartition**：保持消息 ID/role/content/createdAt/reply 顺序不变，分别重分为 1 个、8 个和更多 session。逐项通过 §4 表，semantic arc、独立行为场合、scene epoch 和 todo/agreement 关联均语义等价；session 名称/日期不进入 Proposer envelope。
2. **batch/context/overlap**：至少选择“小 batch + 小支持窗口”“大 batch + 大窗口”“不同 overlap”三组合法配置，并改变 Observer debounce。scan batch/debounce 只能改变 pending wake/raw I/O 预取；三组必须生成完全相同的 `single_source_message_v1` boundary rows、source-scan task envelopes、Observer 调用数与逐 boundary cycle顺序。support/context token用量可以不同，但最终 observations/projections 必须语义等价；旧 evidence 只要属于 candidate 且不越 source boundary 都合法。
3. **target order**：对同一 boundary cycle / `cycleLineageId + reviewEpoch` 使用同一 as-of snapshot，至少运行正序、逆序和随机顺序。特别比较 `episodes → profileRelationship` 与 `profileRelationship → episodes`，证明 profile/relationship 不等待 episode 也不读取同 evaluation 先提交的未来派生状态；另断言后续 semantic review可使用新 as-of但不会改写旧 lineage。
4. **failure/recovery**：分别在 Observer output schema、Proposer output schema、evidence validation、Reducer apply 和事务提交点注入一次失败。恢复后使用同一 observation identity 与 `candidateRetry`：合格事实最终恰好落地一次，失败前 candidate 不被消费，events/state/projection 不重复；不可修复错误保留 retryable/dead-letter 并使健康度明确 degraded。
5. **tail**：在多个不足任何批处理阈值的位置截断时间线，包括恰好在提议、接受、完成和 episode 关闭消息之后停止。断言 pending endpoint可由稍后 assistant提升、原 freeze/tail deadline不后移；在 capture 后/task freeze 前重启仍按原 deadline冻结同一 singleton row。分别由 `tailMaxDelay` 与显式 rebuild/drain 触发 source scan，最终结果与立即逐条扫描等价；不得要求新聊天消息“顺便带过”tail。
6. **online/rebuild**：同一 Alice raw timeline 分别在线增量和从空 v3 state 重建；重建按 boundary 时间顺序，不读取未来 profile/episode。应用上述等价比较器后结果一致。

## 5. 端到端 smoke

真实 Provider 的 schema/channel 能力由 `npm run probe:memory-v2-provider` 验证；最小语义链路由 `npm run smoke:memory-v2-provider` 验证，后者必须让真实 `semanticSignalObserver` 建立 observation，再让 todoProposer 对明确承诺生成带 `candidateDecisions/observationIds` 且可经 Reducer 接受的 `todos.addItem`，不能只回显预制 JSON。它们属于显式联网验收，不并入离线 `test:memory-v2`。其余端到端 smoke 只覆盖少量代表性路径：

- 新增 todo -> 完成 todo -> render 不再显示未完成待办。
- 新增带 actor/requester/dueAt 的短期待办 -> evidence message createdAt 锚定期限 -> wall-clock 到期后原位 overdue -> 仍可完成/取消 -> 也可通过 updateItem 设置未来 dueAt 变回 active。
- scene 首个字段到期但 housekeeping 尚未提交 -> effective view 隐藏该字段并把完整 epoch 快照作为 previous；同 epoch 后续字段到期不降级 previous。明确 start/end 或更新、更晚的 epoch 归档时才单值替换并审计 evicted。
- recentEpisodes 超窗口 -> 最旧 item 确定性滚出并写 cleanup event，不触发 compaction。
- 新增 standing agreement -> 修订 agreement -> 取消 agreement -> render 不再显示已取消约定。
- 明确长期事实 -> 对应长期 section 新增；临时情绪 -> 不进入长期 sections。
- 行为推断的长期特征只有在至少 3 个独立行为场合且跨至少 2 个 semantic arcs 时才允许 profile/relationship 新增；未达到时 observation 保持 `waiting + pattern_threshold_not_met`。一次性动作、同一微事件内的相邻台词、多个 turn/session 不冒充独立证据，worldFacts 不使用行为 trait 推断。
- Episode Prompt 质量测试固定要求：同一 semantic arc 跨 batch/session 只在 observation 层 append，open 时 final state noop，只有明确关闭后才最多 add 一条 recentEpisode；日常微动作 excluded/not_memory_worthy，milestone 不默认双写。以“深夜回家→折返取物→道别→约定次日早餐”为反例时，不得拆成逐动作 item。
- assistant 修正已有长期 item -> `updateItem + assistant_correction` 接受（四个长期 sections 均可）。
- 多次更新/合并后的长期 item -> 明确 forget -> active state 原子移除并按完整 evidenceGroups suppress；随后 rebuild/RAG/Recall 均不恢复旧 source。
- 长期 item correction -> active state 只显示新值，旧 source 从 RAG/Recall 排除，新 correction message 可正常召回。
- `userProfile` 达到上限 -> 新增被 deferred 且 observation 未消费 -> compaction 在同一 section 合并重复项 -> replay 原 proposal 成功，candidate 恰好消费一次。
- compaction 无安全合并项 -> 返回 unable_to_compact -> `compaction_failed`，halt 对应 target；resume 指定 target 后创建新 maintenance child task 重新尝试，成功 replay 后恢复 healthy。
- `todos` 达到上限 -> deferred -> compaction 合并重复待办 -> replay 原 proposal 成功，observation 不丢失/不重复。
- `standingAgreements` 达到上限 -> deferred -> compaction 合并重叠约定 -> replay 原 proposal 成功，observation 不丢失/不重复。
- Provider Adapter 返回 `safety_policy_blocked` -> 落 ops log，candidate 保持 retryable；连续达阈值后只 halt 对应 target，其他 targets/主聊天继续；resume 后用 `candidateRetry` 从 durable observation/task stage 继续。

## 6. 测试落点与入口

离线回归统一使用 Node test runner：`npm run test:memory-v2` 执行 `test/memory/*.test.js`。可复用的结构化场景放在 `modules/memory/harness/fixtures/`，恢复链路的支持数据放在 `modules/memory/harness/recovery-fixtures/`，并由 `modules/memory/harness/runner.js` 按显式 `fixtureKind` 发现、校验和路由。不得再建立第二套 `scripts/memory-v2-verify` runner 或把 fixture 复制到多个目录。

真实 Provider 验收使用 §5 的 `probe:memory-v2-provider` 与 `smoke:memory-v2-provider` 显式入口，不进入离线回归。

Harness 通过后，v2.1/schemaVersion 3 才能接入真实主链路。否则它仍只是换了形状的不可控摘要器。
