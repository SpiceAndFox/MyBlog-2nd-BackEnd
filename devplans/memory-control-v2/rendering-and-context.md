# Memory Control v2 渲染与上下文接入

本文定义 Memory Control v2 如何从结构化状态变成主聊天模型可读上下文，以及它与 context segment、RAG、raw message evidence 的边界。写入协议见 [write-protocol.md](write-protocol.md)。

## 1. Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列。

Renderer 是纯代码模板，不调用 LLM。具体模板见第 5 节。

Renderer 必须：

- 按 `memory_state` 的结构层级区分长期核心记忆、工作区记忆与近期状态。
- 用明确标题标出哪些是当前状态、哪些是历史背景。
- 不判断状态是否过期，不调用 LLM；状态失效、清理和覆盖由 Reducer 维护。
- 避免因为渲染文案把旧场景强行延续到当前回复。
- 保持文本稳定：相同 `memory_state` 与相同 Renderer 代码必须生成相同文本。

## 2. Context 接入

首版采用实时 render 路径。

上下文装配使用单一 `memory` segment：当 `chat_preset_memory.memory_state` 存在且 schema 校验通过时，`memory` 读取结构化状态并调用 Renderer 实时生成完整 memory 文本。

如果 `memory_state` 不存在、`version` 不支持或 schema 校验失败，`memory` segment 直接不注入。是否存在旧格式、是否需要迁移或回放，是迁移层的问题，不由 context segment 耦合历史版本名称。

## 3. RAG 边界

Memory v2 和 RAG 不互相替代。

- Memory 保存当前可用状态、待办、里程碑、长期偏好和关系模式。
- RAG 负责召回具体旧场景、原话和细节。
- Memory 高精度、低容量、持续影响当前回复。
- RAG 高召回、按当前 query 动态取用。

只在某次旧对话中重要、但不应持续影响当前关系状态的事实，应留在 RAG，不进入 core memory。

## 4. Proposer 输入与 Gist 边界

Proposer 输入/输出 envelope 的结构、字段语义和边界规则见 [state-contract.md](state-contract.md) §5。本节只补充与上下文接入相关的边界：

- `evidenceMessages` 统一来自原始 `chat_messages`，user 与 assistant 消息都使用 raw content。Observer 传入时必须标注 `contentKind: "raw"`。
- 普通写入 patch 的 `evidenceRefs.quote` 必须能在对应 raw message content 中校验（校验策略见 [state-contract.md](state-contract.md) §7）；read-only memory context 不参与 quote 校验。
- assistant gist 不进入 v2 memory proposer 输入，也不作为 evidenceRef 来源。

## 5. Renderer 模板

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
- Renderer 只表达 state 中已经存在的层级和生命周期，不自行判断当前/历史归属。
- Renderer 只做确定性模板拼接；同一份 `memory_state` 在同一版 Renderer 下必须输出相同文本。
- `renderedText` 是运行时产物，只进入本次 context assembly，不写回 `chat_preset_memory`。
- 如果未来确实需要 render 缓存，必须作为非权威缓存设计，并带 `renderer_version`；首版不引入。

---
