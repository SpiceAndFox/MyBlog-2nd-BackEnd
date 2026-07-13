# Memory Control v2 写入协议

本文定义 Memory v2 的写入链路与组件编排。数据 shape、枚举、查表与 DDL 见 [state-contract.md](state-contract.md)；确定性算法与状态机见 [算法契约索引](algorithms/README.md)；prompt 细节见 [proposer-prompt.md](proposer-prompt.md)；渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. 写入流水线

Memory v2 的写入链路固定为 4 步：

1. **Observer**（纯代码）：读取最近对话、当前 state、各 target cursor，按 lag 阈值计算 eligible proposer tasks，组装结构化输入。
2. **Proposer**（按记忆族调用，schema-constrained structured output）：每个专用 Proposer 只处理自己负责的一个或多个 sections，输出 patch / noop / unable_to_decide，并按 op 附 evidenceKind；除 `mergeItems` 外附 `evidenceRefs`。
3. **Reducer**（纯代码）：按 [Reducer Apply 算法](algorithms/reducer-application.md) 执行顺序敏感的校验、模拟、容量处理、apply、事件生成与事务提交。
4. **Renderer**（纯代码模板）：读取最新 `memory_state`，实时渲染为主聊天模型可读的 memory 文本。

职责边界：

- **Observer 只算 lag，不做信号检测**。是否需要更新某 section 由对应专用 Proposer 看到消息后自行判断。
- **Proposer 只提出候选 patch + evidenceKind 枚举分类**，不判断最终可信度，不输出自由置信度分数。不同记忆族使用不同 prompt/schema，避免单个万能 Proposer 被过多规则污染。
- **Reducer 不做开放式自然语言理解**；schema/evidence/quote/policy/结构化冲突、领域生命周期、容量与事务提交都按确定性算法执行。
- **Renderer 不暴露 patch log、event log 或 reducer 细节**给主聊天模型。
- **异常诊断投影**在 Memory 写入事务提交后读取 semantic events，独立维护用户告警；它不参与 Reducer/capacity 决策，失败也不改变 normal task 的提交结果。权威算法见[异常诊断投影](algorithms/diagnostic-projection.md)。

### 1.1 Observer

Observer 构造一次 memory tick 的结构化输入，只做三件事：

1. 对每个 target 计算 `lag = 该 user/preset 下 id > coveredUntilMessageId 的有效 source 消息数量`（`coveredUntilMessageId` 存于 `meta.targetCursors[targetKey]`），lag 达到阈值的 target 为 eligible。source 按 messageId 连续读取 user/assistant raw messages，可跨 session；Memory Observer 不沿用主聊天 recent window 的 user-boundary 裁剪，也不注入 session boundary 控制标记。
2. 读取 `chat_memory_target_status`：只有存在 status 行且 status 允许 normal 调度的 target 才形成 eligible intent；缺失 status 行必须视为 degraded 初始化/修复问题，不得按 healthy 放行。`retry_wait` 等到 `nextRetryAt`，`capacity_blocked/halted/rebuilding` 不形成普通 proposal。每个 normal target 唯一映射到一个专用 Proposer。
3. eligible intents 进入同一 `userId/presetId` 串行执行位后，才逐个创建 durable task，并在创建事务中捕获当时最新 `baseRevision`、该 target cursor、observed messages/evidence metadata，组装 immutable `task_payload` 与 Proposer envelope。禁止在一个 tick 开头为多个 targets 预先固化同一个 baseRevision，否则前一 target 正常提交会让后续 task 被误判 stale。

Observer 不检测 `userCorrection`、`todoSignal` 等语义信号——这些由 Proposer 看到消息后自行判断。Observer 只记录每个 target 的 `trigger: { type: "lagThreshold" }`。user-boundary 裁剪只属于主聊天 recent window 的对话可读性规则，不能让 Assistant 消息从 Memory source 中消失。

### 1.2 Proposer

Proposer 按记忆族拆分调用，每个调用都必须使用 provider 支持的 schema-constrained structured output 强制输出 schema（见 [state-contract.md](state-contract.md) §5.5）。LLM 调用经由 [state-contract.md](state-contract.md) §10 的 Memory 专用 Provider Adapter 层；配置必须显式选择已实现的协议 adapter，真实模型/端点还必须通过完整 schema preflight。adapter 把正常输出、网络/Provider 失败、refusal/safety block、max-output truncation 和 schema invalid 归一化为不同结果；`status: "error"` 不交给 Reducer，由 tick orchestrator 直接写 ops_log 并按 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) §5 恢复。

首版固定 7 个 Proposer：

| targetKey / 类型            | Proposer                      | 负责 sections                                                                                    | 更新特征                           |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `scene`                     | `currentStateProposer`        | `scene`                                                                                          | 高频、覆盖式、字段级证据           |
| `todos`                     | `todoProposer`                | `todos`；overdue 是 todo item 的 Reducer 衍生状态                                                 | 中频、事件型、需要完成/取消/到期   |
| `standingAgreements`        | `agreementProposer`           | `standingAgreements`                                                                             | 中低频、事件型、持续互动约定       |
| `episodes`                  | `episodeProposer`             | `recentEpisodes`, `milestones`                                                                   | 近期经历与长期里程碑的晋升判断     |
| `profileRelationship`       | `profileRelationshipProposer` | `userProfile` / `assistantProfile` / `relationship`                                               | 低频、保守、长期档案和关系模式     |
| `worldFacts`                | `worldFactProposer`           | `worldFacts`                                                                                      | 低频、保守、世界设定事实           |
| 维护任务（无 raw cursor）   | `compactionProposer`          | 被阻塞的单个 item section（`recentEpisodes` 暂不触发，由滑动窗口处理）                             | 维护型、只处理预算压力下的合并精简 |

前 6 个是正常写入 Proposer，由 Observer 按 lag 调度。`compactionProposer` 是维护 Proposer，只由 Reducer 的长度预算门触发，不参与普通 lag 轮询。相比原设计的 5 个 normal Proposers，所有 targets 同时 eligible 时的最大 LLM 调用数增至 6；Observer 仍只调用达到触发条件的 target，不得每 tick 无条件调用全部 Proposers。

普通 Proposer 不能输出 `mergeItems`；`mergeItems` 只允许 `compactionProposer` 在维护模式下输出。`compactionProposer` 负责预算压力下的兜底合并和去重；normal Proposer 不承担主动去重。

Proposer 的拆分边界是 section family，不是字段级。`scene.location`、`scene.time`、`scene.mood`、`scene.note` 由同一个 `currentStateProposer` 处理。

Proposer 的输入/输出 envelope、字段语义、边界规则和各 Proposer 的 readOnlyContext 固定范围见 [state-contract.md](state-contract.md) §5。每个普通 Proposer 看到自己的 targetSections 后，自行决定每个 section 输出 `patches` / `noop` / `unable_to_decide`。`compactionProposer` 的输出状态为 `patches` / `unable_to_compact`，见 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md)。

### 1.3 Reducer

Reducer 仍是纯代码的 Policy Gate + State Applier，不使用 LLM，不做开放式自然语言判断、语义冲突检测或语义匹配。完整、顺序敏感的校验与 apply 算法见 [Reducer Apply 算法](algorithms/reducer-application.md)；Evidence/Quote 子算法见 [Evidence 校验与 Quote 匹配算法](algorithms/evidence-validation.md)。

### 1.4 Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列，是纯代码模板，不调用 LLM。具体模板与规则见 [rendering-and-context.md](rendering-and-context.md)。

## 2. 路由与触发

v2 不为每个字段单独调用 Proposer，也不使用单个万能 Proposer。每次 memory tick 按 eligible targets 调度一个或多个专用 Proposer，输出各自负责 section 的 patch bundle；Observer 只负责发现和组装，不预判 section 是否变化。

normal task 的 eligibility、窗口、默认阈值和 force-drain 旁路由 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) 定义。容量阻塞后的 maintenance task、compaction、pending proposal 保护与原 proposal replay 由 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md) 定义。Todo/scene 等状态转换由 [领域生命周期算法](algorithms/domain-lifecycle.md) 定义。

## 3. Cursor 推进规则

Cursor、联合 target 的聚合、retry/resume、successor task、phase identity 与 crash recovery 的完整规范见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md)。容量阻塞的 `deferred`、maintenance task 与 replay 语义见 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md)。本协议只规定这些算法由 tick orchestrator、Reducer 和 durable runtime state 共同执行，不另保留第二份状态机。

## 4. 长期档案与世界事实写入机制

`worldFacts`、`userProfile`、`assistantProfile` 和 `relationship` 是四个正式 section。它们的新增只接受 `long_term_fact`：包括明确表达的长期事实，以及 profile/relationship 中由单个观察窗口内清晰行为模式支撑的稳定特征。对已有 item 的改写基于 `user_correction` 或 `assistant_correction`，走 `updateItem`（见 [state-contract.md](state-contract.md) §6 policy table）；`addItem + correction` 不允许，因为修正语义应指向既有 item。

`assistant_correction` 与 `user_correction` 权限相同，均可修正上述四个正式 section。明确 forget 则使用 `forgetItem + user_forget/assistant_forget`，其权限和原子 suppression 规则见 §5；不得把 forget 伪装成 correction。

单次临时剧情、一次性情绪、单场景互动不得进入长期档案或世界事实。行为推断只适用于 profile/relationship，并且只在窗口内有清晰、显著的行为模式时成立；一次性动作不构成 trait。`memory_compaction` 只能用于合并同一 section 内的已有 item，不得作为新增长期事实的证据类型。

长期 section 的去重由 `compactionProposer` 在维护模式下用 `mergeItems` 兜底；normal Proposer 不输出 `mergeItems`，不承担主动去重。Reducer 不做文本相似度去重。`compactionProposer` 只能在同一正式 section 内合并，禁止跨 section 合并。

> 跨 tick 重复模式累积晋升（N=3/K=2）需要确定性 ledger + 结构化标签匹配（非语义匹配）才能可靠实现，首版不做，留作未来探索。行为推断在单个 contextWindow 内完成，不依赖跨 tick 累积。

## 5. 删除与遗忘

遗忘是确定性策略，不是摘要模型的副作用。Scene/Todo 等生命周期删除与状态转换由 [领域生命周期算法](algorithms/domain-lifecycle.md) 定义；correction、forget、context-suppression tombstone、RAG/Recall 查询末端过滤和 privacy hard delete 由 [Suppression 与 Retention 算法](algorithms/suppression-and-retention.md) 定义。

本协议只保留组件边界：Proposer 不得输出通用 `removeItem`；Reducer 负责原子写入 active state、event/snapshot 与必要 tombstone；projection worker 负责异步清理派生数据，但查询末端过滤始终是 correctness gate。

## 6. NSFW 与安全策略

对成年且 consensual 的成人互动，Proposer 以客观、摘要化方式提出事件本质、双方意愿、关系变化和稳定偏好；Renderer 只渲染已进入 `memory_state` 的摘要化字段，不摘录大段感官描写。

Reducer 不对成人内容做社会规范层面的二次审查；它只校验证据引用、policy gate、冲突和删除规则。Provider 安全策略造成的拦截由 Provider Adapter 识别为 `safety_policy_blocked`（[state-contract.md](state-contract.md) §10），由 tick orchestrator 写入 ops_log，不得伪装成 noop 或静默跳过。

## 7. 迁移原则

Source generation、自动 rebuild、projection checkpoint、`forceDrainTo` 与一次性迁移的完整规范见 [Source Rebuild 与 Projection 算法](algorithms/source-rebuild-and-projection.md)。RAG/Recall 的查询截止点和请求时健康判断见 [Context Coverage 算法](algorithms/context-coverage.md)。

本协议只保留编排边界：source mutation、normal/maintenance/system-cleanup task 共用同一 user/preset 串行执行域；一次性迁移复用正式 pipeline，不增加长期 runtime task type 或兼容路径。

## 8. 失败与降级

失败时保留上一次稳定 `memory_state`。系统不回退到旧的全文摘要重写路径。各失败决策的恢复语义见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md)。

- **Target 连续多次 error**：按 task 算法的升级阈值把该 per-target status 置为 halted，保留最后稳定 state；其它 targets 和主聊天不被全局阻断。
- **输出 schema 错误**（`output_schema_invalid`）：仅当错误发生在 Provider 输出边界时，允许按 `CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX` 对同一 durable task 立即重试，首版上限只能为 0 或 1；重试次数持久化在 task stage payload。输入 envelope 契约错误不重试；输出重试耗尽后 task failed、对应 target halted。所有路径只更新 task/status/ops log，不产生 revision/snapshot。
- **进程重启与持续消费**：worker 启动时扫描，并按集中配置的短周期持续读取 queued/running/到期 retry_wait durable task，按最后持久化 stage 继续并重新校验 revision/cursor；进程内队列不是恢复 authority。任一路径把 task 写回 queued/retry_wait 后都不得依赖新的聊天请求来唤醒。
- **Revision stale（normal task 首次提交时 revision ≠ baseRevision）**：不直接 apply，也不简单失败；创建 successor task，以当前最新 revision 重新组装 envelope 并重新调用 Proposer。
- **state/schema 损坏**：优先从当前 generation 最新合法 snapshot + 后续 normalized events 恢复；必要时按 source rebuild 算法从 raw messages rebuild。
- **resume**：手动重置对应 task 的可执行条件后继续，不修改语义 state，不跳过 cursor 后消息；target 在新/恢复 task 真正成功提交 cursor/snapshot 前保持原 degraded 状态。

### 8.1 用户侧健康状态

用户侧只暴露三档聚合状态，不直接暴露内部 task stage 或错误枚举：

| per-target status | 用户侧状态 | 用户可见语义 |
| --- | --- | --- |
| `healthy` | `healthy` | 该 target 正常运行 |
| `retry_wait` | `degraded` | 瞬时错误退避中，该类记忆可能滞后 |
| `capacity_blocked` | `degraded` | 等待 compaction/replay，该类记忆可能滞后 |
| `halted` | `degraded` | 该类记忆已暂停且可能滞后，需要服务器维护脚本 resume |
| `rebuilding` | `rebuilding` | 该类记忆正在从有效 source 重建 |

聚合时 `rebuilding` 优先于 `degraded`：任一 target 为 `rebuilding`，整体为 `rebuilding`；否则任一 target 非 `healthy`，整体为 `degraded`；全部 target 为 `healthy` 且没有其他 active context-quality 诊断时，整体才为 `healthy`。持久化的 target backlog、GapBridge omitted、state/schema 异常及尚未追平的实际 context projection 等诊断同样参与聚合：重建类诊断映射为 `rebuilding`，其余映射为 `degraded`。

告警规则：

1. 告警必须持久化或从持久化状态确定性派生；新异常通过集中配置的 `alertDebounceMs` 后，在每次相关响应中持续返回，直到对应 target/status/诊断满足明确恢复条件，不能只弹一次后隐藏。Renderer 的 context 内滞后/重建标记不使用该响应 health-alert 防抖。
2. 用户文案保持简洁，但必须指出受影响的记忆类别、是否可能滞后，以及可操作时是否需要人工恢复。精确 reason、taskId、target、attempt、cursor/处理边界保留在诊断信息中；halted 告警必须让运维侧可见这些边界。
3. 恢复时明确产生一次"Memory 已追平到相应 boundary"的恢复通知；恢复通知按健康来源写入 `subject_kind/subject_key`（Memory target、RAG/Recall projection 或 system 诊断），delivery 状态持久化到 [state-contract.md](state-contract.md) §9.10 的 `chat_memory_recovery_notifications` 表，提供 best-effort once 通知语义。清除 active 告警与创建 notification 使用同一持久化事务，不能先宣称恢复再异步创建通知。
4. `halted`、`capacity_blocked` 或 `retry_wait` 不产生全局 `chatBlocked`，也不产生 user/preset 级 halt。其他 targets 和主聊天继续运行。
5. Renderer 继续使用受影响 target 最后一次成功提交的稳定 state，并在上下文中标记该类记忆“可能滞后”；recent window 与该 target 的 GapBridge 仍可补充未写入 Memory 的 raw messages。
6. resume/rebuild 等服务器维护脚本可操作 halted target；普通 Observer/proposal 在恢复完成前不得绕过该 target 的调度门控。Compaction/replay 成功、cursor 推进并提交 snapshot 后只恢复对应 target，不要求其他 targets 同步恢复。
7. scene 字段 patch 的 `capacity_exceeded` rejection 不改变 target status；独立诊断投影把它映射为 active `scene_capacity_exceeded`。Renderer 立即按 active diagnostic 标记该类记忆可能滞后，响应健康告警通过配置的 `alertDebounceMs` 后说明“最近一次更新因长度超限未写入”；只有被拒字段后续 accepted 后才清除相应 pending path，全部 pending paths 恢复后才关闭告警。

### 8.2 运营指标

以下指标只用于观测、容量规划和告警，不因单次样本直接阻断主聊天：

- 总体及 per-target 的 calls/message、eligible rate、input/output tokens、Provider/model latency 与费用；
- `output_schema_invalid_retry`、最终 `output_schema_invalid`、`safety_policy_blocked`、`max_output_truncated`、`llm_call_failed` 与 `unable_to_decide`/`unable_to_compact` rate；
- quote similarity 分布，以及 quote-too-short/quote-not-found/quote-too-long rate；
- compaction success/failure、`replay_failed`、target halt rate、deferred proposal age；
- queue age/backlog、revision/cursor stale；
- GapBridge raw/truncated/omitted；
- rebuild duration、RAG/Recall projection lag、Memory degraded/rebuilding 持续时间。

相比原设计的五个 normal Proposer，当前固定为六个 target 调用族，必须按 target 分开观测调用量、eligible rate、tokens、延迟和费用。只有真实指标表明 `profileRelationship`/`worldFacts` 拆分造成不可接受的成本或延迟时，才重新评估拆分粒度；低价 API 不是忽略限流、失败率或错误累积的理由。

### 8.3 集中配置

以下变量由一个 Memory 配置入口加载、校验并供 Adapter/Observer/Reducer/Renderer/worker 共用，禁止在各模块散落默认值：每个 section 的 `maxItems/maxRenderedChars`、scene TTL、overdue todo 的 `maxRenderedItems/maxRenderedChars`（同时作为 todoProposer writableState 中 overdue todo 的传入上限）、每个 target 的 `lagThreshold`、GapBridge raw 字符预算与截断后最近消息数、quote 匹配算法与阈值、Provider adapter/base URL/API key/model/timeout/input 上限、adapter 专用 thinking mode、Provider retry/backoff、schema-invalid 即时重试上限、compaction retry 次数与 target halt 条件、durable task/projection 轮询周期、snapshot/event/debug retention，以及 degraded/rebuilding 告警防抖与恢复条件。用户时区不是 preset/环境配置：它是 User 的 IANA time-zone 字段（默认 UTC），在 task 创建事务中读取并固化到 immutable envelope。Memory Provider 配置只读取 `CHAT_MEMORY_V2_PROVIDER_*`，不得回退到主聊天的 Provider 环境变量。

Evidence quote 最大 200 Unicode code points 是固定协议值；quote 模糊匹配默认阈值为 `0.75`，但允许从同一集中配置调整。其余默认值在实现前依据真实历史分布和 Provider 能力确定，并随配置文档记录；配置缺失或越界必须在启动/加载边界显式失败，不在运行路径临时猜测。
