# Memory Control 2.01 渲染与上下文接入

本文定义主聊天 Memory Renderer、context segment、RAG/GapBridge 边界，以及它与 `ProposerTaskRenderer` 的区别。写入 artifact 见 [Semantic 写入契约](semantic-write-contract.md)。

## 1. 两类 Renderer

### 1.1 MainChatMemoryRenderer

主聊天 Renderer 把 `memory_state` effective view 渲染为稳定文本：

- 读取当前 authority state、target status 和 active diagnostics；
- 不读取 task artifact、Semantic IR 或 compiled patch；
- 不调用 LLM；
- 不写独立 render authority；
- 相同 state、lifecycle anchors、requestNow、配置和代码生成相同文本；
- 非健康 target 继续使用最后稳定 state，但显示“可能滞后/正在重建”。

### 1.2 ProposerTaskRenderer

写入侧 Renderer 为单个 durable task 生成：

- 人类可读的 writable Memory；
- 人类可读的 read-only Memory；
- 稳定短 refs；
- observed raw messages；
- 私有 ref map 与 message metadata。

它不复用主聊天的完整模板，也不向 Proposer暴露存储 JSON、真实 itemId 或 provenance。详细契约见 [Semantic 写入契约 §3](semantic-write-contract.md)。

## 2. Main Chat Effective View

请求时 effective view 与后台 housekeeping 调用同一组纯代码生命周期函数：

- 已过 TTL 的 current scene 在运行时 view 中移到 previousScene；
- 到期 active Todo 在 view 中显示为 overdue；
- 发现尚未持久化的 lifecycle 变化时幂等唤醒 housekeeping；
- effective view 不是第二份 authority。

Scene field provenance 已从单个 evidence ref 改成 `sourceRefs[]`，但主聊天 Renderer 只渲染 value，不渲染 provenance。

## 3. Context 接入

Recent window、`needsMemory`、user-boundary 裁剪和 GapBridge 顺序继续由 [Context Coverage 算法](algorithms/context-coverage.md) 定义。

- `needsMemory=false`：不注入 Memory；
- `needsMemory=true` 且 state `version="2.01"`、schema valid：注入单一 `memory` segment；
- state 缺失、版本不支持或 schema invalid：跳过并记录明确 debug reason；
- target 非健康或存在 active diagnostic：Renderer 在对应 section 前显示稳定标记；
- main recent window 可跨 session 并保留 user-boundary 裁剪；Memory Observer 不复用该裁剪。

## 4. GapBridge

GapBridge 继续补偿 target cursor 与 recent window 起点之间未被 Memory 覆盖的 raw messages：

- 多 target 去重后注入；
- 只保留完整消息，不截断单条；
- 超预算保留最近 N 条完整消息并持久化 omitted diagnostic；
- 不推进 Memory cursor，不写 Semantic IR/Patch，不替代 worker；
- omitted 令受影响 target degraded，覆盖后恢复并创建 notification。

## 5. RAG/Recall 边界

- Memory 保存持续状态和长期档案；
- RAG/Recall 召回具体旧场景、原话和细节；
- 二者在 context compiler 并列，不互相替代；
- RAG/Recall 仍受 `sourceGeneration + processedBoundary + requiredBoundary` 限制；
- correction/forget 不再创建 suppression tombstone，也不改变 RAG/Recall 查询结果；
- raw source edit/delete/restore 通过 generation rebuild 处理；
- privacy hard delete 物理删除对应 RAG/Recall 派生数据。

RAG chunk 可以继续保存 source refs，用于 generation一致性、来源检查和 privacy purge verification；它们不再用于 correction/forget filtering。

## 6. Proposer 输入边界

- observed messages 统一来自 raw `chat_messages`；
- public input 显示 `messageId/role/createdAt/content`，不显示 contentHash；
- direct `evidenceMessageIds` 只能选本 task 实际显示的消息；
- read-only `supportRefs` 只能选本 task 实际显示的辅助 Memory；
- support ref 的底层 source 可以位于 observed window 之外，由 Compiler 查询和验证；
- `assistant gist` 不进入 Memory Proposer；
- retry/repair/context expansion 使用同一 Memory ref map；context expansion新增消息时，expanded public input与覆盖其全部消息的 private messageMeta必须作为同一 durable expanded artifact持久化；
- Provider prompt/response 不写入 append-only日志。

## 7. 主聊天模板

```text
[长期核心记忆]
{health(worldFacts)}
[长期事实]
{worldFacts || "(无)"}

{health(profileRelationship)}
[User 核心档案]
{userProfile || "(无)"}
[Assistant 核心档案]
{assistantProfile || "(无)"}
[关系模式]
{relationship || "(无)"}

{health(episodes)}
[重要里程碑]
{milestones || "(无)"}

{health(standingAgreements)}
[持续约定]
{standingAgreements || "(无)"}

{health(todos)}
[待办]
{activeTodos || "(无)"}
[已逾期待办]
{overdueTodosWithinBudget || "(无)"}

{health(episodes)}
[最近经历]
{recentEpisodes || "(无)"}

{health(scene)}
[当前状态]
- 地点: {location || "未知"}
- 时间: {time || "未知"}
- 氛围: {mood || "未知"}
- 备注: {note || ""}

[已过期场景 / 上次已知场景]
{previousScene || "(无)"}
```

规则：

- 只渲染 state value 与 Todo领域字段，不渲染 sourceRefs、IDs、events 或 reducer detail；
- recentEpisodes 不硬编码 last N，由 Reducer 容量维护；
- Todo 表达 actor/requester，dueAt 非空时表达期限；
- overdue 使用独立条数/字符预算；
- previousScene 明确标成历史，不伪装成当前；
- `renderedText` 只存在于本次 context assembly。
