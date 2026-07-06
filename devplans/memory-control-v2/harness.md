# Memory Control v2 Harness 验收契约

本文定义 Memory Control v2 的最小可验收测试边界。Harness 的目标不是证明 LLM 永远正确，而是证明 LLM 即使输出不稳定、局部错误或被 provider 拦截，最终 memory state 仍然可控、可审计、可恢复。

顶层设计见 [../plan.md](../plan.md)。状态契约见 [state-contract.md](state-contract.md)，写入协议见 [write-protocol.md](write-protocol.md)，渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. Harness 原则

- **Reducer 优先**：大多数 golden case 应直接测试 Reducer，不依赖真实 LLM。
- **Fixture 可读**：每个 case 明确给出 initial state、input envelope、proposer output、expected events、expected state 和 expected cursor。
- **拒绝路径一等公民**：`rejected` / `error` 的测试数量不能少于 happy path。
- **维护路径可回放**：`deferred` / compaction / 最终预算拒绝必须能从 fixture 中复现。
- **渲染稳定性可比较**：同一 `memory_state` 在同一版 Renderer 下应产生完全相同的 rendered text。
- **真实 LLM 只做 smoke**：少量端到端 smoke 用真实 provider；可靠性判断主要靠结构化 fixture。

## 2. Fixture 形态

建议每个 fixture 使用一个 JSON 文件表达：

```json
{
  "name": "todo-add-with-valid-evidence",
  "initialState": {
    "version": 2,
    "current": {
      "scene": { "location": null, "time": null, "mood": null, "note": null, "lastEvidence": null, "updatedAtMessageId": null },
      "participants": {
        "user": { "emotion": null, "action": null, "intent": null, "lastEvidence": null, "updatedAtMessageId": null },
        "assistant": { "emotion": null, "action": null, "intent": null, "lastEvidence": null, "updatedAtMessageId": null }
      }
    },
    "working": { "todos": [], "recentEpisodes": [] },
    "longTerm": { "milestones": [], "worldFacts": [], "userProfile": [], "assistantProfile": [], "relationship": [] },
    "meta": { "perSectionCursor": { "todos": 120 }, "recovery": {} }
  },
  "inputEnvelope": {
    "task": {
      "tickId": 12345,
      "userId": 1,
      "presetId": "default",
      "schemaVersion": 2,
      "targetMessageId": 121,
      "proposer": "todoProposer",
      "mode": "normal",
      "targetSections": ["todos"],
      "targetPaths": [],
      "observedMessageIds": [121],
      "trigger": { "type": "lagThreshold" }
    },
    "writableState": { "working": { "todos": [] } },
    "readOnlyContext": {
      "current": {
        "scene": { "location": null, "time": null, "mood": null, "note": null, "lastEvidence": null, "updatedAtMessageId": null },
        "participants": {
          "user": { "emotion": null, "action": null, "intent": null, "lastEvidence": null, "updatedAtMessageId": null },
          "assistant": { "emotion": null, "action": null, "intent": null, "lastEvidence": null, "updatedAtMessageId": null }
        }
      },
      "working": { "recentEpisodes": [] },
      "longTerm": { "relationship": [], "userProfile": [] }
    },
    "evidenceMessages": [
      { "id": 121, "role": "user", "contentKind": "raw", "content": "明天提醒我把橡皮还给她" }
    ]
  },
  "proposerOutputs": [
    {
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
  ],
  "expected": {
    "events": [{ "decision": "accepted", "op": "addItem", "evidence_kind": "user_request" }],
    "statePatch": { "working": { "todos": [{ "text": "归还橡皮", "evidenceKind": "user_request" }] } },
    "cursor": { "todos": 121 },
    "renderContains": ["归还橡皮"]
  }
}
```

Fixture 不应保存长篇聊天全文。证据 quote 保持短片段，长对话可用最小复现场景。

## 3. 必测用例组

### 3.1 Schema 与 patch op

- 合法 `setField` / `addItem` / `updateItem` / `mergeItems` / `completeTodo` / `cancelTodo` 被接受。
- 缺少该 op 按 [state-contract.md](state-contract.md) §4 应必填的字段时拒绝。
- 非法 section + op 组合拒绝。
- core patch 缺少子数组 `path` 时拒绝。

### 3.2 Evidence 与 quote

- messageId 不存在时 `rejected: message_id_not_found`。
- quote 精确命中时接受。
- quote 轻微改写但超过相似度阈值时接受。
- quote 与消息不匹配时 `rejected: quote_not_found`。
- provider/LLM 输出伪造 messageId 时不推进错误写入。
- 普通写入 patch 引用 `readOnlyContext` 中 item 的历史 messageId，但该 messageId 不在 `evidenceMessages` 中时拒绝。
- read-only context 可以影响 noop/patch 判断，但不能单独支撑新增事实。

### 3.3 Proposer 输入 envelope

- 普通模式必须使用 `task.trigger.type = "lagThreshold"`；维护模式必须使用 `task.trigger.type = "lengthBudget"`，并带 `limit` 与 `blockedPatchSummary`。
- 同一 Proposer、同一 target、同一 `memory_state` 下，即使 observed messages 内容不同，`readOnlyContext` 的 section/path 形状也必须一致；只允许 `task.observedMessageIds` 和 `evidenceMessages` 随消息窗口变化。
- 固定范围内的 section/path 必须完整输入当前 items；不得做 last N、相似度筛选、关键词筛选或数量截断。
- `working.todos` 全集即 active 子集（完成/取消/过期的 todo 已从数组移除，见 [state-contract.md](state-contract.md) §4）；fixture 应覆盖 active item 出现、已终止 item 不再出现在数组中的行为。
- target section/path 的当前状态只出现在 `writableState`；`readOnlyContext` 不重复提供 target 作为只读证据来源。

### 3.4 Policy table

- `scene.setField + scene_change` 接受。
- `participants.setField + participant_change` 接受。
- `todos.addItem + user_request/user_commitment/assistant_commitment` 接受。
- `milestones.addItem + recent_episode` 拒绝。
- `milestones.addItem + relationship_milestone` 接受，并写入 `longTerm.milestones`。
- `core.addItem + participant_change` 拒绝。
- `core.updateItem + long_term_fact` 拒绝，除非是 `user_correction`。

### 3.5 Cursor 推进

- `accepted`/`noop`/`rejected` 推进对应 section cursor，均落 `chat_memory_events`（[state-contract.md](state-contract.md) §9.1）。
- `noop` 必产生一行 `decision=noop` 占位 event。
- `deferred` 阻止 cursor 推进：同 section 有任一 `deferred` 行则不推进，无论是否存在 `accepted` 行；无 `deferred` 时有任一 `accepted`/`noop`/`rejected` 即推进。
- 混合 `accepted`+`deferred`：同 section 同 tick 既有 `accepted` 又有 `deferred` 时不推进 cursor；compaction 成功后重跑同一窗口，Proposer 对已 `accepted` 内容输出 `noop`，对原 `deferred` patch 重新输出。
- `error`/`unable_to_decide` 落 `chat_memory_ops_log`（[state-contract.md](state-contract.md) §9.2），不落 events。
- `unable_to_decide` 首次后 `meta.recovery.awaitingContextExpansion` 置 true，下一 tick 发扩大 contextWindow；二次仍 `unable_to_decide` 推进 cursor（不是 error，不触发 halt）。
- `error` 连续 3 次后触发 halt（`meta.halted=true`），该 `userId/presetId` 的聊天接口拒绝新消息；`consecutiveErrors` 保留不清零，等手动 resume 时重置。
- 长度预算首次阻塞时记录 `deferred`，触发 compaction task，且不推进 cursor；一个 section `deferred` 不阻塞同 tick 其它 section。
- compaction 成功释放容量后，原 section 重新处理同一消息窗口。
- compaction 无合并空间（`noop`/`unable_to_decide`）后，原 patch 最终 `rejected: length_budget_exceeded` 并推进 cursor；compaction 技术性失败按 error 恢复策略（[write-protocol.md](write-protocol.md) §3.1）处理。
- 非 target section 不出现在 output 时不推进 cursor。

### 3.6 Reducer 状态安全

- 同一 itemId 的合法局部更新只改目标字段。
- 指向不存在 itemId 的操作拒绝。
- `recentEpisodes` 超出长度预算时确定性滚出最旧 item。
- 其他 section 超出长度预算时先 `deferred` 并创建 compaction task。
- `compactionProposer` 只能输出 `mergeItems`；输出 `addItem`、跨 section/path 合并、通用删除时拒绝。
- `memory_compaction` 的 evidenceRefs 必须是维护模式 `writableState` 所有 source items 既有 evidenceRefs 的完整并集，缺少任一 source item 的证据即拒绝。
- `memory_compaction` 引用 `task.trigger.blockedPatchSummary`、`evidenceMessages` 中的新摘录或 readOnlyContext 的证据时拒绝。
- Proposer 输出非 target section/path 时拒绝，且非 target cursor 不推进。
- `expiresAtTime` 过期 todo 被确定性清理。

### 3.7 Provider Adapter 与 halt

- mock adapter 返回 `status: "ok"` → output 交 Reducer，patch 决策落 events。
- mock adapter 返回 `status: "ok"` 但 section 为 `unable_to_decide` → tick orchestrator 截获，落 ops_log，不交 Reducer。
- mock adapter 返回 `status: "error", reason: "safety_policy_blocked"` → 不交 Reducer，落 ops_log（outcome=`safety_policy_blocked`），cursor 不推进；连续达 3 次后触发 halt。
- mock adapter 返回 `status: "error", reason: "output_schema_invalid"` → 不重试同输入，直接触发 halt（持续性错误，重试同输入大概率仍非法）。
- mock adapter 返回 `status: "error", reason: "llm_call_failed"` → 递增 `consecutiveErrors`，下一 tick 自然重试；达 3 次后触发 halt。
- `unable_to_decide` 首次 → `awaitingContextExpansion=true`、cursor 不推进；下一 tick contextWindow 扩大；二次仍 `unable_to_decide` → 推进 cursor（不是 error，不触发 halt）。
- halt 后 `meta.halted=true`，该 `userId/presetId` 的聊天接口拒绝新消息；resume CLI/API 重置 `halted=false` 和所有 `consecutiveErrors` 后入队正常 tick。
- `accepted`/`rejected`/`noop`/`deferred` 均重置 `consecutiveErrors` 与 `awaitingContextExpansion`。
- Reducer 永远只收到 `status: "ok"` 且 section 为 `patches`/`noop` 的 output，不处理空输出或伪造输出。

### 3.8 Renderer 稳定性

- 空 section 使用稳定占位符。
- 当前状态和长期记忆分区清晰。
- 旧场景不会被渲染为当前状态。
- 同一 `memory_state` 与同一版 Renderer 的输出完全一致。
- render 不包含 patch log、event log、reject reason 或 reducer 内部细节。

### 3.9 Context 接入

- `memory_state` 存在且 schema 校验通过时，注入单一 `memory` segment，并由 Renderer 实时生成文本。
- `memory_state` 不存在、`version` 不支持或 schema 校验失败时，`memory` segment 不注入。
- RAG context 与 `memory` segment 并列存在，不互相覆盖。
- debug payload 能看出 `memory` segment 是否注入、跳过原因是什么，方便排查。

### 3.10 迁移与恢复

- 旧 `rolling_summary` / `core_memory` 文本不会直接转换为 v2 权威状态。
- 从原始消息回放可重建 state。
- events 与 ops_log 足以定位 accepted/rejected/deferred/noop/error/unable_to_decide 各决策。
- 单个 tick 失败时保留上一版稳定 `memory_state`。
- 连续错误触发 halt 后，手动 resume 从 cursor 位置继续处理，不跳过任何消息。

## 4. 端到端 smoke

端到端 smoke 只覆盖少量代表性路径：

- 新增 todo -> 完成 todo -> render 不再显示未完成待办。
- 场景变化 -> participants 变化 -> render 当前状态更新，旧状态不残留。
- 明确长期事实 -> core 新增；临时情绪 -> core 不新增。
- 行为推断的长期特征 -> core 新增（`long_term_fact`）；一次性动作不写入。
- assistant 修正已有 core item -> `updateItem + assistant_correction` 接受（所有 core 子数组均可）。
- core/userProfile 达到上限 -> 新增被 deferred -> compaction 合并重复项 -> 下一 tick 可写入新 item。
- compaction 无安全合并项 -> 最终 length_budget_exceeded，不推进坏写入。
- Provider Adapter 返回 `safety_policy_blocked` -> 落 ops_log，cursor 不推进；连续达阈值后触发 halt，该 `userId/presetId` 的聊天接口拒绝新消息；resume 后从 cursor 位置继续。

## 5. 建议落点

首版建议新增 `scripts/memory-v2-verify/run-all.js` 作为统一入口，内部按 fixture 目录分组执行。测试数据建议放在 `scripts/memory-v2-verify/fixtures/`，不要混进 service 目录。

Harness 通过后，v2 才能接入真实主链路。否则 memory v2 只是换了形状的不可控摘要器。
