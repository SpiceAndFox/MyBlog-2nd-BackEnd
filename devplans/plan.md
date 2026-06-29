# Memory Control v2 顶层设计

## 文档定位

本文定义情感类 AI Chat 的 memory control 顶层设计。它不是实施排期，也不是任务拆解清单；它规定系统的目标形态、权威状态、写入边界、失败处理、迁移原则和不可破坏的设计约束。

后续实现计划必须服从本文。若实现中发现本文判断错误，应先修订本文，再调整代码。

## 核心判断

当前 memory 系统的根本问题不是 prompt 不够强，而是把 memory 当成可反复重写的文本摘要。`rolling summary` 和 `core memory` 在多轮压缩、复述、再解释后，必然出现语义漂移、短期剧情侵入长期档案、旧状态污染当前上下文、待办和场景失控等问题。

Memory Control v2 的核心前提是：memory 不是一段文本，而是一组可审计、可更新、可拒绝、可恢复、可渲染的结构化状态。LLM 负责观察对话并提出候选变更，最终写入权属于确定性 reducer。

## 设计目标

1. **受控写入**：所有 memory 变更必须经过结构化 patch 和 reducer，不允许 LLM 直接覆写最终 memory。
2. **证据可追溯**：重要 memory 必须能追溯到原始 message id 或明确事件来源。
3. **状态分层**：当前场景、人物状态、待办、近期经历、里程碑、长期核心档案分别维护，不能混在同一段摘要里。
4. **低漂移**：旧 memory 只能局部增删改，不能被模型反复全文改写。
5. **可恢复**：系统应能从原始消息、patch 事件和状态快照恢复 memory。
6. **可渲染**：底层是结构化状态，注入主聊天模型时渲染成稳定、紧凑、可读的上下文文本。
7. **可审计**：成功、拒绝、无操作和失败的 patch 决策都必须可查。
8. **主链路稳定**：长上下文模型可增强审计和重建，但主写入链路不依赖它存在。

## 非目标

- 不兼容旧 rolling/core pipeline 的内部设计。
- 不把 LLM 输出的整段 summary 作为权威状态。
- 不把所有历史都塞进长期记忆。
- 不用缓存或兼容层掩盖状态模型错误。
- 不为追求 section 并行而引入多锁分序；同一 `userId/presetId` 的 memory 写入保持单队列串行。
- 不把旧 v1 memory 文本直接转换为 v2 权威状态。

**部署假设**：首版假设单实例部署，进程内队列（沿用 `tickScheduler.enqueueByKey`）足够保证 per-(user, preset) 串行。多进程或多实例部署时，进程内队列不再跨进程互斥，必须引入 DB 级锁或基于 `state_revision` 的乐观并发控制。这是已知约束，不是设计缺陷。

## 旧系统取舍

旧系统中保留的是工程思想，不是实现形态。

- 保留同一 `userId/presetId` 串行写入的思想。
- 保留消息编辑、删除、会话恢复会使 memory 失效的思想。
- 保留状态快照用于恢复的思想。
- 废弃旧文本 checkpoint 的中心地位；checkpoint 在 v2 中只表示 state snapshot。
- 废弃“旧文本 + 新对话 -> 新全文”的更新范式。
- 废弃 core memory 依赖 rolling summary checkpoint 的严格同步思路。

## 权威状态

Memory v2 的权威状态是单一 `state_v2` JSONB blob。它保存当前完整 memory state，并由 reducer 原子写回。旧 `rolling_summary` 和 `core_memory` 只能作为 legacy 字段存在，不再参与 v2 写入决策。

**落点**：在现有 `chat_preset_memory` 表新增 `state_v2` JSONB 列、`state_v2_render` TEXT 列和 `state_revision` BIGINT 列（不新建表，复用既有 per-(user, preset) 主键和索引）。`state_v2` blob 内置 `v` 字段作为 schema version，reducer 按 `v` 选 schema holder，`v` 升级走显式迁移函数。`state_revision` 是并发写入修订号，不是 schema version；单实例首版可只递增记录，多实例必须用 `WHERE state_revision = oldRevision` 的乐观写入或 DB 锁。`state_v2_render` 存 renderer 输出的完整 memory 文本，供主聊天只读热路径直接读取，避免反序列化整个 state blob。

概念形态：

```js
{
  v: 2,
  rolling: {
    scene: {},
    participants: {
      user: {},
      assistant: {}
    },
    todos: [],
    recentEpisodes: [],
    milestones: []
  },
  core: {
    worldFacts: [],
    userProfile: [],
    assistantProfile: [],
    relationship: []
  },
  meta: {
    perSectionCursor: {},
    sectionVersions: {},
    promptVersions: {}
  }
}
```

每个可追踪 item 至少包含：

```js
{
  id,
  text,
  evidenceMessageIds,
  confidence,
  createdAtMessageId,
  updatedAtMessageId,
  expiresAtMessageId,
  tags
}
```

`scene` 和 `participants` 是当前状态，可以用轻量字段表达，但必须记录最后证据与更新时间。`todos`、`recentEpisodes`、`milestones` 和 `core` 必须保留 item 级证据。

## 记忆分层

| Section | 作用 | 生命周期 | 写入原则 |
| --- | --- | --- | --- |
| `scene` | 当前地点、时间、氛围、环境锚点 | 高频、覆盖式 | 存完整当前状态；无变化不改 |
| `participants` | 用户和助手当前情绪、动作、意图 | 高频、覆盖式 | 只记录当前状态，不承载长期人格 |
| `todos` | 未完成承诺、约定、澄清项 | 中频、事件型 | 支持创建、完成、取消、过期；删除必须有终止证据 |
| `recentEpisodes` | 最近几次有意义互动 | 高频、滑动窗口 | 普通 episode 到期自然滚出；重要 episode 可晋升 milestone |
| `milestones` | 关系或剧情关键转折 | 低频、归档型 | 默认新增或合并；普通日常不得进入 |
| `core` | 长期事实、偏好、人格、关系模式 | 低频、晋升制 | 只接受明确设定或稳定重复证据 |

每个 section 拥有独立 `coveredUntilMessageId`。section 之间独立推进，互不阻塞；写入执行仍受同一 `userId/presetId` 串行队列约束。

## 写入控制模型

Memory v2 的写入链路固定为：

1. **Observer**：读取最近对话、当前 state、section cursor、必要 gist 和必要原文。
2. **Proposer**：单次 LLM 调用输出一个全 section patch bundle。
3. **Reducer**：纯代码校验并执行 patch，产出 accepted/noop/soft_reject/hard_error 决策。
4. **Renderer**：把最新 state 渲染为主聊天模型可读的 memory 文本。

LLM 不保存最终记忆。Proposer 只能输出候选 patch：

```json
{
  "op": "setField",
  "section": "scene",
  "path": "location",
  "value": "教室室内",
  "evidenceMessageIds": [123, 124],
  "confidence": 0.86
}
```

Reducer 必须执行：

- schema 校验
- evidence message id 校验
- section-specific 规则
- 冲突检测
- 删除保护
- confidence 阈值
- 长度预算
- 过期清理
- 事件记录

上述职责顺序敏感，不可随意调换。关键约束：冲突检测必须在长度预算之前（否则旧条目挤占预算会否决合法新内容），删除保护必须在过期清理之前（否则受保护条目被过期清掉）。

所有 patch 决策都写入 `chat_memory_events`：accepted、soft_reject、hard_error、noop、unable_to_decide 都必须可查。只记录 reject 不够，accepted patch 也必须可追踪。表结构见附录 A。

**Proposer 输出契约**：Proposer 单次 LLM 调用必须输出符合 JSON schema 的结构化结果（schema 见附录 B）。每个 eligible section 必须有明确结果：`patches | noop | unable_to_decide`，并携带 `observedMessageIds`。如果 Proposer 没提某 eligible section，reducer 视为 hard_error（输出契约违反），不猜测推进。`observedMessageIds` 是 reducer 校验 evidence 合法性的依据。

## 路由与触发

v2 不为每个 section 单独调用 LLM。每次 memory tick 只调用一次 Proposer，输出一个全 section patch bundle。但"每次都让 LLM 审所有 section"不比旧摘要好多少——它只是把旧摘要改写换成新型大包输出。因此 v2 引入 **eligibleSections** 机制：

- 每个 section 有独立的 lag 阈值（配置项）。lag = recent window 末端 message id − 该 section 的 `coveredUntilMessageId`。
- `eligible = lag 超过阈值 OR 命中规则触发原因`。规则触发原因由代码层判断，不交给 LLM 自行决定。
- 常见强制触发原因包括：`userCorrection`（用户明确修正事实或记忆）、`todoSignal`（新增/完成/取消待办）、`coreCandidatePromotion`（ledger 候选达到晋升阈值）、`dirtyRebuild`（消息编辑/删除导致重建）、`safetyRetry`（安全拦截后的有限重试）。
- 只有 eligible section 才出现在 Proposer 输入和输出契约中；Observer 记录每个 section 的 `eligibilityReasons`，供 event 审计和后续调参。
- scene/participants 阈值低（高频），core/milestones 阈值高（低频）。这把"不同粒度不同更新时机"落到代码层而非 LLM 层。
- 非 eligible section 不出现在 Proposer 输出的 `sectionResults` 中，其 cursor 不推进（无新观察）。

哪些 section 发生变化，由 Proposer 的 patch bundle 表达；哪些 patch 真正写入，由 reducer 依据 section 规则决定。这套设计保留"按 section 分别判断是否更新"的目标，同时避免多次 LLM 调用和多锁并行带来的复杂度。

## Cursor 推进规则

Cursor 的职责是证明某段消息已经被可靠处理。任何失败都不能静默吞掉证据，但也不能让格式错误或语义模糊永久卡死 section。

- **accepted**：reducer 接受 patch，对应 section cursor 推进。
- **noop**：reducer 确认该消息范围对该 section 无需改动，对应 section cursor 推进。
- **soft reject**（语义拒绝：证据不足、冲突、confidence 低、删除保护触发）：不推进对应 section cursor，事件进入 review/retry 队列。soft reject 实行 bounded retry：同消息范围 soft reject 累计 ≥3 次后，标记 `soft_reject_skipped` 推进 cursor + 进 admin review 队列，不无限重试。retry 之间设冷冻窗口（配置项），不每个 tick 都重试同一段。后续消息可能补足证据，因此 soft reject 的 retry 上限应高于 hard error。
- **unable_to_decide**（Proposer 自述无法判定，非 reducer 拒绝）：与 soft reject 同等处理——不推进 cursor，进 bounded retry 队列。
- **hard error**（结构错误：parse 失败、schema 不合法、malformed JSON、必填字段缺失）：不立即推进 cursor，进入有限重试（bounded retry，上限低于 soft reject）；重试仍失败后，记录 `hard_error_skipped` 事件并推进 cursor，避免永久卡死。连续 hard error 触发 Observer 降级（缩范围或切 prompt 版本）+ admin 告警。

如果某个 section 连续 soft reject 或 hard error，系统冻结该 section 的 cursor，并继续允许其它 section 推进。主聊天仍使用该 section 的上一次稳定 render，不回退到 v1 全量文本摘要。

## Core 晋升机制

`core` 只允许两类写入：

1. 用户或设定文本明确表达的长期事实。
2. 在至少三条 evidence 中重复出现，并跨越至少两个相互分离对话区间的稳定模式（N=3, K=2，硬规则）。

单次临时剧情、一次性情绪、单场景互动不得进入 core。

**Evidence ledger**：N=3/K=2 判定由 reducer 在 `state_v2.coreCandidates` ledger 中累积完成（结构见附录 C）。reducer 是纯代码，只能数自己记的东西；没有 ledger，"稳定证据"就是 LLM 声称它看见了三次。ledger 在每次 accept recentEpisodes / milestones 时扫描更新，累积 `stableHits` 与 `stableSpanSources`；达到阈值后标记 `eligible_for_promotion`，下一次 tick 的 Observer 必须评估晋升。冲突项保留在 ledger 中供 admin review，不自动删除。

Core patch 与已有 core 冲突时，reducer 优先保留旧项并记录冲突事件。只有当新证据明确来自用户修正，或具备更强的重复证据时，才允许修改旧 core item。

## 删除与遗忘

遗忘是确定性策略，不是摘要模型的副作用。

- `scene` 和 `participants` 被新状态覆盖。
- `recentEpisodes` 按窗口自然滚出；只有真正关键的 episode 才晋升 `milestones`。
- `todos` 只能因完成、取消、失效或澄清而删除。
- `milestones` 默认不删除，只允许合并、去重和基于明确证据的纠错。
- `core` 删除最保守，必须来自用户修正或强冲突证据。

## Gist 与原文输入

现有 assistant gist 可以作为低成本辅助输入，但不能替代原始对话。

Observer 固定读取最近用户原文，因为用户消息通常承载偏好、承诺、修正和长期事实。Assistant 轮次优先使用 gist；当 patch 需要精确证据、关系突破、里程碑判断或 core 晋升时，再按 message id 拉取 assistant 原文。

因此 v2 复用现有 gist 能力，但不把当前 assistant-only gist 误当成完整 memory 输入层。

## RAG 边界

Memory v2 和 RAG 不互相替代。

- Memory 保存当前可用状态、待办、里程碑、长期偏好和关系模式。
- RAG 负责召回具体旧场景、原话和细节。
- Memory 高精度、低容量、持续影响当前回复。
- RAG 高召回、按当前 query 动态取用。

只在某次旧对话中重要、但不应持续影响当前关系状态的事实，应留在 RAG，不进入 core memory。

## 长上下文模型的角色

长上下文、低成本、支持结构化输出的 worker 是增强能力，不是主链路依赖。具体 SKU 候选见附录 D。

这类模型适合做：

- 大窗口审计
- 历史一致性检查
- 批量 core 候选复核
- 从原始消息重建 state 的辅助 proposal

它不允许直接覆盖最终 state，也不允许绕过 reducer。

## NSFW 与安全策略

情感 RP 里的成人内容不能被 memory 层静默丢弃。对成年且 consensual 的成人互动，Observer 和 Renderer 以客观、摘要化方式记录事件本质、双方意愿、关系变化和稳定偏好，不摘录大段感官描写。

Reducer 不对成人内容做社会规范层面的二次审查；它只校验证据、冲突、阈值、删除规则和稳定性。Provider 安全策略造成的拦截必须显式记录为 `safety_policy_blocked` 事件，不得伪装成 noop 或静默跳过。

## Prompt 管理

Memory worker prompt 必须从 `prompts/memory/*` 读取，不能写死在 service 文件中。Prompt 是 memory policy 的一部分，必须版本化。

每次 Proposer 输出都记录 prompt kind 与 version。解析失败、schema 失败、证据失败时，只记录事件，不改 state。

## 渲染原则

主聊天模型不应感知 patch log、event log 或 reducer 细节。它只接收 renderer 输出的稳定 memory 文本。

Renderer 必须：

- 区分长期核心记忆与近期状态。
- 明确哪些是当前状态，哪些是历史背景。
- 避免把旧场景强行延续到当前回复。
- 遇到与用户当前陈述冲突的 memory，提示优先澄清。
- 保持文本稳定；未变化 section 不重写表达。

**接入策略**：首版采用兼容 rendered text 路径。v2 renderer 把 state 渲染为完整 memory 文本，落库到 `chat_preset_memory.state_v2_render` 列。上下文装配新增单一 `memoryV2` segment：当 v2 feature flag 开启且 `state_v2_render` 可用时，只由 `memoryV2` 注入完整 v2 memory，旧 `rollingSummary` / `coreMemory` segment 禁用，避免同一份 v2 render 被重复注入。fallback 只在 v2 不可用或 feature flag 关闭时生效，回到旧 `rolling_summary` / `core_memory` 列。这样热路径仍只读一个 TEXT 列，feature flag 切换清晰，后续版本可改为 segment 内部直接读 state blob 并按 section render。

## 迁移原则

v2 是新的权威 memory 设计，不以 v1 兼容为目标。

旧 `rolling_summary` 和 `core_memory` 不直接转换为 v2 state。需要迁移旧会话时，从原始 `chat_messages` 回放生成 v2 patch 和 state。无法回放的旧文本只能作为 legacy reference，不得成为 authoritative memory。

系统上线期间可以保留 feature flag 保护发布风险，但 feature flag 是发布工具，不是架构目标。最终 active memory path 只有 v2。

## 失败与降级

失败时保留上一次稳定 state 和 render。系统不回退到旧的全文摘要重写路径。

- Proposer 输出结构非法（parse/schema/malformed）：记录 `hard_error`，进入有限重试；重试耗尽后标记 `hard_error_skipped` 并推进 cursor，触发 Observer 降级 + admin 告警。
- Patch 语义拒绝（证据不足/冲突/confidence 低/删除保护）：记录 `soft_reject`，不推进相关 section cursor，进 review/retry 队列。
- Provider 安全拦截：记录 `safety_policy_blocked`，不推进相关 section cursor。
- Section 连续失败：冻结该 section cursor，保留旧 render，其它 section 继续推进。
- 全局连续失败：自动降级 Observer 范围至仅处理 `scene` 和 `participants`，并触发 admin 告警；完全停止 memory 写入只能由人工或明确开关触发，不是自动行为。

## 顶层决策清单

| 编号 | 决策 | 结果 |
| --- | --- | --- |
| C1 | 权威状态 | `state_v2` JSONB 是唯一权威 memory state；blob 内置 `v` 字段，reducer 按 `v` 选 schema holder，`v` 升级走显式迁移函数，禁止隐式 schema 漂移 |
| C2 | 写入权 | LLM 只产出 patch proposal，reducer 决定最终写入 |
| C3 | 事件审计 | accepted、soft_reject、hard_error、noop、unable_to_decide 全部写入 `chat_memory_events` |
| C4 | Section 推进 | 每个 section 独立 cursor，同一 `userId/presetId` 单队列串行 |
| C5 | LLM 调用 | 每次 tick 单次 Proposer 调用，仅覆盖 eligible sections 并输出 patch bundle |
| C6 | Core 晋升 | 只接受明确长期事实或跨区间重复稳定证据 |
| C7 | Gist 复用 | assistant gist 是辅助输入；用户原文始终是一等输入 |
| C8 | RAG 边界 | RAG 召回具体历史，memory 保存持续状态 |
| C9 | 迁移 | 旧文本不直接转 v2，旧会话迁移必须基于原始消息回放 |
| C10 | 失败兜底 | 保留稳定 state，不回退到 v1 全文摘要重写 |
| C11 | 存储落点 | `chat_preset_memory` 新增 `state_v2` JSONB + `state_v2_render` TEXT + `state_revision` BIGINT 列；不新建表 |
| C12 | eligibleSections | per-section lag 阈值或规则触发原因决定本轮哪些 section 被 Observer 观察；阈值 scene/participants 低、core/milestones 高 |
| C13 | Proposer 输出契约 | 每个 eligible section 必须有 `patches\|noop\|unable_to_decide` + `observedMessageIds`；缺失 = hard_error |
| C14 | Evidence ledger | `state_v2.coreCandidates` 记录候选事实、命中证据、span 来源、冲突项；N=3/K=2 由 reducer 数 ledger 判定 |
| C15 | Renderer 接入 | 首版兼容 rendered text 落 `state_v2_render` 列；新增单一 `memoryV2` segment 注入，v2 可用时禁用旧 core/rolling segment，fallback 旧列 |
| C16 | 部署假设 | 首版单实例 + 进程内队列；多实例需 DB 锁或基于 `state_revision` 的乐观并发控制 |

## 成功标准

Memory Control v2 成功，不是因为摘要更漂亮，而是因为它在长线聊天里表现出以下性质：

- 场景不变时不会被反复润色和漂移。
- 当前人物状态能及时更新，但不会污染长期人格。
- 待办能创建、完成、取消和过期，不会变成永久幽灵项。
- 里程碑只记录真正重要的关系或剧情转折。
- Core memory 不被临时剧情、一次性互动或错误 summary 污染。
- 每条重要 memory 都能解释“为什么现在是这个状态”。
- 主聊天模型拿到的是稳定上下文，而不是越来越混乱的历史压缩文本。

## 设计一句话

Memory Control v2 的本质是：用 LLM 观察历史，用结构化 patch 表达变化，用确定性 reducer 控制写入，用事件日志保证可审计，用 renderer 给主模型提供稳定上下文。

## 附录 A：接口契约 — `chat_memory_events` 表

所有 patch 决策（accepted / soft_reject / hard_error / noop / unable_to_decide / safety_policy_blocked）必须落此表。这是"可审计"目标的最小落地。

```sql
CREATE TABLE chat_memory_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  tick_id         BIGINT NOT NULL,          -- 同一 tick 的 bundle 共享 id
  section         TEXT NOT NULL,            -- scene|participants|todos|recentEpisodes|milestones|core
  decision        TEXT NOT NULL,            -- accepted|soft_reject|hard_error|noop|unable_to_decide|safety_policy_blocked
  patch_op        TEXT,                     -- setField|addItem|updateItem|removeItem|merge...
  patch_path      TEXT,                     -- section 内路径
  patch_value     JSONB,                    -- 候选值（截断存储）
  evidence_message_ids BIGINT[],            -- patch 携带的证据
  confidence      REAL,
  reject_reason   TEXT,                     -- soft_reject/hard_error 时的具体原因
  observed_message_ids BIGINT[],            -- Proposer 声明观察到的消息范围
  eligibility_reasons TEXT[],               -- Observer 选择该 section 的原因
  prompt_kind     TEXT,
  prompt_version  TEXT,
  schema_version  INT,                      -- state_v2.v，表示 schema version
  state_revision_before BIGINT,             -- 写入前修订号
  state_revision_after  BIGINT,             -- 写入后修订号
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_memory_events_user_preset ON chat_memory_events(user_id, preset_id, created_at DESC);
CREATE INDEX idx_memory_events_section_decision ON chat_memory_events(user_id, preset_id, section, decision);
```

## 附录 B：接口契约 — Proposer 输出 JSON Schema

Proposer 单次 LLM 调用必须输出符合此 schema 的 JSON。解析失败 = hard_error。

```json
{
  "tickId": 12345,
  "observedMessageIds": [120, 121, 122, 123, 124],
  "sectionResults": {
    "scene": {
      "status": "patches",
      "patches": [
        {
          "op": "setField",
          "path": "location",
          "value": "教室室内",
          "evidenceMessageIds": [123, 124],
          "confidence": 0.86
        }
      ]
    },
    "participants": {
      "status": "noop"
    },
    "todos": {
      "status": "patches",
      "patches": [
        {
          "op": "addItem",
          "value": { "text": "归还橡皮", "tags": ["短期"] },
          "evidenceMessageIds": [121],
          "confidence": 0.9
        }
      ]
    },
    "recentEpisodes": {
      "status": "patches",
      "patches": [ "..." ]
    },
    "milestones": {
      "status": "noop"
    },
    "core": {
      "status": "unable_to_decide",
      "reason": "证据不足，需更多观察"
    }
  }
}
```

每个 eligible section 的 `status` 必须是 `patches | noop | unable_to_decide` 之一。非 eligible section 不出现在 `sectionResults` 中。`observedMessageIds` 是 Proposer 声明观察到的消息范围，reducer 用它校验 evidence 合法性。

## 附录 C：接口契约 — Core Evidence Ledger

`state_v2.core` 之外，state blob 内维护 `coreCandidates` ledger，支撑 N=3/K=2 晋升判定。reducer 是纯代码，只能数自己记的东西；没有 ledger，"稳定证据"就是空话。

```js
{
  coreCandidates: [
    {
      candidateText: "用户喜欢被摸头",
      stableHits: 3,
      stableSpanSources: [
        { spanStart: 100, spanEnd: 110, evidenceMessageIds: [105, 108] },
        { spanStart: 200, spanEnd: 210, evidenceMessageIds: [203, 207] }
      ],
      conflicts: [],
      status: "eligible_for_promotion",  // stableHits>=N && distinct(spans)>=K
      createdAtMessageId: 105
    },
    {
      candidateText: "用户讨厌早起",
      stableHits: 1,
      stableSpanSources: [ "..." ],
      conflicts: [{ conflictWith: "用户喜欢清晨散步", evidenceMessageIds: [150] }],
      status: "accumulating",
      createdAtMessageId: 120
    }
  ]
}
```

reducer 在每次 accept recentEpisodes / milestones 时扫描是否命中已有 candidate 或应新建 candidate，累积 `stableHits` 与 `stableSpanSources`。当 `stableHits >= 3 && distinct(stableSpanSources) >= 2` 时标记 `eligible_for_promotion`，下一次 tick 的 Observer 必须评估该 candidate 是否应晋升为 core item。冲突项不删除，保留供 admin review。

## 附录 D：Worker Provider 候选

长上下文、低成本、支持结构化输出的 worker 是增强能力，不是主链路依赖。DeepSeek 官方文档当前列出 `deepseek-v4-flash` 具备 1M context、384K max output、JSON Output 与 Tool Calls 支持，并定位为快速、经济的 V4 选择。参考：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[V4 Preview Release](https://api-docs.deepseek.com/news/news260424)。

落地前必须独立核对当前 API 文档的 SKU、规格与价格。该信息是 worker provider 候选参考，不是顶层设计约束；架构本身不依赖任何特定 SKU 存在。
