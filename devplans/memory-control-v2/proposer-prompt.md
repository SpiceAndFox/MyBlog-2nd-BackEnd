# Memory Control v2 Proposer Prompt 契约

本文定义 Proposer 的 schema-constrained structured output 约束和 prompt 要点。Proposer 只能提出候选 patch，不能直接写入最终 memory。最终校验与写入由 [write-protocol.md](write-protocol.md) 中的 Reducer 完成。Proposer 输入/输出 envelope 的结构、字段语义和边界规则见 [state-contract.md](state-contract.md) §5。

## 1. Prompt 管理

Memory worker prompt 必须从 `prompts/memory/*` 读取，不能写死在 service 文件中。

首版至少拆出以下 prompt：

- `prompts/memory/current-state-proposer.md`
- `prompts/memory/todo-proposer.md`
- `prompts/memory/episode-proposer.md`
- `prompts/memory/core-proposer.md`
- `prompts/memory/compaction-proposer.md`

## 2. Proposer Prompt 设计

### 2.1 Schema-Constrained Output

每个专用 Proposer 的输出都必须通过 provider 支持的 schema-constrained structured output 强制（实现可以是 function/tool calling 或 JSON schema response format，由 provider adapter 决定；禁止裸 prompt + `JSON.parse` 作为主路径）。输出 schema 的字段、枚举和必填规则见 [state-contract.md](state-contract.md) §5.5。

schema 作者注意：

- 输出中的 `proposer` 字段必须等于当前调用的 Proposer 名称。
- `path`、`itemId`、`itemIds` 的必填规则（[state-contract.md](state-contract.md) §4）需要用 `oneOf` 或条件 required 表达：`setField`/`clearField`/`updateItem`/core 的所有 op 要求 `path`；`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`correctItem` 要求 `itemId`；`mergeItems` 要求 `itemIds`（数组）。
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
6. scene 和 participants 是当前状态，用 setField 覆盖；无变化时输出 noop。
7. todos 只记录明确的请求/承诺，模糊愿望不要写入。
8. milestones 位于长期区，只记录关系或剧情关键转折，日常琐事不要写入。
9. core 只接受用户或设定明确表达的长期事实（含 assistant 设定人格），临时剧情、一次性情绪不要写入。core 的 patch 必须用 path 指定长期区子数组（worldFacts/userProfile/assistantProfile/relationship）。
10. 删除/完成/取消待办必须用对应 op（completeTodo/cancelTodo/expireTodo），不要用通用 removeItem。
11. 成人内容：客观记录事件本质、双方意愿、关系变化，不摘录感官描写。

### evidenceKind 判断指南
- user_request: 用户明确请求系统/角色稍后做某事
- user_commitment: 用户明确承诺稍后做某事
- assistant_commitment: assistant 明确承诺稍后做某事
- todo_completion: 待办已完成
- todo_cancel: 待办被取消
- todo_expiration: 短期待办自然失效
- scene_change: 地点/时间/环境/氛围明确变化
- participant_state: 用户或 assistant 当前情绪/动作/意图变化
- recent_episode: 最近发生的有意义互动
- relationship_milestone: 关系或剧情关键转折
- user_correction: 用户明确修正旧记忆或设定
- long_term_fact: 用户/设定明确表达的长期事实
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
5. evidenceKind 只能使用 `memory_compaction`。维护模式不观察新消息，无法见证用户修正；用户修正由 normal proposer 处理。
6. evidenceRefs 只能复制 writableState source items 中已有的 evidenceRefs，并由 evidenceMessages 校验；不要引用 task.trigger.blockedPatchSummary、evidenceMessages 或 readOnlyContext 来证明新事实。
7. value.text 必须是 writableState source items 的高密度合并，不得引入 source items 未表达的新事实。
8. todos 只能合并重复/同一事项的待办；不能把未完成待办删除成"已处理"。
9. milestones/core 只能合并高度重叠项；不能因为容量压力遗忘长期事实。
```

### 2.4 User Prompt

将 [state-contract.md](state-contract.md) §5.1 / §5.2 中对应 Proposer 的 task envelope JSON 直接作为 user message 传入（或序列化为可读文本，取决于 provider 的 structured output 实现）。

---
