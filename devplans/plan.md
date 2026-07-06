# Memory Control v2 顶层设计

## 文档定位

本文定义情感类 AI Chat 的 Memory Control v2 顶层设计：目标形态、权威状态、写入边界、失败处理、迁移原则和不可破坏的设计约束。

详细契约拆分到以下文档：

- [状态契约](memory-control-v2/state-contract.md)：`memory_state`、section、item、evidenceKind、patch op、Proposer 输入/输出信封、policy table、quote 校验、长度预算、审计事件表。**所有静态契约的单一权威来源。**
- [写入协议](memory-control-v2/write-protocol.md)：Observer、专用 Proposer、Reducer、路由、cursor、compaction、失败降级。
- [渲染与上下文接入](memory-control-v2/rendering-and-context.md)：Renderer、`memory` segment、RAG 边界、raw evidence 边界。
- [Proposer Prompt 契约](memory-control-v2/proposer-prompt.md)：schema-constrained structured output 与 worker prompt 要点。
- [Harness 验收契约](memory-control-v2/harness.md)：fixture、golden case、reducer/renderer/pipeline 验证边界。

后续实现计划必须服从本文。若实现中发现本文判断错误，应先修订本文，再调整拆分后的契约文档和代码。

## 1. 核心判断

当前 memory 系统的根本问题不是 prompt 不够强，而是把 memory 当成可反复重写的文本摘要。`rolling summary` 和 `core memory` 在多轮压缩、复述、再解释后，必然出现语义漂移、短期剧情侵入长期档案、旧状态污染当前上下文、待办和场景失控等问题。

Memory Control v2 的核心前提是：

**memory 不是一段文本，而是一组可审计、可更新、可拒绝、可恢复、可渲染的结构化状态。**

LLM 负责观察对话并提出候选变更（patch）；确定性 Reducer 负责校验和写入。LLM 不直接覆写最终 memory。

### 1.1 对 LLM 能力的诚实认知

本设计明确承认以下事实，并据此约束架构：

- **LLM 不能稳定输出复杂嵌套 JSON**：必须用 provider 支持的 schema-constrained structured output 强制 schema（见 [proposer-prompt.md](memory-control-v2/proposer-prompt.md) §2.1）。
- **LLM 会改写 quote 而非原文摘录**：Reducer 对 quote 做模糊匹配，不要求精确匹配，但设定明确阈值（见 [state-contract.md](memory-control-v2/state-contract.md) §7）。
- **LLM 会搞错 messageId**：Reducer 校验 messageId 存在性，搞错则 reject。
- **纯代码不能做语义理解**：Reducer 只做结构化校验（schema、ID 存在性、quote 模糊匹配、policy 查表、同字段覆盖冲突），不做语义冲突检测、不做语义匹配。
- **LLM 不会自发跨 tick 累积匹配**：任何需要跨轮次累积的机制（如"重复出现 3 次"）必须有确定性 ledger 记录，且匹配方式必须是结构化的（标签/字段），不能依赖语义匹配。

## 2. 设计目标

1. **受控写入**：所有 memory 变更必须经过结构化 patch、纯代码校验和 reducer，不允许 LLM 直接覆写最终 memory。
2. **证据可追溯**：重要 memory 必须能追溯到原始 message id 和短证据 quote。
3. **状态分层**：当前场景、人物状态、待办、近期经历、里程碑、长期核心档案分别维护，各有独立更新时机。
4. **低漂移**：旧 memory 只能局部增删改，不能被模型反复全文改写。
5. **可恢复**：系统应能从原始消息、patch 事件和状态快照恢复 memory。
6. **可渲染**：底层是结构化状态，注入主聊天模型时渲染成稳定、紧凑、可读的上下文文本。
7. **可审计**：patch 决策（accepted / rejected / deferred / noop）写入事件表，供调试和排查。
8. **主链路稳定**：失败时恢复到上一次稳定 state；连续错误触发该 userId/presetId 的 halt，暂停该会话聊天直至手动 resume。

## 3. 非目标与部署假设

非目标：

- 不兼容旧 rolling/core pipeline 的内部设计。
- 不把 LLM 输出的整段 summary 作为权威状态。
- 不把所有历史都塞进长期记忆。
- 不用缓存或兼容层掩盖状态模型错误。
- 不把旧 v1 memory 文本直接转换为 v2 权威状态。
- 不做跨 tick 语义模式累积晋升（N=3/K=2 留作未来探索）。
- 不引入独立 Evidence Verifier LLM 调用（验证靠纯代码 + Proposer 输出的 evidenceKind 枚举标签）。
- 不做多实例并发控制（首版单实例，进程内队列足够）。

部署假设：

单实例部署，进程内队列（沿用 `tickScheduler.enqueueByKey`）保证 per-`userId/presetId` 串行。多实例部署是未来问题，届时再加 DB 锁。

## 4. 旧系统取舍

旧系统中保留的是工程思想，不是实现形态。

保留：

- 同一 `userId/presetId` 串行写入（`tickScheduler.enqueueByKey`）。
- 消息编辑、删除、会话恢复会使 memory 失效（dirty 标记）。
- 状态快照用于恢复（checkpoint 机制）。
- worker slot 限流。

废弃：

- 旧文本 checkpoint 的中心地位；checkpoint 在 v2 中只表示 state snapshot。
- "旧文本 + 新对话 -> 新全文"的更新范式。
- core memory 依赖 rolling summary checkpoint 的严格同步思路。

## 5. 权威状态与写入边界

Memory v2 的权威状态是单一 `memory_state` JSONB blob。它保存当前完整 memory state，并由 Reducer 原子写回。旧 `rolling_summary` 和 `core_memory` 只能作为 legacy 字段存在，不再参与 v2 写入决策。

Renderer 输出不是权威状态，不落库为独立列。主聊天热路径读取 `memory_state` 后由纯代码实时渲染为上下文文本；改渲染连接词、标题或压缩格式只需要改 Renderer 代码，不需要回填数据库。

LLM 只负责观察对话并提出结构化 patch。不同记忆族使用不同 Proposer：`currentStateProposer` 处理 `scene` / `participants`，`todoProposer` 处理 `todos`，`episodeProposer` 处理 `recentEpisodes` / `milestones`，`coreProposer` 处理长期核心档案。Proposer 输入使用统一 envelope（结构见 [state-contract.md](memory-control-v2/state-contract.md) §5）。长度预算造成的维护任务由独立 `compactionProposer` 处理，它只能合并 `writableState` 里的既有 item，不能新增事实或静默删除长期记忆。最终写入必须经过确定性 Reducer：schema 校验、messageId 存在性、quote 模糊匹配、policy gate、结构化冲突检测和长度预算。Reducer 不做开放式自然语言理解，也不直接调用 LLM。

完整 schema、section、item、patch 契约、envelope、policy table 见 [state-contract.md](memory-control-v2/state-contract.md)，写入顺序和失败语义见 [write-protocol.md](memory-control-v2/write-protocol.md)。

## 6. 上下文接入边界

上下文装配使用单一 `memory` segment：当 `memory_state` 存在且 schema 校验通过时，`memory` 读取结构化状态并调用 Renderer 实时生成完整 memory 文本。若 `memory_state` 不存在或版本不支持，该 segment 直接不注入，并在日志中报错。Memory 的生成与注入遵循原有逻辑（超出一定轮数后才生成、注入）。

RAG 不替代 memory control。RAG 负责从历史中找相关原文片段，Memory Control 负责维护当前稳定状态和长期档案；两者在 context compiler 层并列注入。

Memory 写入统一使用 raw message evidence：user 与 assistant 消息都从原始 `chat_messages` 读取。Proposer 可以读取由 `memory_state` 裁剪出的 read-only context 来理解当前对话，但普通写入 patch 的 evidenceRef 只能来自普通模式的 `evidenceMessages`；维护模式的 `evidenceMessages` 只用于校验既有 item 的 evidenceRefs，不能作为摘录新事实的来源。read-only context 不能直接证明新事实。assistant gist 不进入 v2 memory proposer 输入，也不作为 evidenceRef 来源。

渲染模板、context segment、RAG 边界和 raw message 规则见 [渲染与上下文接入](memory-control-v2/rendering-and-context.md)。

## 7. Prompt 与 Harness 边界

Memory worker prompt 必须从 `prompts/memory/*` 读取，不能写死在 service 文件中。Proposer 输出必须通过 schema-constrained structured output 强制 schema，不能靠裸 prompt + 文本解析。

Harness 是 Memory Control v2 的必要组成部分，不是后补测试。Reducer、quote matcher、policy table、cursor 推进、renderer 稳定性和失败降级都必须有 fixture/golden case 约束，避免重新滑回不可审计的全文摘要重写。

Prompt 细节见 [Proposer Prompt 契约](memory-control-v2/proposer-prompt.md)，验收边界见 [Harness 验收契约](memory-control-v2/harness.md)。

## 8. 顶层决策清单

| 编号 | 决策              | 结果                                                                  | 权威出处                |
| ---- | ----------------- | --------------------------------------------------------------------- | ----------------------- |
| C1   | 权威状态          | `memory_state` JSONB 是唯一权威 memory state                          | state-contract §1       |
| C2   | 写入权            | Proposer 产出 patch proposal + evidenceKind 枚举分类；纯代码 Reducer 决定最终写入 | write-protocol §1       |
| C3   | 事件审计          | accepted / rejected / deferred / noop 写入 `chat_memory_events`      | state-contract §9       |
| C4   | Section 推进      | 每个 section 独立 cursor，同一 `userId/presetId` 单队列串行            | write-protocol §3       |
| C5   | LLM 调用          | 按记忆族调用专用 Proposer；无独立 Verifier LLM                        | write-protocol §1.2     |
| C6   | Core 写入         | 新增只接受 `long_term_fact`；改写只接受 `user_correction` 或 `assistant_correction`；维护合并只允许重叠项 | write-protocol §4 |
| C7   | Evidence 输入     | raw message 是唯一写入证据；read-only context 只作背景，assistant gist 不作证据 | state-contract §5       |
| C8   | RAG 边界          | RAG 召回具体历史，memory 保存持续状态                                 | rendering-and-context §3 |
| C9   | 迁移              | 旧文本不直接转 v2，旧会话迁移必须基于原始消息回放                     | write-protocol §7       |
| C10  | 失败兜底          | 保留稳定 state；连续错误触发该 userId/presetId 的 halt，手动 resume 后继续；不回退到 v1 全文摘要重写 | write-protocol §8       |
| C11  | 存储落点          | `chat_preset_memory` 新增 `memory_state` JSONB；不新增权威 render 列  | state-contract §1       |
| C12  | eligible tasks    | per-section / per-family lag 阈值决定本轮调度哪些 Proposer            | write-protocol §2       |
| C13  | 结构化输出        | 必须用 schema-constrained structured output 强制 schema；每个目标 section 输出 patches/noop/unable_to_decide | state-contract §5.5     |
| C14  | Reducer 职责      | 纯代码：schema/ID/quote 模糊匹配/policy 查表/结构化冲突；不做 NLU、不做语义匹配 | write-protocol §1.3     |
| C15  | Renderer 接入     | 使用单一 `memory` segment；读取时实时 render，状态不存在或 schema 不支持则不注入 | rendering-and-context §2 |
| C16  | 部署假设          | 首版单实例，进程内队列串行；不做并发控制                              | §3                      |
| C17  | 预算维护          | 长度预算阻塞先 deferred 并触发 compactionProposer；维护失败后才最终拒绝 | write-protocol §2.1     |

## 9. 成功标准

Memory Control v2 成功，不是因为摘要更漂亮，而是因为它在长线聊天里表现出以下性质：

- 场景不变时不会被反复润色和漂移。
- 当前人物状态能及时更新，但不会污染长期人格。
- 待办能创建、完成、取消和过期，不会变成永久幽灵项。
- 里程碑只记录真正重要的关系或剧情转折。
- Core memory 不被临时剧情、一次性互动或错误 summary 污染。
- 每条重要 memory 都能解释"为什么现在是这个状态"。
- 主聊天模型拿到的是稳定上下文，而不是越来越混乱的历史压缩文本。

---
