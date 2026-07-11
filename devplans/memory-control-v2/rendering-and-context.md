# Memory Control v2 渲染与上下文接入

本文定义 Memory Control v2 如何从结构化状态变成主聊天模型可读上下文，以及它与 context segment、RAG、raw message evidence 的边界。写入协议见 [write-protocol.md](write-protocol.md)。

## 1. Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列。

Context compiler 还必须与 `memory_state` 同时读取 `chat_memory_target_status`，作为独立 health sidecar；禁止为了渲染/告警方便把 halted/retry/rebuilding 写回 `memory_state.meta`。本批只保证该状态可被 Renderer/用户告警层访问，具体 healthy/degraded/rebuilding 映射和“该类记忆可能滞后”文案在第 8 批定义。

Renderer 是纯代码模板，不调用 LLM。具体模板见第 5 节。

Renderer 必须：

- 按 `memory_state` 的结构层级区分长期记忆、工作区记忆与近期状态。
- 用明确标题标出哪些是当前状态、哪些是历史背景。
- 不调用 LLM。持久化状态失效、清理和覆盖由 Reducer/housekeeping 维护；但在后台 cleanup 尚未提交时，Renderer 必须按下述同一套纯代码规则构造 effective view。
- 避免因为渲染文案把旧场景强行延续到当前回复。
- 保持文本稳定：相同 `memory_state`、相同 lifecycle anchors、相同 requestNow、相同配置与相同 Renderer 代码必须生成相同文本。

### 1.1 请求时 Effective View

Context compiler 捕获一次 `requestNow`，并按 current.scene 最大 `updatedAtMessageId` 读取对应消息 `createdAt` 作为 `sceneAnchorCreatedAt`，再调用纯代码 `buildEffectiveMemoryView(memoryState, lifecycleAnchors, requestNow, config)`；该函数只复制并转换运行时 view，不直接写数据库：

1. scene 已达到配置化 TTL 时，在 view 中把完整 current.scene（含 provenance）移到单值 previousScene、令 `expiredAt=sceneAnchorCreatedAt+TTL` 并清空 current.scene；因此本次请求不得继续把它称为当前状态。已有 previousScene 在 effective view 中被替换。
2. active todo 满足 `requestNow >= dueAt` 时，在 view 中原位显示为 overdue，并令 `becameOverdueAt=dueAt`；不得继续出现在 active 列表。
3. 发现上述未持久化变化时，幂等唤醒 housekeeping。housekeeping 依 [state-contract.md](state-contract.md) §9.2 提交 revision/snapshot/events；effective view 不是新的 authority，也不能替代持久化。

Scene TTL 基于 scene 四个非 null 字段中最大的 `updatedAtMessageId` 所对应消息的数据库 `createdAt` 加配置 TTL 计算；scene 全空时不读取 anchor、不产生过期动作。该规则与 housekeeping 共用同一纯代码函数，避免读写两套过期判断。

## 2. Context 接入

首版采用实时 render 路径。`memory` segment 的注入受两道门控：

1. **窗口溢出门控**：候选消息数超过 `CHAT_RECENT_WINDOW_MAX_MESSAGES`（当前默认 80）时，最近窗口装不下全部历史，`memory` segment 才注入；窗口能装下全部历史时直接用 recent window，不注入 memory。此门控由 context compiler 既有逻辑承载，v2 沿用。
2. **状态门控**：窗口溢出后，`chat_preset_memory.memory_state` 存在且 schema 校验通过时，`memory` 读取结构化状态并调用 Renderer 实时生成完整 memory 文本。`memory_state` 不存在、`version` 不支持或 schema 校验失败时，`memory` segment 不注入。

除窗口未溢出外，跳过注入时必须记录原因（state 不存在 / version 不支持 / schema 校验失败），写入 debug payload 供排查（见 [harness.md](harness.md) §3.9）。不得静默跳过。

是否存在旧格式、是否需要迁移或回放，是迁移层的问题，不由 context segment 耦合历史版本名称。

## 3. RAG 边界

Memory v2 和 RAG 不互相替代。

- Memory 保存当前场景、待办、持续约定、里程碑、长期偏好和关系模式。
- RAG 负责召回具体旧场景、原话和细节。
- Memory 高精度、低容量、持续影响当前回复。
- RAG 高召回、按当前 query 动态取用。

只在某次旧对话中重要、但不应持续影响当前关系状态的事实，应留在 RAG，不进入长期 sections。

## 4. Proposer 输入与 Gist 边界

Proposer 输入/输出 envelope 的结构、字段语义和边界规则见 [state-contract.md](state-contract.md) §5。本节只补充与上下文接入相关的边界：

- 普通模式的 `observedMessages` 统一来自原始 `chat_messages`，user 与 assistant 消息都使用 raw content。Observer 传入时必须标注 `contentKind: "raw"`。
- 普通写入 patch 的 `evidenceRefs.quote` 必须能在对应 raw message content 中校验（校验策略见 [state-contract.md](state-contract.md) §7）；read-only memory context 不参与 quote 校验。
- 维护模式不向 Proposer 暴露 raw messages、既有 evidenceGroups 或 quote。
- assistant gist 不进入 v2 memory proposer 输入，也不作为 evidenceRefs 来源。

## 5. Renderer 模板

Renderer 是纯代码模板，把结构化 `memory_state` 渲染为稳定文本。Renderer 不调用 LLM，不读取 patch/event log，不依赖数据库中的物化 render 文本。

### 模板

```
[长期核心记忆]
[长期事实]
{longTerm.worldFacts.map(f => `- ${f.text}`).join("\n") || "(无)"}
[User 核心档案]
{longTerm.userProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[Assistant 核心档案]
{longTerm.assistantProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[关系模式]
{longTerm.relationship.map(f => `- ${f.text}`).join("\n") || "(无)"}

[重要里程碑]
{longTerm.milestones.map(m => `- ${m.text}`).join("\n") || "(无)"}

[持续约定]
{working.standingAgreements.map(a => `- ${a.text}`).join("\n") || "(无)"}

[待办]
{working.todos.filter(t => t.status === "active").map(renderTodo).join("\n") || "(无)"}

[已逾期待办]
{renderOverdueTodosWithinBudget(working.todos, config.overdueTodos)}

[最近经历]
{working.recentEpisodes.map(e => `- ${e.text}`).join("\n") || "(无)"}

[当前状态]
- 地点: {current.scene.location.value || "未知"}
- 时间: {current.scene.time.value || "未知"}
- 氛围: {current.scene.mood.value || "未知"}
- 备注: {current.scene.note.value || ""}

[已过期场景 / 上次已知场景]
{current.previousScene ? renderScene(current.previousScene) : "(无)"}

```

### 渲染规则

- 空字段用 "未知" 或 "(无)" 占位，保持结构稳定。
- `recentEpisodes` 已由 Reducer 按 section 的 `maxItems + maxRenderedChars` 滚动清理，Renderer 不再硬编码 `.slice(-3)`。
- `renderTodo` 至少表达 text、actor、requester；dueAt 非 null 时同时表达 deadline。active 与 overdue 来自同一个 `working.todos` section，按 status 分组。
- overdue 组按 `becameOverdueAt DESC`、itemId 稳定打破平局，在独立 `maxRenderedItems + maxRenderedChars` 内取完整 items；不得截断单条后伪装完整，也不占 active todo 的 section 容量。
- `current.previousScene` 使用与 scene 相同的四字段快照（额外含 `expiredAt`），仅在标题 `[已过期场景 / 上次已知场景]` 下渲染，必须明确它不是当前状态。
- 除 §1.1 的确定性 effective view 外，Renderer 只表达 state 中已经存在的层级和生命周期，不自行推断语义状态。
- Renderer 只做确定性模板拼接；同一份 `memory_state` 在同一版 Renderer 下必须输出相同文本。
- `renderedText` 是运行时产物，只进入本次 context assembly，不写回 `chat_preset_memory`。
- 如果未来确实需要 render 缓存，必须作为非权威缓存设计，并带 `renderer_version`；首版不引入。

---
