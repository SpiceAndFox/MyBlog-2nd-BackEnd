# Memory Control v2.1 渲染与上下文接入

本文定义 Memory Control v2.1 / schemaVersion 3 如何从结构化状态变成主聊天模型可读上下文，以及它与 context segment、RAG、raw message evidence 的边界。Renderer 只接受 v3 authority state；开发期不读取或转换 v2 render/state cache，旧派生数据清空后从 raw messages 重建。写入协议见 [write-protocol.md](write-protocol.md)。

## 1. Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列。v2.1/schemaVersion 3 的存储投影保留 `projectionIdentity` 与来源 `observationIds`（可解析到 durable `observationIdentity`）；它们是确定性归并和跨 section 去重依据，不作为文案展示。

Context compiler 还必须与 `memory_state` 同时读取 `chat_memory_target_status` 和 active context-quality diagnostics，作为独立 health sidecar；禁止为了渲染/告警方便把 halted/retry/rebuilding 写回 `memory_state.meta`。健康聚合与持续告警遵循 [write-protocol.md](write-protocol.md) §10。

读取 active diagnostics 前，context assembly 必须 best-effort 同步[异常诊断投影](algorithms/diagnostic-projection.md)。`scene_capacity_exceeded` 令 `[当前状态]` 前出现 `[该类记忆可能滞后]`；响应 `memory_health.alerts` 在通过配置的 `alertDebounceMs` 后说明最近一次更新因长度超限未写入。投影同步失败时保留最后成功投影的告警状态并在 debug 中记录错误，不阻断主聊天。

Renderer 是纯代码模板，不调用 LLM。具体模板见第 5 节。

Renderer 必须：

- 按 `memory_state` 的结构层级区分长期记忆、工作区记忆与近期状态。
- 用明确标题标出哪些是当前状态、哪些是历史背景。
- 不调用 LLM。持久化状态失效、清理和覆盖由 Reducer/housekeeping 维护；但在后台 cleanup 尚未提交时，Renderer 必须按下述同一套纯代码规则构造 effective view。
- 避免因为渲染文案把旧场景强行延续到当前回复。
- 用确定性模板把结构化字段组织成自然、简洁的短句。Proposer 不需要也不应预先拼接 `+`、`→`、`>`、`|` 等展示符号。
- 在跨 section 展示前按 §1.2 的 identity 规则去重；不得用字符串相似度、embedding 或 LLM 猜测两个条目是否相同。
- 保持文本稳定：相同 `memory_state`、相同 lifecycle anchors、相同 requestNow、相同配置与相同 Renderer 代码必须生成相同文本。
- 对 `retry_wait`、`capacity_blocked`、`halted` target 继续渲染最后一次成功提交的稳定 state，但在其负责的 section 前输出稳定标记“该类记忆可能滞后”；不得把旧 state 无提示地称为当前状态。`rebuilding` target 使用“该类记忆正在重建”标记。

标记位置按 target 的固定 section 映射确定：`scene` → 当前状态（previousScene 是已过期历史，不附当前 scene 滞后标记），`todos` → todos，`standingAgreements` → standingAgreements，`episodes` → recentEpisodes/milestones，`profileRelationship` → userProfile/assistantProfile/relationship，`worldFacts` → worldFacts。多个 section 共享一个 target 时，若各 section 在模板中相邻，可在该组的第一个 section 前只输出一次标记；若不相邻（如 `episodes` 的 milestones 与 recentEpisodes 之间隔着其他 section），则应在每个 section 前分别输出标记。active `gap_bridge_truncated` 与 scene capacity active 诊断按其 subject/受影响 target 使用相同“可能滞后”标记。

### 1.1 请求时 Effective View

请求时 effective view 与 housekeeping 必须调用同一纯代码生命周期函数；完整的 scene TTL、Todo overdue/revive、cleanup event 与幂等规则见 [领域生命周期算法](algorithms/domain-lifecycle.md)。Renderer 只消费转换后的运行时 view，不把它持久化为第二份 authority。

schemaVersion 3 的 scene 以 semantic epoch 组织，但四个字段各自持有 evidence anchor/TTL：某一字段被更新只刷新该字段，过期字段在 effective current view 中独立变为“未知”，不得让 mood 更新续期旧 location。`epochTransition.start` 使上一 current epoch 成为唯一 latest previous scene，再展示新 epoch；`epochTransition.end` 归档并清空 current。没有明确 transition 时 Renderer 不根据 session/turn 自行切 epoch。某 epoch 第一个字段 TTL 到期时，共享 lifecycle 函数先以 `endReason=field_ttl` 保存该 epoch 最后一份完整非空快照；同 epoch 其余字段以后分别到期只改变 current effective fields，不得用残缺快照覆盖 previous。全部字段失效后清空 current epoch。

### 1.2 基于 observation/projection identity 的跨 section 去重

同一原始语义可以产生多个合法投影，例如“以后每天做早餐”可能同时更新 agreement，并为当前 scene 提供活动线索。存储层保留每个 section 的合法结构化投影；聊天 context 则按以下规则避免重复强化：

1. `projectionIdentity` 由 Reducer 从 patch 的全部 durable observation roots 确定性派生：单 root 直接使用 root ID，多 root 及 compaction root union 使用同一固定 UUIDv5 set 算法；Proposer/Renderer 都不能按 text 自创。同一 identity 的重试、reaffirm 或跨 section 投影组成一个 render group：纯重复只取最新有效投影；若组内合法 section 投影各有独有结构化语义，则用固定 ownership/priority 模板合成一处表达，不能简单丢掉独有信息。`sourceProjectionIdentities` 只作 provenance；集合部分相交不能触发整项去重，只有最终 projectionIdentity 完全相同才可归为一组。
2. `observationIds` 可解析到 `observationIdentity/root_observation_id`，用于确认共同来源和解释 projection group。不同 `projectionIdentity` 即使共享 observation 主题或 text 相似也不得互相删除；只有显式共享 projection identity 才允许跨 section 去重/合成。ownership 与 priority 是代码配置，不能由当前字符串长短或调用顺序决定。
3. 同一 observation 的一次性 todo 与反复适用的 agreement 是不同语义，若两者都真实成立可以同时渲染；同一句自然文案原样复制到 profile、relationship、episode 等多个 section 则不允许。
4. Observation/candidate 本身、open semantic arc、候选内部判定信息和 noop reason 永不渲染。Episode 只有在 arc 关闭、通过记忆价值门槛并进入最终 `recentEpisodes` 后才展示。
5. identity 缺失是 v3 schema/投影错误，context assembly 按非法 memory state 处理并记录明确 debug reason；不得回退到 v2 字段或模糊文本去重。相同 state、identity 元数据、配置与 Renderer 版本必须得到相同结果。

## 2. Context 接入

首版采用实时 render 路径。Recent window、`needsMemory`、状态门控、user-boundary 裁剪、跳过原因和 GapBridge 的顺序敏感规则统一由 [Context Coverage 算法](algorithms/context-coverage.md) 定义。本文件只负责说明 Renderer 如何把最终 effective view 与 health sidecar 组装为 context segment。

### 2.1 Observation-aware GapBridge

GapBridge 是 context assembly 的覆盖补偿层，合并两类尚未由稳定上下文覆盖的原文：全局 `scannedThroughMessageId` 之后、recent window 之前的未扫描 raw source，以及当前 observation-target lifecycle 仍为 `ready|processing|waiting|retryable|dead_letter` 的 registered evidence。它按 `(messageId,contentHash)` 去重并保留内部 observation-target tags，但不向主模型展示 ID/status。GapBridge 不推进全局 scan checkpoint、不改变 observation-target lifecycle、不写 patch，也不替代正常 source scan/candidate cycle；预算、`gap_bridge_truncated` 诊断及按 `sourceScan|observationTarget` subject 恢复的完整规则见 [Context Coverage 算法](algorithms/context-coverage.md) §2–§3。

## 3. RAG 边界

Memory v2.1 和 RAG 不互相替代。

- Memory 保存当前场景、待办、持续约定、里程碑、长期偏好和关系模式。
- RAG 负责召回具体旧场景、原话和细节。
- Memory 高精度、低容量、持续影响当前回复。
- RAG 高召回、按当前 query 动态取用。

只在某次旧对话中重要、但不应持续影响当前关系状态的事实，应留在 RAG，不进入长期 sections。

Projection checkpoint 的推进与 rebuild 见 [Source Rebuild 与 Projection 算法](algorithms/source-rebuild-and-projection.md)；请求时 `requiredBoundary`、有效检索上界、partial coverage 与健康判断见 [Context Coverage 算法](algorithms/context-coverage.md) §4；correction/forget 后的 tombstone 查询过滤和 privacy hard delete 门控见 [Suppression 与 Retention 算法](algorithms/suppression-and-retention.md)。

## 4. Observer/Proposer 输入与 Gist 边界

Observer/Proposer 输入输出的 v2.1 边界见 [proposer-prompt.md](proposer-prompt.md) §2.6–§2.7。本节只补充与上下文接入相关的边界：

- `semanticSignalObserver` 的 source delta 与专业 Proposer 的 `observedMessages` 都统一来自原始 `chat_messages`，user 与 assistant 消息都使用 raw content，并标注 `contentKind: "raw"`。对专业 Proposer，该字段特指 observations 的最小充分相关原文，不是旧式任意 recent window。session 名称不进入语义输入；reply/turn 元数据只用于源完整性和回复归属。
- 专业 Proposer 必须同时收到待判断 `observations` 和与它们相关的最小充分原文。Observation 用来定位候选，原文用来证明事实；不得只给 observation、episode 摘要或现有 profile 后要求模型继续总结。
- 专业 `observedMessages` 可以包含早于当前 scan delta、batch、overlap 或支持窗口的旧证据。只要它存在于该 observation 的 durable evidence version、未超过 task source boundary 且数据库复核通过，就可以成为合法 evidence；`contextWindow` 不是证据新鲜度边界。
- 普通写入 patch 的 `evidenceRefs.quote` 必须能在对应 raw message content 中校验（校验策略见 [Evidence 校验与 Quote 匹配算法](algorithms/evidence-validation.md)）；read-only memory context 不参与 quote 校验。
- 同一 boundary cycle / `cycleLineageId+reviewEpoch` 触发的多个专业 Proposer 必须使用同一个 as-of memory snapshot。最终 episode/profile 等派生投影只能辅助检索，不能形成“先跑 episodes 才能跑 profile/relationship”的事实依赖；同 source boundary 的后来 semantic review 使用新 lineage显式冻结新 as-of，不与旧 cycle混读。
- 维护模式不向 Proposer 暴露 raw messages、既有 evidenceGroups 或 quote。
- assistant gist 不进入 v3 memory proposer 输入，也不作为 evidenceRefs 来源。

## 5. Renderer 模板

Renderer 是纯代码模板，把结构化 `memory_state` 渲染为稳定、自然且简洁的文本。Renderer 不调用 LLM，不读取 patch/event log，不依赖数据库中的物化 render 文本；它可以读取 authority state 随 item 保存的 projection/observation identity 元数据，以执行 §1.2 的确定性展示去重。

模板中的 `{renderTargetHealthMarker(targetKey)}` 只读取 health sidecar，并按以下优先级输出：target 为 `rebuilding` 时输出“[该类记忆正在重建]”；否则 target 为 `retry_wait/capacity_blocked/halted`，或存在会影响该 target 的 active `gap_bridge_truncated` / `scene_capacity_exceeded` 诊断时输出“[该类记忆可能滞后]”；其余情况输出空字符串。source-scan subject 影响所有尚未获得稳定覆盖的 target，observation-target subject 只影响其 target。该函数不把运行状态写入 `memory_state`。

### 模板

模板执行前先调用纯函数 `buildIdentityDedupedRenderView(effectiveState)`，按 §1.2 生成 `visible`。该函数只选择/归并展示投影，不修改 authority state。

```
[长期核心记忆]
{renderTargetHealthMarker("worldFacts")}
[长期事实]
{renderNaturalItems(visible.longTerm.worldFacts) || "(无)"}
{renderTargetHealthMarker("profileRelationship")}
[User 核心档案]
{renderNaturalItems(visible.longTerm.userProfile) || "(无)"}
[Assistant 核心档案]
{renderNaturalItems(visible.longTerm.assistantProfile) || "(无)"}
[关系模式]
{renderNaturalItems(visible.longTerm.relationship) || "(无)"}

{renderTargetHealthMarker("episodes")}
[重要里程碑]
{renderNaturalItems(visible.longTerm.milestones) || "(无)"}

{renderTargetHealthMarker("standingAgreements")}
[持续约定]
{renderNaturalItems(visible.working.standingAgreements) || "(无)"}

{renderTargetHealthMarker("todos")}
[待办]
{visible.working.todos.filter(t => t.status === "active").map(renderTodo).join("\n") || "(无)"}

[已逾期待办]
{renderOverdueTodosWithinBudget(visible.working.todos, config.overdueTodos)}

{renderTargetHealthMarker("episodes")}
[最近经历]
{renderNaturalItems(visible.working.recentEpisodes) || "(无)"}

{renderTargetHealthMarker("scene")}
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
- `renderNaturalItems` 使用固定语法把 item 的结构化字段和自然语义 text 组织为完整项目，不暴露内部 canonical key、identity、changeKind 或连接符编码。
- `renderTodo` 以自然短句至少表达 text、actor、requester；dueAt 非 null 时同时表达 deadline。active 与 overdue 来自同一个 `working.todos` section，按 status 分组。
- overdue 组按 `becameOverdueAt DESC`、itemId 稳定打破平局，在独立 `maxRenderedItems + maxRenderedChars` 内取完整 items；不得截断单条后伪装完整，也不占 active todo 的 section 容量。
- `current.previousScene` 使用与 scene 相同的四字段快照，并保留契约字段 `epochId/startedAtMessageId/endedAt/endReason`；v3 `renderScene` 只渲染四个语义字段，不输出这些生命周期元数据。它仅在标题 `[已过期场景 / 上次已知场景]` 下渲染，必须明确它不是当前状态。
- schemaVersion 3 的 `previousScene` shape 固定为 `{epochId,startedAtMessageId,endedAt,endReason,location,time,mood,note}`，其中 `endReason=explicit_end|new_epoch|field_ttl`。它永远保存最近真实 epoch 的最后一份完整非空快照；不能因 batch/session 或同 epoch 后续字段逐个过期而降级成残缺快照，也不能回退到更早场景。current 只渲染仍有效的独立字段。
- 除 §1.1 的确定性 effective view 外，Renderer 只表达 state 中已经存在的层级和生命周期，不自行推断语义状态。
- §1.2 的展示去重只抑制重复投影，不删除 state item、不改变 evidence/provenance，也不把一个投影的语义扩展到另一个投影。
- Renderer 只做确定性模板拼接；相同 `memory_state`、相同 lifecycle anchors、相同 requestNow、相同配置与相同 Renderer 代码必须生成相同文本。
- `renderedText` 是运行时产物，只进入本次 context assembly，不写回 `chat_preset_memory`。
- 如果未来确实需要 render 缓存，必须作为非权威缓存设计，并带 `renderer_version`；首版不引入。

---
