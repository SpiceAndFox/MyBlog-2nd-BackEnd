# Memory Control v2 渲染与上下文接入

本文定义 Memory Control v2 如何从结构化状态变成主聊天模型可读上下文，以及它与 context segment、RAG、raw message evidence 的边界。写入协议见 [write-protocol.md](write-protocol.md)。

## 1. Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列。

Context compiler 还必须与 `memory_state` 同时读取 `chat_memory_target_status` 和 active context-quality diagnostics，作为独立 health sidecar；禁止为了渲染/告警方便把 halted/retry/rebuilding 写回 `memory_state.meta`。健康聚合与持续告警遵循 [write-protocol.md](write-protocol.md) §8.1。

Renderer 是纯代码模板，不调用 LLM。具体模板见第 5 节。

Renderer 必须：

- 按 `memory_state` 的结构层级区分长期记忆、工作区记忆与近期状态。
- 用明确标题标出哪些是当前状态、哪些是历史背景。
- 不调用 LLM。持久化状态失效、清理和覆盖由 Reducer/housekeeping 维护；但在后台 cleanup 尚未提交时，Renderer 必须按下述同一套纯代码规则构造 effective view。
- 避免因为渲染文案把旧场景强行延续到当前回复。
- 保持文本稳定：相同 `memory_state`、相同 lifecycle anchors、相同 requestNow、相同配置与相同 Renderer 代码必须生成相同文本。
- 对 `retry_wait`、`capacity_blocked`、`halted` target 继续渲染最后一次成功提交的稳定 state，但在其负责的 section 前输出稳定标记“该类记忆可能滞后”；不得把旧 state 无提示地称为当前状态。`rebuilding` target 使用“该类记忆正在重建”标记。

标记位置按 target 的固定 section 映射确定：`scene` → 当前/previous scene，`todos` → todos，`standingAgreements` → standingAgreements，`episodes` → recentEpisodes/milestones，`profileRelationship` → userProfile/assistantProfile/relationship，`worldFacts` → worldFacts。多个 section 共享一个 target 时，若各 section 在模板中相邻，可在该组的第一个 section 前只输出一次标记；若不相邻（如 `episodes` 的 milestones 与 recentEpisodes 之间隔着其他 section），则应在每个 section 前分别输出标记。GapBridge active omitted 诊断按其 target 使用相同“可能滞后”标记。

### 1.1 请求时 Effective View

请求时 effective view 与 housekeeping 必须调用同一纯代码生命周期函数；完整的 scene TTL、Todo overdue/revive、cleanup event 与幂等规则见 [领域生命周期算法](algorithms/domain-lifecycle.md)。Renderer 只消费转换后的运行时 view，不把它持久化为第二份 authority。

## 2. Context 接入

首版采用实时 render 路径。Recent window、`needsMemory`、状态门控、user-boundary 裁剪、跳过原因和 GapBridge 的顺序敏感规则统一由 [Context Coverage 算法](algorithms/context-coverage.md) 定义。本文件只负责说明 Renderer 如何把最终 effective view 与 health sidecar 组装为 context segment。

### 2.1 Per-target GapBridge

GapBridge 是 context assembly 的覆盖补偿层，不推进 target cursor、不写 patch，也不替代正常 Memory task。其 gap 计算、完整消息选择、omitted 诊断、持续告警与恢复条件见 [Context Coverage 算法](algorithms/context-coverage.md) §2。

## 3. RAG 边界

Memory v2 和 RAG 不互相替代。

- Memory 保存当前场景、待办、持续约定、里程碑、长期偏好和关系模式。
- RAG 负责召回具体旧场景、原话和细节。
- Memory 高精度、低容量、持续影响当前回复。
- RAG 高召回、按当前 query 动态取用。

只在某次旧对话中重要、但不应持续影响当前关系状态的事实，应留在 RAG，不进入长期 sections。

Projection checkpoint 的推进与 rebuild 见 [Source Rebuild 与 Projection 算法](algorithms/source-rebuild-and-projection.md)；请求时 `requiredBoundary`、有效检索上界、partial coverage 与健康判断见 [Context Coverage 算法](algorithms/context-coverage.md) §3；correction/forget 后的 tombstone 查询过滤和 privacy hard delete 门控见 [Suppression 与 Retention 算法](algorithms/suppression-and-retention.md)。

## 4. Proposer 输入与 Gist 边界

Proposer 输入/输出 envelope 的结构、字段语义和边界规则见 [state-contract.md](state-contract.md) §5。本节只补充与上下文接入相关的边界：

- 普通模式的 `observedMessages` 统一来自原始 `chat_messages`，user 与 assistant 消息都使用 raw content。Observer 传入时必须标注 `contentKind: "raw"`。
- 普通写入 patch 的 `evidenceRefs.quote` 必须能在对应 raw message content 中校验（校验策略见 [Evidence 校验与 Quote 匹配算法](algorithms/evidence-validation.md)）；read-only memory context 不参与 quote 校验。
- 维护模式不向 Proposer 暴露 raw messages、既有 evidenceGroups 或 quote。
- assistant gist 不进入 v2 memory proposer 输入，也不作为 evidenceRefs 来源。

## 5. Renderer 模板

Renderer 是纯代码模板，把结构化 `memory_state` 渲染为稳定文本。Renderer 不调用 LLM，不读取 patch/event log，不依赖数据库中的物化 render 文本。

模板中的 `{renderTargetHealthMarker(targetKey)}` 只读取 health sidecar，并按以下优先级输出：target 为 `rebuilding` 时输出“[该类记忆正在重建]”；否则 target 为 `retry_wait/capacity_blocked/halted` 或存在该 target 的 active GapBridge omitted 诊断时输出“[该类记忆可能滞后]”；其余情况输出空字符串。它不把运行状态写入 `memory_state`。

### 模板

```
[长期核心记忆]
{renderTargetHealthMarker("worldFacts")}
[长期事实]
{longTerm.worldFacts.map(f => `- ${f.text}`).join("\n") || "(无)"}
{renderTargetHealthMarker("profileRelationship")}
[User 核心档案]
{longTerm.userProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[Assistant 核心档案]
{longTerm.assistantProfile.map(f => `- ${f.text}`).join("\n") || "(无)"}
[关系模式]
{longTerm.relationship.map(f => `- ${f.text}`).join("\n") || "(无)"}

[重要里程碑]
{renderTargetHealthMarker("episodes")}
{longTerm.milestones.map(m => `- ${m.text}`).join("\n") || "(无)"}

[持续约定]
{renderTargetHealthMarker("standingAgreements")}
{working.standingAgreements.map(a => `- ${a.text}`).join("\n") || "(无)"}

[待办]
{renderTargetHealthMarker("todos")}
{working.todos.filter(t => t.status === "active").map(renderTodo).join("\n") || "(无)"}

[已逾期待办]
{renderOverdueTodosWithinBudget(working.todos, config.overdueTodos)}

[最近经历]
{renderTargetHealthMarker("episodes")}
{working.recentEpisodes.map(e => `- ${e.text}`).join("\n") || "(无)"}

[当前状态]
{renderTargetHealthMarker("scene")}
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
- Renderer 只做确定性模板拼接；相同 `memory_state`、相同 lifecycle anchors、相同 requestNow、相同配置与相同 Renderer 代码必须生成相同文本。
- `renderedText` 是运行时产物，只进入本次 context assembly，不写回 `chat_preset_memory`。
- 如果未来确实需要 render 缓存，必须作为非权威缓存设计，并带 `renderer_version`；首版不引入。

---
