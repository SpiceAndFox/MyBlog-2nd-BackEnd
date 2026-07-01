# Memory Control v2 顶层设计（整理版）

## 文档定位

本文定义情感类 AI Chat 的 Memory Control v2 顶层设计。它不是实施排期，也不是任务拆解清单；它规定系统的目标形态、权威状态、写入边界、接口契约、失败处理、迁移原则和不可破坏的设计约束。

后续实现计划必须服从本文。若实现中发现本文判断错误，应先修订本文，再调整代码。

## 1. 核心判断

当前 memory 系统的根本问题不是 prompt 不够强，而是把 memory 当成可反复重写的文本摘要。`rolling summary` 和 `core memory` 在多轮压缩、复述、再解释后，必然出现语义漂移、短期剧情侵入长期档案、旧状态污染当前上下文、待办和场景失控等问题。

Memory Control v2 的核心前提是：

**memory 不是一段文本，而是一组可审计、可更新、可拒绝、可恢复、可渲染的结构化状态。**

LLM 负责观察对话并提出候选变更；Evidence Verifier 负责把证据支持度标成受控标签；最终写入权属于确定性 Reducer。

## 2. 设计目标

1. **受控写入**：所有 memory 变更必须经过结构化 patch、证据验证和 reducer，不允许 LLM 直接覆写最终 memory。
2. **证据可追溯**：重要 memory 必须能追溯到原始 message id 和短证据 quote。
3. **状态分层**：当前场景、人物状态、待办、近期经历、里程碑、长期核心档案分别维护。
4. **低漂移**：旧 memory 只能局部增删改，不能被模型反复全文改写。
5. **可恢复**：系统应能从原始消息、patch 事件和状态快照恢复 memory。
6. **可渲染**：底层是结构化状态，注入主聊天模型时渲染成稳定、紧凑、可读的上下文文本。
7. **可审计**：成功、拒绝、无操作、安全拦截和失败的 patch 决策都必须可查。
8. **主链路稳定**：长上下文模型可增强审计和重建，但主写入链路不依赖它存在。

## 3. 非目标与部署假设

非目标：

- 不兼容旧 rolling/core pipeline 的内部设计。
- 不把 LLM 输出的整段 summary 作为权威状态。
- 不把所有历史都塞进长期记忆。
- 不用缓存或兼容层掩盖状态模型错误。
- 不为追求 section 并行而引入多锁分序。
- 不把旧 v1 memory 文本直接转换为 v2 权威状态。

部署假设：

首版假设单实例部署，进程内队列（沿用 `tickScheduler.enqueueByKey`）足够保证 per-`userId/presetId` 串行。多进程或多实例部署时，进程内队列不再跨进程互斥，必须引入 DB 级锁或基于 `state_revision` 的乐观并发控制。

## 4. 旧系统取舍

旧系统中保留的是工程思想，不是实现形态。

保留：

- 同一 `userId/presetId` 串行写入。
- 消息编辑、删除、会话恢复会使 memory 失效。
- 状态快照用于恢复。

废弃：

- 旧文本 checkpoint 的中心地位；checkpoint 在 v2 中只表示 state snapshot。
- “旧文本 + 新对话 -> 新全文”的更新范式。
- core memory 依赖 rolling summary checkpoint 的严格同步思路。

## 5. 权威状态与存储落点

Memory v2 的权威状态是单一 `state_v2` JSONB blob。它保存当前完整 memory state，并由 Reducer 原子写回。旧 `rolling_summary` 和 `core_memory` 只能作为 legacy 字段存在，不再参与 v2 写入决策。

在现有 `chat_preset_memory` 表新增三列：

- `state_v2 JSONB`：完整权威 memory state。
- `state_v2_render TEXT`：Renderer 输出的完整可读文本，供主聊天热路径直接读取。
- `state_revision BIGINT`：并发写入修订号，不是 schema version。

`state_v2` blob 内置 `v` 字段作为 schema version。Reducer 按 `v` 选择 schema holder，`v` 升级必须走显式迁移函数。`state_revision` 用于并发控制；单实例首版可只递增记录，多实例必须用 `WHERE state_revision = oldRevision` 的乐观写入或 DB 锁。

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
  coreCandidates: [],
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
  (id, text, evidenceRefs, evidenceKind, support, createdAtMessageId, updatedAtMessageId, expiresAtMessageId, tags);
}
```

`scene` 和 `participants` 是当前状态，可以用轻量字段表达，但必须记录最后证据与更新时间。`todos`、`recentEpisodes`、`milestones` 和 `core` 必须保留 item 级证据。

## 6. 记忆分层

| Section          | 作用                           | 生命周期       | 写入原则                                                 |
| ---------------- | ------------------------------ | -------------- | -------------------------------------------------------- |
| `scene`          | 当前地点、时间、氛围、环境锚点 | 高频、覆盖式   | 存完整当前状态；无变化不改                               |
| `participants`   | 用户和助手当前情绪、动作、意图 | 高频、覆盖式   | 只记录当前状态，不承载长期人格                           |
| `todos`          | 未完成承诺、约定、澄清项       | 中频、事件型   | 支持创建、完成、取消、过期；删除必须有终止证据           |
| `recentEpisodes` | 最近几次有意义互动             | 高频、滑动窗口 | 普通 episode 到期自然滚出；重要 episode 可晋升 milestone |
| `milestones`     | 关系或剧情关键转折             | 低频、归档型   | 默认新增或合并；普通日常不得进入                         |
| `core`           | 长期事实、偏好、人格、关系模式 | 低频、晋升制   | 只接受明确设定或稳定重复证据                             |

每个 section 拥有独立 `coveredUntilMessageId`。section 之间独立推进，互不阻塞；写入执行仍受同一 `userId/presetId` 串行队列约束。

## 7. 写入流水线

Memory v2 的写入链路固定为：

1. **Observer**：读取最近对话、当前 state、section cursor、必要 gist 和必要原文。
2. **Proposer**：单次 LLM 调用输出 eligible sections 的候选 patch bundle。
3. **Evidence Verifier**：判断候选 patch 是否被引用证据支持，输出受控 verdict，不写 state。
4. **Reducer**：纯代码执行 policy gate 和 state apply，产出结构化决策。
5. **Renderer**：把最新 state 渲染为主聊天模型可读的 memory 文本。

职责边界：

- Proposer 只提出候选变更，不判断最终可信度，不输出自由置信度分数。
- Evidence Verifier 可以使用 LLM，但只能输出受控标签，不拥有写入权。
- Reducer 不做开放式自然语言理解，只检查 schema、证据引用、Verifier verdict 和 section policy。
- Renderer 不暴露 patch log、event log 或 reducer 细节给主聊天模型。

### 7.1 Observer

Observer 的职责是构造一次 memory tick 的结构化输入。它决定本轮哪些 section eligible、每个 section 观察哪些 message、哪些 assistant 消息用 gist、哪些必须补 raw content。

Observer 必须输出结构化 JSON，不传散乱 prompt 片段。接口见附录 B。

### 7.2 Proposer

Proposer 单次 LLM 调用只覆盖 eligible sections。每个 eligible section 必须输出 `patches | noop | unable_to_decide` 之一。

Proposer 只能输出候选 patch，不判断最终可信度，不输出自由置信度分数。具体 JSON 契约、合法 `op` 和 patch 字段约束统一见附录 B 与附录 C。

如果 Proposer 没提某个 eligible section，Reducer 视为 `hard_error`，不猜测推进。

### 7.3 Evidence Verifier

Evidence Verifier 判断候选 patch 是否被引用证据支持。它必须输出受控标签：

- `verdict`: `supported | ambiguous | unsupported | contradicted | policy_blocked`
- `support`: `explicit | strong_inference | weak_inference | none`
- `evidenceKind`: 见附录 D
- `reasonCodes`: 受控原因码数组
- `verifiedEvidenceRefs`: 已验证 quote 能在原始 message 中找到的证据引用

首版可以只对高风险 patch 强制启用 Verifier，包括 `core`、`milestones`、删除/完成/取消、覆盖旧 item、用户修正、关系状态大改。低风险 `scene`/`participants` 可由 Proposer 同次输出 verifier-compatible 标签，但 Reducer 仍只认同一套受控 verdict。

### 7.4 Reducer

Reducer 是 Policy Gate + State Applier。它不使用 LLM 自评分，不做开放式自然语言判断。

Reducer 必须执行：

- schema 校验
- evidence message id 校验
- evidence quote 存在性校验
- verifier verdict 校验
- section policy 校验
- 冲突检测
- 删除保护
- 长度预算
- 过期清理
- 事件记录

职责顺序敏感，不可随意调换。冲突检测必须在长度预算之前；删除保护必须在过期清理之前。

### 7.5 Renderer

Renderer 把结构化 state 渲染为主聊天模型可读的稳定文本，并写入 `state_v2_render`。

Renderer 必须：

- 区分长期核心记忆与近期状态。
- 明确哪些是当前状态，哪些是历史背景。
- 避免把旧场景强行延续到当前回复。
- 遇到与用户当前陈述冲突的 memory，提示优先澄清。
- 保持文本稳定；未变化 section 不重写表达。

## 8. 路由与触发

v2 不为每个 section 单独调用 Proposer。每次 memory tick 只调用一次 Proposer，输出 eligible sections 的 patch bundle。

`eligible = lag 超过阈值 OR 命中规则触发原因`

规则：

- 每个 section 有独立 lag 阈值。`lag = recent window 末端 message id - 该 section 的 coveredUntilMessageId`。
- 常见强制触发原因包括 `userCorrection`、`todoSignal`、`coreCandidatePromotion`、`dirtyRebuild`、`safetyRetry`。
- 只有 eligible section 才出现在 Proposer 输入和输出契约中。
- Observer 记录每个 section 的 `eligibilityReasons`，供 event 审计和后续调参。
- 非 eligible section 不出现在 Proposer 输出的 `sectionResults` 中，其 cursor 不推进。

哪些 section 发生变化，由 Proposer 的 patch bundle 表达；patch 是否被证据支持，由 Evidence Verifier 输出受控 verdict；哪些 patch 真正写入，由 Reducer 依据 section policy table 决定。

## 9. Cursor 推进规则

Cursor 的职责是证明某段消息已经被可靠处理。任何失败都不能静默吞掉证据，但也不能让格式错误或语义模糊永久卡死 section。

| 结果                    | Cursor 行为          | 说明                                                        |
| ----------------------- | -------------------- | ----------------------------------------------------------- |
| `accepted`              | 推进                 | Reducer 接受 patch                                          |
| `noop`                  | 推进                 | Reducer 确认该消息范围对该 section 无需改动                 |
| `soft_reject`           | 暂不推进             | Verifier verdict 不支持、证据不足、冲突、删除保护等策略拒绝 |
| `unable_to_decide`      | 暂不推进             | Proposer 或 Verifier 无法判定                               |
| `hard_error`            | 有限重试后推进或冻结 | parse/schema/malformed/缺字段/缺 patch result               |
| `safety_policy_blocked` | 暂不推进             | provider 或 safety policy 阻断                              |

`soft_reject` 和 `unable_to_decide` 进入 bounded retry 队列。同消息范围累计达到上限后，记录 skipped event，推进 cursor，并进入 admin review 队列。retry 之间必须有冷冻窗口。

如果某个 section 连续失败，系统冻结该 section cursor，并继续允许其它 section 推进。主聊天仍使用该 section 的上一次稳定 render，不回退到 v1 全量文本摘要。

## 10. Core 晋升机制

`core` 只允许两类写入：

1. 用户或设定文本明确表达的长期事实。
2. 在至少三条 evidence 中重复出现，并跨越至少两个相互分离对话区间的稳定模式（N=3, K=2）。

单次临时剧情、一次性情绪、单场景互动不得进入 core。

N=3/K=2 判定由 Reducer 在 `state_v2.coreCandidates` ledger 中累积完成。Reducer 只能数自己记录的 ledger；没有 ledger，“稳定证据”就是 LLM 声称它看见了三次。

Core patch 与已有 core 冲突时，Reducer 优先保留旧项并记录冲突事件。只有当新证据明确来自用户修正，或具备更强的重复证据时，才允许修改旧 core item。

## 11. 删除与遗忘

遗忘是确定性策略，不是摘要模型的副作用。

- `scene` 和 `participants` 被新状态覆盖。
- `recentEpisodes` 按窗口自然滚出；只有真正关键的 episode 才晋升 `milestones`。
- `todos` 只能因完成、取消、失效或澄清而删除。
- `milestones` 默认不删除，只允许合并、去重和基于明确证据的纠错。
- `core` 删除最保守，必须来自用户修正或强冲突证据。

禁止 Proposer 使用通用 `removeItem`。删除必须表达为更窄的语义 op，例如 `completeTodo`、`cancelTodo`、`expireTodo`、`mergeItems`、`correctItem`。

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

Observer 固定读取最近用户原文，因为用户消息通常承载偏好、承诺、修正和长期事实。Assistant 轮次优先使用 gist；当 patch 需要精确证据、关系突破、里程碑判断或 core 晋升时，再按 message id 拉取 assistant 原文。

## 15. NSFW 与安全策略

情感 RP 里的成人内容不能被 memory 层静默丢弃。对成年且 consensual 的成人互动，Observer 和 Renderer 以客观、摘要化方式记录事件本质、双方意愿、关系变化和稳定偏好，不摘录大段感官描写。

Reducer 不对成人内容做社会规范层面的二次审查；它只校验证据引用、Verifier verdict、冲突、删除规则和稳定性。Provider 安全策略造成的拦截必须显式记录为 `safety_policy_blocked` 事件，不得伪装成 noop 或静默跳过。

## 16. Prompt 管理

Memory worker prompt 必须从 `prompts/memory/*` 读取，不能写死在 service 文件中。Prompt 是 memory policy 的一部分，必须版本化。

每次 Proposer 和 Evidence Verifier 输出都记录 prompt kind 与 version。解析失败、schema 失败、证据失败时，只记录事件，不改 state。

## 17. 迁移原则

v2 是新的权威 memory 设计，不以 v1 兼容为目标。

旧 `rolling_summary` 和 `core_memory` 不直接转换为 v2 state。需要迁移旧会话时，从原始 `chat_messages` 回放生成 v2 patch 和 state。无法回放的旧文本只能作为 legacy reference，不得成为 authoritative memory。

系统上线期间可以保留 feature flag 保护发布风险，但 feature flag 是发布工具，不是架构目标。最终 active memory path 只有 v2。

## 18. 失败与降级

失败时保留上一次稳定 state 和 render。系统不回退到旧的全文摘要重写路径。

- Proposer 输出结构非法：记录 `hard_error`，进入有限重试；重试耗尽后标记 `hard_error_skipped` 并推进 cursor，触发 Observer 降级和 admin 告警。
- Evidence Verifier 输出结构非法、缺少 patch result、或引用不存在的 `patchId`：记录 `hard_error`，进入有限重试；重试耗尽后标记 `hard_error_skipped`。
- Patch 策略拒绝：记录 `soft_reject`，不推进相关 section cursor，进 review/retry 队列。
- Provider 安全拦截：记录 `safety_policy_blocked`，不推进相关 section cursor。
- Section 连续失败：冻结该 section cursor，保留旧 render，其它 section 继续推进。
- 全局连续失败：自动降级 Observer 范围至仅处理 `scene` 和 `participants`，并触发 admin 告警。完全停止 memory 写入只能由人工或明确开关触发。

## 19. 顶层决策清单

| 编号 | 决策              | 结果                                                                                                           |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------- |
| C1   | 权威状态          | `state_v2` JSONB 是唯一权威 memory state                                                                       |
| C2   | 写入权            | Proposer 只产出 patch proposal；Evidence Verifier 只产出受控证据 verdict；Reducer 决定最终写入                 |
| C3   | 事件审计          | accepted、soft_reject、hard_error、noop、unable_to_decide、safety_policy_blocked 全部写入 `chat_memory_events` |
| C4   | Section 推进      | 每个 section 独立 cursor，同一 `userId/presetId` 单队列串行                                                    |
| C5   | LLM 调用          | 每次 tick 单次 Proposer 调用；高风险 patch 进入 Evidence Verifier                                              |
| C6   | Core 晋升         | 只接受明确长期事实或跨区间重复稳定证据                                                                         |
| C7   | Gist 复用         | assistant gist 是辅助输入；用户原文始终是一等输入                                                              |
| C8   | RAG 边界          | RAG 召回具体历史，memory 保存持续状态                                                                          |
| C9   | 迁移              | 旧文本不直接转 v2，旧会话迁移必须基于原始消息回放                                                              |
| C10  | 失败兜底          | 保留稳定 state，不回退到 v1 全文摘要重写                                                                       |
| C11  | 存储落点          | `chat_preset_memory` 新增 `state_v2` JSONB + `state_v2_render` TEXT + `state_revision` BIGINT                  |
| C12  | eligibleSections  | per-section lag 阈值或规则触发原因决定本轮哪些 section 被 Observer 观察                                        |
| C13  | Proposer 输出契约 | 每个 eligible section 必须有 `patches                                                                          | noop | unable_to_decide`+`observedMessageIds` |
| C14  | Evidence Verifier | Verifier 输出受控 verdict、support、evidenceKind 和 reasonCodes；Reducer 不使用 LLM 自评分                     |
| C15  | Evidence ledger   | `state_v2.coreCandidates` 记录候选事实、命中证据、span 来源、冲突项                                            |
| C16  | Renderer 接入     | 新增单一 `memoryV2` segment 注入，v2 可用时禁用旧 core/rolling segment                                         |
| C17  | 部署假设          | 首版单实例；多实例需 DB 锁或基于 `state_revision` 的乐观并发控制                                               |

## 20. 成功标准

Memory Control v2 成功，不是因为摘要更漂亮，而是因为它在长线聊天里表现出以下性质：

- 场景不变时不会被反复润色和漂移。
- 当前人物状态能及时更新，但不会污染长期人格。
- 待办能创建、完成、取消和过期，不会变成永久幽灵项。
- 里程碑只记录真正重要的关系或剧情转折。
- Core memory 不被临时剧情、一次性互动或错误 summary 污染。
- 每条重要 memory 都能解释“为什么现在是这个状态”。
- 主聊天模型拿到的是稳定上下文，而不是越来越混乱的历史压缩文本。

## 21. 设计一句话

Memory Control v2 的本质是：用 LLM 观察历史，用结构化 patch 表达变化，用 Evidence Verifier 标注证据支持度，用确定性 Reducer 控制写入，用事件日志保证可审计，用 Renderer 给主模型提供稳定上下文。

## 附录 A：`chat_memory_events` 表

所有 patch 决策（accepted / soft_reject / hard_error / noop / unable_to_decide / safety_policy_blocked）必须落此表。这是可审计目标的最小落地。

```sql
CREATE TABLE chat_memory_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  tick_id         BIGINT NOT NULL,
  section         TEXT NOT NULL,
  decision        TEXT NOT NULL,
  patch_id        TEXT,
  patch_op        TEXT,
  patch_path      TEXT,
  patch_value     JSONB,
  evidence_message_ids BIGINT[],
  evidence_quotes TEXT[],
  verifier_verdict TEXT,
  support         TEXT,
  evidence_kind   TEXT,
  reason_codes    TEXT[],
  reject_reason   TEXT,
  observed_message_ids BIGINT[],
  eligibility_reasons TEXT[],
  prompt_kind     TEXT,
  prompt_version  TEXT,
  verifier_prompt_kind TEXT,
  verifier_prompt_version TEXT,
  schema_version  INT,
  state_revision_before BIGINT,
  state_revision_after  BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_events_user_preset
  ON chat_memory_events(user_id, preset_id, created_at DESC);

CREATE INDEX idx_memory_events_section_decision
  ON chat_memory_events(user_id, preset_id, section, decision);
```

## 附录 B：Observer 输入与 Proposer 输出

Observer 给 Proposer 的输入：

```json
{
  "tickId": 12345,
  "userId": 1,
  "presetId": "default",
  "schemaVersion": 2,
  "stateRevision": 17,
  "targetMessageId": 124,
  "state": { "v": 2, "rolling": {}, "core": {}, "meta": {} },
  "eligibleSections": {
    "scene": {
      "coveredUntilMessageId": 118,
      "observedMessageIds": [119, 120, 121, 122, 123, 124],
      "eligibilityReasons": ["lagThreshold"]
    },
    "todos": {
      "coveredUntilMessageId": 100,
      "observedMessageIds": [119, 120, 121, 122, 123, 124],
      "eligibilityReasons": ["todoSignal"]
    }
  },
  "messages": [
    { "id": 121, "role": "user", "contentKind": "raw", "content": "明天提醒我把橡皮还给她" },
    { "id": 122, "role": "assistant", "contentKind": "gist", "content": "Assistant 表示会记得提醒。" }
  ]
}
```

Proposer 输出：

```json
{
  "tickId": 12345,
  "observedMessageIds": [120, 121, 122, 123, 124],
  "sectionResults": {
    "scene": {
      "status": "patches",
      "patches": [
        {
          "patchId": "scene:setField:tmp-1",
          "op": "setField",
          "path": "location",
          "value": "教室室内",
          "evidenceRefs": [{ "messageId": 123, "quote": "我们还在教室里" }]
        }
      ]
    },
    "todos": {
      "status": "patches",
      "patches": [
        {
          "patchId": "todos:addItem:tmp-1",
          "op": "addItem",
          "value": { "text": "归还橡皮", "tags": ["短期"] },
          "evidenceRefs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }]
        }
      ]
    },
    "core": {
      "status": "unable_to_decide",
      "reason": "证据不足，需更多观察"
    }
  }
}
```

每个 eligible section 的 `status` 必须是 `patches | noop | unable_to_decide` 之一。非 eligible section 不出现在 `sectionResults` 中。

## 附录 C：Patch Op 合法值

| op                     | 允许 section                                    | 含义                                           |
| ---------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `setField`             | `scene`, `participants`                         | 设置覆盖式状态字段                             |
| `clearField`           | `scene`, `participants`                         | 清除已经失效的覆盖式状态字段                   |
| `addItem`              | `todos`, `recentEpisodes`, `milestones`, `core` | 新增 item                                      |
| `updateItem`           | `todos`, `recentEpisodes`, `milestones`, `core` | 局部更新已有 item                              |
| `mergeItems`           | `todos`, `recentEpisodes`, `milestones`, `core` | 合并重复或高度重叠 item                        |
| `completeTodo`         | `todos`                                         | 将待办标记为完成                               |
| `cancelTodo`           | `todos`                                         | 将待办标记为取消                               |
| `expireTodo`           | `todos`                                         | 将短期待办标记为失效                           |
| `promoteCoreCandidate` | `core`                                          | 将已达阈值的 `coreCandidates` 晋升为 core item |
| `correctItem`          | `todos`, `milestones`, `core`                   | 基于用户明确修正纠错                           |

Patch 约束：

- `patchId` 在同一 tick 内唯一，供 Verifier 和 event log 引用。
- `op` 必须属于上表。
- `path` 对 `setField`、`clearField`、`updateItem` 必填。
- `itemId` 对 `updateItem`、`mergeItems`、`completeTodo`、`cancelTodo`、`expireTodo`、`correctItem` 必填。
- `value` 对 `setField`、`addItem`、`updateItem`、`correctItem` 必填。
- `evidenceRefs` 至少包含一个 `{ messageId, quote }`，除非该 op 是纯确定性清理且由 Reducer 自行触发。
- `quote` 必须是短片段，不保存大段原文。

`coreCandidates` 是 Reducer 维护的内部 ledger，不是 Proposer 可直接写入的 section。

## 附录 D：Evidence Verifier 输入与输出

Verifier 输入：

```json
{
  "tickId": 12345,
  "patches": [
    {
      "patchId": "todos:addItem:tmp-1",
      "section": "todos",
      "op": "addItem",
      "value": { "text": "归还橡皮", "tags": ["短期"] },
      "evidenceRefs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }]
    }
  ],
  "evidenceMessages": [{ "id": 121, "role": "user", "content": "明天提醒我把橡皮还给她" }],
  "stateBrief": {
    "existingTodos": [],
    "existingCoreConflicts": []
  }
}
```

Verifier 输出：

```json
{
  "tickId": 12345,
  "patchResults": [
    {
      "patchId": "todos:addItem:tmp-1",
      "verdict": "supported",
      "support": "explicit",
      "evidenceKind": "user_request",
      "verifiedEvidenceRefs": [
        {
          "messageId": 121,
          "quote": "明天提醒我把橡皮还给她",
          "quoteFound": true
        }
      ],
      "reasonCodes": ["explicit_user_request"],
      "notes": ""
    }
  ]
}
```

合法 `verdict`：

| verdict          | 含义                                   | Reducer 默认处理                         |
| ---------------- | -------------------------------------- | ---------------------------------------- |
| `supported`      | patch 被证据支持                       | 继续按 section policy 判定               |
| `ambiguous`      | 证据可能支持，但语义不清               | `soft_reject` 或 bounded retry           |
| `unsupported`    | 证据不支持 patch                       | `soft_reject`                            |
| `contradicted`   | 证据与 patch 冲突                      | `soft_reject` + conflict event           |
| `policy_blocked` | provider/safety/prompt policy 阻断验证 | `safety_policy_blocked` 或 `soft_reject` |

合法 `support`：

| support            | 含义                                |
| ------------------ | ----------------------------------- |
| `explicit`         | 原文直接表达该事实/请求/修正        |
| `strong_inference` | 强上下文推断，低风险 section 可接受 |
| `weak_inference`   | 弱推断，高风险 section 不接受       |
| `none`             | 无支持                              |

Reducer 不使用 LLM 直出的数字 confidence。若实现需要记录模型自评分，只能作为 debug telemetry，不得参与核心写入决策。

## 附录 E：Evidence Kind 与 Section Policy

`evidenceKind` 合法值：

| evidenceKind             | 说明                                      |
| ------------------------ | ----------------------------------------- |
| `user_request`           | 用户明确请求系统/角色稍后做某事           |
| `user_commitment`        | 用户明确承诺稍后做某事                    |
| `assistant_commitment`   | assistant 明确承诺稍后做某事              |
| `todo_completion`        | 待办已完成                                |
| `todo_cancel`            | 待办被取消                                |
| `todo_expiration`        | 短期待办自然失效或被澄清为不再需要        |
| `scene_change`           | 地点、时间、环境或氛围明确变化            |
| `participant_state`      | 用户或 assistant 当前情绪、动作、意图变化 |
| `recent_episode`         | 最近发生的有意义互动                      |
| `relationship_milestone` | 关系或剧情关键转折                        |
| `user_correction`        | 用户明确修正旧记忆或设定                  |
| `long_term_fact`         | 用户/设定明确表达的长期事实               |
| `core_pattern_hit`       | ledger 中稳定模式的一次命中               |

Section policy：

| section/op                                          | 最低 verdict/support          | 允许 evidenceKind                                         | 备注                              |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| `scene.setField` / `scene.clearField`               | `supported` + `explicit       | strong_inference`                                         | `scene_change`                    | 覆盖式状态；旧场景不得凭空延续      |
| `participants.setField` / `participants.clearField` | `supported` + `explicit       | strong_inference`                                         | `participant_state`               | 只写当前状态，不写长期人格          |
| `todos.addItem`                                     | `supported` + `explicit`      | `user_request`, `user_commitment`, `assistant_commitment` | 模糊愿望不写入                    |
| `todos.completeTodo`                                | `supported` + `explicit`      | `todo_completion`                                         | 删除/完成必须有终止证据           |
| `todos.cancelTodo`                                  | `supported` + `explicit`      | `todo_cancel`, `user_correction`                          | 用户修正优先                      |
| `todos.expireTodo`                                  | `supported` + `explicit       | strong_inference`                                         | `todo_expiration`                 | 仅短期待办允许失效                  |
| `recentEpisodes.addItem`                            | `supported` + `explicit       | strong_inference`                                         | `recent_episode`                  | 滑动窗口，普通 episode 到期自然滚出 |
| `milestones.addItem`                                | `supported` + `explicit`      | `relationship_milestone`, `user_correction`               | 普通日常不得进入                  |
| `core.addItem`                                      | `supported` + `explicit`      | `long_term_fact`, `user_correction`                       | 单次临时剧情不得进入              |
| `core.promoteCoreCandidate`                         | `supported` + `explicit       | strong_inference`                                         | `core_pattern_hit`                | 必须已满足 N=3/K=2 ledger 阈值      |
| `*.updateItem` / `*.mergeItems` / `*.correctItem`   | 不低于目标 section 的新增要求 | 与目标 section 相同，或 `user_correction`                 | 冲突时默认保留旧项并记录 conflict |

## 附录 F：Reducer 与 Renderer 输出

Reducer 输出：

```json
{
  "tickId": 12345,
  "schemaVersion": 2,
  "stateRevisionBefore": 17,
  "stateRevisionAfter": 18,
  "sectionDecisions": {
    "todos": {
      "decision": "accepted",
      "cursorAction": "advance",
      "coveredUntilMessageId": 124,
      "acceptedPatchIds": ["todos:addItem:tmp-1"],
      "rejectedPatchIds": [],
      "reasonCodes": ["explicit_user_request"]
    },
    "core": {
      "decision": "unable_to_decide",
      "cursorAction": "hold",
      "coveredUntilMessageId": 100,
      "acceptedPatchIds": [],
      "rejectedPatchIds": [],
      "reasonCodes": ["insufficient_stable_evidence"]
    }
  },
  "events": ["chat_memory_events rows"],
  "nextState": "{state_v2 JSONB}",
  "nextRender": "{state_v2_render TEXT}"
}
```

合法 `decision`：`accepted | noop | soft_reject | hard_error | unable_to_decide | safety_policy_blocked`。

合法 `cursorAction`：`advance | hold | freeze | skip_after_bounded_retry`。

Renderer 输出：

```json
{
  "stateRevision": 18,
  "renderedText": "[当前状态]\\n- ...",
  "renderedSections": {
    "currentState": "[当前状态]\\n- ...",
    "todos": "[待办]\\n- ...",
    "recentHistory": "[近期背景]\\n- ...",
    "core": "[长期核心记忆]\\n- ..."
  },
  "sourceSectionVersions": {
    "scene": 4,
    "participants": 7,
    "todos": 3,
    "core": 2
  }
}
```

只有 `renderedText` 写入 `state_v2_render` 并进入主聊天热路径；`renderedSections` 可作为 debug/admin 视图使用。

## 附录 G：Core Evidence Ledger

`state_v2.core` 之外，state blob 内维护 `coreCandidates` ledger，支撑 N=3/K=2 晋升判定。

```js
{
  coreCandidates: [
    {
      candidateText: "用户喜欢被摸头",
      stableHits: 3,
      stableSpanSources: [
        {
          spanStart: 100,
          spanEnd: 110,
          evidenceRefs: [
            { messageId: 105, quote: "我一直挺喜欢被摸头的" },
            { messageId: 108, quote: "这样会让我安心" },
          ],
        },
        {
          spanStart: 200,
          spanEnd: 210,
          evidenceRefs: [
            { messageId: 203, quote: "摸头这个设定可以保留" },
            { messageId: 207, quote: "她被摸头时会放松" },
          ],
        },
      ],
      conflicts: [],
      status: "eligible_for_promotion",
      createdAtMessageId: 105,
    },
    {
      candidateText: "用户讨厌早起",
      stableHits: 1,
      stableSpanSources: [],
      conflicts: [
        {
          conflictWith: "用户喜欢清晨散步",
          evidenceRefs: [{ messageId: 150, quote: "我其实很喜欢清晨散步" }],
        },
      ],
      status: "accumulating",
      createdAtMessageId: 120,
    },
  ];
}
```

Reducer 在每次 accept recentEpisodes / milestones 时扫描是否命中已有 candidate 或应新建 candidate，累积 `stableHits` 与 `stableSpanSources`。当 `stableHits >= 3 && distinct(stableSpanSources) >= 2` 时标记 `eligible_for_promotion`，下一次 tick 的 Observer 必须评估该 candidate 是否应晋升为 core item。

## 附录 H：Worker Provider 候选

长上下文、低成本、支持结构化输出的 worker 是增强能力，不是主链路依赖。具体 provider 和 SKU 是可替换实现细节，不属于顶层设计约束。

落地前必须独立核对当前 API 文档的 SKU、规格、价格、JSON 输出能力和 tool/function calling 能力。架构本身不依赖任何特定 provider 或 SKU 存在。
