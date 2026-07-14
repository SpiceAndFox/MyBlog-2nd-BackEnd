# Context Coverage 算法

本文是主聊天 recent window、`needsMemory`、per-target GapBridge、RAG/Recall 查询截止点和 projection 查询时健康判断的单一权威来源。Renderer 模板见 [渲染与上下文接入](../rendering-and-context.md) §5；sidecar DDL 见 [状态契约](../state-contract.md) §9.7、§9.9、§9.10。

## 1. Recent Window 与 needsMemory

Context compiler 先从该 user/preset 的有效 user/assistant raw messages 构造跨 session 候选历史，再以集中配置的 Unicode code point 阈值计算 `needsMemory`。只使用这一项逻辑门控，不再同时叠加 message count、tokenizer 估算或 provider context 百分比：

1. 候选历史的 raw content Unicode code point 总数不超过阈值时，recent window 保留全部消息，`needsMemory=false`，不注入 `memory`。
2. 超过阈值时，recent window 从最新消息向前选择不超过同一字符阈值的完整消息，再应用既有 user-boundary 裁剪，令 `needsMemory=true`。
3. 最新一条消息即使单独超过逻辑阈值也必须完整保留。不得截断单条 raw message 来伪装成完整消息；provider 的物理 context 上限是另一层能力边界。
4. `needsMemory=true` 后，`chat_preset_memory.memory_state` 存在且 schema 校验通过时，`memory` 读取结构化状态并调用 Renderer 实时生成完整 memory 文本；`memory_state` 不存在、`version` 不支持或 schema 校验失败时，`memory` segment 不注入。

recent window 可以跨 session，session 只保留为消息元数据；不得插入会改变 Proposer 或主聊天语义处理的 session boundary 控制标记。主聊天 recent window 保留 user-boundary 裁剪，Memory Observer 按 target cursor 读取完整 source，两者不能复用同一个裁剪结果。

除 `needsMemory=false` 外，跳过注入时必须记录原因（state 不存在 / version 不支持 / schema 校验失败），写入 debug payload 供排查，不得静默跳过。

## 2. Per-target GapBridge

`needsMemory=true` 时，recent window 可能已经移除某个 target 尚未处理的尾批。Context compiler 必须用每个 normal target 的 cursor 补齐这段 raw-message coverage，不依赖 legacy `summarizedUntilMessageId`：

1. 令 `R` 为 user-boundary 裁剪后 recent window 第一条消息的 messageId，`C` 为该 target 的 `coveredUntilMessageId`。按该 target 的完整有效 source 查询满足 `C < messageId < R` 的消息；这组消息是该 target 的有效 gap。没有 recent window 或 `C >= R` 时该 target 没有 gap。
2. GapBridge 使用独立于 Memory Renderer section 容量的逻辑 Unicode code point 预算。所有未超预算的 gap 消息以完整 raw message 注入单一 `gapBridge` context segment；多个 target 引用同一消息时只注入一次，同时保留该消息覆盖的 target keys。
3. 合并去重后的 gap 超预算时，不调用 LLM 压缩。先按 messageId 倒序选择同时满足集中配置的最近 N 条上限与字符预算的完整消息，再恢复为 messageId 升序注入。不能只截取消息正文的一部分。
4. 单条消息本身超过预算时，该消息计入 omitted，不注入截断版本；使用 LLM 压缩或其他精细处理留给 [Gap Compressor 延后设计](../../deferred/memory-control-v2/gap-compressor.md)。
5. 任何 omitted 都必须按受影响 target 写入 `chat_context_quality_diagnostics`，至少保存 requestId、userId/presetId、subjectKind/subjectKey、targetCursor、R、原 gap 条数/字符数、保留边界、保留条数、omitted 条数/字符数和 `omitted_upper_message_id`，并明确 `truncated=true`。完整 gap 不需要写持久化成功记录。
6. 记录保持 active，直到该 target cursor 覆盖其 `omitted_upper_message_id`，或后续 context assembly 在同一事务锁定当前 generation/state，并证明原省略区间 `(target_cursor, omitted_upper_message_id]` 已无有效 source；不能把带历史 `upToMessageId` 的本次 gap 查询为空当作全局证明，也不能只因请求结束而清除。
7. 截断不阻断主聊天，但受影响 target 必须一直视为上下文覆盖不完整：用户侧进入 degraded 并持续告警“部分早期对话未在上下文中”，注入的旧 target state 标记为“可能滞后”。resolved 后才清除告警并创建恢复通知。

同一 generation 内的 active GapBridge diagnostic 更新必须令 `omitted_upper_message_id` 单调不减。多个 context 请求并发或乱序完成时，较早/较小的历史查询不得覆盖较新请求已经记录的更大遗漏上界；恢复事务也必须重新校验当前行没有超出本次已证明覆盖的上界。

GapBridge 的逻辑预算只限制该 segment，自身不占用或改变任何 Memory section 的 `maxItems/maxRenderedChars`；其最终文本仍计入主模型不可突破的物理 context 上限。GapBridge 只补主聊天上下文，不推进 target cursor、不写 patch，也不替代后续正常 Memory task。

## 3. RAG/Recall 查询边界

Memory 保存当前场景、待办、持续约定、里程碑、长期偏好和关系模式；RAG 负责召回具体旧场景、原话和细节。两者互不替代。

RAG/Recall 查询截止点与 projection 告警边界使用以下三个术语：

- `sourceBoundary`：当前 `sourceGeneration` 下最新有效 source messageId。
- `requiredBoundary`：本次主聊天查询需要 RAG/Recall 覆盖到的历史截止点，定义为 `recentWindowStartMessageId - 1`，因为 `messageId >= recentWindowStartMessageId` 的消息已由 recent window 完整覆盖，RAG/Recall 不再需要。
- `processedBoundary`：projection checkpoint 中实际已处理到的 `processedBoundaryMessageId`。

RAG/Recall 查询时，有效检索上界为 `min(processedBoundary, requiredBoundary)`。该上界约束完整检索结果，包括命中的 projection chunk、为 chunk 附加的前后 raw dialogue 和据此生成的 Scene Recall；enrichment 不得越过 cutoff 重新读取更晚消息。六个 Memory target cursor 与 RAG/Recall cutoff 相互独立：Memory cursor 追平不代表 RAG/Recall 追平，反之亦然。

Projection 告警条件：

- `processedGeneration != sourceGeneration` → 该 projection 为 `rebuilding`；
- `processedGeneration == sourceGeneration AND processedBoundary < requiredBoundary` → 该 projection 为 `degraded`，告警“部分早期对话未在上下文中”；
- `processedGeneration == sourceGeneration AND processedBoundary >= requiredBoundary` → 该 projection 为 `healthy`，即使 `processedBoundary < sourceBoundary`，因为 projection 落后范围全部在 recent window 内，不影响本次查询。

这里的 `healthy/degraded/rebuilding` 是本次 context query 的覆盖健康判断，不改写 projection worker/checkpoint 的运行状态；worker 是否已追平其 captured source boundary 仍由 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) 决定。两者必须使用不同的代码类型或字段名，避免把“本次查询所需范围已覆盖”误写成“projection 已全量追平”。

Projection 只部分覆盖 `requiredBoundary` 时（`processedBoundary > 0` 但 `< requiredBoundary`），仍注入已处理部分的结果，并在注入时明确标记检索范围不完整。不因部分落后而完全跳过 projection 注入。

Context compiler 只能把 `processedGeneration == sourceGeneration AND processedBoundary >= requiredBoundary` 的 projection 当作完整当前结果。未满足此条件的 projection 必须保持 `degraded/rebuilding` 告警，不得把旧 projection 无提示注入或声称为当前状态。

同一 generation 内持久化的 active projection-lag diagnostic 也必须保留已经观察到的最大 `requiredBoundary`。较小边界的并发/历史请求可以在自身响应中判定 query-scoped healthy，但不得据此 resolve 一个仍要求更大边界的 active diagnostic 或发送虚假恢复通知。

## 4. 健康标记与恢复通知

Renderer 对 `retry_wait`、`capacity_blocked`、`halted` target 继续渲染最后一次成功提交的稳定 state，但在其负责的 section 前输出稳定标记“该类记忆可能滞后”；`rebuilding` target 使用“该类记忆正在重建”标记。

多个 section 共享一个 target 时，若各 section 在模板中相邻，可在该组的第一个 section 前只输出一次标记；若不相邻（如 `episodes` 的 milestones 与 recentEpisodes），则应在每个 section 前分别输出标记。GapBridge active omitted 诊断按其 target 使用相同“可能滞后”标记。

恢复通知按健康来源写入 `subject_kind/subject_key`，使用 best-effort once 语义：同一恢复事件只创建一行 notification；响应传输成功后由响应层 best-effort 标记 delivered。它不保证恰好一次 delivery，允许响应成功但 delivered 更新前崩溃导致的重复投递。

## 5. 当前总 Context 预算边界

当前各 segment 仍使用独立逻辑预算，尚未引入 provider/model 统一总 context 裁剪。当前部署前提与未来算法见 [总 Context 预算与降级顺序（延后）](../../deferred/memory-control-v2/total-context-budget.md)。GapBridge 与 RAG 的内容重叠当前明确接受，见 [GapBridge 与 RAG 内容重叠（延后）](../../deferred/memory-control-v2/gap-bridge-rag-overlap.md)。

## 6. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.8、§3.9、§3.10。
