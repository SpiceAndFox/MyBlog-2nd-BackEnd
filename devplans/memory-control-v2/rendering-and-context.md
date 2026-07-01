# Memory Control v2 渲染与上下文接入

本文定义 Memory Control v2 如何从结构化状态变成主聊天模型可读上下文，以及它与旧 memory segment、RAG、assistant gist 的边界。写入协议见 [write-protocol.md](write-protocol.md)。

## 1. Renderer

Renderer 把结构化 state 渲染为主聊天模型可读的稳定文本，并写入 `state_v2_render`。

Renderer 是纯代码模板，不调用 LLM。具体模板见附录 G。

Renderer 必须：

- 区分长期核心记忆与近期状态。
- 明确哪些是当前状态，哪些是历史背景。
- 避免把旧场景强行延续到当前回复。
- 保持文本稳定：未变化 section 不重写表达，直接用上次渲染结果。

## 12. Context 接入

首版采用兼容 rendered text 路径。

v2 renderer 把 state 渲染为完整 memory 文本，落库到 `chat_preset_memory.state_v2_render`。上下文装配新增单一 `memoryV2` segment：当 v2 feature flag 开启且 `state_v2_render` 可用时，只由 `memoryV2` 注入完整 v2 memory，旧 `rollingSummary` / `coreMemory` segment 禁用，避免重复注入。

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

Renderer 是纯代码模板，把结构化 state 渲染为稳定文本。未变化的 section 直接复用上一次的渲染片段（存于内存或 state blob 的 `meta.renderedSections`）。

### 模板

```
[当前状态]
- 地点: {scene.location || "未知"}
- 时间: {scene.time || "未知"}
- 氛围: {scene.mood || "未知"}
- 备注: {scene.note || ""}
- 用户: 情绪={participants.user.emotion || "?"} | 动作={participants.user.action || "?"} | 意图={participants.user.intent || "?"}
- 助手: 情绪={participants.assistant.emotion || "?"} | 动作={participants.assistant.action || "?"} | 意图={participants.assistant.intent || "?"}

[待办]
{todos.map(t => `- ${t.tags.includes("长期") ? "[长期]" : "[短期]"} ${t.text}`).join("\n") || "(无)"}

[最近经历]
{recentEpisodes.slice(-3).map(e => `- ${e.text}`).join("\n") || "(无)"}

[重要里程碑]
{milestones.map(m => `- ${m.text}`).join("\n") || "(无)"}

[长期核心记忆]
[长期事实]
{core.worldFacts.map(f => `- ${f.text}`).join("\n") || "(无)"}
[User 核心档案]
{core.userProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[Assistant 核心档案]
{core.assistantProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[关系当前状态]
{core.relationship.map(f => `- ${f.text}`).join("\n") || "(无)"}
```

### 渲染规则

- 空字段用 "未知" 或 "(无)" 占位，保持结构稳定。
- `recentEpisodes` 只渲染最近 3 条（滑动窗口）。
- 未变化 section 的渲染片段直接复用上次结果，不重新生成（避免文本漂移）。
- 只有 `renderedText`（完整拼接结果）写入 `state_v2_render` 并进入主聊天热路径。
- `renderedSections`（各 section 的片段）可存于 state blob 的 `meta` 中供下次复用，也可作为 admin/debug 视图。

---
