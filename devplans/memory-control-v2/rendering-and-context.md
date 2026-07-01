# Memory Control v2 渲染与上下文接入

本文定义 Memory Control v2 如何从结构化状态变成主聊天模型可读上下文，以及它与旧 memory segment、RAG、assistant gist 的边界。写入协议见 [write-protocol.md](write-protocol.md)。

## 1. Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列。

Renderer 是纯代码模板，不调用 LLM。具体模板见附录 G。

Renderer 必须：

- 区分长期核心记忆与近期状态。
- 明确哪些是当前状态，哪些是历史背景。
- 避免把旧场景强行延续到当前回复。
- 保持文本稳定：相同 `memory_state` 与相同 Renderer 代码必须生成相同文本。

## 12. Context 接入

首版采用实时 render 路径。

上下文装配新增单一 `memoryV2` segment：当 v2 feature flag 开启且 `chat_preset_memory.memory_state` 可用时，`memoryV2` 读取结构化状态并调用 Renderer 实时生成完整 v2 memory 文本。旧 `rollingSummary` / `coreMemory` segment 禁用，避免重复注入。

fallback 只在 v2 不可用或 feature flag 关闭时生效，回到旧 `rolling_summary` / `core_memory` 列。

## 13. RAG 边界

Memory v2 和 RAG 不互相替代。

- Memory 保存当前可用状态、待办、里程碑、长期偏好和关系模式。
- RAG 负责召回具体旧场景、原话和细节。
- Memory 高精度、低容量、持续影响当前回复。
- RAG 高召回、按当前 query 动态取用。

只在某次旧对话中重要、但不应持续影响当前关系状态的事实，应留在 RAG，不进入 core memory。

## 14. Gist 与原文输入

现有 assistant gist 可以作为低成本辅助输入，但不能替代原始对话。

Observer 固定读取最近用户原文，因为用户消息通常承载偏好、承诺、修正和长期事实。Assistant 轮次优先使用 gist。

**证据可靠性差异**：用户消息（raw）的 evidenceRef quote 是原始表达，证据可靠性高。Assistant 消息（gist）的 evidenceRef quote 来自 gist 压缩文本而非原文，证据可靠性低于 raw——gist 可能已丢失或改写关键细节。Reducer 做 quote 模糊匹配时，对 gist 来源的 message 用相同策略（gist 文本本身是稳定的，匹配 gist 文本即可），但系统应诚实认知：gist 来源的证据是"gist 记录了什么"，不是"assistant 原文说了什么"。

Observer 传入 messages 时已标注 `contentKind: "raw" | "gist"`（见附录 A），Reducer 可通过 messageId 查到对应 message 的 contentKind，无需在 evidenceRef 中重复标注。

首版不实现"按需拉取 assistant 原文"的复杂逻辑。如果后续发现 gist 丢失关键证据导致 memory 质量下降，再考虑对高风险 patch（core/milestones）按 messageId 拉取 assistant 原文。

## 附录 G：Renderer 模板

Renderer 是纯代码模板，把结构化 `memory_state` 渲染为稳定文本。Renderer 不调用 LLM，不读取 patch/event log，不依赖数据库中的物化 render 文本。

### 模板

```
[当前状态]
- 地点: {current.scene.location || "未知"}
- 时间: {current.scene.time || "未知"}
- 氛围: {current.scene.mood || "未知"}
- 备注: {current.scene.note || ""}
- 用户: 情绪={current.participants.user.emotion || "?"} | 动作={current.participants.user.action || "?"} | 意图={current.participants.user.intent || "?"}
- 助手: 情绪={current.participants.assistant.emotion || "?"} | 动作={current.participants.assistant.action || "?"} | 意图={current.participants.assistant.intent || "?"}

[待办]
{working.todos.map(t => `- ${t.tags.includes("长期") ? "[长期]" : "[短期]"} ${t.text}`).join("\n") || "(无)"}

[最近经历]
{working.recentEpisodes.slice(-3).map(e => `- ${e.text}`).join("\n") || "(无)"}

[重要里程碑]
{longTerm.milestones.map(m => `- ${m.text}`).join("\n") || "(无)"}

[长期核心记忆]
[长期事实]
{longTerm.worldFacts.map(f => `- ${f.text}`).join("\n") || "(无)"}
[User 核心档案]
{longTerm.userProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[Assistant 核心档案]
{longTerm.assistantProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[关系当前状态]
{longTerm.relationship.map(f => `- ${f.text}`).join("\n") || "(无)"}
```

### 渲染规则

- 空字段用 "未知" 或 "(无)" 占位，保持结构稳定。
- `recentEpisodes` 只渲染最近 3 条（滑动窗口）。
- Renderer 只做确定性模板拼接；同一份 `memory_state` 在同一版 Renderer 下必须输出相同文本。
- `renderedText` 是运行时产物，只进入本次 context assembly，不写回 `chat_preset_memory`。
- 如果未来确实需要 render 缓存，必须作为非权威缓存设计，并带 `renderer_version`；首版不引入。

---
