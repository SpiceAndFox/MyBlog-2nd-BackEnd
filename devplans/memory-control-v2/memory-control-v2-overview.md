# Memory Control v2 顶层设计

## 文档定位

本文定义情感类 AI Chat 的 Memory Control v2 顶层设计：目标形态、权威状态、写入边界、失败处理、迁移原则和不可破坏的设计约束。

详细契约拆分到以下文档：

- [状态契约](memory-control-v2/state-contract.md)：`memory_state`、section、item、evidenceKind、patch op、Proposer 输入/输出信封、policy table、长度预算、审计事件表与运行 sidecar DDL。**所有静态契约的单一权威来源。**
- [写入协议](memory-control-v2/write-protocol.md)：Observer、专用 Proposer、Reducer、路由、cursor、compaction、失败降级。
- [算法契约索引](memory-control-v2/algorithms/README.md)：确定性算法、状态转移、失败分支、幂等与运行不变量。**所有算法行为的单一权威入口。**
- [渲染与上下文接入](memory-control-v2/rendering-and-context.md)：Renderer、`memory` segment、RAG 边界、raw evidence 边界。
- [Proposer Prompt 契约](memory-control-v2/proposer-prompt.md)：schema-constrained structured output 与 worker prompt 要点。
- [Harness 验收契约](memory-control-v2/harness.md)：fixture、golden case、reducer/renderer/pipeline 验证边界。

后续实现计划必须服从本文。若实现中发现本文判断错误，应先修订本文，再调整拆分后的契约文档和代码。

### 设计与实现原则

本次重构采用偏瀑布式设计：设计阶段一次性覆盖 durable proposal 的 deferred/compaction/replay、每 revision 完整 snapshot、todo overdue、expired scene、GapBridge、用户告警、forget 与 RAG suppression 等已确定能力。实现仍按 State → Proposer/Cursor → Evidence/Capacity → Persistence/Recovery → Compaction → Domain Lifecycle → Context → Health → Rebuild/Projection → Forget/Suppression → Cross-cutting 的依赖顺序分层推进和验收，但实施顺序不代表把已确定能力延期到不明确的未来。明确不进入当前范围的能力只以 §3 和 [延后设计清单](deferred/memory-control-v2/readme.md) 为准。

设计在完整性与可落地性之间取平衡：只为明确的故障路径引入机制；能用简单确定性规则解决的问题，不叠加多套预算、风险分类或额外 LLM 判断。LLM 负责语义判断并提出候选变更；Reducer 只负责纯代码可验证的结构、作用域、权限、证据引用、容量、并发前置条件和事务约束。

### 契约继承边界

本文与各子文档共同构成对原 Memory Control v2 设计的修订，不通过省略内容重新定义全部契约。未被明确修改、替换或列入延后清单的既有契约继续有效，省略不代表删除；item/evidenceGroups/evidenceKind/op/policy table、Proposer envelope/readOnlyContext、确定性算法、Prompt、Renderer、Scene Snapshot/Recall 等细节以对应子文档为准。算法步骤、状态转移、失败分支和幂等规则以 [算法契约索引](memory-control-v2/algorithms/README.md) 为入口；讨论稿中未经明确确认的实现细节不构成规范。

## 1. 核心判断

当前 memory 系统的根本问题不是 prompt 不够强，而是把 memory 当成可反复重写的文本摘要。`rolling summary` 和 `core memory` 在多轮压缩、复述、再解释后，必然出现语义漂移、短期剧情侵入长期档案、旧状态污染当前上下文、待办和场景失控等问题。

Memory Control v2 的核心前提是：

**memory 不是一段文本，而是一组可审计、可更新、可拒绝、可恢复、可渲染的结构化状态。**

LLM 负责观察对话并提出候选变更（patch）；确定性 Reducer 负责校验和写入。LLM 不直接覆写最终 memory。

### 1.1 对 LLM 能力的诚实认知

本设计明确承认以下事实，并据此约束架构：

- **LLM 不能稳定输出复杂嵌套 JSON**：必须用 provider 支持的 schema-constrained structured output 强制 schema（见 [proposer-prompt.md](memory-control-v2/proposer-prompt.md) §2.1）。
- **LLM 会改写 quote 而非原文摘录**：Reducer 对 quote 做模糊匹配，不要求精确匹配，但设定明确阈值（见 [Evidence 校验与 Quote 匹配算法](memory-control-v2/algorithms/evidence-validation.md)）。
- **LLM 会搞错 messageId**：Reducer 校验 messageId 存在性，搞错则 reject。
- **纯代码不能做语义理解**：Reducer 只做结构化校验（schema、作用域、权限、ID 存在性、quote 模糊匹配、policy 查表、容量、并发前置条件和事务边界），不做语义冲突检测、不做语义匹配，也不宣称能证明 patch text 被 evidence 蕴含。
- **LLM 的语义判断会有偏差**：系统接受有限的语义误判风险，不增加“高风险事实”分类或第二个 Verifier LLM；依靠 provenance、事件、snapshot、correction/forget 和恢复路径使错误可追踪、可纠正。
- **LLM 不会自发跨 tick 累积匹配**：任何需要跨轮次累积的机制（如"重复出现 3 次"）必须有确定性 ledger 记录，且匹配方式必须是结构化的（标签/字段），不能依赖语义匹配。

## 2. 设计目标

1. **受控写入**：所有 memory 变更必须经过结构化 patch、纯代码校验和 reducer，不允许 LLM 直接覆写最终 memory。
2. **证据可追溯**：重要 memory 必须能追溯到原始 message id、短证据 quote 和证据组。
3. **状态分层**：当前场景、待办、持续约定、近期经历、里程碑、长期核心档案分别维护，各有独立更新时机。
4. **低漂移**：旧 memory 只能局部增删改，不能被模型反复全文改写。
5. **可恢复**：系统应能从原始消息、patch 事件和状态快照恢复 memory；避免变更静默丢失或重复应用，并在 forget 后阻止相同来源被自动重建。
6. **可渲染**：底层是结构化状态，注入主聊天模型时渲染成稳定、紧凑、可读的上下文文本。
7. **可审计**：patch 决策（accepted / rejected / deferred / noop）写入事件表，供调试和排查。
8. **主链路稳定**：失败时保留上一次稳定 state；连续错误只 halt 对应 Memory target，运行恢复状态由 durable task/per-target status/ops log 持久化，其他 targets 与主聊天不被全局阻断。用户侧统一聚合为 `healthy` / `degraded` / `rebuilding`，并持续告警到恢复完成。
9. **故障可区分**：模型调用/输出错误、Reducer 拒绝或异常、事务提交失败分别记录，不用一个笼统失败状态掩盖责任边界。

## 3. 非目标与部署假设

非目标：

- 不兼容旧 rolling/core pipeline 的内部设计。
- 不把 LLM 输出的整段 summary 作为权威状态。
- 不把所有历史都塞进长期记忆。
- 不用缓存或兼容层掩盖状态模型错误。
- 不把旧 v1 memory 文本直接转换为 v2 权威状态。
- 不做跨 tick 语义模式累积晋升（N=3/K=2 留作未来探索）。
- 不引入独立 Evidence Verifier LLM 调用（验证靠纯代码 + Proposer 输出的 evidenceKind 枚举标签）。
- 不要求 LLM 判断“高风险事实”，也不引入 NLI 来证明 patch text 被 evidence 语义蕴含。
- 不做多实例并发控制（首版单实例，进程内队列配合持久化幂等校验）。
- 不在本轮实现 LLM Suppression Proposer、Gap Compressor、长期 overdue todo 的精细归档/检索/清理、容量自动降级策略、总 context 预算裁剪、GapBridge 与 RAG 内容去重；延后项统一见 [延后设计清单](deferred/memory-control-v2/readme.md)。

部署假设：

- 单实例部署，进程内队列（沿用 `tickScheduler.enqueueByKey`）保证 per-`userId/presetId` 串行；durable task 的稳定 identity/dedupe key 与提交前 generation/cursor/revision 校验负责重启和重复 delivery 的幂等防护。多实例部署是未来问题，届时需另行设计 DB lock/lease/fencing，不能把当前幂等约束误称为多实例并发控制。
- 主聊天和所有 Memory Proposer 只能配置为已声明约 1M context 的模型；启动时验证实际 model capability（`maxInputTokens`），不满足时拒绝启动。总 context 预算裁剪策略在 1M 模型下收益极低，延后处理（见 [总 Context 预算（延后）](deferred/memory-control-v2/total-context-budget.md)）。
- 容量 halt 发生后有明确的"调高配置 → 重启/重载 → resume"操作步骤；上线前根据真实历史做一次容量分布和全量 rebuild 的 calls/tokens/latency 测量，以确定合适的默认容量值；货币费用由 Provider 官方余额变化评估，不进入 Memory 运行时或迁移报告。

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

PostgreSQL 中的结构化 `memory_state` 是新系统唯一的当前 Memory authority。它保存当前完整 memory state，并由 Reducer 原子写回。旧 `rolling_summary`、`core_memory` 和 v1 checkpoint 都是可清除的派生数据，不转换为新系统 authority，也不与新 Memory 同时注入；确认 v1 worker/注入已经停用后，可以在 v2 正式切换前独立清除。`chat_messages` 中的 User/Assistant 原文是 rebuild 的权威 source，Memory 退役、rehearsal、迁移和 cutover 均不得修改或删除它；只有独立、明确授权的用户隐私删除流程可以改变 raw source。

协议层正式 section 固定为 `scene`、`todos`、`standingAgreements`、`recentEpisodes`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`。`core` 不作为 section；`current.previousScene` 与 todo 的 `status=overdue` 是 Reducer 维护的衍生状态，不进入 Proposer `sectionResults`，也不拥有 cursor。

`current`、`working`、`longTerm` 和 `meta` 只是 `memory_state` 的物理存储容器，不是 section 或 target，不得出现在 patch/event/policy 的 `section`、`task.targetKey` 或 `sectionResults` key 中。

user/preset 下的对话跨 session 语义连续。session 只是按天或 UI 划分的存储单元，不是 Memory 或 scene 的语义边界。sessionId 只保留在消息中，不复制到 evidence、event 或 Recall provenance；这些结构通过 messageId / source messageIds 追溯来源。

Renderer 输出不是权威状态，不落库为独立列。主聊天热路径读取 `memory_state` 后由纯代码实时渲染为上下文文本；改渲染连接词、标题或压缩格式只需要改 Renderer 代码，不需要回填数据库。

LLM 只负责观察对话并提出结构化 patch。不同记忆族使用不同 Proposer：`currentStateProposer` 处理 `scene`，`todoProposer` 处理 `todos`，`agreementProposer` 处理 `standingAgreements`，`episodeProposer` 处理 `recentEpisodes` / `milestones`，`profileRelationshipProposer` 处理 `userProfile` / `assistantProfile` / `relationship`，`worldFactProposer` 处理 `worldFacts`。Proposer 输入使用统一 envelope（结构见 [state-contract.md](memory-control-v2/state-contract.md) §5）。`compactionProposer` 同时服务容量恢复和达到高水位后的非阻塞主动整理；调用 LLM 前先由纯代码合并规范化 text 完全相同的安全重复项，LLM 只能合并 `writableState` 里的既有 item，不能新增事实或静默删除长期记忆。最终写入必须经过确定性 Reducer：schema、section/target 作用域、new-batch evidence、messageId、quote 模糊匹配、policy 权限、exact text/profile canonicalKey、结构化冲突、容量、generation/cursor/revision 前置条件和事务边界校验。Reducer 不做开放式自然语言理解、不直接调用 LLM，也不证明候选 text 被 evidence 语义蕴含。

完整 schema、section、item、patch 契约、envelope、policy table 见 [state-contract.md](memory-control-v2/state-contract.md)，写入顺序和失败语义见 [write-protocol.md](memory-control-v2/write-protocol.md)。

## 6. 上下文接入边界

上下文装配以集中配置的 Unicode 字符阈值计算 `needsMemory`，不叠加 message count、tokenizer 估算或 context 百分比。`needsMemory=true` 且 `memory_state` 存在、schema 校验通过时，单一 `memory` segment 读取结构化状态并调用 Renderer 实时生成完整 memory 文本；否则按明确原因跳过。主聊天 recent window 可跨 session 并保留 user-boundary 裁剪，Memory Observer 则按 target cursor 读取不经该裁剪的完整 raw source。

普通 lagThreshold 下未达阈值的尾批允许等待后续消息；若尾批已被极长新消息挤出 recent window，per-target GapBridge 按 `coveredUntilMessageId < messageId < recentWindowStartMessageId` 补入完整 raw messages。GapBridge 使用独立字符预算；超预算时只保留最近 N 条完整消息并持久化 omitted/保留边界，继续聊天但显式降级告警，不能静默截断或调用 LLM 临时压缩。Source rebuild 必须忽略 lagThreshold 并 force drain 到捕获边界。注入门控与 GapBridge 细节见 [Context Coverage 算法](memory-control-v2/algorithms/context-coverage.md) §1–§2，normal task 的 eligibility、窗口与 force-drain 调度边界见 [Task 执行、Cursor 与幂等算法](memory-control-v2/algorithms/task-execution-and-idempotency.md) §2。

RAG 不替代 memory control。RAG 负责从历史中找相关原文片段，Memory Control 负责维护当前稳定状态和长期档案；两者在 context compiler 层并列注入。

普通写入使用 raw observed messages：user 与 assistant 消息都从原始 `chat_messages` 读取。Proposer 可以读取由 `memory_state` 裁剪出的 redacted read-only context 来理解当前对话；普通写入 patch 的 evidenceRefs 只能来自普通模式的 `observedMessages`。维护模式不向 LLM 暴露 raw messages 或既有 evidenceGroups，也不接收 Proposer 输出的 evidenceRefs；`mergeItems` 的 evidenceGroups 由 Reducer 从 source items 继承。read-only context 不能直接证明新事实。assistant gist 不进入 v2 memory proposer 输入，也不作为 evidenceRefs 来源。

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
| C4   | Target 推进       | 每个 target 独立 cursor（联合处理的 section 共享一个 cursor），同一 `userId/presetId` 单队列串行            | write-protocol §3       |
| C5   | LLM 调用          | 按记忆族调用专用 Proposer；无独立 Verifier LLM                        | write-protocol §1.2     |
| C6   | 长期 section 写入 | `worldFacts`/`userProfile`/`assistantProfile`/`relationship` 是独立正式 section；新增只接受 `long_term_fact`，改写接受双方 correction，明确 forget 接受双方 forget，同 section 内才允许合并 | write-protocol §4-§5 |
| C7   | Evidence 输入     | 普通写入证据来自 `observedMessages`；维护合并证据由 Reducer 继承 source items；read-only context 只作背景 | state-contract §5       |
| C8   | RAG 边界          | RAG 召回具体历史，memory 保存持续状态                                 | rendering-and-context §3 |
| C9   | 迁移              | 旧文本不直接转 v2，旧会话迁移必须基于原始消息回放                     | write-protocol §7       |
| C10  | 失败兜底          | 保留稳定 state；连续错误只 halt 对应 target，手动 resume 指定 target（resume 创建新 maintenance child task，不复用已终态旧 task）；不回退到 v1 全文摘要重写 | [Task 执行、Cursor 与幂等算法](memory-control-v2/algorithms/task-execution-and-idempotency.md) §5–§6；write-protocol §8 |
| C11  | 存储落点          | `chat_preset_memory` 新增 `memory_state` JSONB；不新增权威 render 列  | state-contract §1       |
| C12  | eligible tasks    | per-target lag 阈值决定本轮调度哪些 Proposer            | write-protocol §2       |
| C13  | 结构化输出        | 必须用 schema-constrained structured output 强制 schema；每个目标 section 输出 patches/noop/unable_to_decide | state-contract §5.5     |
| C14  | Reducer 职责      | 纯代码校验结构/作用域/权限/证据引用/容量/并发前置条件/事务边界；不做 NLU、语义匹配或 evidence 蕴含证明 | write-protocol §1.3     |
| C15  | Renderer 接入     | 使用单一 `memory` segment；读取时实时 render，状态不存在或 schema 不支持则不注入 | rendering-and-context §2 |
| C16  | 部署假设          | 首版单实例，进程内队列串行并做持久化幂等校验；不做多实例并发控制       | §3                      |
| C17  | 预算维护          | 可 compaction item section 的长度预算阻塞时 capacity-blocked 并创建 maintenance task；compaction 后确定性 replay 原 proposal；compaction/replay 失败时 halt 对应 target。不可 compaction 的 scene 超限字段以 `capacity_exceeded` 拒绝、推进 cursor、不创建 maintenance（临时方案，待容量默认值稳定后引入自动降级，见 [容量降级策略（延后）](deferred/memory-control-v2/capacity-degradation.md)） | [Compaction 与 Proposal Replay 算法](memory-control-v2/algorithms/compaction-and-replay.md)；[Reducer Apply 算法](memory-control-v2/algorithms/reducer-application.md) |
| C18  | 健康与告警        | 用户侧只暴露 healthy/degraded/rebuilding；非健康原因持续可见，halt 只作用于对应 target，主聊天继续；scene capacity rejection 由已提交 event 的独立持久化诊断投影派生告警，不污染 Reducer/capacity 事务 | write-protocol §8；[异常诊断投影](memory-control-v2/algorithms/diagnostic-projection.md) |
| C19  | Source rebuild    | sourceGeneration 是 Memory/RAG/Recall 共享世代；任何有效 source 变化都 +1；source mutation 进入串行队列并原子进入 rebuilding，并用既有 tasks force drain | write-protocol §7       |
| C20  | 一次性迁移        | v1 派生 Memory 可在其 runtime 停用后独立清除；raw messages 始终保留，v2 只有 rebuild/force drain 与全量校验成功后才能启服；不建 Flush 子系统 | [Source Rebuild 与 Projection 算法](memory-control-v2/algorithms/source-rebuild-and-projection.md) §5 |
| C21  | Correction/Forget | correction 以新 revision 替换 active 值；forget 原子移除 item 并按完整 evidenceGroups 写 source tombstone，RAG/Recall/rebuild 均执行 suppression | write-protocol §5       |
| C22  | Privacy hard delete | 跨 raw、Memory 历史/任务 payload、RAG/Recall、tombstone/diagnostic/notification sidecar、diagnostic projection checkpoint 与受控 debug 存储物理清除，并从剩余 source rebuild 后才恢复服务；禁止日志记录 raw prompt/完整 state | [Suppression、Hard Delete 与 Retention 算法](memory-control-v2/algorithms/suppression-and-retention.md) §5 |
| C23  | Provider Adapter   | Memory 使用专用原生 structured-output Adapter；区分调用失败、安全拒绝、输出截断和 schema invalid，不支持的模型禁止配置 | state-contract §10 |
| C24  | 串行与幂等        | 单实例 per-user/preset 串行（含 source mutation）；stable task/dedupe identity 与 generation/cursor/revision 提交校验保证重复恢复不重复 apply；revision stale 时创建 successor task | state-contract §9.2-§9.3, §9.6 |
| C25  | 运营与配置        | 六个 target 分项观测 calls/tokens/延迟/失败与恢复质量；货币费用由 Provider 官方余额评估，不作为运行或迁移门禁；容量、阈值、重试、retention 和告警参数集中配置 | write-protocol §8.2-§8.3 |

## 9. 成功标准

Memory Control v2 成功，不是因为摘要更漂亮，而是因为它在长线聊天里表现出以下性质：

- 场景不变时不会被反复润色和漂移。
- 待办能创建、完成、取消和过期，不会变成永久幽灵项。
- 持续约定能创建、修订和取消，不会伪装成待办。
- 里程碑只记录真正重要的关系或剧情转折。
- 长期档案与世界事实 sections 不被临时剧情、一次性互动或错误 summary 污染。
- 每条重要 memory 都能解释"为什么现在是这个状态"。
- 主聊天模型拿到的是稳定上下文，而不是越来越混乱的历史压缩文本。
- durable proposal、compaction/replay、snapshot 和 cursor 在崩溃或重复 delivery 后不会静默丢失或重复应用。
- 错误记忆可追溯到 source evidence；correction/forget 后 active context、rebuild、RAG 与 Recall 不会重新暴露被替换或遗忘的来源。
- 模型失败、Reducer 拒绝/异常和事务失败可分别诊断；target 滞后、重建或 halt 时用户持续看到准确状态，恢复后能确认已追平。

---
