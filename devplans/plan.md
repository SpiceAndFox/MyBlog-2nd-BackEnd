# Memory Control v2 顶层设计

## 文档定位

本文不是实施排期，也不是任务拆解清单。它定义的是情感类 AI Chat 的 memory control 顶层设计：系统为什么要重构、什么状态应被记住、谁有权改写记忆、哪些约束不可破坏，以及未来具体实现应服从哪些设计原则。

文档同时收录一组已经拍板的顶层决策（见末尾"顶层设计决策清单"）。这些决策不是实施细节，而是构成设计的硬约束 —— 实施计划必须服从本文，而非反过来用局部工程便利牵引整体设计。

本文修订版在初版基础上补齐了三项被回避的顶层决策（存储模型、路由与触发模型、core 晋升机制），并显式回答了失败兜底、迁移策略、NSFW policy、与既有 gist/RAG 能力的复用关系。

## 核心判断

当前 memory 系统的根本问题不是 prompt 不够强，而是把 memory 当成可反复重写的文本摘要。`rolling summary` 和 `core memory` 在多轮压缩、复述、再解释后，必然出现语义漂移、状态混杂、旧事实污染新上下文、短期剧情侵入长期档案等问题。

Memory Control v2 的设计前提是：memory 不是一段文本，而是一组可审计、可更新、可拒绝、可渲染的状态。LLM 可以帮助观察和提出修改，但不能直接成为最终状态的写入者。

## 设计目标

1. **受控**：所有 memory 变更必须经过结构化 patch、确定性校验和 reducer。
2. **有证据**：重要记忆必须能追溯到原始 message id 或明确事件来源。
3. **分层**：短期状态、近期剧情、待办、里程碑、长期核心档案分别维护，不混在同一段摘要里；每条 section 拥有独立的推进游标与重叠判定。
4. **低漂移**：旧 memory 不应被模型反复自由改写；允许局部增删改，不允许无边界全文重写。
5. **可恢复**：系统应能从事件日志、快照和原始对话重建状态，而不是依赖某一次 LLM 输出。
6. **可渲染**：底层是结构化状态，但注入主聊天模型时必须渲染成稳定、清晰、紧凑的上下文文本。
7. **可审计**：长上下文模型用于复核和提出修复建议，而不是绕过控制层直接覆盖 memory；reducer 的拒绝事件必须落表可查。
8. **可复用**：v2 必须建立在既有的 message gist 与 RAG 通路之上，不能另起一套对话读取通路。

## 非目标

- 不追求兼容旧 rolling/core pipeline 的内部实现。
- 不让模型输出的整段 summary 成为权威状态。
- 不把所有历史都塞入长期记忆。
- 不用缓存或兼容层掩盖状态模型错误。
- 不为追求"完全并行 section 更新"而引入多锁分序。
- 不无视线上既有数据 —— 旧会话通过 feature flag 维持 v1，不强制迁移（详见"迁移策略"）。

## 旧系统取舍

旧系统中值得保留的是少量工程思想，而不是具体实现。

- 保留"同一 user/preset 的 memory 写入需要串行化"的思想。沿用 `tickScheduler.enqueueByKey` 的 per-(user, preset) 单一串行队列。
- 保留"消息编辑、删除、会话恢复会导致 memory 失效"的思想。
- 保留"状态需要可恢复"的思想。
- 复用既有 `services/chat/memory/gistPipeline.js` 的 per-message gist（落表 `chat_message_gists`）作为 Observer 的低成本输入，而不是另起对话原文全量读取通路。
- 复用既有 `services/chat/rag/*`（chunker / indexer / retriever / sceneRecall）作为记忆之外的召回通路，与 memory 各司其职。
- 废弃"checkpoint 保存旧文本摘要"的中心地位。
- 废弃"旧文本 + 新对话 -> 新全文"的更新范式。
- 废弃 core memory 依赖 rolling summary checkpoint 的严格同步思路。

在 v2 中，checkpoint 应被重新理解为 **state snapshot**；恢复依据应是 **原始消息 + patch event log（如启用）+ snapshot**，而不是某个历史时刻的非结构化 summary 文本。首版不强加事件溯源，patch 不独立成表；reducer 的拒绝事件单独成表，确保"可审计"目标的最小落地。

## 记忆分层

Memory v2 将记忆拆成不同生命周期的 section。每个 section 有自己的更新条件、删除规则、证据强度，以及**独立的 `coveredUntilMessageId` 推进游标**。section 之间彼此独立推进，互不阻塞，但都受单一 per-(user, preset) 串行队列约束。

| Section | 作用 | 生命周期 | 更新原则 | 证据强度要求 |
| --- | --- | --- | --- | --- |
| `scene` | 当前场景锚点，如地点、时间、氛围 | 高频、覆盖式 | 存完整当前状态；无变化则不改 | 最近 1 条 evidenceMessageId 即可 |
| `participants` | 当前人物状态，如情绪、动作、意图 | 高频、覆盖式 | 只记录当前状态，不承载长期人格 | 最近 1 条 evidenceMessageId 即可 |
| `todos` | 未完成承诺、约定、澄清项 | 中频、事件型 | 支持创建、完成、取消、过期；删除必须有证据 | ≥1 条 evidenceMessageIds；必须有 `createdAtMessageId` |
| `recentEpisodes` | 最近几次有意义互动 | 高频、滑动窗口 | 允许追加和合并，不允许反复改写旧含义 | 每条 episode ≥1 条 evidenceMessageIds |
| `milestones` | 关系或剧情关键里程碑 | 低频、近似归档 | 默认 append/merge；普通日常不得进入 | 每条 milestone ≥2 条来自不同 message span 的 evidence；默认不删除 |
| `core` | 长期事实、偏好、人格、关系模式 | 低频、晋升制 | 必须层叠证据；不接受单次临时事件污染 | "稳定证据"：相同时效命中的 evidence 出现 ≥N 条、且来源 spans ≥K 个不同 message 区间（N、K 由配置定义，初版建议 N=3、K=2） |

这套分层的重点不是"标题变多"，而是每个 section 的写入权、删除权、更新频率、证据门槛和推进游标不同。

## 状态模型

权威 memory 应是结构化 state，而不是文本。按存储模型决策（见末决策清单 C1），首版采用单一 JSONB blob 落库，reducer 在内存中跑 patch 后整体写回；reject 事件单独成表用于审计。

概念形态：

```js
{
  v: 2,
  rolling: {
    scene: { location?, time?, mood?, note?, updatedAtMessageId, evidenceMessageIds: [...] },
    participants: {
      user:   { emotion?, action?, intent?, updatedAtMessageId, evidenceMessageIds: [...] },
      assistant: { emotion?, action?, intent?, updatedAtMessageId, evidenceMessageIds: [...] },
    },
    todos: [ /* todo item */ ],
    recentEpisodes: [ /* episode item */ ],
    milestones: [ /* milestone item */ ],
  },
  core: {
    worldFacts: [ /* item */ ],
    userProfile: [ /* item */ ],
    assistantProfile: [ /* item */ ],
    relationship: [ /* item */ ],
  },
  meta: {
    perSectionCursor: { scene, participants, todos, recentEpisodes, milestones, core },
    proposedByPromptVersion: { observer, renderer, redisCompiler },
    lastRejectCountBySection: { /* section -> int */ },
  },
}
```

每个可追踪 item（todos / recentEpisodes / milestones / core.* 等）字段：

```js
{
  id,                          // section 内稳定 id
  text,                        // 高密度短语，禁止完整句子
  evidenceMessageIds: [...],    // 必填，证据回溯
  confidence,                  // 0~1，reducer 用于阈值判定
  createdAtMessageId,
  updatedAtMessageId,
  expiresAtMessageId,          // 可空；过期由 section 规则决定
  tags: [...],                 // 可选
  stableHits,                  // core 专用，晋升计数器
  stableSpanSources            // core 专用，命中过的不同 message 区间
}
```

`scene` 和 `participants` 因属当前状态，可只记录最后更新时间和证据来源，免 item 完整字段；但 `core`、`milestones`、`todos` 必须具备上述完整证据约束。

## 存储与持久化模型（决策 C1）

- **权威状态**：`chat_preset_memory` 表新增 `state_v2` JSONB 列（与既有 `rolling_summary`/`core_memory` 两列并存，老列在迁移期内只读保留），单一 blob 落库，reducer 内存跑 patch 整体写回。
- **per-(user, preset) 串行**：沿用 `tickScheduler.enqueueByKey`，单锁串行，section reducer 内部为纯函数无锁；不为"并行 section"做锁分序。
- **崩溃恢复**：首版依赖 reducer 串行 + 整体写入的原子性 + 既有 `chat_preset_memory_checkpoints` 的 state snapshot 能力（snapshot 内容由文本改为 JSONB blob）。
- **事件溯源**：首版不强加 append-only patch 事件表；仅在 reducer 拒绝 patch 时落 reject 事件行（表 `chat_memory_reject_events`），后续按需要再升级到完整事件溯源。
- **schema 演进**：state blob 内置 `v` 字段，reducer 按 `v` 选择 schema holder；`v` 升级走显式迁移函数，禁止隐式。

## 写入控制模型

Memory v2 的写入链路分为四个职责层：

1. **Observer**：读取近期对话 gists + 必要原文增量、当前 state、各 section 的 per-section cursor，组装成单次 LLM 请求输入。
2. **Proposer**：单次 LLM 调用，输出一份**全 section patch bundle**（包含零或多个 patch），每个 patch 携带 op、section、path、value、evidence、confidence。
3. **Reducer**：纯代码串行执行 reducer 链，逐 patch 决定 accept/reject/noop，对通过的 patch 应用到 state。
4. **Renderer**：把 state 渲染成主聊天模型可读的 memory 文本，按 section 的 `updatedAt` 做缓存。

LLM 的职责是"提出候选变更"，不是"保存最终记忆"。最终写入必须由 reducer 决定。

典型 patch 概念：

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

Reducer 链必须**按下列顺序**执行（顺序敏感，不可调换）：

1. schema 校验（结构、必填字段、枚举值）
2. 证据校验（`evidenceMessageIds` 必须是真实存在的且在 tick covered 范围内的 message id）
3. conflict 检测（与同 section 现有条目按 id/path 命中，决定 merge / replace / reject）
4. section-specific 规则（晋升稳定证据、删除保护、过期）
5. confidence 阈值（section 级阈值，core/milestones 高、scene/participants 低）
6. 长度预算（per-section 与 global 双层预算）
7. 过期与清理（仅在前 6 步全 accept 后才执行过期清理，避免"先过期腾位再否决新内容"的回收问题）

## 路由与触发模型（决策 C2、C3）

这是"路由判断该更新哪些项"的顶层落地点，也是与 ChatGPT 原稿最大的不同。

- **不做多 Proposer**：避免"每 section 各自触发一次 LLM"造成的成本爆炸，亦避免触发判定本身成为新的复杂子系统。
- **统一 Observer 单次出 bundle**：每次 tick 调用一次 Observer，输出包含所有可能 section 的 patch bundle（其中无意义的 section 不出 patch）；reducer 内部逐 patch 按 section 各自的更新原则决定 accept/reject —— 这就是"实时判断哪些项该更新"的落地点，路由发生在 reducer 而非另起 LLM。
- **成本与现状持平**：保留每 tick 一次 LLM 调用的总成本预算，单次 bundle 多 patch 不增加调用次数。
- **core 晋升双触发**：
  - 兜底路径：Observer 在常规 tick 里直接对 core 出 patch，受 reducer 的"稳定证据"阈值否决（多数会被 reject，正常）。
  - 加速路径：当 `recentEpisodes` 在最近 N 条命中同一 stable pattern（按 tags / embedding / 文本正则）累计 M 次，且候选 core 项尚不存在，主动让 Observer 在下一次 tick 必须评估该 pattern 是否应晋升 —— 该决策由 reducer 在 accept recentEpisodes 时累积，不另起 LLM 触发判定。
- **不早跑 deep-context 长上下文晋升**：core 晋升始终发生在常规 Observer 调用内，不依赖长上下文模型调度。

## core 晋升机制（决策 C3）

core 的"晋升制"由"稳定证据"门槛保证：

- **稳定证据定义**：同一 stable pattern 在 ≥N 条 evidence 中、且 source messages 分布在 ≥K 个不重叠 message 区间（间隔由配置决定，初版 N=3、K=2），由 reducer 在每次 accept recentEpisodes / milestones 时累积 `stableHits` 与 `stableSpanSources` 字段。
- **晋升接受条件**：reducer 接受 core patch 当且仅当 `stableHits ≥ N && distinct(stableSpanSources) ≥ K`，且 evidence 与现有 core 不构成直接矛盾。否则 patch 直接 reject，并记入 reject 事件表，但 cursor 仍正常 advance（不丢更新）。
- **触发晋升**：见上节"core 晋升双触发"。
- **矛盾处理**：新 patch 与现有 core item 直接冲突时，reducer 优先升级现有 item 而非新增 —— 升级动作必须有"冲突证据"（≥2 条 evidence 指向相反事实），否则保留旧 item，新 patch reject 并入 review 队列。

## 删除与遗忘原则

遗忘不是让模型随手"压缩掉"。不同 section 的遗忘规则不同：

- `scene` 和 `participants` 可以被新状态覆盖。
- `recentEpisodes` 按窗口（最近 K 条）和重要性自然滚动，旧 episode 必须进入 `milestones` 后才从窗口中删除。
- `todos` 的删除需要完成、取消、失效或澄清结果，必须有 evidence 指向终止事件。
- `milestones` 默认不删除，只允许合并、纠错或去重；纠错型删除必须由用户修正或冲突证据触发。
- `core` 删除和修改应最保守，必须有明确冲突证据或用户修正；普通日常不得通过任何路径进入 core。

这使"遗忘"成为确定性策略，而不是摘要模型的副作用。删除保护发生在 reducer 链第 4 步，过期清理发生在第 7 步。

## 长上下文模型的角色（决策 C5）

长上下文模型能力应视为可配置 capability，不绑死任何特定 SKU。若某个生产模型确实提供数百万级 context 与结构化 output 能力，可启用下列角色；若不存在则保持禁用，不影响 Observer+Reducer+Renderer 主链路运行：

它适合承担：

- 大窗口审计：检查当前 state 是否缺证据、过期或冲突。
- 候选晋升批量复核：当 reducer 在长时间内 reject 了过多晋升候选，触发一次长窗口复核。
- 迁移辅助：把 legacy summary 转成候选 patch，而不是直接信任。
- 重建辅助：在原始消息和 patch log 上提出修复建议。

它不应承担：

- 直接覆盖最终 memory state。
- 无证据删除旧记忆。
- 把全历史重新总结成一段新的权威文本。

是否启用、调用的模型、调用 cadence 均由配置决定，架构本身不依赖该能力存在。**特别提示**：原稿引用的"deepseek-v4-flash 1M context、384K max output"规格在落实施前必须独立核对当前 API 文档；若不属实，不要把架构赌在该 SKU 上。

## 复用既有 gist 与 RAG 能力（修订新增）

v2 不是另起一套对话消化通路：

- **Observer 输入**默认走 gist 优先：从 `chat_message_gists` 读 gists，仅在 section 需要原文细节（如 milestones 的关键事件、core 晋升的稳定证据来源核对）时按 `evidenceMessageIds` 拉 specific 原文，避免每次 tick 全量原文 token 爆炸。
- **RAG 边界维持现状**：`services/chat/rag/*` 负责历史细节召回，memory 负责当前可用状态、长期偏好、关系模式和关键里程碑。一个事实若只在某次旧对话中重要但不应持续影响当前关系状态，应留在 RAG，不进 core memory。
- **Renderer 输出与 RAG 召回**：主聊天模型的 system 注入最终由 Renderer 输出的 memory 段 + RAG 召回段拼装而成，二者职责严格区分，不可互相覆盖。

## NSFW Policy（修订新增，决策 C7）

情感类 RP 的成人内容是产品硬需求，必须在顶层显式声明：

- 在成年、双方 consensual 的场景下，Observer 与 Renderer 不对成人内容做主动自我审查。
- 对成人内容的处理与现有 `rollingSummary.js` / `coreMemory.js` 的 system prompt 一致：客观、直白记录本质、双方意愿和关系突破点，不摘录大段感官描写。
- Reducer 不二次审查成人内容是否符合社会规范；其只校验证据、冲突、阈值、稳定证据等结构约束。
- 任何下游 provider 安全策略对本类内容的拦截应被显式编码为配置开关（参考既有 `isSafetyPolicyBlockedError` 处理路径），而非隐式丢弃 patch。
- 任何版本升级不得静默削弱此项。

## 上下文注入与渲染原则

主聊天模型不应感知内部 patch log、event log 或 reducer 细节，只需收到清晰的 memory 渲染结果。

渲染输出应满足：

- 区分长期核心记忆与近期状态。
- 明确哪些是当前状态，哪些是历史背景。
- 避免把旧场景强行延续到当前回复。
- 遇到与用户当前陈述冲突的内容，应提示模型优先澄清。
- 文本稳定，避免每次渲染都换表达。

底层 state 可以复杂，但注入给主模型的文本必须克制、可读、低噪声。

**delta-managed render**：Renderer 按 section 的 `updatedAt` 做缓存 —— 仅当 section 自上次 render 后被 reducer 写过，才重新渲染该 section 段；未变更 section 沿用上次缓存文本拼装。主 model 的 system 注入附 section 版本号，避免感官上的"又写了一遍"。

## 迁移策略（决策 C4）

采用 feature flag 双轨：

- **老 user**：保持 v1 rolling summary + core memory 路径不变，state_v2 列保持空。不做强制迁移。
- **新会话 / 新 user**：默认启用 v2，老路径相关列不再写入。
- **一键回放脚本**：作为可选工具提供 —— 对需要迁移的老会话，从 `chat_messages` 原始消息按 v2 Observer 流程从头消化，生成 v2 state；该脚本只能由 admin 主动触发，不接受任何"自动 LLM 迁移"路径。
- **不做"老 memory 文本 -> v2 state" 的直接 LLM 转换**：老 `rolling_summary` 文本不进入 v2 作为 authoritative state；如有保留必要走原始消息回放。
- **回滚**：v2 启用期内任何时刻可关 FF 回到 v1，因两套列并存。

## Prompt 管理原则

Memory worker prompt 必须从 `prompts/memory/*` 读取，不能继续散落或写死在 service 文件中（现有 `rollingSummary.js` / `coreMemory.js` 的 system 字符串硬编码即属违例，重构时必须外移）。Prompt 是 memory policy 的一部分，必须能被版本化、审阅和替换。

新增 prompt 装载层：按 `{kind, version}` 从 `prompts/memory/{kind}-{version}.md` 读取，装载版本号写入 state meta 的 `proposedByPromptVersion`，便于回滚 prompt 时识别哪批 state 由哪版 prompt 产出。所有 worker 输出必须结构化。解析失败、schema 失败、证据失败时，系统应记录失败原因，但不得改写 authoritative state。

## 失败与降级策略（修订新增，决策 C6）

reducer 拒绝 patch 是高频路径（情感 RP 含大量隐喻、省略、角色代称），必须显式定义兜底：

- **单次 reject**：patch 落 reject 事件表，section cursor 仍正常 advance（不丢更新）。
- **连续 ≥3 次同 section reject**：该 section 在本会话内暂停 advance（cursor 冻结到当前），并投递告警到 admin review 队列；其它 section 不受影响，主聊天调用继续走缓存 render。
- **连续 ≥5 次跨 section reject（观察 bundle 全否）**：触发 Observer prompt 阈值降级（强制下次 Observer 输出仅 scene/participants，其它 section 本会话内不再调 Observer）+ admin 告警，不回退到 v1 文本全量替换路径。
- **生产安全策略拦截**：保留既有 `isSafetyPolicyBlockedError` 处理路径 —— worker 输出被拦截时降级保留旧 state、advance cursor，记 reject 事件原因为 `safety_policy_blocked`。
- **不做静默 fallback 到旧全量文本摘要路径**：本设计不存在 LLM 输出整体改写权威 state 的兜底，因为那正是 v2 想消灭的失败模式。

## 与 RAG 的边界

Memory v2 和 RAG 不是互相替代。

- Memory 保存当前可用状态、长期偏好、关系模式和关键里程碑。
- RAG 负责从历史对话中召回具体场景、原话和细节。
- Memory 应高精度、低容量、可控。
- RAG 可高召回、按查询动态取用。

一个事实如果只在某次旧对话中重要，但不应持续影响当前关系状态，它更适合留在 RAG，而不是进入 core memory。

## 成功标准

Memory Control v2 成功，不是因为摘要更漂亮，而是因为它在长线聊天里表现出以下性质：

- 场景不变时不会被反复润色和漂移。
- 当前人物状态能及时更新，但不会污染长期人格。
- 待办能创建、完成、取消和过期，不会变成永久幽灵项。
- 里程碑只记录真正重要的关系或剧情转折。
- core memory 不被临时剧情、一次性互动或错误 summary 污染。
- 修改、删除、重建后，memory 能解释"为什么现在是这个状态"。
- 主聊天模型拿到的是稳定上下文，而不是越来越混乱的历史压缩文本。
- reducer 的拒绝事件可被 admin 查询，prompt 调整与阈值调参可被独立 trace。
- 一次 Observer LLM 调用即完成一次全 section patch 评估，总 LLM 调用成本与 v1 持平。
- 失去长上下文模型能力时，主链路不退化。

## 顶层设计决策清单

以下是已拍板的硬约束，所有实施计划必须服从：

| 编号 | 决策点 | 拍板结果 |
| --- | --- | --- |
| C1 | 存储模型 | 单一 JSONB blob `state_v2` 落库 + reject 事件单独表；首版不强加事件溯源；state 内置 `v` 字段，schema 升级走显式迁移函数 |
| C2 | 路由与触发模型 | 统一 Observer 单次出全 section patch bundle；路由判定放在 reducer 内逐 patch 执行；不为多 section 跑多次 LLM |
| C3 | core 晋升机制 | 兜底路径 = Observer 在常规 tick 内对 core 出 patch，受 reducer 的稳定证据阈值（N=3 命中 / K=2 不同 span）否决；加速路径 = recentEpisodes 命中同模式时由 reducer 累积，触发下一次 Observer 必须评估 |
| C4 | 迁移策略 | Feature flag 双轨，老会话冻结 v1；提供一键原始消息回放脚本；不做 LLM 全量迁移 |
| C5 | 长上下文模型 | 参数化 capability，unbundled；首版主链路不依赖其存在；启用与否、模型、cadence 均由配置决定 |
| C6 | 失败兜底 | 单次 reject 落表但不丢 cursor；同 section 连 ≥3 reject 暂停该 section advance + admin 告警；跨 section 连 ≥5 reject 降级 Observer 范围；不做 v1 全量文本回退兜底 |
| C7 | NSFW policy | 写入顶层章节；Observer 与 Renderer 在双 consensual 成人场景下不自我审查；Reducer 不二次审查社会规范；provider 安全拦截走显式配置开关 |

## 设计一句话

Memory Control v2 的本质是：用 LLM 观察历史，用结构化 patch 表达变化，用确定性 reducer 控制写入，用 renderer 给主模型提供稳定上下文 —— 并以单一 bundle、统一 reducer、per-section cursor、稳定证据晋升和显式 reject 兜底，把"长线不失控"约束固化到架构层而非 prompt 层。