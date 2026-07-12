# Memory Control v2 Harness 验收契约

本文定义 Memory Control v2 的最小可验收测试边界。Harness 的目标不是证明 LLM 永远正确，而是证明 LLM 即使输出不稳定、局部错误或被 provider 拦截，最终 memory state 仍然可控、可审计、可恢复。

顶层设计见 [../memory-control-v2-overview.md](../memory-control-v2-overview.md)。状态契约见 [state-contract.md](state-contract.md)，写入协议见 [write-protocol.md](write-protocol.md)，渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. Harness 原则

- **Reducer 优先**：大多数 golden case 应直接测试 Reducer，不依赖真实 LLM。
- **Fixture 可读**：每个 case 明确给出 initial state、input envelope、proposer output、expected events、expected state 和 expected cursor。
- **拒绝路径一等公民**：`rejected` / `error` 的测试数量不能少于 happy path。
- **维护路径可回放**：`deferred` / compaction / 最终预算拒绝必须能从 fixture 中复现。
- **渲染回归基线**：Renderer 是纯代码模板，同一 `memory_state` 在同一版 Renderer 下产生确定性输出。golden snapshot 锁定完整 rendered text，Renderer 代码变更时 golden test 失败以提示回归。
- **真实 LLM 只做 smoke**：少量端到端 smoke 用真实 provider；可靠性判断主要靠结构化 fixture。

## 2. Fixture 形态

每个 fixture 使用一个 JSON 文件表达，支持单 tick 和多 tick 场景。单 tick 即 `ticks` 数组只有一个元素。

```json
{
  "name": "todo-add-with-valid-evidence",
  "initialState": {
    "version": 2,
    "current": {
      "scene": {
        "location": { "value": null, "evidenceRef": null, "updatedAtMessageId": null },
        "time": { "value": null, "evidenceRef": null, "updatedAtMessageId": null },
        "mood": { "value": null, "evidenceRef": null, "updatedAtMessageId": null },
        "note": { "value": null, "evidenceRef": null, "updatedAtMessageId": null }
      },
      "previousScene": null
    },
    "working": { "todos": [], "standingAgreements": [], "recentEpisodes": [] },
    "longTerm": { "milestones": [], "worldFacts": [], "userProfile": [], "assistantProfile": [], "relationship": [] },
    "meta": { "revision": 0, "targetCursors": { "todos": 120 } }
  },
  "initialTargetStatuses": {
    "scene": { "status": "healthy", "consecutiveErrors": 0 },
    "todos": { "status": "healthy", "consecutiveErrors": 0 },
    "standingAgreements": { "status": "healthy", "consecutiveErrors": 0 },
    "episodes": { "status": "healthy", "consecutiveErrors": 0 },
    "profileRelationship": { "status": "healthy", "consecutiveErrors": 0 },
    "worldFacts": { "status": "healthy", "consecutiveErrors": 0 }
  },
  "ticks": [
    {
      "description": "User asks to be reminded about returning an eraser",
      "input": {
        "task": {
          "taskId": "018f2f5e-7f2a-7b11-9c31-111111111111",
          "tickId": 12345,
          "userId": 1,
          "presetId": "default",
          "schemaVersion": 2,
          "baseRevision": 0,
          "targetKey": "todos",
          "cursorBefore": 120,
          "targetMessageId": 121,
          "proposer": "todoProposer",
          "mode": "normal",
          "targetSections": ["todos"],
          "observedMessageIds": [121],
          "trigger": { "type": "lagThreshold" },
          "now": "2026-07-06T22:30:00Z"
        },
        "writableState": { "working": { "todos": [] } },
        "readOnlyContext": {
          "current": {
            "scene": {
              "location": { "value": null, "updatedAtMessageId": null },
              "time": { "value": null, "updatedAtMessageId": null },
              "mood": { "value": null, "updatedAtMessageId": null },
              "note": { "value": null, "updatedAtMessageId": null }
            }
          },
          "working": { "standingAgreements": [], "recentEpisodes": [] },
          "longTerm": { "userProfile": [], "assistantProfile": [] }
        },
        "observedMessages": [
          {
            "id": 121,
            "role": "user",
            "createdAt": "2026-07-06T22:30:00Z",
            "contentKind": "raw",
            "content": "明天提醒我把橡皮还给她",
            "contentHash": "sha256:1b94b37c16d073e89d406a0ff36da228029f998f21ca1894d533a222062396c1"
          }
        ]
      },
      "adapterMock": {
        "status": "ok",
        "output": {
          "tickId": 12345,
          "proposer": "todoProposer",
          "sectionResults": {
            "todos": {
              "status": "patches",
              "patches": [
                {
                  "op": "addItem",
                  "value": { "text": "归还橡皮", "actor": "user", "requester": "user" },
                  "evidenceKind": "user_request",
                  "evidenceRefs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }]
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
          "schema_version": 2,
          "base_revision": 0,
          "result_revision": 1,
          "cursor_before": 120,
          "cursor_after": 121,
          "group_kind": "proposal"
        },
        "events": [
          {
            "event_kind": "proposal_decision",
            "decision": "accepted",
            "op": "addItem",
            "evidence_kind": "user_request",
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
                "createdAtMessageId": 121,
                "updatedAtMessageId": 121,
                "actor": "user",
                "requester": "user",
                "status": "active",
                "becameOverdueAt": null,
                "dueAt": null,
                "evidenceGroups": [
                  {
                    "evidenceKind": "user_request",
                    "refs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }]
                  }
                ]
              }
            ]
          }
        },
        "cursor": { "todos": 121 },
        "snapshot": { "revision": 1, "schema_version": 2 },
        "task": {
          "task_id": "018f2f5e-7f2a-7b11-9c31-111111111111",
          "status": "succeeded",
          "result_revision": 1
        },
        "targetStatus": { "target_key": "todos", "status": "healthy", "consecutive_errors": 0 },
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

Fixture runner 默认用 `initialState` 写 generation 0 / revision 0 完整 snapshot；需要模拟后续 generation 的 fixture 必须显式提供匹配的全局 revision 与 generation-boundary snapshot。测试不得只在内存中构造 state 而跳过 snapshot。`initialTargetStatuses` 独立于 `memory_state` 初始化，且必须为全部六个 normal target 各提供一行相同 generation 的初始 status。`initialState.meta.targetCursors` 只需列出本 fixture 涉及的 target key；未列出的 target cursor 默认为 0，表示该 target 尚未处理任何消息。

### Fixture 断言匹配规则

- **statePatch 深合并**：patch 值与 `initialState` 深合并，只覆盖 fixture 中列出的字段。Reducer 生成的字段（`id`）用 matcher 表达。确定性字段（`dueAt`、`status`、`becameOverdueAt`、`createdAtMessageId`、`updatedAtMessageId`）必须显式列出。
- **events 子集字段匹配**：只检查 fixture 中列出的字段，忽略自增列（`id`、`user_id`、`preset_id`、`tick_id`、`created_at`）。行数必须精确匹配。按插入顺序逐行匹配。`rejected` 行必须包含 `reject_reason`。支持 `maintenance_task_id` 和 `merged_from_item_ids` 字段断言，可用 `{ "_match": "notNull" }` 匹配任意非 null 值。
- **eventGroup/snapshot/task/targetStatus**：分别校验 revision group、完整 post-state snapshot、durable task 终态和 per-target status；snapshot.state 必须深等于同事务最终 `memory_state`，它们与 events/cursor 必须来自同一事务。
- **opsLog**：按插入顺序精确匹配 fixture 中列出的字段。
- **cursor**：精确匹配各 target 的 `coveredUntilMessageId`。
- **meta**：只比较语义 state 元数据（revision/targetCursors）；不得出现 halted/recovery/retry 字段。
- **renderEquals**：完整 rendered text 的 golden snapshot 路径，为 `null` 时跳过。Renderer 代码变更时 golden test 失败以提示回归。
- **renderContains**：宽松子串检查，用于 smoke test。
- **Matcher 语法**：`{ "_match": "string", "prefix": "todo:" }` 匹配以 `"todo:"` 开头的字符串；`{ "_match": "notNull" }` 匹配任意非 null 值。

## 3. 必测用例组

### 3.1 Schema 与 patch op

- 合法 `setField` / `clearField` / `addItem` / `updateItem` / `mergeItems` / `completeTodo` / `cancelTodo` / `expireTodo` / `cancelAgreement` 被接受。
- normal Proposer 输出 `mergeItems` 时拒绝（`mergeItems` 只允许 `compactionProposer`）；`compactionProposer` 输出 `addItem`/`updateItem` 等非 `mergeItems` op 时拒绝。
- 缺少该 op 按 [state-contract.md](state-contract.md) §4 应必填的字段时拒绝。
- 非法 section + op 组合拒绝。
- item section patch 使用 `sectionResults` key 直接寻址；携带多余 `path` 时 schema 拒绝。只有 scene 字段操作允许 `path`。
- `current`、`working`、`longTerm`、`meta` 作为 `sectionResults` key 或 event/policy `section` 时拒绝；它们只是存储容器。
- `todos.addItem.value.dueAt` 与 `todos.updateItem.value.dueChange.set.dueAt` 符合 absolute/relative union 时接受；结构非法时拒绝。Todo update 无论是否修改期限都必须显式给出 keep/clear/set 之一。

### 3.2 Evidence 与 quote

- messageId 不存在时 `rejected: message_id_not_found`。
- messageId 属于 observedMessages，但数据库中的 userId/presetId/role/createdAt/contentHash 任一项与 proposal-time task payload 不一致时 `rejected: evidence_source_mismatch`。
- evidence 可以来自 newBatch 或 overlap；只有 overlap evidence 但其余校验通过时接受，不要求至少一条 evidence 来自 newBatch。
- quote 精确命中时接受。
- 所有 quote 长度都走相同归一化 + 等长窗口 Levenshtein 规则；轻微改写且相似度达到配置阈值时接受，不存在短 quote 精确匹配专用分支。
- 大小写、Unicode whitespace 和 `QUOTE_IGNORABLE_PUNCTUATION` 明列标点的差异按统一归一化移除；未列入该集合的字符不得由调用点自行忽略，symbol 不作为信息字符。
- quote 为空、纯 whitespace/punctuation/symbol，或归一化后只有 1-2 个信息字符时 `rejected: quote_too_short`；恰好 3 个信息字符继续进入模糊匹配。
- quote 恰好 200 个 Unicode code points 时可进入匹配；201 个时 `rejected: quote_too_long`。用非 BMP 字符覆盖 code point 与 UTF-16 code unit 的差异，Reducer 不得自动裁剪。
- quote 与消息不匹配时 `rejected: quote_not_found`。
- 默认阈值读取为 0.75；阈值配置改变时 matcher 使用配置值，不在调用点硬编码。
- 否定词删除、数字/姓名替换不走专项规则或 NLI；是否接受只由统一相似度阈值决定，测试和文档不得宣称已解决否定翻转。
- provider/LLM 输出伪造 messageId 时不推进错误写入。
- 普通写入 patch 引用 `readOnlyContext` 中 item 的历史 messageId，但该 messageId 不在 `observedMessages` 中时拒绝。
- 普通写入 patch accepted 后，Reducer 将该 patch 的 `evidenceRefs` 连同 `patch.evidenceKind` 包装为一个 `evidenceGroup`（携带 `evidenceKind` + `refs`）。
- 普通写入 patch 带多个 `evidenceRefs` 时，`updatedAtMessageId` 取该 group 内最大的 `messageId`。
- read-only context 可以影响 noop/patch 判断，但不能单独支撑新增事实。

### 3.3 Proposer 输入 envelope

- 普通模式必须使用 `task.trigger.type = "lagThreshold"`；维护模式必须使用 `task.trigger.type = "lengthBudget"`，并带 `dimension=maxItems|maxRenderedChars` 与对应配置 `limit`。
- normal task 必须携带 durable UUID `taskId` 与创建时 `baseRevision`；提交前二者关联的 task row 必须存在，并重新校验 `baseRevision === meta.revision`。`task.targetKey` 只能是六个合法 targetKey；每个 task 只有一个 `cursorBefore`、new batch 和 `targetMessageId`。
- maintenance task 不携带 `cursorBefore`；其 `targetMessageId` 必须等于来源 normal proposal 的 `targetMessageId`，只用于关联、幂等和后续 replay，不得用于读取 raw messages 或推进 cursor。
- maintenance task 的 `parent_task_id` 必须指向来源 normal task；normal task 在 `capacity_blocked` 阶段的 `stage_payload` 必须至少持久化 `persistedProposal` 和 `maintenanceTaskId`。
- normal/maintenance task 的 proposal-time envelope 与 evidence metadata 必须写入 immutable `task_payload`；retry/restart 不得从变化后的 recent window 临时重组同一个 task input。Proposer 返回后经 schema 校验并分配 patchId 的完整 proposal 写入可变的 `stage_payload.persistedProposal`，不写入 `task_payload`。
- 同一 tick 多个 targets eligible 时只先排 intents；第一个 target 提交 revision 后，第二个 target 创建 task 时必须捕获新 revision，不得因共享 tick 初始 baseRevision 产生伪 `stale_result`。
- 同一 Proposer、同一 target、同一 `memory_state` 下，即使 observed messages 内容不同，`readOnlyContext` 的 section 形状也必须一致；只允许 `task.observedMessageIds` 和 `observedMessages` 随消息窗口变化。
- 固定范围内的 section 必须完整输入当前 items；不得做 last N、相似度筛选、关键词筛选或数量截断。
- `observedMessages` 按 `coveredUntilMessageId` 之后的分页规则组装：从 `coveredUntilMessageId` 后取最早未处理 batch，再补充 `coveredUntilMessageId` 及之前的 overlap；不得取全局最新 M 条跳过 backlog。
- normal task 的 `task.targetMessageId` 必须等于本轮 new batch 的最大 messageId，不取 overlap 的 messageId。
- `working.todos` 同时包含 active 与 overdue items；fixture 应覆盖 wall-clock 到期后 item 原位变 overdue，以及 complete/cancel/expire 终止后才从数组移除。非 todo Proposer 的 readOnlyContext 仍只接收 §5.3 规定的 active 子集。
- `working.standingAgreements` 全集即 active 子集（取消的 agreement 已从数组移除，见 [state-contract.md](state-contract.md) §4）；fixture 应覆盖 active item 出现、已取消 item 不再出现在数组中的行为。
- target sections 的当前状态只出现在 `writableState`；`readOnlyContext` 不重复提供 target 作为只读证据来源。
- `writableState` item 含 `id` 字段；`readOnlyContext` item 不含 `id` 字段（[state-contract.md](state-contract.md) §5）。
- `profileRelationshipProposer` 只能写 `userProfile`/`assistantProfile`/`relationship`，固定只读 `worldFacts` 及 §5.3 规定的公共背景；`worldFactProposer` 只能写 `worldFacts`，固定只读另外三个长期 sections 及公共背景。两者不得把对方的 writable section 放入自己的 `writableState`。

### 3.4 Policy table

- `scene.setField + scene_change` 接受。
- `todos.addItem + user_request/user_commitment/assistant_request/assistant_commitment` 接受。
- `standingAgreements.addItem + standing_agreement` 接受。
- `standingAgreements.cancelAgreement + agreement_cancel` 接受。
- `milestones.addItem + recent_episode` 拒绝。
- `milestones.addItem + relationship_milestone` 接受，并写入 `longTerm.milestones`。
- `worldFacts`/`userProfile`/`assistantProfile`/`relationship` 的 `addItem + scene_change` 拒绝。
- 上述四个 section 的 `addItem + long_term_fact` 接受；行为推断只在 profile/relationship 中允许。
- 上述四个 section 的 `updateItem + long_term_fact` 拒绝。
- 上述四个 section 的 `updateItem + user_correction/assistant_correction` 接受。
- 对 `worldFacts`/`userProfile`/`assistantProfile`/`relationship` 分别覆盖 User 与 Assistant 消息支持 `addItem + long_term_fact` 的接受用例；不得按 role 把任一方限制为只能维护 userProfile 或 assistantProfile。
- 上述四个 section 分别覆盖 user 消息支持 `updateItem + user_correction`、assistant 消息支持 `updateItem + assistant_correction`；evidenceKind 与数据库真实 role 不符时 `rejected: evidence_role_mismatch`。

### 3.5 Cursor 推进

- 可推进终局中的 `accepted`/`noop`/普通 `rejected` 推进对应 target cursor，并在一个事务形成 `base_revision + 1`（group 的 `base_revision` = 事务开始时最新 revision）、event group/events、完整 post-state snapshot、task 终态和 healthy target status。
- `noop` 必产生一行 `decision=noop` 占位 event。
- `deferred` 阻止 cursor 推进：同 target 有任一 `deferred` 行则不推进，无论是否存在 `accepted` 行；无 `deferred` 时有任一 `accepted`/`noop`/`rejected` 即推进。
- 混合 `accepted`+`deferred` 的非原子混合提交已被禁止：capacity-blocked 时本轮不 apply 任何 patch，只为触发容量阻塞的 patch 写 `deferred`（`result_revision=null` 审计 group），其他 patch 的最终 decision 延迟到 replay group；任何实际提交的 state revision 都必须拥有同号完整 snapshot，未提交 state/cursor 时不得伪造 revision。
- Provider/schema `error` 由 tick orchestrator 截获，只原子更新 durable task、per-target status 与 ops log；不落 semantic events、不交 Reducer、不增加 revision/snapshot。
- `unable_to_decide` 首次只把当前 task 的 `context_expansion_attempt` 置 1；下一 attempt 扩大窗口。二次仍无法判断时以 cursor-only revision 终结，写 snapshot/task/status。
- 瞬时 error 连续 3 次后只把对应 target status 置为 halted；`memory_state` 不出现 halt/recovery 字段，其他 targets 的 cursor/status 不变。
- 长度预算首次阻塞时只为触发容量阻塞的 patch 写 `deferred`（`result_revision=null` 审计 group），触发 maintenance task，per-target status 进入 `capacity_blocked`，且不推进 cursor；一个 target `capacity_blocked` 不阻塞同 tick 其它 target。
- compaction 成功释放容量后，replay 原 proposal（不重新调 Proposer），使用原稳定 `patchId` 写最终 replay group。
- compaction 返回 `unable_to_compact` → tick orchestrator 截获，maintenance task failed、对应 target halted；不交 Reducer、cursor 不推进、不增加 revision/snapshot。
- compaction 成功执行 mergeItems 但 replay 预检仍因容量不足 → normal task 进入 `replay_failed`（reason=`capacity_still_exceeded`）→ halt 对应 target，cursor 不推进。
- 容量超限不产生 patch 级 `rejected: length_budget_exceeded`；首次阻塞为 `deferred`（审计 group），终局失败由 task 级 `compaction_failed` / `replay_failed` 触发 halt，其他 reject reason 仍推进 cursor。
- 缺少 target section 或包含非 target section 属于 `output_schema_invalid`，本 task 的 target cursor 不推进；其它 target 不受影响。
- `episodeProposer` 的 `recentEpisodes` 与 `milestones` 共享 `episodes` cursor：一个 section accepted/noop、另一个 `unable_to_decide` 时整个 target 不推进；两者都形成可推进终局后只推进一次。
- `profileRelationshipProposer` 的 `userProfile`、`assistantProfile`、`relationship` 三个正式 section 共享 `profileRelationship` cursor；`worldFactProposer` 只推进独立的 `worldFacts` cursor。event 的 `section` 记录实际正式 section，`target_key` 记录共享 cursor 归属。
- maintenance task 的 `targetKey` 仅关联来源 normal target；它不携带 `cursorBefore`，不读取或推进 raw-message cursor，也不拥有独立 `targetCursors` key。它完成后仍由被阻塞的原 normal target 决定 cursor。
- ops_log 的 `task_id/target_key` 必填；可明确归属某个 `sectionResults` 的 outcome 填对应正式 section。task 级 outcome 的 `section` 必须为 null，且不得用 targetKey 代填。

### 3.6 Reducer 状态安全

- 同一 itemId 的合法局部更新只改目标字段。
- 指向不存在 itemId 的操作拒绝。
- 每个 item section 都从测试注入的集中配置读取 `maxItems` 与 `maxRenderedChars`，不得使用散落硬编码值。
- `maxItems` 未超但 apply 后 `maxRenderedChars` 超限，以及 `maxRenderedChars` 未超但 `maxItems` 超限，均进入 `deferred` 并触发 maintenance task；maintenance trigger 分别记录正确的 `dimension` 和 `limit`。
- `updateItem` 等非 add patch 扩大语义文本并导致 `maxRenderedChars` 超限时同样经过容量门，不得只在 `addItem` 上检查。
- `maxRenderedChars` 按 Unicode code points 只统计 Renderer 可能输出的语义文本；普通 item 计 text，todo 还计 actor/requester/非 null dueAt 的渲染值。quote/evidenceGroups/hash/ID/provenance 与 Renderer 标题、字段标签、连接词、模板标点不计。
- scene 只校验语义 values 的 `maxRenderedChars`，不虚构 `maxItems`。
- proposal/envelope 即使很大也不因 Memory 业务层“总字符上限”被拒绝；Provider context/output 硬上限由 Adapter 测试覆盖，不映射成 section capacity reject reason。
- `recentEpisodes` apply 后超出 `maxItems` 或 `maxRenderedChars` 时，Reducer 按确定性顺序滚出最旧 items 直至两项均满足；不 deferred、不创建 maintenance task。每个滚出项写 `recent_episode_evicted` event，同 revision snapshot 可完整 replay。
- item section 超出长度预算时 normal task 进入 `capacity_blocked`，只为触发容量阻塞的 patch 写 `deferred` 并创建 maintenance task。compaction 返回 `unable_to_compact`（`compaction_failed`）或 replay 预检仍因容量不足（`replay_failed`）时只 halt 对应 target。
- `compactionProposer` 的 section `status` 为 `patches` 或 `unable_to_compact`；`status` 为 `patches` 时 patch 的 `op` 只能是 `mergeItems`，输出 `addItem`、跨 section 合并、通用删除时拒绝。
- `agreementProposer` 输出 `completeTodo`/`cancelTodo`/`expireTodo` 时拒绝。
- `memory_compaction` 输出 `evidenceRefs` 时拒绝。
- `memory_compaction` accepted 后，Reducer 将 source items 既有 `evidenceGroups` 完整继承到 merged item，并保留 group 边界。
- `memory_compaction` accepted 后，merge event 的 `item_id` 为 null，`merged_from_item_ids` 存储完整 source item ID 数组（按持久化 patch 中的稳定顺序），`result_item_id` 存储新 merged item ID。
- `memory_compaction` accepted 后，merged item 的 `updatedAtMessageId` 取所有 source evidenceGroups refs 的最大 `messageId`。
- `memory_compaction` 的 `value.text` 不得引入 source items 未表达的新事实——此约束由 compactionProposer prompt 承担（[proposer-prompt.md](proposer-prompt.md) §2.4/§4.7），Reducer 不做语义检测，仅 LLM smoke 覆盖。
- Proposer 输出非 target section 时记 `output_schema_invalid` 并 halt 对应 target；item patch 携带 `path` 时 schema 拒绝，只按本 task 的 `targetKey` 决定 cursor，其它 target cursor 不受影响。
- Todo add 缺 actor/requester 或输出非法枚举时 schema 拒绝；合法 add 初始化 `status=active`、`becameOverdueAt=null`，dueAt 缺省为 null。
- Todo update 的 dueChange 分别覆盖 keep/clear/set；dueChange 缺失或分支混合时 schema 拒绝。relative dueAt 必须以 evidence message createdAt 为 anchor；fixture 故意令 task.now 与 message.createdAt 不同，证明实现未误用执行时间。
- 已计算 dueAt 早于 housekeeping now 时不拒绝历史事实：同一 apply/cleanup 或下一次 housekeeping 将 item 原位改为 overdue，写 `todo_became_overdue`，`becameOverdueAt=dueAt`，并保留 itemId、actor、requester、dueAt、evidenceGroups。
- overdue todo 仍可由 `completeTodo`/`cancelTodo` 终止；active 容量只统计 active items，overdue items 不触发 compaction、不得 merge。
- Todo compaction 仅接受 actor/requester/dueAt 分别相同的 active source items；任一字段不同或包含 overdue item 时拒绝。
- Scene TTL 到期时写 `scene_expired`，完整 current scene/provenance 进入单值 previousScene 后 current 四字段清空；若替换已有 previousScene，同一 revision 还写 `expired_scene_evicted`。两者均不创建 compaction task。
- Scene/Todo housekeeping 重复执行必须幂等：状态已转换时不新建空 revision，不重写 expiredAt/becameOverdueAt。
- `todos`、`standingAgreements`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship` 均需各自的同 section compaction 测试。

### 3.7 Provider Adapter 与 per-target recovery

- mock adapter 返回合法 `status: "ok"` → output 交 Reducer；成功提交时 task/status/events/state/snapshot 同事务完成。
- proposer/tickId 不匹配、`sectionResults` 残缺或非法 → task failed、对应 target halted、ops log=`output_schema_invalid`；不交 Reducer，不推进 cursor，不增加 revision/snapshot。
- `unable_to_decide` 首次 → task `context_expansion_attempt=1`，写 ops log，不修改 target 长期错误计数；二次仍 unable 才以 cursor-only revision 终结。
- compactionProposer 返回 `unable_to_compact` → maintenance task failed、对应 target halted、写 ops log；不增加 revision/snapshot。
- `safety_policy_blocked` / `llm_call_failed` → task `retry_wait`、attempt 递增、写 notBefore，target status=`retry_wait` 且 `consecutive_errors + 1`；第三次只 halt 对应 target。
- `output_schema_invalid` 是持续性错误：task failed、对应 target halted，不重试同输入。
- 任一 target halted 时，其他 target 仍可创建/提交 task；halted target 的最后稳定 state 保留。全局 `memory_state.meta.halted` 不得重新出现。
- resume 指定 target：对于 `retry_wait` target，重置为 `healthy`、清 error count/nextRetryAt 并重新排队可恢复 task；对于 `halted` target（compaction/replay 失败），重置为 `capacity_blocked`（不立即设 `healthy`），复用原 maintenance task 重新进入 compaction；不修改 state/revision/snapshot，也不重置其他 targets。只有原 proposal 成功 replay、cursor 推进并提交 snapshot 后才恢复 `healthy`。
- 任一成功 revision 在同事务将对应 target 恢复 healthy、错误计数归零并终结 task。
- Reducer 永远只收到 `status: "ok"` 且 section 为 `patches`/`noop` 的 output，不处理空输出、Provider error、unable 或伪造输出。
- 健康聚合表驱动覆盖全部 per-target status：全 healthy → `healthy`；任一 retry_wait/capacity_blocked/halted → `degraded`；任一 rebuilding → `rebuilding`，且 rebuilding 与 degraded 同时存在时整体仍为 `rebuilding`。
- active GapBridge omitted 或其他非 target context-quality 诊断也使整体进入 `degraded`/`rebuilding`；只有全部 target healthy 且无 active 诊断时才能恢复 `healthy`。
- 非 healthy 告警在连续响应中持续返回，包含受影响记忆类别和“可能滞后/正在重建”语义；恢复事务完成后 active 告警消失，并恰好产生一次包含已追平 boundary 的恢复通知。
- 任一 target halted 不产生全局 `chatBlocked` 或 user/preset 级 halt；主聊天和其他 targets 的任务继续。resume/rebuild 维护入口可操作 halted target，普通 Observer 不可绕过。
- halted target 的 Renderer golden 继续包含最后稳定 state，并在该 target 固定 section 组前只出现一次“该类记忆可能滞后”；rebuilding 使用“该类记忆正在重建”。不得把这些标记写回 `memory_state.meta`。

### 3.8 Renderer 稳定性（渲染回归基线）

- 空 section 使用稳定占位符。
- 当前状态和长期记忆分区清晰。
- requestNow 已越过 scene TTL、但 cleanup 尚未持久化时，effective view 把它渲染在 `[已过期场景 / 上次已知场景]`，当前状态为空；同时只幂等唤醒 housekeeping。
- requestNow 已越过 todo dueAt、但 cleanup 尚未持久化时，effective view 只在 overdue 组渲染该 item。overdue 组按 becameOverdueAt DESC/itemId 稳定排序并同时满足独立条数/字符预算。
- Todo render 包含 actor/requester，存在 dueAt 时包含 deadline；recentEpisodes 不再硬编码只取最近 3 条。
- golden snapshot 锁定完整 rendered text，Renderer 代码变更时 golden test 失败以提示回归。
- render 不包含 patch log、event log、reject reason 或 reducer 内部细节。

### 3.9 Context 接入

- 候选历史 raw content 的 Unicode code point 总数不超过集中配置阈值时 `needsMemory=false`，recent window 保留全部消息且不注入 `memory`；不得叠加 message count、tokenizer 或 context 百分比门控。
- `needsMemory=true` 且 `memory_state` 存在、schema 校验通过时，注入单一 `memory` segment，并由 Renderer 实时生成文本。
- `needsMemory=true` 但 `memory_state` 不存在、`version` 不支持或 schema 校验失败时，`memory` segment 不注入，debug payload 记录明确原因，不得静默跳过。
- recent window 可跨 session 且保留 user-boundary 裁剪；Memory Observer fixture 必须证明 Assistant 开头的 source 未被同一规则裁掉，且不注入 session boundary 控制标记。
- 对每个 target 构造 `coveredUntilMessageId < messageId < recentWindowStartMessageId` 的 gap；预算内完整 raw 注入，重复消息去重但保留 target keys。超预算只保留最近 N 条完整消息并恢复升序，单条超预算计入 omitted，不得截断或调用 LLM 压缩。
- GapBridge omitted 必须产生 active 的持久化诊断记录并触发 degraded/“可能滞后”标记；cursor 覆盖 omitted 上界后才能 resolved。GapBridge 不推进 cursor、不写 patch/event，也不改变 section 容量。
- RAG context 与 `memory` segment 并列存在，不互相覆盖。

### 3.10 迁移与恢复

- 旧 `rolling_summary` / `core_memory` 文本不会直接转换为 v2 权威状态。
- 首次初始化 generation 0 state 时写 revision 0 完整 snapshot；revision 跨 generation 单调递增，每个成功 revision N 恰好一份带 generation 的同号完整 post-state snapshot，不额外写 pre-state snapshot。
- 一个 task bundle 含多个 accepted patch 时只增加一次 revision、写一个 event group 和一份 snapshot；add event 的 `result_item_id` 非 null，accepted event 含完整 normalized operation。
- cursor-only revision（noop、普通 rejected、二次 unable 后推进）也写完整 snapshot；纯 error/retry/halt/deferred 且 state/cursor 未变化时不增加 revision、不写 snapshot。
- 二次 unable 的 cursor-only event group 可以没有 semantic event，原因只记 ops log；不得伪造 noop/accepted。noop 与普通 rejected 仍保留各自 proposal-decision event。
- deferred 的 `result_revision` 为 null；其 event group/events、原 task stage、派生 maintenance task 和 target status 必须同事务提交，不能只留下 deferred event 而没有可恢复 task。
- 注入事务故障点覆盖 state、event group/events、snapshot、cursor、task 终态、target status 的每个写入位置；任一点失败都整体 rollback，不得出现半提交。
- system cleanup 修改持久化 state 时必须写 `decision=system_cleanup`、具体 cleanup_type 和完整 normalized operation；覆盖 `scene_expired`、`expired_scene_evicted`、`todo_became_overdue`、`recent_episode_evicted` 四类。Proposal post-state 触发的 cleanup 与 proposal decisions 同 group/revision；独立后台 housekeeping 才断言 `group_kind=system_cleanup`。
- 从当前 generation 最新合法 snapshot replay 后续 event groups 可恢复相同 state/cursors；replay 不调用 LLM，并拒绝 generation/revision 断层、cursor 不连续、schema 不兼容或 task/target 不一致的 event group。
- snapshot/state 损坏时优先恢复当前 generation 最新合法 snapshot；必要时从 raw messages rebuild。
- 进程重启会从数据库读取 queued/running/retry_wait task 并从持久化 stage 继续；进程内队列、计数器或 flag 丢失不影响恢复。
- stale generation/revision/cursor 执行结果写 `stale_result` ops log 并丢弃，不得覆盖新 state；replay 必须先匹配 generation，再检查 target cursor、proposal 活动性、引用 item 与 schema/source hashes；同 generation 的其他 target revision 增长不单独构成 stale。
- 语义恢复只依赖 snapshot/events；运行状态恢复只依赖 durable task/per-target status/ops log，不能互相推定。
- 旧 `meta.recovery/halted` 不做 in-place 迁移，新 target status 从 healthy/0 初始化。
- 普通 append 不增加 `sourceGeneration`；编辑历史、regenerate 截断、删除、session trash/restore/permanent delete、preset/可见性变化和排序语义变化各自覆盖 generation `+1` 路径。
- source mutation、generation `+1`、captured boundary、旧 generation 全部非终态 Memory task 取消、新 generation 空 state、下一个全局 revision snapshot 和六个 target `rebuilding` 必须同事务；逐写入点故障均整体 rollback，revision 不得因 rebuild 重置为 0。Generation 初始化不伪造 section event group，恢复从该 snapshot 开始。
- generation 变化后，旧 normal/maintenance/compaction/replay 结果一律 stale 且不能提交；同 generation 内其他 target 导致的 revision 增长仍不单独使 replay stale。
- rebuild 从当前有效 raw messages 重放，`forceDrainTo(capturedBoundaryMessageId)` 忽略 lagThreshold 并只使用既有 durable normal tasks；六个 cursor 与 state/snapshot/events 校验完成前保持 rebuilding，未追平不得宣告 healthy。
- rebuild 期间再次改变 source 时，旧 rebuild 结果不得推进新 generation 的 state、cursor 或 status；worker 转而处理最新 generation/boundary。
- RAG 与 Recall checkpoint 独立断言 `processedGeneration + processedBoundaryMessageId`；Memory targets 追平不代表 projection 追平。generation 提交前重校失败时 projection 结果 stale，实际参与 context compile 的未追平 projection 持续触发告警。
- 一次性迁移 smoke 按“停服 → 更新 → 删除旧 Memory → raw rebuild/force drain → 校验 → 启服”执行；校验失败断言聊天服务保持关闭，且不存在 Flush task/type/table。

## 4. 端到端 smoke

端到端 smoke 只覆盖少量代表性路径：

- 新增 todo -> 完成 todo -> render 不再显示未完成待办。
- 新增带 actor/requester/dueAt 的短期待办 -> evidence message createdAt 锚定期限 -> wall-clock 到期后原位 overdue -> 仍可完成/取消。
- scene 到期但 housekeeping 尚未提交 -> effective view 不再称其为当前场景 -> cleanup 持久化为 previousScene；下一 scene 到期时单值替换并审计 evicted。
- recentEpisodes 超窗口 -> 最旧 item 确定性滚出并写 cleanup event，不触发 compaction。
- 新增 standing agreement -> 修订 agreement -> 取消 agreement -> render 不再显示已取消约定。
- 明确长期事实 -> 对应长期 section 新增；临时情绪 -> 不进入长期 sections。
- 行为推断的长期特征 -> profile/relationship 新增（`long_term_fact`）；一次性动作不写入，worldFacts 不使用行为 trait 推断。
- assistant 修正已有长期 item -> `updateItem + assistant_correction` 接受（四个长期 sections 均可）。
- `userProfile` 达到上限 -> 新增被 deferred -> compaction 在同一 section 合并重复项 -> replay 原 proposal 成功，cursor 推进。
- compaction 无安全合并项 -> 返回 unable_to_compact -> `compaction_failed`，halt 对应 target；resume 指定 target 后复用原 maintenance task 重新尝试，成功 replay 后恢复 healthy。
- `todos` 达到上限 -> deferred -> compaction 合并重复待办 -> replay 原 proposal 成功，cursor 推进。
- `standingAgreements` 达到上限 -> deferred -> compaction 合并重叠约定 -> replay 原 proposal 成功，cursor 推进。
- Provider Adapter 返回 `safety_policy_blocked` -> 落 ops log，cursor 不推进；连续达阈值后只 halt 对应 target，其他 targets/主聊天继续；resume 指定 target 后从 durable task/cursor 位置继续。

## 5. 建议落点

首版建议新增 `scripts/memory-v2-verify/run-all.js` 作为统一入口，内部按 fixture 目录分组执行。测试数据建议放在 `scripts/memory-v2-verify/fixtures/`，不要混进 service 目录。

Harness 通过后，v2 才能接入真实主链路。否则 memory v2 只是换了形状的不可控摘要器。
