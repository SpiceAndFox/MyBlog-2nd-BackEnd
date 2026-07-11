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
      }
    },
    "working": { "todos": [], "standingAgreements": [], "recentEpisodes": [] },
    "longTerm": { "milestones": [], "worldFacts": [], "userProfile": [], "assistantProfile": [], "relationship": [] },
    "meta": { "halted": false, "targetCursors": { "todos": 120 }, "recovery": {} }
  },
  "ticks": [
    {
      "description": "User asks to be reminded about returning an eraser",
      "input": {
        "task": {
          "tickId": 12345,
          "userId": 1,
          "presetId": "default",
          "schemaVersion": 2,
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
          { "id": 121, "role": "user", "contentKind": "raw", "content": "明天提醒我把橡皮还给她" }
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
                  "value": { "text": "归还橡皮" },
                  "evidenceKind": "user_request",
                  "evidenceRefs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }]
                }
              ]
            }
          }
        }
      },
      "expected": {
        "events": [
          { "decision": "accepted", "op": "addItem", "evidence_kind": "user_request" }
        ],
        "statePatch": {
          "working": {
            "todos": [
              {
                "id": { "_match": "string", "prefix": "todo:" },
                "text": "归还橡皮",
                "createdAtMessageId": 121,
                "updatedAtMessageId": 121,
                "expiresAtTime": null,
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
        "opsLog": [],
        "meta": { "halted": false, "recovery": {} },
        "renderEquals": null,
        "renderContains": ["归还橡皮"]
      }
    }
  ]
}
```

Fixture 不应保存长篇聊天全文。证据 quote 保持短片段，长对话可用最小复现场景。

### Fixture 断言匹配规则

- **statePatch 深合并**：patch 值与 `initialState` 深合并，只覆盖 fixture 中列出的字段。Reducer 生成的字段（`id`）用 matcher 表达。确定性字段（`expiresAtTime`、`createdAtMessageId`、`updatedAtMessageId`）必须显式列出。
- **events 子集字段匹配**：只检查 fixture 中列出的字段，忽略自增列（`id`、`user_id`、`preset_id`、`tick_id`、`created_at`）。行数必须精确匹配。按插入顺序逐行匹配。`rejected` 行必须包含 `reject_reason`。支持 `maintenance_task_id` 字段断言，可用 `{ "_match": "notNull" }` 匹配任意非 null 值。
- **opsLog**：按插入顺序精确匹配 fixture 中列出的字段。
- **cursor**：精确匹配各 target 的 `coveredUntilMessageId`。
- **meta**：深合并比较。
- **renderEquals**：完整 rendered text 的 golden snapshot 路径，为 `null` 时跳过。Renderer 代码变更时 golden test 失败以提示回归。
- **renderContains**：宽松子串检查，用于 smoke test。
- **Matcher 语法**：`{ "_match": "string", "prefix": "todo:" }` 匹配以 `"todo:"` 开头的字符串；`{ "_match": "notNull" }` 匹配任意非 null 值。

## 3. 必测用例组

### 3.1 Schema 与 patch op

- 合法 `setField` / `clearField` / `addItem` / `updateItem` / `mergeItems` / `completeTodo` / `cancelTodo` / `expireTodo` / `cancelAgreement` 被接受。
- 缺少该 op 按 [state-contract.md](state-contract.md) §4 应必填的字段时拒绝。
- 非法 section + op 组合拒绝。
- item section patch 使用 `sectionResults` key 直接寻址；携带多余 `path` 时 schema 拒绝。只有 scene 字段操作允许 `path`。
- `todos` 的 `addItem`/`updateItem` 的 `value.expiresAt` 符合 `oneOf`（absolute/relative）时接受；结构非法时拒绝。

### 3.2 Evidence 与 quote

- messageId 不存在时 `rejected: message_id_not_found`。
- quote 精确命中时接受。
- quote 轻微改写但超过相似度阈值时接受。
- quote 与消息不匹配时 `rejected: quote_not_found`。
- provider/LLM 输出伪造 messageId 时不推进错误写入。
- 普通写入 patch 引用 `readOnlyContext` 中 item 的历史 messageId，但该 messageId 不在 `observedMessages` 中时拒绝。
- 普通写入 patch accepted 后，Reducer 将该 patch 的 `evidenceRefs` 连同 `patch.evidenceKind` 包装为一个 `evidenceGroup`（携带 `evidenceKind` + `refs`）。
- 普通写入 patch 带多个 `evidenceRefs` 时，`updatedAtMessageId` 取该 group 内最大的 `messageId`。
- read-only context 可以影响 noop/patch 判断，但不能单独支撑新增事实。

### 3.3 Proposer 输入 envelope

- 普通模式必须使用 `task.trigger.type = "lagThreshold"`；维护模式必须使用 `task.trigger.type = "lengthBudget"`，并带 `limit`。
- normal task 必须携带合法 `task.targetKey` 和唯一 `cursorBefore`；`cursorBefore` 等于任务创建时 `meta.targetCursors[targetKey]`，且该 task 只有一个 new batch 和一个 `targetMessageId`。
- 同一 Proposer、同一 target、同一 `memory_state` 下，即使 observed messages 内容不同，`readOnlyContext` 的 section 形状也必须一致；只允许 `task.observedMessageIds` 和 `observedMessages` 随消息窗口变化。
- 固定范围内的 section 必须完整输入当前 items；不得做 last N、相似度筛选、关键词筛选或数量截断。
- `observedMessages` 按 `coveredUntilMessageId` 之后的分页规则组装：从 `coveredUntilMessageId` 后取最早未处理 batch，再补充 `coveredUntilMessageId` 及之前的 overlap；不得取全局最新 M 条跳过 backlog。
- `task.targetMessageId` 必须等于本轮 new batch 的最大 messageId，不取 overlap 的 messageId。
- `working.todos` 全集即 active 子集（完成/取消/过期的 todo 已从数组移除，见 [state-contract.md](state-contract.md) §4）；fixture 应覆盖 active item 出现、已终止 item 不再出现在数组中的行为。
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

### 3.5 Cursor 推进

- 可推进终局中的 `accepted`/`noop`/普通 `rejected` 推进对应 target cursor，均落 `chat_memory_events`（[state-contract.md](state-contract.md) §9.1）；具体聚合阻塞条件见下列用例。
- `noop` 必产生一行 `decision=noop` 占位 event。
- `deferred` 阻止 cursor 推进：同 target 有任一 `deferred` 行则不推进，无论是否存在 `accepted` 行；无 `deferred` 时有任一 `accepted`/`noop`/`rejected` 即推进。
- 混合 `accepted`+`deferred`：同 target 同 tick 既有 `accepted` 又有 `deferred` 时不推进 cursor；compaction 成功后重跑同一窗口，Proposer 对已 `accepted` 内容输出 `noop`，对原 `deferred` patch 重新输出。
- `error`/`unable_to_decide` 由 tick orchestrator 截获，落 `chat_memory_ops_log`（[state-contract.md](state-contract.md) §9.2），不落 events，不交 Reducer。
- `unable_to_decide` 首次后 `meta.recovery.awaitingContextExpansion` 置 true，下一 tick 发扩大 contextWindow；二次仍 `unable_to_decide` 推进 cursor（不是 error，不触发 halt）。
- `error` 连续 3 次后触发 halt（`meta.halted=true`），该 `userId/presetId` 的聊天接口拒绝新消息；`consecutiveErrors` 保留不清零，等手动 resume 时重置。
- 长度预算首次阻塞时记录 `deferred`，触发 compaction task，且不推进 cursor；一个 target `deferred` 不阻塞同 tick 其它 target。
- compaction 成功释放容量后，原 section 重新处理同一消息窗口。
- compaction 返回 `unable_to_compact` → tick orchestrator 截获，触发 halt，不交 Reducer，cursor 不推进；compaction 技术性失败按 error 恢复策略（[write-protocol.md](write-protocol.md) §3.1）处理。
- compaction 成功执行 mergeItems 但合并后仍超限 → Reducer 记录 `rejected: length_budget_exceeded` → tick orchestrator halt，cursor 不推进。
- `length_budget_exceeded` 是唯一触发 halt 的 reject reason，其他 reject reason 仍推进 cursor。
- 缺少 target section 或包含非 target section 属于 `output_schema_invalid`，本 task 的 target cursor 不推进；其它 target 不受影响。
- `episodeProposer` 的 `recentEpisodes` 与 `milestones` 共享 `episodes` cursor：一个 section accepted/noop、另一个 `unable_to_decide` 时整个 target 不推进；两者都形成可推进终局后只推进一次。
- `profileRelationshipProposer` 的 `userProfile`、`assistantProfile`、`relationship` 三个正式 section 共享 `profileRelationship` cursor；`worldFactProposer` 只推进独立的 `worldFacts` cursor。event 的 `section` 记录实际正式 section，`target_key` 记录共享 cursor 归属。
- compaction task 的 `targetKey` 仅关联来源 normal target；它不携带 `cursorBefore`，不读取或推进 raw-message cursor，也不拥有独立 `targetCursors` key。它完成后仍由被阻塞的原 normal target 决定 cursor。

### 3.6 Reducer 状态安全

- 同一 itemId 的合法局部更新只改目标字段。
- 指向不存在 itemId 的操作拒绝。
- `recentEpisodes` 超出长度预算时确定性滚出最旧 item。
- 其他 section 超出长度预算时先 `deferred` 并创建 compaction task。compaction 返回 `unable_to_compact` → halt；compaction 合并后仍超限 → `rejected: length_budget_exceeded` → halt。
- `compactionProposer` 的 section `status` 为 `patches` 或 `unable_to_compact`；`status` 为 `patches` 时 patch 的 `op` 只能是 `mergeItems`，输出 `addItem`、跨 section 合并、通用删除时拒绝。
- `agreementProposer` 输出 `completeTodo`/`cancelTodo`/`expireTodo` 时拒绝。
- `memory_compaction` 输出 `evidenceRefs` 时拒绝。
- `memory_compaction` accepted 后，Reducer 将 source items 既有 `evidenceGroups` 完整继承到 merged item，并保留 group 边界。
- `memory_compaction` accepted 后，merged item 的 `updatedAtMessageId` 取所有 source evidenceGroups refs 的最大 `messageId`。
- `memory_compaction` 的 `value.text` 不得引入 source items 未表达的新事实——此约束由 compactionProposer prompt 承担（[proposer-prompt.md](proposer-prompt.md) §2.4/§4.7），Reducer 不做语义检测，仅 LLM smoke 覆盖。
- Proposer 输出非 target section 时记 `output_schema_invalid` 并触发 halt；item patch 携带 `path` 时 schema 拒绝，只按本 task 的 `targetKey` 决定 cursor，其它 target cursor 不受影响。
- `expiresAtTime` 到期的 active todo 保持同一 itemId/evidenceGroups，原位变为 `status=overdue`、写 `becameOverdueAt`，并产生 `system_cleanup: todo_became_overdue`；不得移入另一数组或静默删除。
- overdue todo 仍可由 `completeTodo`/`cancelTodo` 终止；active 容量只统计 active items，overdue items 不触发 compaction、不得 merge。
- scene 到期后完整旧值写入 `current.previousScene` 并清空 current scene；替换已有 previousScene 时写 `expired_scene_evicted`，且 previousScene 不拥有 section/cursor。
- `expiresAt: { "mode": "absolute", "date": "2026-07-10" }` → Reducer 计算 `expiresAtTime = 2026-07-11T00:00:00Z`（date + 1天 buffer）并写入 item。
- `expiresAt: { "mode": "relative", "days": 14 }` → Reducer 从 `task.now` 计算 `expiresAtTime = now + 14天 + 1天` 并写入 item。
- `expiresAt: { "mode": "relative", "months": 1 }` → Reducer 用日历库 `addMonths` 计算，正确处理月末边界（如 1/31 + 1月 = 2/28）。
- `expiresAt` 计算出的 `expiresAtTime` 不在未来时 `rejected: invalid_expiry_in_past`。
- `expiresAt` 缺省时 item 无 `expiresAtTime`（null），不触发 overdue 状态更新。
- `expiresAt: { "mode": "relative", "years": 1, "months": 2, "days": 15 }` → Reducer 按 `years → months → days → +1天` 顺序计算 `expiresAtTime`，从 `task.now` 依次加 1 年、2 月、15 天、再 +1 天 buffer。
- `todos`、`standingAgreements`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship` 均需各自的同 section compaction 测试。

### 3.7 Provider Adapter 与 halt

- mock adapter 返回 `status: "ok"` → output 交 Reducer，patch 决策落 events。
- mock adapter 返回 `status: "ok"` 但 `output.proposer !== task.proposer` 或 `output.tickId !== task.tickId` → tick orchestrator 截获，落 ops_log（outcome=`output_schema_invalid`），触发 halt，不交 Reducer，cursor 不推进。
- mock adapter 返回 `status: "ok"` 但 `sectionResults` 缺少 target section、包含非 target section 或目标 section 缺少 `status` → tick orchestrator 截获，落 ops_log（outcome=`output_schema_invalid`），触发 halt，不交 Reducer，cursor 不推进。
- mock adapter 返回 `status: "ok"` 但 section 为 `unable_to_decide` → tick orchestrator 截获，落 ops_log，不交 Reducer。
- mock adapter 返回 `status: "ok"` 但 compactionProposer 的 section 为 `unable_to_compact` → tick orchestrator 截获，落 ops_log（outcome=`unable_to_compact`），触发 halt，不交 Reducer，cursor 不推进。
- mock adapter 返回 `status: "error", reason: "safety_policy_blocked"` → 不交 Reducer，落 ops_log（outcome=`safety_policy_blocked`），cursor 不推进，`consecutiveErrors` 递增；达 3 次时设置 `meta.halted=true`，第 3 行 outcome 仍记 `safety_policy_blocked`。
- mock adapter 返回 `status: "error", reason: "output_schema_invalid"` → 不重试同输入，直接触发 halt（持续性错误，重试同输入大概率仍非法）。
- mock adapter 返回 `status: "error", reason: "llm_call_failed"` → 不交 Reducer，落 ops_log（outcome=`llm_call_failed`），cursor 不推进，`consecutiveErrors` 递增，下一 tick 自然重试；达 3 次时设置 `meta.halted=true`，第 3 行 outcome 仍记 `llm_call_failed`。
- `unable_to_decide` 首次 → `awaitingContextExpansion=true`、cursor 不推进；下一 tick contextWindow 扩大；二次仍 `unable_to_decide` → 推进 cursor（不是 error，不触发 halt）。
- halt 后 `meta.halted=true`，该 `userId/presetId` 的聊天接口拒绝新消息；resume CLI/API 重置 `halted=false`、所有 `consecutiveErrors` 及 compaction 有界执行计数后入队正常 tick。
- `accepted`/`rejected`/`noop`/`deferred` 均重置 `consecutiveErrors` 与 `awaitingContextExpansion`。
- Reducer 永远只收到 `status: "ok"` 且 section 为 `patches`/`noop` 的 output，不处理空输出或伪造输出。

### 3.8 Renderer 稳定性（渲染回归基线）

- 空 section 使用稳定占位符。
- 当前状态和长期记忆分区清晰。
- 旧场景不会被渲染为当前状态。
- golden snapshot 锁定完整 rendered text，Renderer 代码变更时 golden test 失败以提示回归。
- render 不包含 patch log、event log、reject reason 或 reducer 内部细节。

### 3.9 Context 接入

- `memory_state` 存在且 schema 校验通过时，注入单一 `memory` segment，并由 Renderer 实时生成文本。
- `memory_state` 不存在、`version` 不支持或 schema 校验失败时，`memory` segment 不注入。
- 窗口未溢出时 `memory` segment 不注入，不记录跳过原因（正常路径，非异常）。
- 窗口溢出但注入失败（state 不存在 / version 不支持 / schema 校验失败）时，debug payload 记录跳过原因，不得静默跳过。
- RAG context 与 `memory` segment 并列存在，不互相覆盖。

### 3.10 迁移与恢复

- 旧 `rolling_summary` / `core_memory` 文本不会直接转换为 v2 权威状态。
- 从原始消息回放可重建 state。
- events 与 ops_log 足以定位 accepted/rejected/deferred/noop/error/unable_to_decide/unable_to_compact 各决策。
- 单个 tick 失败时保留上一版稳定 `memory_state`。
- 连续错误触发 halt 后，手动 resume 从 cursor 位置继续处理，不跳过任何消息。

## 4. 端到端 smoke

端到端 smoke 只覆盖少量代表性路径：

- 新增 todo -> 完成 todo -> render 不再显示未完成待办。
- 新增带 `expiresAt` 的短期待办 -> Reducer 计算出 `expiresAtTime` -> wall-clock 过期后确定性清理，render 不再显示。
- 场景变化 -> render 当前状态更新，旧场景不残留。
- 新增 standing agreement -> 修订 agreement -> 取消 agreement -> render 不再显示已取消约定。
- 明确长期事实 -> 对应长期 section 新增；临时情绪 -> 不进入长期 sections。
- 行为推断的长期特征 -> profile/relationship 新增（`long_term_fact`）；一次性动作不写入，worldFacts 不使用行为 trait 推断。
- assistant 修正已有长期 item -> `updateItem + assistant_correction` 接受（四个长期 sections 均可）。
- `userProfile` 达到上限 -> 新增被 deferred -> compaction 在同一 section 合并重复项 -> 下一 tick 可写入新 item。
- compaction 无安全合并项 -> 返回 unable_to_compact -> 触发 halt；resume 后重新尝试。
- `todos` 达到上限 -> deferred -> compaction 合并重复待办 -> 下一 tick 可写入新 item。
- `standingAgreements` 达到上限 -> deferred -> compaction 合并重叠约定 -> 下一 tick 可写入新 item。
- Provider Adapter 返回 `safety_policy_blocked` -> 落 ops_log，cursor 不推进；连续达阈值后触发 halt，该 `userId/presetId` 的聊天接口拒绝新消息；resume 后从 cursor 位置继续。

## 5. 建议落点

首版建议新增 `scripts/memory-v2-verify/run-all.js` 作为统一入口，内部按 fixture 目录分组执行。测试数据建议放在 `scripts/memory-v2-verify/fixtures/`，不要混进 service 目录。

Harness 通过后，v2 才能接入真实主链路。否则 memory v2 只是换了形状的不可控摘要器。
