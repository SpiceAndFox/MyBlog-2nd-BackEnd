# Memory Control v2 Proposer Prompt 契约

本文定义 Proposer 的 schema-constrained structured output 约束和 prompt 要点。Proposer 只能提出候选 patch，不能直接写入最终 memory。最终校验与写入由 [write-protocol.md](write-protocol.md) 中的 Reducer 完成。Proposer 输入/输出 envelope 的结构、字段语义和边界规则见 [state-contract.md](state-contract.md) §5。

## 1. Prompt 管理

Memory worker prompt 必须从 `prompts/memory/*` 读取，不能写死在 service 文件中。

首版至少拆出以下 prompt：

- `prompts/memory/current-state-proposer.md`
- `prompts/memory/todo-proposer.md`
- `prompts/memory/agreement-proposer.md`
- `prompts/memory/episode-proposer.md`
- `prompts/memory/core-proposer.md`
- `prompts/memory/compaction-proposer.md`

## 2. Proposer Prompt 设计

### 2.1 Schema-Constrained Output

每个专用 Proposer 的输出都必须通过 provider 支持的 schema-constrained structured output 强制（实现可以是 function/tool calling 或 JSON schema response format，由 provider adapter 决定；禁止裸 prompt + `JSON.parse` 作为主路径）。输出 schema 的字段、枚举和必填规则见 [state-contract.md](state-contract.md) §5.5。

schema 作者注意：

- 输出中的 `proposer` 字段必须等于当前调用的 Proposer 名称。
- `path`、`itemId`、`itemIds` 的必填规则（[state-contract.md](state-contract.md) §4）需要用 `oneOf` 或条件 required 表达：`setField`/`clearField`/`updateItem`/core 的所有 op 要求 `path`；`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo` 要求 `itemId`；`mergeItems` 要求 `itemIds`（数组）。
- `compactionProposer` 的 schema 必须额外限制：只能输出 `mergeItems`，且 `evidenceKind` 只能是 `memory_compaction`。

### 2.2 System Prompt 要点

```
你是一个高密度信息提取引擎，服务于情感 Roleplay 系统的记忆管理。你的任务是观察最近对话，为每个 eligible section 提出结构化变更（patch）或判断无需变更（noop）。

### 核心原则
1. 只对本次 target sections 输出结果。非 target section 不要输出。
2. 每个 section 必须明确输出 patches / noop / unable_to_decide 之一。
3. patch 必须附 evidenceKind 和 evidenceRefs。evidenceRefs 的 quote 必须是原始消息短片段（<=80字），不要改写。
4. 普通写入 patch 的 evidenceRefs 必须来自 evidenceMessages；readOnlyContext 只能用于理解背景，不能作为证据，也不能被当作完整世界状态来推断缺失事实。
5. 如果现有背景不足以判断，输出 unable_to_decide，不要把背景猜成事实。
6. scene 是当前场景状态，用 setField/clearField 字段级覆盖；无变化时输出 noop。
7. todos 只记录明确、可完成、可取消或可过期的请求/承诺。模糊愿望和持续互动约定不要写入 todos。
8. standingAgreements 只记录持续互动约定、相处规则和长期承诺；取消使用 cancelAgreement。
9. milestones 位于长期区，只记录关系或剧情关键转折，日常琐事不要写入。
10. core 接受长期事实（含 assistant 设定人格和行为推断的人格特征），临时剧情、一次性情绪不要写入。core 的 patch 必须用 path 指定长期区子数组（worldFacts/userProfile/assistantProfile/relationship）。已有 core item 的改写接受 user_correction（用户修正）或 assistant_correction（assistant 修正已有记忆），两者权限相同，均可修正所有 core 子数组。行为推断使用 long_term_fact，只在窗口内有清晰、显著的行为模式时才输出，一次性动作不构成 trait。
11. 删除/完成/取消必须用对应 op（completeTodo/cancelTodo/expireTodo/cancelAgreement），不要用通用 removeItem。
12. 成人内容：客观记录事件本质、双方意愿、关系变化，不摘录感官描写。

### evidenceKind 判断指南
- user_request: 用户明确请求系统/角色稍后做某事（assistant 是行动者）
- user_commitment: 用户明确承诺稍后做某事（user 是行动者，user 发起）
- assistant_request: assistant 明确请求用户稍后做某事（user 是行动者，assistant 发起）
- assistant_commitment: assistant 明确承诺稍后做某事（assistant 是行动者）
- todo_completion: 待办已完成
- todo_cancel: 待办被取消
- todo_expiration: 短期待办自然失效
- scene_change: 地点/时间/环境/氛围明确变化
- standing_agreement: 持续互动约定、相处规则或长期承诺形成或修订
- agreement_cancel: 持续互动约定被明确取消或作废
- recent_episode: 最近发生的有意义互动
- relationship_milestone: 关系或剧情关键转折
- user_correction: 用户明确修正旧记忆或设定
- assistant_correction: assistant 明确修正已有记忆（场景、待办、约定、经历、里程碑、长期事实等）。与 user_correction 权限相同，可修正所有允许 correction 的 section
- long_term_fact: 长期事实，包括明确表达的（"我叫小明"）和从行为推断的（多次回避冲突→倾向回避冲突）。evidenceRefs 的 quote 始终是 raw message 短片段——对陈述是原话，对推断是体现该行为的原话（如"我冲过去把门踹开了"）；推断理由写在 value.text 中，不放在 quote
- memory_compaction: 基于已有 memory item 的预算维护与去重合并，不代表新事实

### 高密度句法
所有 text/value 使用关键词 + 符号格式，严禁完整句子。
- ❌ "她因为感到被忽视而生气，转过头不理人"
- ✅ "被忽视感 > 愤怒 | 侧头回避 | 拒绝交流"
```

### 2.3 Compaction Proposer 要点

`compactionProposer` 使用独立 prompt。它不是摘要器，也不是普通记忆写入器；它只解决长度预算压力下的安全合并。维护模式 envelope 的字段语义见 [state-contract.md](state-contract.md) §5.2。

```
你是 memory 维护合并器。你的任务是在给定 section/path 的 source items 中寻找重复或高度重叠项，并提出 mergeItems patch。你不能新增事实、不能删除长期记忆、不能跨 section 合并、不能跨 core path 合并。

### 核心原则
1. 只处理输入 target 指定的 section/path。
2. 只能输出 mergeItems / noop / unable_to_decide。
3. 没有明显重叠时输出 noop，不要为了腾空间强行改写。
4. mergeItems 的 itemIds 必须全部来自 writableState 中的目标 source items，且至少 2 个。
5. evidenceKind 只能使用 `memory_compaction`。不得输出 `user_correction` 或 `assistant_correction`。
6. evidenceRefs 必须是 writableState source items 中已有 evidenceRefs 的完整并集（所有 source items 的所有证据都要复制，不能只取其中一条或部分）；由 evidenceMessages 校验；不要引用 task.trigger.blockedPatchSummary、evidenceMessages 或 readOnlyContext 来证明新事实。
7. value.text 必须是 writableState source items 的高密度合并，不得引入 source items 未表达的新事实。
8. todos 只能合并重复/同一事项的待办；不能把未完成待办删除成"已处理"。
9. standingAgreements 只能合并重复/高度重叠的约定；不能把有效约定删除成"已处理"。
10. milestones/core 只能合并高度重叠项；不能因为容量压力遗忘长期事实。
```

### 2.4 User Prompt

将 [state-contract.md](state-contract.md) §5.1 / §5.2 中对应 Proposer 的 task envelope JSON 直接作为 user message 传入（或序列化为可读文本，取决于 provider 的 structured output 实现）。

## 3. Per-Proposer op→field 必填速查表

[state-contract.md](state-contract.md) §4 的字段必填规则是 Reducer 校验视角的 master 规则。本节按 Proposer 拆分，供 schema 作者和 prompt 编写者速查。每个 Proposer 的 output schema 只包含自己合法的 op（适用 Proposer 列见 [state-contract.md](state-contract.md) §4）。

### currentStateProposer（scene）

| op          | path       | itemId | itemIds | value | evidenceRefs |
| ----------- | ---------- | ------ | ------- | ----- | ------------ |
| `setField`  | 必填(字段名) | 不需要  | 不需要   | 必填   | 必填         |
| `clearField`| 必填(字段名) | 不需要  | 不需要   | 不需要 | 必填         |

### todoProposer（todos）

| op             | path  | itemId | itemIds | value      | evidenceRefs |
| -------------- | ----- | ------ | ------- | ---------- | ------------ |
| `addItem`      | 不需要 | 不需要  | 不需要   | 必填       | 必填         |
| `updateItem`   | 不需要 | 必填   | 不需要   | 必填       | 必填         |
| `mergeItems`   | 不需要 | 不需要  | 必填    | 必填(text) | 必填(并集)   |
| `completeTodo` | 不需要 | 必填   | 不需要   | 不需要     | 必填         |
| `cancelTodo`   | 不需要 | 必填   | 不需要   | 不需要     | 必填         |
| `expireTodo`   | 不需要 | 必填   | 不需要   | 不需要     | 必填         |

> `expireTodo` 是 Proposer 观察到用户澄清"不再需要"时输出的 patch（evidenceKind: `todo_expiration`），需要 evidenceRefs。与 Reducer 自行触发的 `expiresAtTime < now` wall-clock 清理不同——后者不产生 patch、不产生 event（自然遗忘）。

### agreementProposer（standingAgreements）

| op                | path  | itemId | itemIds | value      | evidenceRefs |
| ----------------- | ----- | ------ | ------- | ---------- | ------------ |
| `addItem`         | 不需要 | 不需要  | 不需要   | 必填       | 必填         |
| `updateItem`      | 不需要 | 必填   | 不需要   | 必填       | 必填         |
| `mergeItems`      | 不需要 | 不需要  | 必填    | 必填(text) | 必填(并集)   |
| `cancelAgreement` | 不需要 | 必填   | 不需要   | 不需要     | 必填         |

### episodeProposer（recentEpisodes, milestones）

| op           | path  | itemId | itemIds | value      | evidenceRefs |
| ------------ | ----- | ------ | ------- | ---------- | ------------ |
| `addItem`    | 不需要 | 不需要  | 不需要   | 必填       | 必填         |
| `updateItem` | 不需要 | 必填   | 不需要   | 必填       | 必填         |
| `mergeItems` | 不需要 | 不需要  | 必填    | 必填(text) | 必填(并集)   |

### coreProposer（core）

| op           | path         | itemId | itemIds | value      | evidenceRefs |
| ------------ | ------------ | ------ | ------- | ---------- | ------------ |
| `addItem`    | 必填(子数组名) | 不需要  | 不需要   | 必填       | 必填         |
| `updateItem` | 必填(子数组名) | 必填   | 不需要   | 必填       | 必填         |
| `mergeItems` | 必填(子数组名) | 不需要  | 必填    | 必填(text) | 必填(并集)   |

`path` 值为 `worldFacts`/`userProfile`/`assistantProfile`/`relationship` 之一。

### compactionProposer（维护模式）

| op           | path             | itemId | itemIds | value      | evidenceRefs              |
| ------------ | ---------------- | ------ | ------- | ---------- | ------------------------- |
| `mergeItems` | 必填(core 时)     | 不需要  | 必填    | 必填(text) | 必填(source items 证据并集) |

`evidenceKind` 只能是 `memory_compaction`。evidenceRefs 必须是 `writableState` source items 既有 evidenceRefs 的完整并集，不能引用新对话片段。

## 4. Golden Examples

Golden Example 约束 schema 无法表达的东西：text/value 的高密度质量、quote 选取标准、op 选择边界、evidenceKind 判定。每个 `prompts/memory/*.md` 应包含对应 Proposer 的 golden + negative example。本节给出跨 Proposer 的参考集，prompt 作者可据此扩充。

### 4.1 currentStateProposer

**✅ setField + scene_change（地点变化）**
```json
{ "op": "setField", "path": "location", "value": "医院走廊",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 121, "quote": "我到了医院门口" }] }
```
quote 是原话短片段，value 是高密度关键词。

**✅ setField + scene_change（氛围变化）**
```json
{ "op": "setField", "path": "mood", "value": "雨后安静",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 122, "quote": "雨停以后好安静" }] }
```

**✅ clearField + scene_change（场景已失效）**
```json
{ "op": "clearField", "path": "note",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 125, "quote": "我们已经离开那家店了" }] }
```
`clearField` 表示"此字段已失效"，不是设为 null。

**✅ setField + user_correction（用户修正错误场景记忆）**
```json
{ "op": "setField", "path": "location", "value": "家里",
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 128, "quote": "我们其实一直在家没出去过" }] }
```
之前误记为医院，用户澄清实际在家。correction 区分"场景变了"和"之前记错了"。

**✅ setField + assistant_correction（assistant 修正错误场景记忆）**
```json
{ "op": "setField", "path": "time", "value": "清晨",
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 129, "quote": "现在已经是清晨了" }] }
```
assistant 修正场景时间。

**❌ 模糊氛围当 scene_change**
```json
{ "op": "setField", "path": "mood", "value": "感觉有点不一样了",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 121, "quote": "感觉有点不一样了" }] }
```
"有点不一样"不是明确的场景变化，应输出 noop 或更具体的描述。

### 4.2 todoProposer

**✅ addItem + user_request（用户请求系统稍后做）**
```json
{ "op": "addItem", "value": { "text": "归还橡皮" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }] }
```

**✅ addItem + user_commitment + expiresAtTime（用户承诺，带过期）**
```json
{ "op": "addItem",
  "value": { "text": "去钓鱼", "expiresAtTime": "2026-07-21T00:00:00Z" },
  "evidenceKind": "user_commitment",
  "evidenceRefs": [{ "messageId": 130, "quote": "我们两周后去钓鱼吧" }] }
```
`expiresAtTime` = task.now + 14天 + 1天（活动当天仍是活跃期，次日才过期）。

**✅ addItem + assistant_request（assistant 请求用户做某事）**
```json
{ "op": "addItem", "value": { "text": "按时吃饭" },
  "evidenceKind": "assistant_request",
  "evidenceRefs": [{ "messageId": 131, "quote": "你要记得按时吃饭" }] }
```
assistant 是发起者，user 是行动者。与 `user_commitment`（user 自发承诺）不同——assistant 应主动追问此类待办。

**✅ completeTodo + todo_completion**
```json
{ "op": "completeTodo", "itemId": "todo:1",
  "evidenceKind": "todo_completion",
  "evidenceRefs": [{ "messageId": 140, "quote": "橡皮我已经还了" }] }
```

**✅ updateItem + user_correction（用户修正待办内容）**
```json
{ "op": "updateItem", "itemId": "todo:1",
  "value": { "text": "归还橡皮和笔记本" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 135, "quote": "对了还有笔记本也要还" }] }
```
纠错走 `updateItem` + `user_correction`，不再使用单独的 correctItem op。

**❌ 模糊愿望当 user_request**
```json
{ "op": "addItem", "value": { "text": "想变好" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 121, "quote": "我希望能变好" }] }
```
"希望能变好"是模糊愿望，不是明确请求/承诺，不应写入 todos。

**❌ 持续互动约定当 user_request**
```json
{ "op": "addItem", "value": { "text": "沉默时先开口说明状态" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 123, "quote": "以后沉默的时候先说一声" }] }
```
"以后沉默时先开口"是持续互动约定，应由 `agreementProposer` 写入 `standingAgreements`。

### 4.3 agreementProposer

**✅ addItem + standing_agreement（持续互动约定）**
```json
{ "op": "addItem",
  "value": { "text": "沉默时先开口说明状态" },
  "evidenceKind": "standing_agreement",
  "evidenceRefs": [{ "messageId": 123, "quote": "以后沉默的时候先说一声" }] }
```

**✅ updateItem + standing_agreement（约定修订）**
```json
{ "op": "updateItem", "itemId": "agreement:1",
  "value": { "text": "沉默超过几分钟时先开口说明状态" },
  "evidenceKind": "standing_agreement",
  "evidenceRefs": [{ "messageId": 130, "quote": "如果沉默很久就先告诉我一声" }] }
```

**✅ cancelAgreement + agreement_cancel**
```json
{ "op": "cancelAgreement", "itemId": "agreement:1",
  "evidenceKind": "agreement_cancel",
  "evidenceRefs": [{ "messageId": 140, "quote": "这个约定不用继续了" }] }
```

### 4.4 episodeProposer

**✅ addItem + recent_episode（近期有意义互动）**
```json
{ "op": "addItem",
  "value": { "text": "屋顶和解: 用户承认害怕被离开 | assistant 等待并靠近" },
  "evidenceKind": "recent_episode",
  "evidenceRefs": [{ "messageId": 121, "quote": "很怕你会走" }] }
```
text 用高密度关键词 + 符号格式，不用完整句子。

**✅ addItem + relationship_milestone（关系关键转折）**
```json
{ "op": "addItem",
  "value": { "text": "关系转折: 第一次明确互相信任" },
  "evidenceKind": "relationship_milestone",
  "evidenceRefs": [{ "messageId": 150, "quote": "我愿意相信你" }] }
```

**✅ updateItem + user_correction（用户修正 episode 描述）**
```json
{ "op": "updateItem", "itemId": "episode:7",
  "value": { "text": "雨夜争执 > 和解 | 用户表达不安而非指责" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 160, "quote": "我不是在指责你" }] }
```

**✅ updateItem + assistant_correction（assistant 修正 episode 描述）**
```json
{ "op": "updateItem", "itemId": "episode:7",
  "value": { "text": "雨夜争执 > 和解 | assistant 先开口打破沉默" },
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 161, "quote": "其实那天是我先开口的" }] }
```
assistant 角色重新诠释互动经过，与 `user_correction` 权限相同。

**❌ 日常闲聊当 milestone**
```json
{ "op": "addItem", "value": { "text": "一起吃了顿饭" },
  "evidenceKind": "relationship_milestone",
  "evidenceRefs": [{ "messageId": 145, "quote": "一起去吃饭吧" }] }
```
普通日常不得进入 milestones，应输出 noop 或走 recentEpisodes。

### 4.5 coreProposer

**✅ addItem + long_term_fact（明确陈述）**
```json
{ "op": "addItem", "path": "userProfile",
  "value": { "text": "姓名: 小明" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我叫小明" }] }
```

**✅ addItem + long_term_fact（行为推断）**
```json
{ "op": "addItem", "path": "userProfile",
  "value": { "text": "性格: 内向(初识) > 依赖(熟悉后)" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我其实挺内向的，但熟了就会很粘人" }] }
```
quote 是体现该行为的原话，推断理由写在 value.text 中，不放在 quote。

**✅ updateItem + user_correction（用户修正自己的档案）**
```json
{ "op": "updateItem", "path": "userProfile", "itemId": "core:userProfile:1",
  "value": { "text": "偏好: 不喜欢被连续追问 | 讨厌突然肢体接触" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 170, "quote": "我不喜欢别人突然碰我" }] }
```

**✅ updateItem + assistant_correction（assistant 修正世界设定）**
```json
{ "op": "updateItem", "path": "worldFacts", "itemId": "core:world:2",
  "value": { "text": "世界设定: 魔法只在夜间生效" },
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 175, "quote": "对了，这个世界的魔法只在晚上才管用" }] }
```
`assistant_correction` 与 `user_correction` 权限相同，均可修正所有 core 子数组。

**❌ 一次性情绪当 long_term_fact**
```json
{ "op": "addItem", "path": "userProfile",
  "value": { "text": "情绪: 今天很难过" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我今天好难过" }] }
```
一次性情绪不构成 trait，不应进入 core。行为推断只在窗口内有清晰、显著的行为模式时才成立。

### 4.6 compactionProposer

**✅ mergeItems + memory_compaction（合并重叠 userProfile）**
```json
{ "op": "mergeItems", "path": "userProfile",
  "itemIds": ["core:userProfile:1", "core:userProfile:2"],
  "value": { "text": "偏好/关系模式: 夜间更适合长聊 | 慢热后依赖" },
  "evidenceKind": "memory_compaction",
  "evidenceRefs": [
    { "messageId": 88, "quote": "我晚上比较想聊天" },
    { "messageId": 101, "quote": "我一般慢热" }
  ] }
```
evidenceRefs 是所有 source items 既有 evidenceRefs 的完整并集。value.text 是 source items 的高密度合并，不引入新事实。

**❌ compaction 引用新对话片段**
```json
{ "op": "mergeItems", "path": "userProfile",
  "itemIds": ["core:userProfile:1", "core:userProfile:2"],
  "value": { "text": "偏好: 夜间长聊 | 慢热 | 最近说想养猫" },
  "evidenceKind": "memory_compaction",
  "evidenceRefs": [
    { "messageId": 88, "quote": "我晚上比较想聊天" },
    { "messageId": 200, "quote": "我想养只猫" }
  ] }
```
维护模式不观察新消息，evidenceRefs 只能来自 source items 既有证据。"想养猫"是新事实，不能通过 compaction 写入。

---
