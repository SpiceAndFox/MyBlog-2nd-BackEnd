# Memory Control v2 Harness 验收契约

本文定义 Memory Control v2 的最小可验收测试边界。Harness 的目标不是证明 LLM 永远正确，而是证明 LLM 即使输出不稳定、局部错误或被 provider 拦截，最终 memory state 仍然可控、可审计、可恢复。

顶层设计见 [../plan.md](../plan.md)。状态契约见 [state-contract.md](state-contract.md)，写入协议见 [write-protocol.md](write-protocol.md)，渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. Harness 原则

- **Reducer 优先**：大多数 golden case 应直接测试 Reducer，不依赖真实 LLM。
- **Fixture 可读**：每个 case 明确给出 initial state、observed messages、proposer output、expected events、expected state 和 expected cursor。
- **拒绝路径一等公民**：`rejected` / `error` 的测试数量不能少于 happy path。
- **渲染稳定性可比较**：未变化 section 的 rendered fragment 应保持不变，避免文案漂移。
- **真实 LLM 只做 smoke**：少量端到端 smoke 用真实 provider；可靠性判断主要靠结构化 fixture。

## 2. Fixture 形态

建议每个 fixture 使用一个 JSON 文件表达：

```json
{
  "name": "todo-complete-with-valid-evidence",
  "initialState": {},
  "messages": [
    { "id": 121, "role": "user", "contentKind": "raw", "content": "明天提醒我把橡皮还给她" }
  ],
  "eligibleSections": ["todos"],
  "proposerOutput": {},
  "expected": {
    "events": [],
    "statePatch": {},
    "cursor": { "todos": 121 },
    "renderContains": []
  }
}
```

Fixture 不应保存长篇聊天全文。证据 quote 保持短片段，长对话可用最小复现场景。

## 3. 必测用例组

### 3.1 Schema 与 patch op

- 合法 `setField` / `addItem` / `updateItem` / `mergeItems` / `completeTodo` / `cancelTodo` / `correctItem` 被接受。
- 缺少必填 `path`、`itemId`、`itemIds`、`value`、`evidenceRefs` 时拒绝。
- 非法 section + op 组合拒绝。
- core patch 缺少子数组 `path` 时拒绝。

### 3.2 Evidence 与 quote

- messageId 不存在时 `rejected: message_id_not_found`。
- quote 精确命中时接受。
- quote 轻微改写但超过相似度阈值时接受。
- quote 与消息不匹配时 `rejected: quote_not_found`。
- provider/LLM 输出伪造 messageId 时不推进错误写入。

### 3.3 Policy table

- `scene.setField + scene_change` 接受。
- `participants.setField + participant_state` 接受。
- `todos.addItem + user_request/user_commitment/assistant_commitment` 接受。
- `milestones.addItem + recent_episode` 拒绝。
- `core.addItem + participant_state` 拒绝。
- `core.updateItem + long_term_fact` 拒绝，除非是 `user_correction`。

### 3.4 Cursor 推进

- `accepted` 推进对应 section cursor。
- `noop` 推进对应 section cursor。
- 全部 patch 被 policy/duplicate 拒绝时推进 cursor，并记录 rejected events。
- schema/provider/error 在 bounded retry 后按失败策略处理，不能无限卡住 section。
- 非 eligible section 不出现在 output 时不推进 cursor。

### 3.5 Reducer 状态安全

- 同一 itemId 的合法局部更新只改目标字段。
- 指向不存在 itemId 的操作拒绝。
- duplicate core item 拒绝。
- `recentEpisodes` 超出长度预算时确定性滚出最旧 item。
- 其他 section 超出长度预算时拒绝新增。
- `expiresAtMessageId` 过期 todo 被确定性清理。

### 3.6 Renderer 稳定性

- 空 section 使用稳定占位符。
- 当前状态和长期记忆分区清晰。
- 旧场景不会被渲染为当前状态。
- 未变化 section 复用上次 rendered fragment。
- render 不包含 patch log、event log、reject reason 或 reducer 内部细节。

### 3.7 Context 接入

- v2 feature flag 开启且 `state_v2_render` 存在时，只注入 `memoryV2` segment。
- v2 注入时旧 `rollingSummary` / `coreMemory` segment 禁用。
- RAG context 与 memoryV2 并列存在，不互相覆盖。
- debug payload 能看出 memoryV2 是否注入，方便排查。

### 3.8 迁移与恢复

- 旧 `rolling_summary` / `core_memory` 文本不会直接转换为 v2 权威状态。
- 从原始消息回放可重建 state。
- patch event 与 state snapshot 足以定位 accepted/rejected/error 决策。
- 单个 tick 失败时保留上一版稳定 render。

## 4. 端到端 smoke

端到端 smoke 只覆盖少量代表性路径：

- 新增 todo -> 完成 todo -> render 不再显示未完成待办。
- 场景变化 -> participants 变化 -> render 当前状态更新，旧状态不残留。
- 明确长期事实 -> core 新增；临时情绪 -> core 不新增。
- Proposer 返回 malformed structured output -> 记录 error，主聊天仍使用旧 render。

## 5. 建议落点

首版建议新增 `scripts/memory-v2-verify/run-all.js` 作为统一入口，内部按 fixture 目录分组执行。测试数据建议放在 `scripts/memory-v2-verify/fixtures/`，不要混进 service 目录。

Harness 通过后，才能把 v2 feature flag 打开到真实主链路。否则 memory v2 只是换了形状的不可控摘要器。