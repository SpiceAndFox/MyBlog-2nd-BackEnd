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

所有 patch 决策都写入 `chat_memory_events`：accepted、soft_reject、hard_error、noop 都必须可查。只记录 reject 不够，accepted patch 也必须可追踪。

## 路由与触发

v2 不为每个 section 单独调用 LLM。每次 memory tick 只调用一次 Proposer，输出一个全 section patch bundle。哪些 section 发生变化，由 Proposer 的 patch bundle 表达；哪些 patch 真正写入，由 reducer 依据 section 规则决定。

这套设计保留“按 section 分别判断是否更新”的目标，同时避免多次 LLM 调用和多锁并行带来的复杂度。

## Cursor 推进规则

Cursor 的职责是证明某段消息已经被可靠处理。任何失败都不能静默吞掉证据，但也不能让格式错误永久卡死 section。

- **accepted**：reducer 接受 patch，对应 section cursor 推进。
- **noop**：reducer 确认该消息范围对该 section 无需改动，对应 section cursor 推进。
- **soft reject**（语义拒绝：证据不足、冲突、confidence 低、删除保护触发）：不推进对应 section cursor，事件进入 review/retry 队列；下次 tick 重新评估该消息范围，因后续消息可能补足证据。
- **hard error**（结构错误：parse 失败、schema 不合法、malformed JSON、必填字段缺失）：不立即推进 cursor，进入有限重试（bounded retry）；重试仍失败后，记录 `hard_error_skipped` 事件并推进 cursor，避免永久卡死。连续 hard error 触发 Observer 降级（缩范围或切 prompt 版本）+ admin 告警。

如果某个 section 连续 soft reject 或 hard error，系统冻结该 section 的 cursor，并继续允许其它 section 推进。主聊天仍使用该 section 的上一次稳定 render，不回退到 v1 全量文本摘要。

## Core 晋升机制

`core` 只允许两类写入：

1. 用户或设定文本明确表达的长期事实。
2. 在至少三条 evidence 中重复出现，并跨越至少两个相互分离对话区间的稳定模式（N=3, K=2，硬规则）。

单次临时剧情、一次性情绪、单场景互动不得进入 core。

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

长上下文、低成本、支持结构化输出的 worker 是增强能力，不是主链路依赖。DeepSeek 官方文档当前列出 `deepseek-v4-flash` 具备 1M context、384K max output、JSON Output 与 Tool Calls 支持，并定位为快速、经济的 V4 选择。参考：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[V4 Preview Release](https://api-docs.deepseek.com/news/news260424)。

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
| C3 | 事件审计 | accepted、soft_reject、hard_error、noop 全部写入 `chat_memory_events` |
| C4 | Section 推进 | 每个 section 独立 cursor，同一 `userId/presetId` 单队列串行 |
| C5 | LLM 调用 | 每次 tick 单次 Proposer 调用，输出全 section patch bundle |
| C6 | Core 晋升 | 只接受明确长期事实或跨区间重复稳定证据 |
| C7 | Gist 复用 | assistant gist 是辅助输入；用户原文始终是一等输入 |
| C8 | RAG 边界 | RAG 召回具体历史，memory 保存持续状态 |
| C9 | 迁移 | 旧文本不直接转 v2，旧会话迁移必须基于原始消息回放 |
| C10 | 失败兜底 | 保留稳定 state，不回退到 v1 全文摘要重写 |

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
