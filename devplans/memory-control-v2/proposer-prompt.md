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
- `path`、`itemId`、`itemIds` 的必填规则（[state-contract.md](state-contract.md) §4）需要用 `oneOf` 或条件 required 表达：`setField`/`clearField` 要求 `path`；`core` 的所有 op（`addItem`/`updateItem`/`mergeItems`）要求 `path`；`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`cancelAgreement` 要求 `itemId`；`mergeItems` 要求 `itemIds`（数组）。`core` 的 `updateItem`/`mergeItems` 同时要求 `path` 和 `itemId`/`itemIds`。
- `todos` 的 `addItem`/`updateItem` 的 `value` 可选包含 `expiresAt`，schema 用 `oneOf` 表达 `{ "mode": "absolute", "date": "date" }` 与 `{ "mode": "relative", "days"?: int, "months"?: int, "years"?: int }` 两种形态（见 [state-contract.md](state-contract.md) §4）。relative 模式下 `days`/`months`/`years` 至少出现一个，schema 用 `anyOf: [{required: [days]}, {required: [months]}, {required: [years]}]` 表达。
- `compactionProposer` 的 schema 必须额外限制：只能输出 `mergeItems`，且 `evidenceKind` 只能是 `memory_compaction`，不得输出 `evidenceRefs`。

### 2.2 Prompt 设计原则

每个 `prompts/memory/*.md` 是独立、自包含的 prompt 文件，只包含本 Proposer 目标 section 相关的原则、evidenceKind 子集（[state-contract.md](state-contract.md) §3.1）、op 速查（§3）和 golden example（§4）。不同 Proposer 的 prompt 之间允许重复共享原则。

以下原则按主题分组。各 prompt 文件按 §2.3 的组成表提取相关条目。

#### 通用原则

1. 只对本次 targetSections 输出结果。非 target section 不要输出。
2. 每个 target section 必须明确输出 patches / noop / unable_to_decide 之一。
3. noop 与 unable_to_decide 的区别：
   - noop：已理解对话内容，确认无变更需要。
   - unable_to_decide：现有信息不足以判断是否有变更（如关键消息不在观察窗口内、指代不明无法确认对象）。
   - 不要把"看不懂"伪装成"没变化"。
4. patch 必须附 evidenceKind；除 mergeItems 外，patch 必须附 evidenceRefs。evidenceRefs 的 quote 必须是 observedMessages 中的原始消息短片段（<=80字），不要改写。
5. 普通写入 patch 的 evidenceRefs 必须来自 observedMessages；readOnlyContext 只能用于理解背景，不能作为证据，也不能被当作完整世界状态来推断缺失事实。
6. readOnlyContext 中的 item 不含 id 字段。itemId/itemIds 必须来自 writableState 中对应 section 的 item。
7. 如果现有背景不足以判断，输出 unable_to_decide，不要把背景猜成事实。
8. 删除/完成/取消必须用对应 op（completeTodo/cancelTodo/expireTodo/cancelAgreement），不要用通用 removeItem。
9. 输出结构为 sectionResults 容器，必须恰好覆盖 task.targetSections：
   ```json
   {
     "tickId": "<task.tickId>",
     "proposer": "<本 Proposer 名称>",
     "sectionResults": {
       "<section>": {
         "status": "patches | noop | unable_to_decide",
         "patches": [ ... ]
       }
     }
   }
   ```

#### 高密度句法

所有 text/value 使用关键词 + 符号格式，严禁完整句子。

- ❌ "她因为感到被忽视而生气，转过头不理人"
- ✅ "被忽视感 > 愤怒 | 侧头回避 | 拒绝交流"

#### 成人内容

value.text 客观记录事件本质、双方意愿、关系变化，不写感官描写。quote 可以摘录原话片段（含感官描写），因为 quote 仅用于审计溯源，不渲染给主聊天模型。

#### expiresAt（仅 todoProposer）

短期待办如有明确时间约定，在 value 中设置 expiresAt：

- 听到明确日期 → `{ "mode": "absolute", "date": "YYYY-MM-DD" }`
- 听到相对时长 → `{ "mode": "relative", "days": N }` / `{ "months": N }` / `{ "years": N }`
- 只提取你听到的，不要做日期计算。推断不出具体日期时（如"下周三"无法确定是几号），不设 expiresAt。

#### evidenceKind 判断指南

以下为完整 evidenceKind 列表。各 prompt 文件只包含本 Proposer 合法的子集（[state-contract.md](state-contract.md) §3.1）。

- user_request: 用户明确请求系统/角色稍后做某事（assistant 是行动者）
- user_commitment: 用户明确承诺稍后做某事（user 是行动者，user 发起）
- assistant_request: assistant 明确请求用户稍后做某事（user 是行动者，assistant 发起）
- assistant_commitment: assistant 明确承诺稍后做某事（assistant 是行动者）
- todo_completion: 待办已完成
- todo_cancel: 待办被取消
- todo_expiration: 短期待办自然失效或被澄清为不再需要
- scene_change: 地点/时间/环境/氛围明确变化
- standing_agreement: 持续互动约定、相处规则或长期承诺形成或修订
- agreement_cancel: 持续互动约定被明确取消或作废
- recent_episode: 最近发生的有意义互动
- relationship_milestone: 关系或剧情关键转折
- user_correction: 用户明确修正旧记忆或设定
- assistant_correction: assistant 明确修正已有记忆。与 user_correction 权限相同
- long_term_fact: 长期事实，包括明确表达的（"我叫小明"）和从行为推断的（多次回避冲突→倾向回避冲突）。evidenceRefs 的 quote 始终是 raw message 短片段——对陈述是原话，对推断是体现该行为的原话（如"我冲过去把门踹开了"）；推断理由写在 value.text 中，不放在 quote
- memory_compaction: 基于已有 memory item 的预算维护与去重合并，不代表新事实

### 2.3 各 Proposer 专属原则

以下原则按 Proposer 分组，每个 `prompts/memory/*.md` 在 §2.2 通用原则基础上追加本组原则。

#### currentStateProposer（scene）

- scene 是当前场景状态，用 setField/clearField 字段级覆盖；无变化时输出 noop。
- scene 多字段变化时输出多个 setField patch，每个 patch 恰好 1 条 evidenceRef。
- clearField 表示"此字段已失效"，不是设为 null。

#### todoProposer（todos）

- todos 只记录明确、可完成、可取消或可过期的请求/承诺。模糊愿望和持续互动约定不要写入 todos。
- 短期待办如有明确时间约定，设置 expiresAt（见 §2.2 expiresAt）。

#### agreementProposer（standingAgreements）

- standingAgreements 只记录持续互动约定、相处规则和长期承诺；取消使用 cancelAgreement。

#### episodeProposer（recentEpisodes, milestones）

- milestones 位于长期区，只记录关系或剧情关键转折，日常琐事不要写入。

#### coreProposer（core）

- core 接受长期事实（含 assistant 设定人格和行为推断的人格特征），临时剧情、一次性情绪不要写入。
- core 的 patch 必须用 path 指定长期区子数组（worldFacts/userProfile/assistantProfile/relationship）。
- 已有 core item 的改写接受 user_correction 或 assistant_correction，两者权限相同。
- 行为推断使用 long_term_fact，只在窗口内有清晰、显著的行为模式时才输出，一次性动作不构成 trait。

### 2.4 Compaction Proposer 要点

`compactionProposer` 使用独立 prompt，只解决长度预算压力下的安全合并。维护模式 envelope 的字段语义见 [state-contract.md](state-contract.md) §5.2。

```
你是 memory 维护合并器。你的任务是在给定 section/path 的 source items 中寻找重复或高度重叠项，并提出 mergeItems patch。你不能新增事实、不能删除长期记忆、不能跨 section 合并、不能跨 core path 合并。

### 核心原则
1. 只处理输入 target 指定的 section/path。
2. 只能输出 mergeItems 或 unable_to_compact。
3. 没有明显重叠时输出 unable_to_compact。
4. mergeItems 的 itemIds 必须全部来自 writableState 中的目标 source items，且至少 2 个。
5. evidenceKind 只能使用 `memory_compaction`。不得输出 `user_correction` 或 `assistant_correction`。
6. 不输出 evidenceRefs；Reducer 会根据 itemIds 从 source items 继承 evidenceGroups。
7. value.text 必须是 writableState source items 的高密度合并，不得引入 source items 未表达的新事实。
8. todos 只能合并重复/同一事项的待办；不能把未完成待办删除成"已处理"。
9. standingAgreements 只能合并重复/高度重叠的约定；不能把有效约定删除成"已处理"。
10. milestones/core 只能合并高度重叠项；不能因为容量压力遗忘长期事实。
```

### 2.5 User Prompt

将 [state-contract.md](state-contract.md) §5.1 / §5.2 中对应 Proposer 的 task envelope JSON 直接作为 user message 传入（或序列化为可读文本，取决于 provider 的 structured output 实现）。

## 3. Per-Proposer op→field 必填速查表

[state-contract.md](state-contract.md) §4 的字段必填规则是 Reducer 校验视角的 master 规则。本节按 Proposer 拆分，供 schema 作者和 prompt 编写者速查。每个 Proposer 的 output schema 只包含自己合法的 op（适用 Proposer 列见 [state-contract.md](state-contract.md) §4）。

### currentStateProposer（scene）

| op           | path         | itemId | itemIds | value  | evidenceRefs |
| ------------ | ------------ | ------ | ------- | ------ | ------------ |
| `setField`   | 必填(字段名) | 不需要 | 不需要  | 必填   | 必填         |
| `clearField` | 必填(字段名) | 不需要 | 不需要  | 不需要 | 必填         |

### todoProposer（todos）

| op             | path   | itemId | itemIds | value      | evidenceRefs |
| -------------- | ------ | ------ | ------- | ---------- | ------------ |
| `addItem`      | 不需要 | 不需要 | 不需要  | 必填       | 必填         |
| `updateItem`   | 不需要 | 必填   | 不需要  | 必填       | 必填         |
| `mergeItems`   | 不需要 | 不需要 | 必填    | 必填(text) | 不输出       |
| `completeTodo` | 不需要 | 必填   | 不需要  | 不需要     | 必填         |
| `cancelTodo`   | 不需要 | 必填   | 不需要  | 不需要     | 必填         |
| `expireTodo`   | 不需要 | 必填   | 不需要  | 不需要     | 必填         |

> `expireTodo` 是 Proposer 观察到用户澄清"不再需要"时输出的 patch（evidenceKind: `todo_expiration`），需要 evidenceRefs。与 Reducer 自行触发的 `expiresAtTime < now` wall-clock 清理不同——后者不产生 patch、不产生 event（自然遗忘）。

### agreementProposer（standingAgreements）

| op                | path   | itemId | itemIds | value      | evidenceRefs |
| ----------------- | ------ | ------ | ------- | ---------- | ------------ |
| `addItem`         | 不需要 | 不需要 | 不需要  | 必填       | 必填         |
| `updateItem`      | 不需要 | 必填   | 不需要  | 必填       | 必填         |
| `mergeItems`      | 不需要 | 不需要 | 必填    | 必填(text) | 不输出       |
| `cancelAgreement` | 不需要 | 必填   | 不需要  | 不需要     | 必填         |

### episodeProposer（recentEpisodes, milestones）

| op           | path   | itemId | itemIds | value      | evidenceRefs |
| ------------ | ------ | ------ | ------- | ---------- | ------------ |
| `addItem`    | 不需要 | 不需要 | 不需要  | 必填       | 必填         |
| `updateItem` | 不需要 | 必填   | 不需要  | 必填       | 必填         |
| `mergeItems` | 不需要 | 不需要 | 必填    | 必填(text) | 不输出       |

### coreProposer（core）

| op           | path           | itemId | itemIds | value      | evidenceRefs |
| ------------ | -------------- | ------ | ------- | ---------- | ------------ |
| `addItem`    | 必填(子数组名) | 不需要 | 不需要  | 必填       | 必填         |
| `updateItem` | 必填(子数组名) | 必填   | 不需要  | 必填       | 必填         |
| `mergeItems` | 必填(子数组名) | 不需要 | 必填    | 必填(text) | 不输出       |

`path` 值为 `worldFacts`/`userProfile`/`assistantProfile`/`relationship` 之一。

### compactionProposer（维护模式）

| op           | path          | itemId | itemIds | value      | evidenceRefs |
| ------------ | ------------- | ------ | ------- | ---------- | ------------ |
| `mergeItems` | 必填(core 时) | 不需要 | 必填    | 必填(text) | 不输出       |

`evidenceKind` 只能是 `memory_compaction`。compactionProposer 输出状态为 `patches | unable_to_compact`。Reducer 根据 itemIds 从 source items 继承 evidenceGroups。

## 4. Golden Examples

Golden Example 约束 schema 无法表达的东西：text/value 的高密度质量、quote 选取标准、op 选择边界、evidenceKind 判定。每个 `prompts/memory/*.md` 应包含对应 Proposer 的 golden + negative example。本节给出跨 Proposer 的参考集，prompt 作者可据此扩充。

### 4.1 currentStateProposer

**✅ setField + scene_change（地点变化）**

```json
{
  "op": "setField",
  "path": "location",
  "value": "医院门口",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 121, "quote": "我到了医院门口" }]
}
```

quote 是原话短片段，value 是高密度关键词。

**✅ setField + scene_change（氛围变化）**

```json
{
  "op": "setField",
  "path": "mood",
  "value": "雨后安静",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 122, "quote": "雨停以后好安静" }]
}
```

**✅ clearField + scene_change（场景已失效）**

```json
{
  "op": "clearField",
  "path": "note",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 125, "quote": "我们已经离开那家店了" }]
}
```

`clearField` 表示"此字段已失效"，不是设为 null。

**✅ setField + user_correction（用户修正错误场景记忆）**

```json
{
  "op": "setField",
  "path": "location",
  "value": "家里",
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 128, "quote": "我们其实一直在家没出去过" }]
}
```

之前误记为医院，用户澄清实际在家。correction 区分"场景变了"和"之前记错了"。

**✅ setField + assistant_correction（assistant 修正错误场景记忆）**

```json
{
  "op": "setField",
  "path": "time",
  "value": "清晨",
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 129, "quote": "现在已经是清晨了" }]
}
```

assistant 修正场景时间。

**❌ 模糊氛围当 scene_change**

```json
{
  "op": "setField",
  "path": "mood",
  "value": "感觉有点不一样了",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 121, "quote": "感觉有点不一样了" }]
}
```

"有点不一样"不是明确的场景变化，应输出 noop 或更具体的描述。

### 4.2 todoProposer

**✅ addItem + user_request（用户请求系统稍后做）**

```json
{
  "op": "addItem",
  "value": { "text": "归还橡皮" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }]
}
```

**✅ addItem + user_commitment + expiresAt（用户承诺，带过期）**

```json
{
  "op": "addItem",
  "value": { "text": "去钓鱼", "expiresAt": { "mode": "relative", "days": 14 } },
  "evidenceKind": "user_commitment",
  "evidenceRefs": [{ "messageId": 130, "quote": "我们两周后去钓鱼吧" }]
}
```

LLM 只提取"两周"= 14 天。Reducer 计算 expiresAtTime = task.now + 14天 + 1天（buffer，活动当天仍活跃）。

**✅ addItem + user_commitment + expiresAt（绝对日期）**

```json
{
  "op": "addItem",
  "value": { "text": "去玩", "expiresAt": { "mode": "absolute", "date": "2026-07-10" } },
  "evidenceKind": "user_commitment",
  "evidenceRefs": [{ "messageId": 133, "quote": "我们十号去玩吧" }]
}
```

LLM 提取明确日期，Reducer 计算 expiresAtTime = 2026-07-10 + 1天（buffer）。

**✅ addItem + assistant_request（assistant 请求用户做某事）**

```json
{
  "op": "addItem",
  "value": { "text": "按时吃饭" },
  "evidenceKind": "assistant_request",
  "evidenceRefs": [{ "messageId": 131, "quote": "你要记得按时吃饭" }]
}
```

assistant 是发起者，user 是行动者。与 `user_commitment`（user 自发承诺）不同——assistant 应主动追问此类待办。

**✅ completeTodo + todo_completion**

```json
{
  "op": "completeTodo",
  "itemId": "todo:1",
  "evidenceKind": "todo_completion",
  "evidenceRefs": [{ "messageId": 140, "quote": "橡皮我已经还了" }]
}
```

**✅ updateItem + user_correction（用户修正待办内容）**

```json
{
  "op": "updateItem",
  "itemId": "todo:1",
  "value": { "text": "归还橡皮和笔记本" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 135, "quote": "对了还有笔记本也要还" }]
}
```

纠错走 `updateItem` + `user_correction`，不再使用单独的 correctItem op。

**✅ addItem + assistant_commitment（assistant 承诺做某事）**

```json
{
  "op": "addItem",
  "value": { "text": "准备生日惊喜" },
  "evidenceKind": "assistant_commitment",
  "evidenceRefs": [{ "messageId": 132, "quote": "我来准备生日惊喜吧" }]
}
```

assistant 是行动者兼发起者。

**✅ cancelTodo + todo_cancel**

```json
{
  "op": "cancelTodo",
  "itemId": "todo:1",
  "evidenceKind": "todo_cancel",
  "evidenceRefs": [{ "messageId": 141, "quote": "橡皮不用还了" }]
}
```

**✅ expireTodo + todo_expiration**

```json
{
  "op": "expireTodo",
  "itemId": "todo:2",
  "evidenceKind": "todo_expiration",
  "evidenceRefs": [{ "messageId": 142, "quote": "那件事已经过了吧，不用管了" }]
}
```

用户澄清待办不再需要。与 `cancelTodo`（明确取消）的区别：expire 侧重"自然失效或被澄清为不再需要"，cancel 侧重"明确取消"。

**✅ mergeItems + user_request（普通模式去重）**

```json
{
  "op": "mergeItems",
  "itemIds": ["todo:1", "todo:3"],
  "value": { "text": "归还橡皮和笔记本" },
  "evidenceKind": "user_request"
}
```

普通模式下 todoProposer 发现 writableState 中有重复待办，主动合并。不输出 evidenceRefs；Reducer 从 source items 继承 evidenceGroups。

**❌ 模糊愿望当 user_request**

```json
{
  "op": "addItem",
  "value": { "text": "想变好" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 121, "quote": "我希望能变好" }]
}
```

"希望能变好"是模糊愿望，不是明确请求/承诺，不应写入 todos。

**❌ 持续互动约定当 user_request**

```json
{
  "op": "addItem",
  "value": { "text": "沉默时先开口说明状态" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 123, "quote": "以后沉默的时候先说一声" }]
}
```

"以后沉默时先开口"是持续互动约定，应由 `agreementProposer` 写入 `standingAgreements`。

### 4.3 agreementProposer

**✅ addItem + standing_agreement（持续互动约定）**

```json
{
  "op": "addItem",
  "value": { "text": "沉默时先开口说明状态" },
  "evidenceKind": "standing_agreement",
  "evidenceRefs": [{ "messageId": 123, "quote": "以后沉默的时候先说一声" }]
}
```

**✅ updateItem + standing_agreement（约定修订）**

```json
{
  "op": "updateItem",
  "itemId": "agreement:1",
  "value": { "text": "沉默超过几分钟时先开口说明状态" },
  "evidenceKind": "standing_agreement",
  "evidenceRefs": [{ "messageId": 130, "quote": "如果沉默很久就先告诉我一声" }]
}
```

**✅ cancelAgreement + agreement_cancel**

```json
{
  "op": "cancelAgreement",
  "itemId": "agreement:1",
  "evidenceKind": "agreement_cancel",
  "evidenceRefs": [{ "messageId": 140, "quote": "这个约定不用继续了" }]
}
```

**✅ updateItem + user_correction（用户修正约定内容）**

```json
{
  "op": "updateItem",
  "itemId": "agreement:1",
  "value": { "text": "沉默时先说明原因再开口" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 136, "quote": "不是先开口，是先说原因" }]
}
```

**✅ updateItem + assistant_correction（assistant 修正约定）**

```json
{
  "op": "updateItem",
  "itemId": "agreement:1",
  "value": { "text": "沉默超过几分钟时先说明状态" },
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 137, "quote": "其实之前说的是沉默很久才需要" }]
}
```

**✅ mergeItems + standing_agreement（普通模式去重）**

```json
{
  "op": "mergeItems",
  "itemIds": ["agreement:1", "agreement:2"],
  "value": { "text": "沉默时先说明状态 | 不独自离开" },
  "evidenceKind": "standing_agreement"
}
```

普通模式下 agreementProposer 发现 writableState 中有重叠约定，主动合并。不输出 evidenceRefs；Reducer 从 source items 继承 evidenceGroups。

### 4.4 episodeProposer

**✅ addItem + recent_episode（近期有意义互动）**

```json
{
  "op": "addItem",
  "value": { "text": "屋顶和解: 用户承认害怕被离开 | assistant 等待并靠近" },
  "evidenceKind": "recent_episode",
  "evidenceRefs": [{ "messageId": 121, "quote": "很怕你会走" }]
}
```

text 用高密度关键词 + 符号格式，不用完整句子。

**✅ addItem + relationship_milestone（关系关键转折）**

```json
{
  "op": "addItem",
  "value": { "text": "关系转折: 第一次明确互相信任" },
  "evidenceKind": "relationship_milestone",
  "evidenceRefs": [{ "messageId": 150, "quote": "我愿意相信你" }]
}
```

**✅ updateItem + user_correction（用户修正 episode 描述）**

```json
{
  "op": "updateItem",
  "itemId": "episode:7",
  "value": { "text": "雨夜争执 > 和解 | 用户表达不安而非指责" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 160, "quote": "我不是在指责你" }]
}
```

**✅ updateItem + assistant_correction（assistant 修正 episode 描述）**

```json
{
  "op": "updateItem",
  "itemId": "episode:7",
  "value": { "text": "雨夜争执 > 和解 | assistant 先开口打破沉默" },
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 161, "quote": "其实那天是我先开口的" }]
}
```

assistant 角色重新诠释互动经过，与 `user_correction` 权限相同。

**✅ mergeItems + recent_episode（普通模式去重）**

```json
{
  "op": "mergeItems",
  "itemIds": ["episode:7", "episode:9"],
  "value": { "text": "雨夜争执 > 和解 | 用户表达不安 | assistant 先开口" },
  "evidenceKind": "recent_episode"
}
```

普通模式下 episodeProposer 发现 writableState 中有重叠 episode，主动合并。不输出 evidenceRefs；Reducer 从 source items 继承 evidenceGroups。

**❌ 日常闲聊当 milestone**

```json
{
  "op": "addItem",
  "value": { "text": "一起吃了顿饭" },
  "evidenceKind": "relationship_milestone",
  "evidenceRefs": [{ "messageId": 145, "quote": "一起去吃饭吧" }]
}
```

普通日常不得进入 milestones，应输出 noop 或走 recentEpisodes。

### 4.5 coreProposer

**✅ addItem + long_term_fact（明确陈述）**

```json
{
  "op": "addItem",
  "path": "userProfile",
  "value": { "text": "姓名: 小明" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我叫小明" }]
}
```

**✅ addItem + long_term_fact（行为推断）**

```json
{
  "op": "addItem",
  "path": "userProfile",
  "value": { "text": "性格: 内向(初识) > 依赖(熟悉后)" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我其实挺内向的，但熟了就会很粘人" }]
}
```

quote 是体现该行为的原话，推断理由写在 value.text 中，不放在 quote。

**✅ updateItem + user_correction（用户修正自己的档案）**

```json
{
  "op": "updateItem",
  "path": "userProfile",
  "itemId": "core:userProfile:1",
  "value": { "text": "偏好: 不喜欢被连续追问 | 讨厌突然肢体接触" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 170, "quote": "我不喜欢别人突然碰我" }]
}
```

**✅ updateItem + assistant_correction（assistant 修正世界设定）**

```json
{
  "op": "updateItem",
  "path": "worldFacts",
  "itemId": "core:worldFacts:2",
  "value": { "text": "世界设定: 魔法只在夜间生效" },
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 175, "quote": "对了，这个世界的魔法只在晚上才管用" }]
}
```

`assistant_correction` 与 `user_correction` 权限相同，均可修正所有 core 子数组。

**✅ mergeItems + user_correction（普通模式合并修正）**

```json
{
  "op": "mergeItems",
  "path": "userProfile",
  "itemIds": ["core:userProfile:1", "core:userProfile:3"],
  "value": { "text": "偏好: 不喜欢被连续追问 | 讨厌突然肢体接触" },
  "evidenceKind": "user_correction"
}
```

普通模式下 coreProposer 发现 writableState 中有重叠 core item，主动合并。不输出 evidenceRefs；Reducer 从 source items 继承 evidenceGroups。

**❌ 一次性情绪当 long_term_fact**

```json
{
  "op": "addItem",
  "path": "userProfile",
  "value": { "text": "情绪: 今天很难过" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我今天好难过" }]
}
```

一次性情绪不构成 trait，不应进入 core。行为推断只在窗口内有清晰、显著的行为模式时才成立。

### 4.6 compactionProposer

**✅ mergeItems + memory_compaction（合并重叠 userProfile）**

```json
{
  "op": "mergeItems",
  "path": "userProfile",
  "itemIds": ["core:userProfile:1", "core:userProfile:2"],
  "value": { "text": "偏好/关系模式: 夜间更适合长聊 | 慢热后依赖" },
  "evidenceKind": "memory_compaction"
}
```

value.text 是 source items 的高密度合并，不引入新事实。evidenceGroups 由 Reducer 继承。

**❌ compaction 引入 source items 未表达的新事实**

```json
{
  "op": "mergeItems",
  "path": "userProfile",
  "itemIds": ["core:userProfile:1", "core:userProfile:2"],
  "value": { "text": "偏好: 夜间长聊 | 慢热 | 最近说想养猫" },
  "evidenceKind": "memory_compaction"
}
```

维护模式只合并 source items 已表达的事实。

---
