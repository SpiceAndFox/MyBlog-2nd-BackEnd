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

标记位置按 target 的固定 section 映射确定：`scene` → 当前/previous scene，`todos` → todos，`standingAgreements` → standingAgreements，`episodes` → recentEpisodes/milestones，`profileRelationship` → userProfile/assistantProfile/relationship，`worldFacts` → worldFacts。多个 section 共享一个 target 时可在该组的第一个 section 前只输出一次标记。GapBridge active omitted 诊断按其 target 使用相同“可能滞后”标记。

### 1.1 请求时 Effective View

Context compiler 捕获一次 `requestNow`，并按 current.scene 最大 `updatedAtMessageId` 读取对应消息 `createdAt` 作为 `sceneAnchorCreatedAt`，再调用纯代码 `buildEffectiveMemoryView(memoryState, lifecycleAnchors, requestNow, config)`；该函数只复制并转换运行时 view，不直接写数据库：

1. scene 已达到配置化 TTL 时，在 view 中把完整 current.scene（含 provenance）移到单值 previousScene、令 `expiredAt=sceneAnchorCreatedAt+TTL` 并清空 current.scene；因此本次请求不得继续把它称为当前状态。已有 previousScene 在 effective view 中被替换。
2. active todo 满足 `requestNow >= dueAt` 时，在 view 中原位显示为 overdue，并令 `becameOverdueAt=dueAt`；不得继续出现在 active 列表。
3. 发现上述未持久化变化时，幂等唤醒 housekeeping。housekeeping 依 [state-contract.md](state-contract.md) §9.2 提交 revision/snapshot/events；effective view 不是新的 authority，也不能替代持久化。

Scene TTL 基于 scene 四个非 null 字段中最大的 `updatedAtMessageId` 所对应消息的数据库 `createdAt` 加配置 TTL 计算；scene 全空时不读取 anchor、不产生过期动作。该规则与 housekeeping 共用同一纯代码函数，避免读写两套过期判断。

## 2. Context 接入

首版采用实时 render 路径。Context compiler 先从该 user/preset 的有效 user/assistant raw messages 构造跨 session 候选历史，再以集中配置的 Unicode code point 阈值计算 `needsMemory`。只使用这一项逻辑门控，不再同时叠加 message count、tokenizer 估算或 provider context 百分比：

1. **`needsMemory` 门控**：候选历史的 raw content Unicode code point 总数不超过阈值时，recent window 保留全部消息，`needsMemory=false`，不注入 `memory`。超过阈值时，recent window 从最新消息向前选择不超过同一字符阈值的完整消息，再应用既有 user-boundary 裁剪，令 `needsMemory=true`；最新一条消息即使单独超过逻辑阈值也必须完整保留。不得截断单条 raw message 来伪装成完整消息；provider 的物理 context 上限是另一层能力边界。
2. **状态门控**：`needsMemory=true` 后，`chat_preset_memory.memory_state` 存在且 schema 校验通过时，`memory` 读取结构化状态并调用 Renderer 实时生成完整 memory 文本。`memory_state` 不存在、`version` 不支持或 schema 校验失败时，`memory` segment 不注入。

recent window 可以跨 session，session 只保留为消息元数据；不得插入会改变 Proposer 或主聊天语义处理的 session boundary 控制标记。主聊天 recent window 保留 user-boundary 裁剪，Memory Observer 则按 [write-protocol.md](write-protocol.md) §1.1 读取完整 source，两者不能复用同一个裁剪结果。

除 `needsMemory=false` 外，跳过注入时必须记录原因（state 不存在 / version 不支持 / schema 校验失败），写入 debug payload 供排查（见 [harness.md](harness.md) §3.9）。不得静默跳过。

是否存在旧格式、是否需要迁移或回放，是迁移层的问题，不由 context segment 耦合历史版本名称。

### 2.1 Per-target GapBridge

`needsMemory=true` 时，recent window 可能已经移除某个 target 尚未处理的尾批。Context compiler 必须用每个 normal target 的 cursor 补齐这段 raw-message coverage，不依赖 legacy `summarizedUntilMessageId`：

1. 令 `R` 为 user-boundary 裁剪后 recent window 第一条消息的 messageId，`C` 为该 target 的 `coveredUntilMessageId`。按该 target 的完整有效 source 查询满足 `C < messageId < R` 的消息；这组消息是该 target 的有效 gap。没有 recent window 或 `C >= R` 时该 target 没有 gap。
2. GapBridge 使用独立于 Memory Renderer section 容量的逻辑 Unicode code point 预算。所有未超预算的 gap 消息以完整 raw message 注入单一 `gapBridge` context segment；多个 target 引用同一消息时只注入一次，同时保留该消息覆盖的 target keys。
3. 合并去重后的 gap 超预算时，不调用 LLM 压缩。先按 messageId 倒序选择同时满足集中配置的最近 N 条上限与字符预算的完整消息，再恢复为 messageId 升序注入。不能只截取消息正文的一部分。
4. 单条消息本身超过预算时，该消息计入 omitted，不注入截断版本；使用 LLM 压缩或其他精细处理留给 [Gap Compressor 延后设计](../memory-control-v2-deferred/gap-compressor.md)。
5. 任何 omitted 都必须按受影响 target 写入 context-assembly 的持久化诊断记录，至少保存 requestId、userId/presetId、targetKey、cursor、R、原 gap 条数/字符数、保留边界、保留条数和 omitted 条数，并明确 `truncated=true`。该记录不属于 `memory_state`、semantic event 或 Memory ops log；完整 gap 不需要写持久化成功记录。记录保持 active，直到该 target cursor 覆盖其 omitted 上界，或后续 context assembly 证明该 target 在当时的 recent-window 起点前已无 omitted gap，再标记 resolved，不能只因请求结束而清除。
6. 截断不阻断主聊天，但受影响 target 必须一直视为上下文覆盖不完整：用户侧进入 degraded 并持续告警“部分早期对话未在上下文中”，注入的旧 target state 标记为“可能滞后”。只有第 5 条的 active 诊断满足 resolved 条件后才清除告警，并明确通知 Memory 已追平到相应 boundary。

GapBridge 的逻辑预算只限制该 segment，自身不占用或改变任何 Memory section 的 `maxItems/maxRenderedChars`；其最终文本仍计入主模型不可突破的物理 context 上限。GapBridge 只补主聊天上下文，不推进 target cursor、不写 patch，也不替代后续正常 Memory task。

## 3. RAG 边界

Memory v2 和 RAG 不互相替代。

- Memory 保存当前场景、待办、持续约定、里程碑、长期偏好和关系模式。
- RAG 负责召回具体旧场景、原话和细节。
- Memory 高精度、低容量、持续影响当前回复。
- RAG 高召回、按当前 query 动态取用。

只在某次旧对话中重要、但不应持续影响当前关系状态的事实，应留在 RAG，不进入长期 sections。

RAG 与 Recall 各自维护独立 projection checkpoint，至少记录 `processedGeneration` 和 `processedBoundaryMessageId`，并以 `memory_state.meta.sourceGeneration` 为共享 raw-source invalidation 世代。Memory target cursor 追平不能推定任一 projection 已追平；普通追加未改变 generation 时，各 projection 仍按自己的 boundary 增量推进。

Context compiler 只能把与当前 `sourceGeneration` 一致且已追平其 captured boundary 的 projection 当作当前结果。实际参与本次 context compile 的 RAG/Recall projection 若 generation 不一致或尚未追平，必须保持 `degraded/rebuilding` 告警，不得把旧 projection 无提示注入或声称为当前状态。Projection worker 在提交 checkpoint 前必须重校 generation；进程内 wake-up 只降低延迟，启动与周期轮询时的 generation/boundary 比较才提供不依赖 outbox 的 correctness 保证。完整 drain 规则见 [write-protocol.md](write-protocol.md) §7.1。

Context compiler 还必须读取 [write-protocol.md](write-protocol.md) §5 的 context-suppression tombstones。RAG chunk 保存其全部 source `messageId + contentHash`，任一 source 命中 tombstone 时既不能返回，也不能注入；重新分块时跳过整条匹配消息。Recall 的候选 evidence ref、raw window 与最终文本应用同一过滤。Projection 的异步删除尚未完成时，查询末端过滤仍是不可绕过的 correctness gate。

Correction 后只渲染当前 revision 中 item 的新值，不渲染旧 event/snapshot 内容；forgetItem accepted 后该 item 已从 active state 移除，Renderer 不得以“已作废”等占位文本继续注入。Privacy hard delete 进行中沿用 `rebuilding` 门控，在全存储清除和剩余 source rebuild 校验完成前不得注入旧 projection。

## 4. Proposer 输入与 Gist 边界

Proposer 输入/输出 envelope 的结构、字段语义和边界规则见 [state-contract.md](state-contract.md) §5。本节只补充与上下文接入相关的边界：

- 普通模式的 `observedMessages` 统一来自原始 `chat_messages`，user 与 assistant 消息都使用 raw content。Observer 传入时必须标注 `contentKind: "raw"`。
- 普通写入 patch 的 `evidenceRefs.quote` 必须能在对应 raw message content 中校验（校验策略见 [state-contract.md](state-contract.md) §7）；read-only memory context 不参与 quote 校验。
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
