# Memory Control v2 Proposer Prompt 契约

本文定义 Proposer 的 function calling / structured output 约束和 prompt 要点。Proposer 只能提出候选 patch，不能直接写入最终 memory。最终校验与写入由 [write-protocol.md](write-protocol.md) 中的 Reducer 完成。

## 1. Prompt 管理

Memory worker prompt 必须从 `prompts/memory/*` 读取，不能写死在 service 文件中。

首版至少拆出以下 prompt：

- `prompts/memory/current-state-proposer.md`
- `prompts/memory/todo-proposer.md`
- `prompts/memory/episode-proposer.md`
- `prompts/memory/core-proposer.md`

首版不做 prompt 版本化（个人项目用 git 管理 prompt 变更即可）。如果后续需要 A/B 测试 prompt，再加版本字段。

固定 prompt 统一管理是后续横向重构计划：扫描后端中长期维护的系统/任务级 prompt，将它们迁移到 `prompts/<domain>/*`，由 service 读取。service 文件只保留动态变量拼装、参数传递和调用逻辑。短小且完全局部的运行时格式化模板可以继续留在代码中。

## 2. Proposer Prompt 设计

### 2.1 Function Calling Schema

每个专用 Proposer 的输出都通过 function calling 强制。定义一个 tool，其 parameters JSON schema 对应该 Proposer 的输出结构。关键约束：

- `proposer` 必须等于当前调用的 Proposer 名称。
- `sectionResults` 的 key 只能是该 Proposer 本次负责的 target sections。
- 每个 sectionResult 的 `status` 是 enum：`patches | noop | unable_to_decide`。
- `patches` 数组中每个 patch 的 `op` 是 enum（见 [state-contract.md](state-contract.md) 的 Patch Op 合法值）。
- `evidenceKind` 是 enum（见 [state-contract.md](state-contract.md) 的 Evidence Kind 合法值）。
- `evidenceRefs` 至少 1 项，每项含 `messageId`（integer）和 `quote`（string，max 80 字符）。
- `path`、`itemId`、`itemIds` 的必填规则按 [state-contract.md](state-contract.md) 的 Patch Op 约束。function calling schema 中用 `oneOf` 或条件 required 表达：`setField`/`clearField`/`updateItem`/core 的所有 op 要求 `path`；`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`correctItem` 要求 `itemId`；`mergeItems` 要求 `itemIds`（数组）。

### 2.2 System Prompt 要点

```
你是一个高密度信息提取引擎，服务于情感 Roleplay 系统的记忆管理。你的任务是观察最近对话，为每个 eligible section 提出结构化变更（patch）或判断无需变更（noop）。

### 核心原则
1. 只对本次 target sections 输出结果。非 target section 不要输出。
2. 每个 section 必须明确输出 patches / noop / unable_to_decide 之一。
3. patch 必须附 evidenceKind 和 evidenceRefs。evidenceRefs 的 quote 必须是消息原文的短片段（<=80字），不要改写。
4. evidenceRefs 的 messageId 必须是输入 messages 中真实存在的 id。
5. scene 和 participants 是当前状态，用 setField 覆盖；无变化时输出 noop。
6. todos 只记录明确的请求/承诺，模糊愿望不要写入。
7. milestones 位于长期区，只记录关系或剧情关键转折，日常琐事不要写入。
8. core 只接受用户明确表达的长期事实或用户修正，临时剧情、一次性情绪不要写入。core 的 patch 必须用 path 指定长期区子数组（worldFacts/userProfile/assistantProfile/relationship）。
9. 删除/完成/取消待办必须用对应 op（completeTodo/cancelTodo/expireTodo），不要用通用 removeItem。
10. 成人内容：客观记录事件本质、双方意愿、关系变化，不摘录感官描写。

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

### 高密度句法
所有 text/value 使用关键词 + 符号格式，严禁完整句子。
- ❌ "她因为感到被忽视而生气，转过头不理人"
- ✅ "被忽视感 > 愤怒 | 侧头回避 | 拒绝交流"
```

### 2.3 User Prompt

将 [write-protocol.md](write-protocol.md) 中对应 Proposer 的 task JSON 直接作为 user message 传入（或序列化为可读文本，取决于 provider 的 function calling 实现）。

---
