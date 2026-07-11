# Memory Control v2 写入协议

本文定义 Memory v2 的写入链路与 Reducer 治理规则。所有数据 shape、枚举、查表、校验算法见 [state-contract.md](state-contract.md)；prompt 细节见 [proposer-prompt.md](proposer-prompt.md)；渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. 写入流水线

Memory v2 的写入链路固定为 4 步：

1. **Observer**（纯代码）：读取最近对话、当前 state、各 target cursor，按 lag 阈值计算 eligible proposer tasks，组装结构化输入。
2. **Proposer**（按记忆族调用，schema-constrained structured output）：每个专用 Proposer 只处理自己负责的一个或多个 sections，输出 patch / noop / unable_to_decide，并按 op 附 evidenceKind；除 `mergeItems` 外附 `evidenceRefs`。
3. **Reducer**（纯代码）：schema 校验 → messageId 存在性 → quote 模糊匹配 → policy gate → 结构化冲突检测 → apply。
4. **Renderer**（纯代码模板）：读取最新 `memory_state`，实时渲染为主聊天模型可读的 memory 文本。

职责边界：

- **Observer 只算 lag，不做信号检测**。是否需要更新某 section 由对应专用 Proposer 看到消息后自行判断。
- **Proposer 只提出候选 patch + evidenceKind 枚举分类**，不判断最终可信度，不输出自由置信度分数。不同记忆族使用不同 prompt/schema，避免单个万能 Proposer 被过多规则污染。
- **Reducer 不做开放式自然语言理解**，只检查 schema、messageId 存在性、quote 模糊匹配、policy 查表、同字段/同 itemId 的结构化冲突。
- **Renderer 不暴露 patch log、event log 或 reducer 细节**给主聊天模型。

### 1.1 Observer

Observer 构造一次 memory tick 的结构化输入，只做三件事：

1. 对每个 target 计算 `lag = 该 user/preset 下 id > coveredUntilMessageId 的消息数量`（`coveredUntilMessageId` 存于 `meta.targetCursors[targetKey]`），lag 达到阈值的 target 为 eligible。
2. 读取 `chat_memory_target_status`：只有 status 允许 normal 调度的 target 才形成 eligible intent；`retry_wait` 等到 `nextRetryAt`，`capacity_blocked/halted/rebuilding` 不形成普通 proposal。每个 normal target 唯一映射到一个专用 Proposer。
3. eligible intents 进入同一 `userId/presetId` 串行执行位后，才逐个创建 durable task，并在创建事务中捕获当时最新 `baseRevision`、该 target cursor、observed messages/evidence metadata，组装 immutable `task_payload` 与 Proposer envelope。禁止在一个 tick 开头为多个 targets 预先固化同一个 baseRevision，否则前一 target 正常提交会让后续 task 被误判 stale。

Observer 不检测 `userCorrection`、`todoSignal` 等语义信号——这些由 Proposer 看到消息后自行判断。Observer 只记录每个 target 的 `trigger: { type: "lagThreshold" }`。

### 1.2 Proposer

Proposer 按记忆族拆分调用，每个调用都必须使用 provider 支持的 schema-constrained structured output 强制输出 schema（见 [state-contract.md](state-contract.md) §5.5）。LLM 调用经由 [state-contract.md](state-contract.md) §10 的 Provider Adapter 层——adapter 把 provider 响应与错误（含 `safety_policy_blocked`）归一化为统一结果；`status: "error"` 的结果不交给 Reducer，由 tick orchestrator 直接写 ops_log 并按 §3.1 恢复策略处理。

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

Proposer 的输入/输出 envelope、字段语义、边界规则和各 Proposer 的 readOnlyContext 固定范围见 [state-contract.md](state-contract.md) §5。每个普通 Proposer 看到自己的 targetSections 后，自行决定每个 section 输出 `patches` / `noop` / `unable_to_decide`。`compactionProposer` 的输出状态为 `patches` / `unable_to_compact`，见 §2.1。

### 1.3 Reducer

Reducer 是纯代码的 Policy Gate + State Applier。它不使用 LLM，不做开放式自然语言判断，不做语义冲突检测，不做语义匹配。

Reducer 必须按顺序执行：

1. **schema 校验**：patch 的 op、path/itemId、value 是否符合 [state-contract.md](state-contract.md) §4 的 Patch Op 约束；item patch 由所属 `sectionResults` key 直接确定 section，只有 scene 字段操作使用 `path`。`todos` 的 `addItem`/`updateItem` 若 `value` 含 `expiresAt`，解析结构化表达式并计算 `expiresAtTime`（见 [state-contract.md](state-contract.md) §4），计算结果在过去则 reject（reason: `invalid_expiry_in_past`）。
2. **evidence source 校验**：普通模式非 `mergeItems` patch 的 `evidenceRefs.messageId` 必须在 `observedMessages` 范围内且真实存在；数据库中的 user/preset/role/createdAt/contentHash 必须与 proposal-time task payload 一致，并按 evidenceKind 校验真实 role。`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`，Reducer 校验 `itemIds` 指向的 source items 存在且带有结构合法的 `evidenceGroups`。
3. **quote 模糊匹配**：普通模式非 `mergeItems` patch 按 [state-contract.md](state-contract.md) §7 的 200-code-point、最少 3 个信息字符和统一 Levenshtein 规则校验。
4. **policy gate**：按 section + op + evidenceKind 查 [state-contract.md](state-contract.md) §6 的 policy table，判断是否允许。
5. **结构化冲突检测**：只检查同字段覆盖（`setField`）、同 itemId 操作（`updateItem`/`completeTodo` 等）、跨 section 合并、itemId 是否真实存在和操作顺序合法性。不做语义冲突检测。
6. **长度预算**：按 [state-contract.md](state-contract.md) §8 校验各 item section 的 `maxItems + maxRenderedChars`，只统计 Renderer 可能输出的语义文本。对完整 proposal 的最终模拟 post-state 做容量检查；任一基础维度超限时 normal task 进入 `capacity_blocked`，只为触发容量阻塞的 patch 写 `deferred` event（`result_revision=null`），同事务创建 maintenance task；`recentEpisodes`、previousScene、overdue todo 的确定性例外留在领域生命周期批次定义。
7. **领域生命周期**：Reducer/housekeeping 的任何确定性持久化变化都走 [state-contract.md](state-contract.md) §9.2 通用 system cleanup event + revision/snapshot 机制，禁止 silent mutation；scene/todo 等具体 `cleanup_type` 与 apply 规则在第 6 批定义。
8. **apply**：通过校验的 patch 应用到 state，生成新 state。普通非 `mergeItems` item patch 的 `evidenceRefs` 连同 `patch.evidenceKind` 包装为一个 `evidenceGroup`追加到 item；`mergeItems` 继承 source items 的 `evidenceGroups`，各 group 保留各自 evidenceKind。含 `expiresAt` 的 todo patch 将 step 1 计算出的 `expiresAtTime` 写入 item。
9. **事件记录**：为整个 task bundle 建立一个 event group；每个 patch 的决策写一行 event，`noop` 写占位，Reducer/housekeeping 的确定性 state 变化写通用 `system_cleanup` event。accepted/system cleanup 必须保存完整 `normalized_operation`。
10. **revision 事务提交**：预留 event IDs、生成最终 item IDs，设置 `meta.revision = baseRevision + 1`，并把 post-state、完整 snapshot、event group/events、cursor、task 终态和 target status 同事务提交。若本次只有不改变 state/cursor 的运行失败，则不走此步骤，改走 §3.1 的运行状态事务。

职责顺序敏感，不可随意调换。

### 1.4 Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列，是纯代码模板，不调用 LLM。具体模板与规则见 [rendering-and-context.md](rendering-and-context.md)。

## 2. 路由与触发

v2 不为每个字段单独调用 Proposer，也不使用单个万能 Proposer。每次 memory tick 按 eligible targets 调度一个或多个专用 Proposer，输出各自负责 section 的 patch bundle。

**检测频率与上下文窗口是两个独立参数**：

- `lagThreshold`（N）：检测频率。`lag = 该 user/preset 下 id > coveredUntilMessageId 的消息数量`，lag >= N 时该 target eligible。
- `contextWindow`（M ≥ N）：发给 Proposer 的观察窗口大小上限。
- `newBatch`：从 `coveredUntilMessageId` 之后按 `id ASC` 取最早的 `min(N, lag)` 条未处理消息。
- `overlap`：从 `coveredUntilMessageId` 及之前取最近的 `M - newBatch.length` 条消息，按 `id ASC` 放在 `newBatch` 前。
- `observedMessageIds = overlap + newBatch`，`targetMessageId = max(newBatch.id)`。窗口内 `id > coveredUntilMessageId` 的消息是本轮新消息，`id <= coveredUntilMessageId` 的消息只作重叠上下文。普通写入 patch 的 evidenceRefs 可以引用 observedMessages 中的任意消息（含重叠部分），但 patch 应反映本轮新消息。

- Observer 将 eligible targets 列为 `eligibleTasks`，每个 normal target 对应一个 task 和一个专用 Proposer。
- 只有目标 section 出现在该 Proposer 的输入和输出契约中。
- 非目标 section 不出现在 Proposer 输出的 `sectionResults` 中；cursor 属于 target，不存在 section cursor。
- **目标 section 是否实际发生变化，由对应 Proposer 读取 envelope 后自行决定**（输出 patch 或 noop），不由 Observer 预判。

触发与上下文窗口建议（可调）：

| targetKey             | lagThreshold | contextWindow | 理由                                         |
| --------------------- | ------------ | ------------- | -------------------------------------------- |
| `scene`               | 4            | 6             | 场景变化高频，及时捕捉；窗口小，当前状态为主 |
| `todos`               | 6            | 12            | 待办中频；窗口略大以判断完成/取消            |
| `standingAgreements`  | 8            | 12            | 持续约定中低频；窗口用于判断修订/取消        |
| `episodes`            | 10           | 15            | 近期经历中频                                 |
| `profileRelationship` | 8            | 20            | 长期档案低频但需较多上下文判断               |
| `worldFacts`          | 8            | 20            | 世界设定低频但需较多上下文判断               |

### 2.1 Compaction task

`compactionProposer` 不是普通写入 Proposer，不由 lag 阈值调度。它只在 Reducer 的长度预算门发现 item patch 会超过上限时触发，用来释放容量或确认没有安全压缩空间。

状态分属两类 task 和 per-target status，不是单条链。`target_halted` 不是 task stage，只是 per-target status（`capacity_blocked` 或 `halted`）。maintenance task 必须持久化 `parent_task_id` 指向来源 normal task；normal task 的 `stage_payload` 持久化当前 `maintenance_task_id`。

**Normal task stage**（`task_type=normal`）：

```text
pending → proposing → proposal_persisted
→ capacity_blocked
→ replaying_original_proposal
├→ succeeded
└→ replay_failed
```

**Maintenance task stage**（`task_type=maintenance`）：

```text
pending → compacting
├→ compaction_applied       # 至少一个 patch apply 成功（其他可能因保护而 reject，见步骤 5）
└→ compaction_failed        # 全部 patch 被保护或无安全合并空间
```

触发流程：

1. normal proposal 中的 item patch 经模拟 apply 后，目标 section 将超过 `maxItems` 或 `maxRenderedChars`；不只检查 `addItem`，会增长渲染文本的 `updateItem` 等操作同样受容量门约束。Reducer 对完整 proposal 的最终模拟 post-state 做容量检查。
2. 如果任一 section 超容量，本轮不 apply proposal 中的任何 patch（禁止 accepted + deferred 非原子混合提交）。normal task 进入 `capacity_blocked` stage，per-target status 进入 `capacity_blocked`。capacity-blocked 事务只为触发容量阻塞的 patch 写 `decision: "deferred"`、`result_revision=null` 的 event group（"capacity-blocked 审计 group"）；其他 patch 暂不写最终 decision，完整 proposal 写入 normal task 的 `stage_payload.persistedProposal`（`task_payload` 在 task 创建时固化后不可变，不存放 Proposer 运行时输出）。同事务创建 maintenance task（`task_type=maintenance`、`parent_task_id` 指向 normal task），normal task 的 `stage_payload.maintenanceTaskId` 持久化对应 maintenance task ID。cursor 不推进。
3. maintenance task 按 `task.targetSections` 固定顺序，每次只压缩一个阻塞 section。maintenance task 与普通 task 共用同一 `userId/presetId` 串行队列（见 §2），使用 [state-contract.md](state-contract.md) §5.2 的 maintenance 模式 envelope；trigger 的 `dimension` 记录本次阻塞来自 `maxItems` 还是 `maxRenderedChars`。其 `targetKey` 只关联来源 normal target；`targetMessageId` 只复制来源 normal proposal 的阻塞边界，用于关联、幂等和后续 replay。两者均不表示 compaction 拥有或推进 raw-message cursor，compaction 也不据此读取 raw messages。
4. `compactionProposer` 的 section `status` 为 `patches` 或 `unable_to_compact`（约束见 [state-contract.md](state-contract.md) §5.5）。`status` 为 `patches` 时，patch 的 `op` 只能是 `mergeItems`。
5. Reducer 对 compaction patch 继续执行 schema、itemIds、policy、结构化冲突和 source evidence 完整性校验。`memory_compaction` 的 evidenceGroups 由 Reducer 根据 `itemIds` 从 source items 继承。Pending proposal 保护：Reducer 对 compaction patch 的 `itemIds` 与该 target 所有 pending（capacity_blocked/compacting）proposal 引用的 itemId 集合做交集校验——这是纯代码硬校验，不是 prompt 约束。相交的 compaction patch 被 reject，reason=`item_protected_by_pending_proposal`；该 compaction patch 不 apply，同一 maintenance task 的其他 patch 仍可正常 apply。一个 maintenance task 的全部 patch 均因保护而 reject 时，视同 `unable_to_compact`，进入 `compaction_failed`。
6. compaction apply 成功后形成 maintenance task 的 revision+snapshot（`compaction_applied`）。每次 compaction revision 后重新预检完整 proposal 的模拟 post-state；仍有其他阻塞 section 时继续创建下一个 maintenance task（按 `targetSections` 固定顺序），而不是立即 `replay_failed`。所有阻塞 section 都释放容量后，normal task 从 `capacity_blocked` 进入 `replaying_original_proposal`。
7. replay 从数据库读取原 proposal，在当前 state 上先对完整 proposal 重做纯代码预检，预检通过后才确定性 replay；不得重新调用原 Proposer。replay 时使用原稳定 `patchId` 为全部 patch 写最终 `accepted/rejected/noop` events（"最终 replay group"），replay revision 基于执行时最新全局 revision 创建。replay 的 stale 判定只看以下条件：
    - 当前 target cursor 仍等于原 `cursorBefore`；
    - proposal 仍是该 target 的活动 proposal（normal task 非终局）；
    - 引用 item 仍存在并通过当前 state 的纯代码预检；
    - schema/source hashes 仍兼容。

    其他 target 导致的全局 revision 增长不使 proposal stale；原始 `baseRevision` 只用于审计。`sourceGeneration` 在此期间变化的 stale 分支由第 9 批定义。
8. 如果 compactionProposer 返回 `unable_to_compact`（无安全合并空间），maintenance task 进入 `compaction_failed`，per-target status 进入 `halted`。如果 compaction `accepted` 但 replay 预检仍因容量不足而失败，normal task 进入 `replay_failed`（reason=`capacity_still_exceeded`），per-target status 进入 `halted`。replay 的其他非 stale 确定性失败同样进入 `replay_failed`，并记录精确 reason。如果 compaction 发生技术性失败（LLM 调用/schema/provider），按 §3.1 error 恢复策略处理。

maintenance task 有界执行：尝试上限按 `(parentTaskId, section)` 计算，同一 section 对同一阻塞窗口最多尝试 1 次。resume 复用原 maintenance task 重新进入 compaction，不创建新 child task；resume 将 per-target status 从 `halted` 变为 `capacity_blocked`，不立即设 healthy，只有原 proposal 成功 replay、cursor 推进并提交 snapshot 后才恢复 `healthy`。

遗忘边界：

- `recentEpisodes` 的遗忘仍由 Reducer 按滑动窗口确定性滚出，不需要 compactionProposer。
- `todos` 不能因为容量压力被静默删除；active item 可完成、取消或合并重复项，overdue item 只可 complete/cancel，不参与 compaction 或 merge。
- `standingAgreements` 不能因为容量压力被静默删除，只能取消、修订或合并重复项。
- `milestones`、`worldFacts`、`userProfile`、`assistantProfile` 和 `relationship` 不能自动遗忘；compactionProposer 只能在同一 section 内合并明显重叠项。

## 3. Cursor 推进规则

本节的 `cursor` 指当前 target 的 `coveredUntilMessageId`，存于 `meta.targetCursors[targetKey]`。

核心原则：**Proposer 已经看过消息并给出了明确判断（patches 或 noop），且 Reducer 不需要外部维护任务才能完成决策，则消息视为已处理，cursor 推进。** Proposer 无法判断（`unable_to_decide`）、技术性失败（`error`）、预算维护暂缓（`deferred`）时不推进。容量问题的终局由 task 级 `compaction_failed` / `replay_failed` 表达，不是 patch 级 reject reason。

`accepted`/`rejected`/`deferred`/`noop` 是 Reducer 的 patch 决策，落 revision event group/events；`error`/`unable_to_decide`/`unable_to_compact` 发生在 patch 产生之前，落 ops log 并更新 durable task/per-target status。`error` 达阈值后只 halt 对应 target；`unable_to_decide` 扩窗口重试一次后仍无法判断则以 cursor revision 终结；`unable_to_compact` halt 对应 target。

| 决策                                   | Cursor 行为 | 落地表  | 触发条件                                                                                                                                      |
| -------------------------------------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`                             | 推进        | events  | 至少一个 patch 被 apply                                                                                                                       |
| `noop`                                 | 推进        | events  | Proposer 明确说无变化；记 `decision=noop` 占位行                                                                                              |
| `rejected`                             | 推进        | events  | patches 全被拒（policy/quote/schema/item 校验等）                                                                                             |
| `deferred`                             | 不推进      | events  | item patch 被长度预算阻塞，capacity-blocked 审计 group 中写 `deferred`（`result_revision=null`），已触发 maintenance task                                                                                              |
| `unable_to_decide`                     | 不推进      | ops_log | Proposer 自认判断不了；按 §3.1 扩大上下文重试，仍无法判断后推进 cursor                                                                        |
| `unable_to_compact`                    | 不推进      | ops_log | compactionProposer 判定无安全合并空间；maintenance task 进入 `compaction_failed`，halt 对应 target（见 §3.1）                                  |
| `error`                                | 不推进      | ops_log | Provider Adapter 返回 `status: "error"`（[state-contract.md](state-contract.md) §10）；按 §3.1 重试，达到阈值后 halt 对应 target              |

cursor 按整个 normal proposal 的 target 级结果聚合，而不是按单个 section 或单行 event 判断。联合 target（`episodes` 与 `profileRelationship`）的所有 `sectionResults` 必须都形成可推进终局：任一 section 为 `unable_to_decide`、任务发生 `error`，或任一 patch 为 `deferred` 时，整个 target cursor 不推进；不能因为另一个 section 已 `accepted`/`noop`/普通 `rejected` 就提前推进。全部 section 均已终局且不存在上述阻塞结果时，有任一 `accepted`/`noop`/普通 `rejected` event 即推进。event 按 `target_key` 聚合；`section` 直接记录九个正式 section 之一。

一个 section 的 `patches` 数组里可能多个 patch 独立校验，部分 `accepted`、部分普通 `rejected` 时可以推进；有任一 `deferred` 时不推进。`deferred` 阻止推进是因为该 target 需要在 compaction 后 replay 原 proposal——capacity-blocked 时本轮不 apply 任何 patch（禁止 accepted+deferred 混合提交），compaction 成功后从数据库确定性 replay 原 proposal，不重新调用 Proposer。被拒 patch 的 `reject_reason` 仍各自落 event 行供审计。

**capacity-blocked 时的 replay 语义**：禁止 accepted + deferred 非原子混合提交。当 proposal 中任一 patch 因容量阻塞时，本轮不 apply 任何 patch。normal task 进入 `capacity_blocked`，只为触发容量阻塞的 patch 写 `deferred` event（`result_revision=null` 审计 group），其他 patch 的最终 decision 延迟到 replay group。compaction 成功释放容量后，normal task 从数据库读取原 proposal 并确定性 replay（不重新调用原 Proposer），使用原稳定 `patchId` 为全部 patch 写最终 `accepted/rejected/noop` events。完整状态机与 replay 的 stale 判定见 §2.1。

`deferred` 不推进：该 target 等待 maintenance task 有界执行；compaction 成功后 replay 原 proposal，compaction 无合并空间（`compaction_failed`）或 replay 预检仍因容量不足（`replay_failed`）时 halt 对应 target。

### 3.1 重试与恢复策略

cursor 表只规定 cursor 怎么动；本节规定每种不推进决策的恢复语义——重试时改变什么、何时升级。

任何成功 revision 都必须在同一事务把对应 durable task 写到终态，并将该 target 的 `consecutiveErrors` 重置为 0、清除 retry 时间；不能先提交 state/snapshot，再异步修复 task/status。

**error（Provider Adapter 返回 `status: "error"`，见 [state-contract.md](state-contract.md) §10）**

- tick orchestrator 不把 error 交给 Reducer。它在一个运行状态事务中写 ops log、更新 durable task 的 attempt/notBefore/status，并更新对应 per-target status；cursor 不推进，revision/snapshot 不增加。
- 瞬时错误（`llm_call_failed`/`safety_policy_blocked`）：target status 的 `consecutiveErrors + 1`，task 进入 `retry_wait` 并写有限指数退避的 `notBefore/nextRetryAt`。
- 持续性错误（`output_schema_invalid`）：task 进入 failed，对应 target status 直接进入 halted；不重试同输入。
- 升级阈值（仅瞬时错误）：`consecutiveErrors` 达 3 后仅将该 target 置为 halted。其它 targets 的 task/cursor/status 不受影响，`memory_state` 继续保留该 target 最后一次稳定 state。

**手动 resume**

```
CLI: node scripts/memory-v2-resume.js --userId=1 --presetId=default --targetKey=todos
API: POST /admin/memory/resume { userId, presetId, targetKey }
```

resume 只更新指定 per-target status 和对应 task：对于 `retry_wait` target，重置为 `healthy`、清错误计数/nextRetryAt，并将可恢复 task 重新置为 queued；对于 `halted` target（compaction/replay 失败），重置为 `capacity_blocked`（不立即设 `healthy`），复用原 maintenance task 重新进入 compaction，不创建新 child task。不改 `memory_state`，不产生 revision/snapshot。worker 随后从 durable task 或该 target cursor 继续，不跳过消息。服务器维护脚本可以操作 halted target，普通 proposal 不得绕过 halt。只有原 proposal 成功 replay、cursor 推进并提交 snapshot 后才恢复 `healthy`。

**unable_to_decide（Proposer 自认信息不足）**

- tick orchestrator 写 ops log，并把当前 durable task 的 `contextExpansionAttempt` 从 0 更新为 1；该状态只属于本 proposal/window，不写 per-target status 或 `memory_state`。
- task 下一次 attempt 读取该字段并发送扩大的 contextWindow。
- 扩大 1 次仍 `unable_to_decide` → 以一个只推进该 target cursor 的 revision 终结 task，并在同事务写 event group、snapshot、task 终态和 healthy target status。

**rejected（Proposer 已判断但被拒）**

- 推进 cursor（见 §3 表格），记 events（decision=`rejected`）。不重试——重跑同输入大概率同结果。
- 不自动告警；rejected 模式靠人工查 `chat_memory_events` 发现。

**deferred（预算阻塞）**

- 不推进 cursor。capacity-blocked 事务只为触发容量阻塞的 patch 写 `deferred` event（`result_revision=null` 审计 group），其他 patch 暂不写最终 decision。同事务创建 maintenance task 并将 per-target status 置为 `capacity_blocked`。compaction 成功释放容量 → replay 原 proposal（不重新调 Proposer）；compaction 返回 `unable_to_compact` → `compaction_failed`，halt 对应 target；replay 预检仍因容量不足 → `replay_failed`（reason=`capacity_still_exceeded`），halt 对应 target；compaction 技术性失败 → 按 error 策略处理。

**unable_to_compact（compactionProposer 判定无安全合并空间）**

- tick orchestrator 在运行状态事务中写 ops log、将 maintenance task 置为 `compaction_failed`，并将对应 target status 置为 `halted`。不增加 revision/snapshot。
- resume 复用原 maintenance task 重新进入 compaction，不创建新 child task；per-target status 从 `halted` 变为 `capacity_blocked`，不立即设 healthy。

**replay_failed（compaction accepted 但 replay 预检仍因容量不足或其他确定性失败）**

- normal task 进入 `replay_failed`（reason=`capacity_still_exceeded` 或其他确定性失败原因），per-target status 置为 `halted`；不增加 revision/snapshot。
- resume 复用原 maintenance task 重新进入 compaction，不创建新 child task；per-target status 从 `halted` 变为 `capacity_blocked`，不立即设 healthy。

## 4. 长期档案与世界事实写入机制

`worldFacts`、`userProfile`、`assistantProfile` 和 `relationship` 是四个正式 section。它们的新增只接受 `long_term_fact`：包括明确表达的长期事实，以及 profile/relationship 中由单个观察窗口内清晰行为模式支撑的稳定特征。对已有 item 的改写基于 `user_correction` 或 `assistant_correction`，走 `updateItem`（见 [state-contract.md](state-contract.md) §6 policy table）；`addItem + correction` 不允许，因为修正语义应指向既有 item。

`assistant_correction` 与 `user_correction` 权限相同，均可修正上述四个正式 section。

单次临时剧情、一次性情绪、单场景互动不得进入长期档案或世界事实。行为推断只适用于 profile/relationship，并且只在窗口内有清晰、显著的行为模式时成立；一次性动作不构成 trait。`memory_compaction` 只能用于合并同一 section 内的已有 item，不得作为新增长期事实的证据类型。

长期 section 的去重由 `compactionProposer` 在维护模式下用 `mergeItems` 兜底；normal Proposer 不输出 `mergeItems`，不承担主动去重。Reducer 不做文本相似度去重。`compactionProposer` 只能在同一正式 section 内合并，禁止跨 section 合并。

> 跨 tick 重复模式累积晋升（N=3/K=2）需要确定性 ledger + 结构化标签匹配（非语义匹配）才能可靠实现，首版不做，留作未来探索。行为推断在单个 contextWindow 内完成，不依赖跨 tick 累积。

## 5. 删除与遗忘

遗忘是确定性策略，不是摘要模型的副作用。

- `scene` 字段被新状态覆盖（`setField`）。
- `recentEpisodes` 按窗口自然滚出（Reducer 清理超出上限的旧 item）；只有真正关键的 episode 由 `episodeProposer` 主动输出 `addItem` 到 `longTerm.milestones`。
- `todos` 只能因完成、取消或失效而移除（`completeTodo`/`cancelTodo`/`expireTodo`）；`updateItem` 只修订待办内容或时间字段。
- `standingAgreements` 只能因取消或修订而移除或改变（`cancelAgreement`/`updateItem`）。
- `milestones` 位于长期区，默认不删除，只允许 `mergeItems` 和基于 `user_correction`/`assistant_correction` 的 `updateItem`。
- `worldFacts`、`userProfile`、`assistantProfile` 和 `relationship` 当前不存在通用删除 op；forget 的移除与 suppression 语义由专门协议定义，不能用“修改 text 为作废”代替。

禁止 Proposer 使用通用 `removeItem`。删除必须表达为更窄的语义 op（见 [state-contract.md](state-contract.md) §4）。`compactionProposer` 也不例外：它的主要能力是 `mergeItems`，不是删除。容量压力不能成为长期记忆静默遗忘的理由。

## 6. NSFW 与安全策略

对成年且 consensual 的成人互动，Proposer 以客观、摘要化方式提出事件本质、双方意愿、关系变化和稳定偏好；Renderer 只渲染已进入 `memory_state` 的摘要化字段，不摘录大段感官描写。

Reducer 不对成人内容做社会规范层面的二次审查；它只校验证据引用、policy gate、冲突和删除规则。Provider 安全策略造成的拦截由 Provider Adapter 识别为 `safety_policy_blocked`（[state-contract.md](state-contract.md) §10），由 tick orchestrator 写入 ops_log，不得伪装成 noop 或静默跳过。

## 7. 迁移原则

v2 是新的权威 memory 设计，不以 v1 兼容为目标。

旧 `rolling_summary` 和 `core_memory` 不直接转换为 v2 state。需要迁移旧会话时，从原始 `chat_messages` 回放：对旧消息按批次跑 v2 pipeline（Observer → 专用 Proposer → Reducer），生成 `memory_state`。回放成本与正常 tick 相同，不额外设计"文本转结构"的特殊路径。无法回放的旧文本只能作为 legacy reference，不得成为 authoritative memory。

v2 直接作为 active memory path 上线。v1 代码路径在 v2 线上跑稳后再清理，但这只是代码清理纪律，不是 runtime feature flag。

## 8. 失败与降级

失败时保留上一次稳定 `memory_state`。系统不回退到旧的全文摘要重写路径。各失败决策的恢复语义见 §3.1。

- **Target 连续多次 error**：按 §3.1 升级阈值把该 per-target status 置为 halted，保留最后稳定 state；其它 targets 和主聊天不因本批恢复机制被全局阻断。用户侧告警映射在第 8 批落地。
- **持续性错误**（`output_schema_invalid`）：当前 task failed、对应 target halted，不重试同输入；只更新 task/status/ops log，不产生 revision/snapshot。
- **进程重启**：单实例 worker 从数据库读取非终态 durable task，按最后持久化 stage 继续，并重新校验 revision/cursor；进程内队列不是恢复 authority。
- **state/schema 损坏**：优先从最新合法 snapshot + 后续 normalized events 恢复；必要时 raw-message rebuild，完整 rebuild 规则在第 9 批定义。
- **resume**：手动重置指定 per-target status 和对应 task 后继续，不修改语义 state，不跳过 cursor 后消息。
