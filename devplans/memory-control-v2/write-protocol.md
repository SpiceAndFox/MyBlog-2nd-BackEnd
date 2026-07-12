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

1. 对每个 target 计算 `lag = 该 user/preset 下 id > coveredUntilMessageId 的有效 source 消息数量`（`coveredUntilMessageId` 存于 `meta.targetCursors[targetKey]`），lag 达到阈值的 target 为 eligible。source 按 messageId 连续读取 user/assistant raw messages，可跨 session；Memory Observer 不沿用主聊天 recent window 的 user-boundary 裁剪，也不注入 session boundary 控制标记。
2. 读取 `chat_memory_target_status`：只有 status 允许 normal 调度的 target 才形成 eligible intent；`retry_wait` 等到 `nextRetryAt`，`capacity_blocked/halted/rebuilding` 不形成普通 proposal。每个 normal target 唯一映射到一个专用 Proposer。
3. eligible intents 进入同一 `userId/presetId` 串行执行位后，才逐个创建 durable task，并在创建事务中捕获当时最新 `baseRevision`、该 target cursor、observed messages/evidence metadata，组装 immutable `task_payload` 与 Proposer envelope。禁止在一个 tick 开头为多个 targets 预先固化同一个 baseRevision，否则前一 target 正常提交会让后续 task 被误判 stale。

Observer 不检测 `userCorrection`、`todoSignal` 等语义信号——这些由 Proposer 看到消息后自行判断。Observer 只记录每个 target 的 `trigger: { type: "lagThreshold" }`。user-boundary 裁剪只属于主聊天 recent window 的对话可读性规则，不能让 Assistant 消息从 Memory source 中消失。

### 1.2 Proposer

Proposer 按记忆族拆分调用，每个调用都必须使用 provider 支持的 schema-constrained structured output 强制输出 schema（见 [state-contract.md](state-contract.md) §5.5）。LLM 调用经由 [state-contract.md](state-contract.md) §10 的 Memory 专用 Provider Adapter 层；不支持 structured output 的 Provider/model 配置启动即失败。adapter 把正常输出、网络/Provider 失败、refusal/safety block、max-output truncation 和 schema invalid 归一化为不同结果；`status: "error"` 不交给 Reducer，由 tick orchestrator 直接写 ops_log 并按 §3.1 恢复策略处理。

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

1. **schema 校验**：patch 的 op、path/itemId、value 是否符合 [state-contract.md](state-contract.md) §4 的 Patch Op 约束；item patch 由所属 `sectionResults` key 直接确定 section，只有 scene 字段操作使用 `path`。Todo add 必须含 actor/requester，todo update 必须含显式 dueChange；Reducer 解析 dueAt 表达式，相对期限以该 patch 最新 evidence message 的数据库 createdAt 为 anchor，不使用 task/worker 时间。
2. **evidence source 校验**：普通模式非 `mergeItems` patch 的 `evidenceRefs.messageId` 必须在 `observedMessages` 范围内且真实存在；数据库中的 user/preset/role/createdAt/contentHash 必须与 proposal-time task payload 一致，并按 evidenceKind 校验真实 role。`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`，Reducer 校验 `itemIds` 指向的 source items 存在且带有结构合法的 `evidenceGroups`。
3. **quote 模糊匹配**：普通模式非 `mergeItems` patch 按 [state-contract.md](state-contract.md) §7 的 200-code-point、最少 3 个信息字符和统一 Levenshtein 规则校验。
4. **policy gate**：按 section + op + evidenceKind 查 [state-contract.md](state-contract.md) §6 的 policy table，判断是否允许。
5. **结构化冲突检测**：只检查同字段覆盖（`setField`）、同 itemId 操作（`updateItem`/`forgetItem`/`completeTodo` 等）、跨 section 合并、itemId 是否真实存在和操作顺序合法性。不做语义冲突检测。
6. **领域生命周期归一化**：先在模拟 post-state 上应用 dueAt 到期、scene TTL 和 recentEpisodes 滑动窗口规则；任何确定性持久化变化都按 [state-contract.md](state-contract.md) §9.2 写对应 system cleanup event，禁止 silent mutation。Todo 到期原位变 overdue；scene 到期写单值 previousScene 后清空固定字段；recentEpisodes 滚出最旧项。
7. **长度预算**：对 lifecycle 归一化后的模拟 post-state 按 [state-contract.md](state-contract.md) §8 校验容量。Todo 容量只统计 active items；recentEpisodes 已由滑动窗口收敛；previousScene/overdue 不触发 compaction。其余 item section 超限时 normal task 进入 `capacity_blocked`，只为触发容量阻塞的 patch 写 `deferred` event（`result_revision=null`），同事务创建 maintenance task。
8. **apply**：通过校验的 patch 应用到 state，生成新 state。普通 add/update item patch 的 `evidenceRefs` 补入已校验的数据库 `contentHash` 后，与 `patch.evidenceKind` 包装为一个 `evidenceGroup` 追加到 item；`forgetItem` 从 pre-state item 的完整 evidenceGroups 生成 tombstones 后移除 item，不把 forget evidence 追加到已移除对象；`mergeItems` 继承 source items 的 `evidenceGroups`，各 group 保留各自 evidenceKind。Todo add 写入 actor/requester/dueAt；update 按 dueChange keep/clear/set 修改 dueAt。Todo merge 仅在 actor/requester/dueAt 分别相同时成立并原样继承三字段。
9. **事件记录**：为整个 task bundle 建立一个 event group；每个 patch 的决策写一行 event，`noop` 写占位，Reducer/housekeeping 的确定性 state 变化写通用 `system_cleanup` event。Proposal 模拟 post-state 直接触发的 cleanup 与 proposal decisions 共用该 proposal group/revision；无 proposal 的后台 housekeeping 使用独立 `group_kind=system_cleanup`。accepted/system cleanup 必须保存完整 `normalized_operation`。
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

上述查询都基于跨 session 的完整有效 source，不做 user-boundary 裁剪。普通聊天中 `0 < lag < lagThreshold` 的尾批允许暂留：recent window 仍提供原文，后续消息到达后再一起处理；这不是 correctness failure，因此不增加 idle flush 或 session rollover flush。若极长新消息使尾批离开 recent window，主聊天由 [rendering-and-context.md](rendering-and-context.md) §2.1 的 per-target GapBridge 补齐，不通过修改 cursor 或提前调用 Proposer 来掩盖 gap。

Source rebuild、一次性迁移和服务器维护排查不受普通 `lagThreshold` 限制，必须调用同一 worker 内部 `forceDrainTo(capturedBoundaryMessageId)`，直至六个 normal target cursor 都到达捕获边界。`forceDrainTo` 只是绕过 eligible 阈值并重复执行既有 target pipeline，不是新的 task 类型或独立 Flush 子系统；generation、dirty 派生状态和 rebuild 原子边界见 §7。

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
    - task/proposal 的 `sourceGeneration` 仍等于当前 `memory_state.meta.sourceGeneration`；generation 不同立即取消旧 normal/maintenance task，不跨 generation replay；
    - 当前 target cursor 仍等于原 `cursorBefore`；
    - proposal 仍是该 target 的活动 proposal（normal task 非终局）；
    - 引用 item 仍存在并通过当前 state 的纯代码预检；
    - schema/source hashes 仍兼容。

    generation 相同时，其他 target 导致的 revision 增长不使 proposal stale；原始 `baseRevision` 只用于审计。
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
- 可重试调用失败（`llm_call_failed`/`safety_policy_blocked`/`max_output_truncated`）：target status 的 `consecutiveErrors + 1`，task 进入 `retry_wait` 并写有限指数退避的 `notBefore/nextRetryAt`。三类原因必须分别记录指标；truncation 重试可由 Adapter 按集中配置在 Provider 物理上限内调整输出预算，但不得改变 Memory section 容量。
- 持续性错误（`output_schema_invalid`）：task 进入 failed，对应 target status 直接进入 halted；不重试同输入。
- 升级阈值（仅上述可重试错误）：`consecutiveErrors` 达 3 后仅将该 target 置为 halted。其它 targets 的 task/cursor/status 不受影响，`memory_state` 继续保留该 target 最后一次稳定 state。

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

`assistant_correction` 与 `user_correction` 权限相同，均可修正上述四个正式 section。明确 forget 则使用 `forgetItem + user_forget/assistant_forget`，其权限和原子 suppression 规则见 §5；不得把 forget 伪装成 correction。

单次临时剧情、一次性情绪、单场景互动不得进入长期档案或世界事实。行为推断只适用于 profile/relationship，并且只在窗口内有清晰、显著的行为模式时成立；一次性动作不构成 trait。`memory_compaction` 只能用于合并同一 section 内的已有 item，不得作为新增长期事实的证据类型。

长期 section 的去重由 `compactionProposer` 在维护模式下用 `mergeItems` 兜底；normal Proposer 不输出 `mergeItems`，不承担主动去重。Reducer 不做文本相似度去重。`compactionProposer` 只能在同一正式 section 内合并，禁止跨 section 合并。

> 跨 tick 重复模式累积晋升（N=3/K=2）需要确定性 ledger + 结构化标签匹配（非语义匹配）才能可靠实现，首版不做，留作未来探索。行为推断在单个 contextWindow 内完成，不依赖跨 tick 累积。

## 5. 删除与遗忘

遗忘是确定性策略，不是摘要模型的副作用。

- `scene` 字段被新状态覆盖（`setField`）。
- scene TTL 到期时把完整旧值及 provenance 写入单值 `current.previousScene` 后清空 current；新到期 scene 直接替换旧 previousScene，并分别记录 `scene_expired` / `expired_scene_evicted`，不调用 compactionProposer。
- `recentEpisodes` 超出滑动窗口容量时按确定性顺序滚出最旧 item，并记录 `recent_episode_evicted`；只有真正关键的 episode 由 `episodeProposer` 主动输出 `addItem` 到 `longTerm.milestones`。
- `todos` 只能因完成、取消或失效而移除（`completeTodo`/`cancelTodo`/`expireTodo`）；`updateItem` 只修订待办内容或时间字段。
- wall-clock 到达 `dueAt` 不是删除/expire：housekeeping 在 `working.todos` 内原位将 active item 更新为 overdue，保留 provenance，并记录 `todo_became_overdue`。Overdue 仍可 complete/cancel，不自动 archive，也不参与 compaction。
- `standingAgreements` 只能因取消或修订而移除或改变（`cancelAgreement`/`updateItem`）。
- `milestones` 位于长期区，默认不删除，只允许 `mergeItems` 和基于 `user_correction`/`assistant_correction` 的 `updateItem`。
- `worldFacts`、`userProfile`、`assistantProfile` 和 `relationship` 只允许通过 `forgetItem + user_forget/assistant_forget` 明确遗忘；User 与 Assistant 对四个 section 权限相同。不能用“修改 text 为作废”代替 forget。

禁止 Proposer 使用通用 `removeItem`。删除必须表达为更窄的语义 op（见 [state-contract.md](state-contract.md) §4）。`compactionProposer` 也不例外：它的主要能力是 `mergeItems`，不是删除。容量压力不能成为长期记忆静默遗忘的理由。

### 5.1 Correction 与 provenance

`updateItem + user_correction/assistant_correction` accepted 时创建新 revision：active state 中目标 item 只保留修正后的可见 value，但保留 itemId，并把本次已校验的 correction evidence 作为新 `evidenceGroup` 追加到既有完整 `evidenceGroups`。旧 event/revision/snapshot 不改写；Renderer 只渲染当前 revision 的新值，不渲染旧值或把旧值写成“已作废”。

在 apply 前，Reducer 从 pre-update item 的全部 `evidenceGroups` 收集每个 ref 的 `messageId + contentHash`。本次 correction 的 state/event/snapshot 与旧 source 的 context-suppression tombstones 必须同一事务提交；任一写入失败则 correction 整体 rollback。Tombstone 提交后立即成为查询过滤的 correctness gate，相交 RAG chunks 由 projection worker 失效/删除。Correction 消息自身的新 evidence 正常进入 RAG，只有被替换 item 的旧 source 被 suppress。

### 5.2 Forget 与 context-suppression tombstone

`forgetItem` accepted 时，Reducer 必须先读取当前 item 的完整 `evidenceGroups`，直接收集所有 ref 的 `messageId + contentHash`，再从 active section 移除该 item。无需建立 provenance graph，也不遍历完整 event chain；update 追加和 merge 继承 evidenceGroups 的规则保证当前 item 已覆盖全部历史来源。

Context-suppression tombstone 是独立于 `memory_state`、跨 `sourceGeneration` 保留的 durable sidecar。每条至少包含 `(userId, presetId, messageId, contentHash)`、reason=`forget|correction`、来源 item/section、创建 revision 与时间；同一 source key 重复写入必须幂等。`forgetItem` 的 active-state 移除、accepted event、snapshot 与 tombstones 必须同一事务提交，禁止出现“item 已删但 source 可重新召回”或“已 suppress 但 revision 未提交”的半状态。相交 RAG chunks 随后由 projection worker 失效/删除；在此之前查询末端的 tombstone 过滤仍阻止其返回。

Tombstone 只抑制匹配的 `messageId + contentHash` 版本，不修改 raw chat message，也不删除历史 event/snapshot。Source rebuild 可以按时间顺序重放 raw messages以重建 correction 链，但在清除 dirty 前必须以 tombstones 做确定性终态过滤：任何 evidenceGroups 含 suppressed source 的候选默认从 active state 移除；唯一例外是它同时含 messageId 更晚、未 suppressed 的 `user_correction/assistant_correction` evidenceGroup，此时保留修正后 item 及完整 provenance。RAG/Recall 及主聊天 context 仍不得注入其中匹配的旧 source。这样既能重建修正后的 item，又不能让已 forget 的旧事实因 rebuild 或与其他 evidence 合并而再次出现。

### 5.3 RAG/Recall suppression

当前不引入 `suppressionProposer`。RAG chunk 必须保存组成它的全部 source `messageId + contentHash`；任一 source key 命中 tombstone，现有 chunk 即失效/删除。后续分块和 embedding 跳过整条匹配消息，查询返回前再做一次 source suppression 过滤，防止 checkpoint 延迟或残留 chunk 泄漏。Correction 的新消息按普通 source 建索引。

Recall 在选择 evidenceGroup、拉 raw window 和拼合 context 三处应用相同 source-key 过滤：suppressed ref 不能作为候选 join key，suppressed raw message 不能出现在 recall 文本；一个 group 的 refs 全被过滤后跳过该 group。该 message-level 方案可能连带排除同一消息中的其他无关事实，这是当前为降低复杂度明确接受的保守副作用。片段级方案见 [Suppression Proposer 延后设计](../memory-control-v2-deferred/suppression-proposer.md)。

### 5.4 Privacy hard delete

Privacy hard delete 与普通 forget 不同：它必须物理清除指定内容在 raw messages、Memory state/events/snapshots、durable task/proposal payload、context-suppression tombstones、RAG/Recall 与 ops/debug 派生存储中的副本。删除会使旧 revision/source 不再可 replay，因此在同一受控维护流程增加 `sourceGeneration`，删除受影响的旧派生历史，再从剩余 raw source rebuild/force drain；完成全存储校验前保持 `rebuilding`，不得继续注入旧 context。普通 forget 不执行物理删除。

## 6. NSFW 与安全策略

对成年且 consensual 的成人互动，Proposer 以客观、摘要化方式提出事件本质、双方意愿、关系变化和稳定偏好；Renderer 只渲染已进入 `memory_state` 的摘要化字段，不摘录大段感官描写。

Reducer 不对成人内容做社会规范层面的二次审查；它只校验证据引用、policy gate、冲突和删除规则。Provider 安全策略造成的拦截由 Provider Adapter 识别为 `safety_policy_blocked`（[state-contract.md](state-contract.md) §10），由 tick orchestrator 写入 ops_log，不得伪装成 noop 或静默跳过。

## 7. 迁移原则

### 7.1 Source Generation 与自动 Rebuild

`memory_state.meta.sourceGeneration` 是 Memory、RAG 与 Recall 共享的 raw-source 世代。普通追加 User/Assistant message 不增加 generation，只唤醒 normal worker。只有变更触及至少一个 target cursor 已覆盖的 source 时，才自动 `sourceGeneration + 1` 并 rebuild：

- 编辑历史消息；
- regenerate 导致截断或删除后续消息；
- 删除历史消息；
- session trash、restore 或 permanent delete；
- 消息 preset 归属或可见性变化；
- raw source 排序语义变化。

服务器维护脚本还可因 state/schema 损坏、关键 Proposer prompt/model 更换、不兼容的 Memory schema/compaction 语义变化、人工判断无法局部修复，或 v2 首次从 raw history 建立 state 而显式 rebuild。

自动 source mutation 必须在一个数据库事务中完成以下动作：提交 raw source 变化；捕获变化后的有效 source boundary；`sourceGeneration + 1`；取消旧 generation 的全部非终态 Memory tasks（normal/maintenance/system_cleanup）；初始化该 generation 的空 state 与六个 target cursor；写下一个全局 revision 的完整 snapshot；将六个 target status 更新为同 generation 的 `rebuilding` 并保存 captured boundary。Generation 初始化 revision 不伪造某个正式 section/target 的 event group，后续恢复从该完整 snapshot 开始且禁止跨 generation replay。任一步失败都整体 rollback，禁止 controller 在 source 已提交后再 best-effort 标 dirty。当前 generation 仍有任一 `rebuilding` target 即为持久化 dirty 状态，不另设全局 dirty flag。

Rebuild worker 从当前 generation 的有效 raw messages 重放，并调用 §7.2 的 `forceDrainTo(capturedBoundaryMessageId)`，忽略 `lagThreshold` 直到六个 target cursor 都到达 captured boundary。完成后必须校验 state/schema、generation、snapshot、event/revision 连续性和全部 target cursors；每个 target 只有在自身校验通过后才能清除 `rebuild_boundary_message_id` 并恢复 `healthy`。generation 期间再次变化时，本轮所有结果 stale，必须丢弃并由新 generation 重启流程。

RAG 与 Recall invalidation 不依赖通用 outbox。两者各自持久化独立 projection checkpoint，至少包含 `processedGeneration` 与 `processedBoundaryMessageId`；worker 在启动、周期轮询和进程内 wake-up 时，把 checkpoint 与权威 `sourceGeneration` 和当前 source boundary 比较。generation 不同则失效并重建当前 generation 的派生数据；generation 相同的普通追加按 boundary 增量追平。每轮先捕获 generation/boundary，提交前再次校验 generation，只有仍一致且追平 captured boundary 时才能原子推进 checkpoint。进程内 wake-up 只降低延迟；checkpoint 比较才是 correctness 保证。

### 7.2 Force Drain 与一次性迁移

`forceDrainTo(boundaryMessageId)` 只是 worker 内部能力：绕过普通 eligible/`lagThreshold` 门槛和 `rebuilding/halted` 的普通调度门控，重复使用既有 durable normal tasks 和六条 target pipeline，直到所有 target cursor 到达指定边界。该旁路只对已授权的 rebuild/维护入口开放，普通 Observer 仍不得为 rebuilding/halted target 创建 proposal。Force-drain task 成功提交中间批次时 target 保持 `rebuilding`，到达并校验自身 captured boundary 后才恢复 `healthy`。它只用于 source rebuild、服务器维护脚本排查和一次性迁移；不新增 Flush 子系统、Flush task type、状态机或持久化表。

v2 是新的权威 memory 设计，不以 v1 兼容为目标。一次性迁移不是长期运行时子系统，也不新增专用 task type：停止对外服务 → 更新 schema/代码 → 物理删除旧 rolling/core Memory 数据 → 从 raw messages 初始化 v2 state 并 rebuild/force drain → 校验 generation/state/snapshots/events/cursors 与 projection checkpoints → 启动服务。Rebuild 未追平或校验失败时不得启动对外聊天服务。

旧 `rolling_summary` 和 `core_memory` 不直接转换为 v2 state。回放仍按批次跑 v2 pipeline（Observer → 专用 Proposer → Reducer）；不设计“文本转结构”的特殊路径。无法回放的旧文本不得成为 authoritative memory，也不继承旧 `meta.recovery`、halt 或 error count。

v2 直接作为 active memory path 上线。v1 代码路径在 v2 线上跑稳后再清理，但这只是代码清理纪律，不是 runtime feature flag。

## 8. 失败与降级

失败时保留上一次稳定 `memory_state`。系统不回退到旧的全文摘要重写路径。各失败决策的恢复语义见 §3.1。

- **Target 连续多次 error**：按 §3.1 升级阈值把该 per-target status 置为 halted，保留最后稳定 state；其它 targets 和主聊天不被全局阻断。
- **持续性错误**（`output_schema_invalid`）：当前 task failed、对应 target halted，不重试同输入；只更新 task/status/ops log，不产生 revision/snapshot。
- **进程重启**：单实例 worker 从数据库读取非终态 durable task，按最后持久化 stage 继续，并重新校验 revision/cursor；进程内队列不是恢复 authority。
- **state/schema 损坏**：优先从当前 generation 最新合法 snapshot + 后续 normalized events 恢复；必要时按 §7 从 raw messages rebuild。
- **resume**：手动重置指定 per-target status 和对应 task 后继续，不修改语义 state，不跳过 cursor 后消息。

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

1. 告警必须持久化或从持久化状态确定性派生，并在每次相关响应中持续返回，直到对应 target/status/诊断满足明确恢复条件；不能只弹一次后隐藏。
2. 用户文案保持简洁，但必须指出受影响的记忆类别、是否可能滞后，以及可操作时是否需要人工恢复。精确 reason、taskId、target、attempt、cursor/处理边界保留在诊断信息中；halted 告警必须让运维侧可见这些边界。
3. 恢复时明确产生一次“Memory 已追平到相应 boundary”的恢复通知；清除 active 告警与写入恢复状态使用同一已持久化结果，不能先宣称恢复再异步清状态。
4. `halted`、`capacity_blocked` 或 `retry_wait` 不产生全局 `chatBlocked`，也不产生 user/preset 级 halt。其他 targets 和主聊天继续运行。
5. Renderer 继续使用受影响 target 最后一次成功提交的稳定 state，并在上下文中标记该类记忆“可能滞后”；recent window 与该 target 的 GapBridge 仍可补充未写入 Memory 的 raw messages。
6. resume/rebuild 等服务器维护脚本可操作 halted target；普通 Observer/proposal 在恢复完成前不得绕过该 target 的调度门控。Compaction/replay 成功、cursor 推进并提交 snapshot 后只恢复对应 target，不要求其他 targets 同步恢复。

### 8.2 运营指标

以下指标只用于观测、容量规划和告警，不因单次样本直接阻断主聊天：

- 总体及 per-target 的 calls/message、eligible rate、input/output tokens、Provider/model latency 与费用；
- `output_schema_invalid`、`safety_policy_blocked`、`max_output_truncated`、`llm_call_failed` 与 `unable_to_decide`/`unable_to_compact` rate；
- quote similarity 分布，以及 quote-too-short/quote-not-found/quote-too-long rate；
- compaction success/failure、`replay_failed`、target halt rate、deferred proposal age；
- queue age/backlog、revision/cursor stale；
- GapBridge raw/truncated/omitted；
- rebuild duration、RAG/Recall projection lag、Memory degraded/rebuilding 持续时间。

相比原设计的五个 normal Proposer，当前固定为六个 target 调用族，必须按 target 分开观测调用量、eligible rate、tokens、延迟和费用。只有真实指标表明 `profileRelationship`/`worldFacts` 拆分造成不可接受的成本或延迟时，才重新评估拆分粒度；低价 API 不是忽略限流、失败率或错误累积的理由。

### 8.3 集中配置

以下变量由一个 Memory 配置入口加载、校验并供 Adapter/Observer/Reducer/Renderer/worker 共用，禁止在各模块散落默认值：每个 section 的 `maxItems/maxRenderedChars`、scene TTL、overdue todo 的 `maxRenderedItems/maxRenderedChars`、每个 target 的 `lagThreshold`、GapBridge raw 字符预算与截断后最近消息数、quote 匹配算法与阈值、Provider retry/backoff、compaction retry 次数与 target halt 条件、snapshot/event/debug retention，以及 degraded/rebuilding 告警防抖与恢复条件。

Evidence quote 最大 200 Unicode code points 是固定协议值；quote 模糊匹配默认阈值为 `0.75`，但允许从同一集中配置调整。其余默认值在实现前依据真实历史分布和 Provider 能力确定，并随配置文档记录；配置缺失或越界必须在启动/加载边界显式失败，不在运行路径临时猜测。
