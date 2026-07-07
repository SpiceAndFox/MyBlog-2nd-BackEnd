# Memory Control v2 写入协议

本文定义 Memory v2 的写入链路与 Reducer 治理规则。所有数据 shape、枚举、查表、校验算法见 [state-contract.md](state-contract.md)；prompt 细节见 [proposer-prompt.md](proposer-prompt.md)；渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. 写入流水线

Memory v2 的写入链路固定为 4 步：

1. **Observer**（纯代码）：读取最近对话、当前 state、各 section cursor，按 lag 阈值计算 eligible proposer tasks，组装结构化输入。
2. **Proposer**（按记忆族调用，schema-constrained structured output）：每个专用 Proposer 只处理自己负责的 section，输出 patch / noop / unable_to_decide，并按 op 附 evidenceKind；除 `mergeItems` 外附 `evidenceRefs`。
3. **Reducer**（纯代码）：schema 校验 → messageId 存在性 → quote 模糊匹配 → policy gate → 结构化冲突检测 → apply。
4. **Renderer**（纯代码模板）：读取最新 `memory_state`，实时渲染为主聊天模型可读的 memory 文本。

职责边界：

- **Observer 只算 lag，不做信号检测**。是否需要更新某 section 由对应专用 Proposer 看到消息后自行判断。
- **Proposer 只提出候选 patch + evidenceKind 枚举分类**，不判断最终可信度，不输出自由置信度分数。不同记忆族使用不同 prompt/schema，避免单个万能 Proposer 被过多规则污染。
- **Reducer 不做开放式自然语言理解**，只检查 schema、messageId 存在性、quote 模糊匹配、policy 查表、同字段/同 itemId 的结构化冲突。
- **Renderer 不暴露 patch log、event log 或 reducer 细节**给主聊天模型。

### 1.1 Observer

Observer 构造一次 memory tick 的结构化输入，只做三件事：

1. 对每个 section 计算 `lag = 该 user/preset 下 id > coveredUntilMessageId 的消息数量`，lag 达到阈值的 section 为 eligible。
2. 按 Proposer family 聚合 eligible sections，生成 `eligibleTasks`。
3. 为每个 eligible task 按 `coveredUntilMessageId` 之后的分页规则收集 observedMessageIds（见 §2），并组装 Proposer input envelope（结构见 [state-contract.md](state-contract.md) §5）。

Observer 不检测 `userCorrection`、`todoSignal` 等语义信号——这些由 Proposer 看到消息后自行判断。Observer 只记录每个 section 的 `trigger: { type: "lagThreshold" }`。

### 1.2 Proposer

Proposer 按记忆族拆分调用，每个调用都必须使用 provider 支持的 schema-constrained structured output 强制输出 schema（见 [state-contract.md](state-contract.md) §5.5）。LLM 调用经由 [state-contract.md](state-contract.md) §10 的 Provider Adapter 层——adapter 把 provider 响应与错误（含 `safety_policy_blocked`）归一化为统一结果；`status: "error"` 的结果不交给 Reducer，由 tick orchestrator 直接写 ops_log 并按 §3.1 恢复策略处理。

首版固定 6 个 Proposer：

| Proposer               | 负责 section                                    | 更新特征                           |
| ---------------------- | ----------------------------------------------- | ---------------------------------- |
| `currentStateProposer` | `scene`                                         | 高频、覆盖式、字段级证据           |
| `todoProposer`         | `todos`                                         | 中频、事件型、需要完成/取消/过期   |
| `agreementProposer`    | `standingAgreements`                            | 中低频、事件型、持续互动约定       |
| `episodeProposer`      | `recentEpisodes`, `milestones`                  | 近期经历与长期里程碑的晋升判断     |
| `coreProposer`         | `core`                                          | 低频、保守、长期事实和用户修正     |
| `compactionProposer`   | `todos`, `standingAgreements`, `milestones`, `core`（`recentEpisodes` 暂不触发，由滑动窗口处理） | 维护型、只处理预算压力下的合并精简 |

前 5 个是正常写入 Proposer，由 Observer 按 lag 调度。`compactionProposer` 是维护 Proposer，只由 Reducer 的长度预算门触发，不参与普通 lag 轮询。

普通 Proposer 在正常 pass 中若发现 writableState 里有明显重复或高度重叠的 item，可以直接输出 `mergeItems`（policy table 已按 section + evidenceKind 把关安全性）。`compactionProposer` 只负责预算压力下的兜底合并，不承担主动去重；主动去重由各 normal proposer 在自己的 writableState 范围内顺带完成。

Proposer 的拆分边界是 section family，不是字段级。`scene.location`、`scene.time`、`scene.mood`、`scene.note` 由同一个 `currentStateProposer` 处理。

Proposer 的输入/输出 envelope、字段语义、边界规则和各 Proposer 的 readOnlyContext 固定范围见 [state-contract.md](state-contract.md) §5。每个 Proposer 看到自己的 eligible sections 后，自行决定每个 section 输出 `patches` / `noop` / `unable_to_decide`。

### 1.3 Reducer

Reducer 是纯代码的 Policy Gate + State Applier。它不使用 LLM，不做开放式自然语言判断，不做语义冲突检测，不做语义匹配。

Reducer 必须按顺序执行：

1. **schema 校验**：patch 的 op、path/itemId、value 是否符合 [state-contract.md](state-contract.md) §4 的 Patch Op 约束。
2. **messageId 存在性校验**：普通模式非 `mergeItems` patch 的 `evidenceRefs.messageId` 是否在 `observedMessages` 范围内且真实存在；`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`，Reducer 校验 `itemIds` 指向的 source items 存在且带有结构合法的 `evidenceGroups`。
3. **quote 模糊匹配**：普通模式非 `mergeItems` patch 按 [state-contract.md](state-contract.md) §7 策略校验。
4. **policy gate**：按 section + op + evidenceKind 查 [state-contract.md](state-contract.md) §6 的 policy table，判断是否允许。
5. **结构化冲突检测**：只检查同字段覆盖（`setField`）、同 itemId 操作（`updateItem`/`completeTodo` 等）、同 section/path 合并、itemId 是否真实存在和操作顺序合法性。不做语义冲突检测。
6. **长度预算**：各 section item 数量上限（[state-contract.md](state-contract.md) §8）。`recentEpisodes` 超限时确定性滚出最旧 item；其它 section 新增超限时返回 `deferred: length_budget_exceeded` 并触发 compaction task，维护失败后才最终拒绝新增。
7. **过期清理**：Reducer 自行触发，扫描 `expiresAtTime < now`（wall-clock）的 todo，从数组中移除。这是纯确定性清理，不需要 evidenceRefs，不产生事件行（自然遗忘）。此取舍的理由见 [state-contract.md](state-contract.md) §8。
8. **apply**：通过校验的 patch 应用到 state，生成新 state。普通非 `mergeItems` item patch 的 `evidenceRefs` 包装为一个 `evidenceGroup`；`mergeItems` 继承 source items 的 `evidenceGroups`。
9. **事件记录**：每个 patch 的决策写一行 `chat_memory_events`（[state-contract.md](state-contract.md) §9.1）；`noop` 写一行占位（`decision=noop`，`patch_id` 为 null）。一个 section 一个 tick 可能有多个 patch，因此可能有多行 event。section 级 cursor 推进是派生的：看该 section 该 tick 的所有 event 行聚合（见 §3）。

职责顺序敏感，不可随意调换。

### 1.4 Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列，是纯代码模板，不调用 LLM。具体模板与规则见 [rendering-and-context.md](rendering-and-context.md)。

## 2. 路由与触发

v2 不为每个字段单独调用 Proposer，也不使用单个万能 Proposer。每次 memory tick 按 eligible sections 调度一个或多个专用 Proposer，输出各自负责 section 的 patch bundle。

**检测频率与上下文窗口是两个独立参数**：

- `lagThreshold`（N）：检测频率。`lag = 该 user/preset 下 id > coveredUntilMessageId 的消息数量`，lag >= N 时该 section eligible。
- `contextWindow`（M ≥ N）：发给 Proposer 的观察窗口大小上限。
- `newBatch`：从 `coveredUntilMessageId` 之后按 `id ASC` 取最早的 `min(N, lag)` 条未处理消息。
- `overlap`：从 `coveredUntilMessageId` 及之前取最近的 `M - newBatch.length` 条消息，按 `id ASC` 放在 `newBatch` 前。
- `observedMessageIds = overlap + newBatch`，`targetMessageId = max(newBatch.id)`。窗口内 `id > coveredUntilMessageId` 的消息是本轮新消息，`id <= coveredUntilMessageId` 的消息只作重叠上下文。普通写入 patch 的 evidenceRefs 可以引用 observedMessages 中的任意消息（含重叠部分），但 patch 应反映本轮新消息。

- Observer 将 eligible sections 聚合成 `eligibleTasks`，每个 task 对应一个 Proposer。
- 只有目标 section 出现在该 Proposer 的输入和输出契约中。
- 非目标 section 不出现在 Proposer 输出的 `sectionResults` 中，其 cursor 不推进。
- **目标 section 是否实际发生变化，由对应 Proposer 读取 envelope 后自行决定**（输出 patch 或 noop），不由 Observer 预判。

触发与上下文窗口建议（可调）：

| Section          | lagThreshold | contextWindow | 理由                                         |
| ---------------- | ------------ | ------------- | -------------------------------------------- |
| `scene`          | 4            | 6             | 场景变化高频，及时捕捉；窗口小，当前状态为主 |
| `todos`          | 6            | 12            | 待办中频；窗口略大以判断完成/取消            |
| `standingAgreements` | 8        | 12            | 持续约定中低频；窗口用于判断修订/取消        |
| `recentEpisodes` | 10           | 15            | 近期经历中频                                 |
| `milestones`     | 10           | 15            | 里程碑晋升判断来自 episode flow              |
| `core`           | 8            | 20            | core 低频但需较多上下文判断长期事实          |

### 2.1 Compaction task

`compactionProposer` 不是普通写入 Proposer，不由 lag 阈值调度。它只在 Reducer 的长度预算门发现 `addItem` 会超过上限时触发，用来释放容量或确认没有安全压缩空间。

触发流程：

1. 普通 Proposer 输出 `addItem`，且目标 section/path 已达到 item 数量上限。
2. Reducer 不立即最终拒绝，也不推进该 section cursor，而是记录 `decision: "deferred"`（[state-contract.md](state-contract.md) §9.1，`deferred` 不填 `reject_reason`），关联 `maintenance_task_id`，并创建一个 compaction task。
3. compaction task 与普通 task 共用同一 `userId/presetId` 串行队列（见 §2），使用 [state-contract.md](state-contract.md) §5.2 的 maintenance 模式 envelope。
4. `compactionProposer` 只能输出 `mergeItems` 或 `noop` / `unable_to_decide`（约束见 [state-contract.md](state-contract.md) §5.5）。
5. Reducer 对 compaction patch 继续执行 schema、itemIds、policy、结构化冲突和 source evidence 完整性校验。`memory_compaction` 的 evidenceGroups 由 Reducer 根据 `itemIds` 从 source items 继承。
6. 如果 compaction 成功释放容量，原 section 保持 cursor 不变，在下一次 tick 重新处理同一消息窗口（`deferred` 已阻止 cursor 推进，无论同 tick 是否存在 `accepted` patch，见 §3）。如果 compactionProposer 返回 `noop`/`unable_to_decide`（无安全合并空间），原新增 patch 最终 `rejected: length_budget_exceeded` 并推进 cursor。如果 compaction 发生技术性失败（LLM 调用/schema/provider），按 §3.1 error 恢复策略处理。

遗忘边界：

- `recentEpisodes` 的遗忘仍由 Reducer 按滑动窗口确定性滚出，不需要 compactionProposer。
- `todos` 不能因为容量压力被静默删除，只能完成、取消、过期或合并重复项。
- `standingAgreements` 不能因为容量压力被静默删除，只能取消、修订或合并重复项。
- `milestones` 和 `core` 不能自动遗忘；compactionProposer 只能合并明显重叠项，不能删除长期事实。
- 无安全合并空间时，系统保留旧 state、记录告警，后续新增继续按预算规则处理。

## 3. Cursor 推进规则

本节的 `cursor` 指当前 section 的 `coveredUntilMessageId`，存于 `meta.perSectionCursor[section]`。

核心原则：**Proposer 已经看过消息并给出了明确判断（patches 或 noop），且 Reducer 不需要外部维护任务才能完成决策，则消息视为已处理，cursor 推进。** 只有 Proposer 无法判断（`unable_to_decide`）、技术性失败（`error`）或预算维护暂缓（`deferred`）才不立即推进。

`accepted`/`rejected`/`deferred`/`noop` 是 Reducer 的 patch 决策，落 `chat_memory_events`（[state-contract.md](state-contract.md) §9.1）；`error`/`unable_to_decide` 发生在 patch 产生之前（Provider Adapter 层或 Proposer 自身），落 `chat_memory_ops_log`（[state-contract.md](state-contract.md) §9.2）。`error` 达阈值后触发该 `userId/presetId` 的 halt 而非推进 cursor；`unable_to_decide` 扩窗口重试一次后仍无法判断则推进 cursor。

| Reducer 决策       | Cursor 行为 | 落地表    | 触发条件                                                                                    |
| ------------------ | ----------- | --------- | ------------------------------------------------------------------------------------------- |
| `accepted`         | 推进        | events    | 至少一个 patch 被 apply                                                                     |
| `noop`             | 推进        | events    | Proposer 明确说无变化；记 `decision=noop` 占位行                                             |
| `rejected`         | 推进        | events    | patches 全被拒（policy/quote 等），或 compaction 无合并空间后的最终预算拒绝 |
| `deferred`         | 不推进      | events    | 新增被长度预算阻塞，已触发 compaction task                                                  |
| `unable_to_decide` | 不推进      | ops_log   | Proposer 自认判断不了；按 §3.1 扩大上下文重试，仍无法判断后推进 cursor（不是 error，不触发 halt）                 |
| `error`            | 不推进      | ops_log   | Provider Adapter 返回 `status: "error"`（[state-contract.md](state-contract.md) §10）；按 §3.1 重试，达到阈值后触发该 userId/presetId 的 halt                 |

`rejected` 推进的理由：Proposer 已处理消息，重跑同输入大概率得到类似结果——`policy_not_allowed` 是系统性错误，`quote_not_found` 虽可能因 LLM 随机性下次摘录不同 quote，但不值得为此卡住整个 section。`length_budget_exceeded` 只在 compaction 无合并空间后才作为最终 rejected 推进。

多 patch 部分接受：一个 section 一个 tick 的 `patches` 数组里可能多个 patch 独立校验，部分 `accepted` 部分 `rejected`/`deferred`。cursor 按 section 级聚合——**有任一 `deferred` 行则不推进**，无论是否存在 `accepted` 行；无 `deferred` 时，有任一 `accepted`/`noop`/`rejected` 行即推进。`deferred` 阻止推进是因为该 section 需要在 compaction 后重跑整个消息窗口——已 `accepted` 的 patch 已写入 state，重跑时 Proposer 会看到更新后的 `writableState` 并对已处理内容输出 `noop`，不会重复写入。被拒 patch 的 `reject_reason` 仍各自落 event 行供审计。

**混合 accepted+deferred 时的 reprocess 语义**：当同一 section 同一 tick 既有 `accepted` 又有 `deferred` patch 时，cursor 不推进（`deferred` 阻止推进）。compaction 成功后，section 重新处理同一消息窗口——Proposer 看到更新后的 `writableState`（已 `accepted` 的 patch 已在 state 中），对已处理内容输出 `noop`，对原 `deferred` 的 patch 重新输出（此时 compaction 已释放容量，可以 `accepted`）。compaction 失败时 `deferred` 转为 `rejected: length_budget_exceeded`，cursor 推进。

`deferred` 不推进：该 section 等待 compaction task 有界执行；compaction 成功后重新跑同一窗口，compaction 无空间后改为最终 rejected 并推进。

### 3.1 重试与恢复策略

cursor 表只规定 cursor 怎么动；本节规定每种不推进决策的恢复语义——重试时改变什么、何时升级。

**error（Provider Adapter 返回 `status: "error"`，见 [state-contract.md](state-contract.md) §10）**

- tick orchestrator 不把 error 结果交给 Reducer，直接写 ops_log（[state-contract.md](state-contract.md) §9.2）并按错误性质分流。cursor 不推进，下一 tick 该 section lag 仍超标，自然重试（tick 调度提供间隔，不是热循环）。
- 瞬时错误（`llm_call_failed`/`safety_policy_blocked`）：递增 `meta.recovery[section].consecutiveErrors`，允许跨 tick 重试。
- 持续性错误（`output_schema_invalid`）：不递增 `consecutiveErrors`、不重试同输入，直接触发 halt——schema-constrained output 正常情况下不应出现 `output_schema_invalid`，出现即 provider/schema 配置 bug，重试同输入大概率仍非法。
- 升级阈值（仅瞬时错误）：`consecutiveErrors` 达 3 后，触发 halt（`meta.halted=true`），该 `userId/presetId` 的聊天接口拒绝新消息。`consecutiveErrors` 保留不清零，等手动 resume 时重置。halt 不推进 cursor——cursor 停在出错前的位置，resume 后从该位置继续处理，不跳过任何消息。

**手动 resume**

```
CLI: node scripts/memory-v2-resume.js --userId=1 --presetId=default
API: POST /admin/memory/resume { userId, presetId }
```

resume 做的事：重置 `meta.halted=false` 和所有 `meta.recovery[section].consecutiveErrors=0`，入队一个正常 tick。下一 tick 各 section 的 lag 会很大（因为 cursor 停在旧位置），Observer 按"cursor 之后第 N 条消息"取窗口，正常走 pipeline。如果错误已修复 → 正常推进；如果没修复 → 再次 halt。

**unable_to_decide（Proposer 自认信息不足）**

- tick orchestrator 写 ops_log（outcome=`unable_to_decide`），置 `meta.recovery[section].awaitingContextExpansion = true`，不推进 cursor。
- 下一 tick Observer 读到 `awaitingContextExpansion` → 发扩大的 contextWindow（如 +10），而非重发同输入——同输入必然同结果。
- 扩大 1 次仍 `unable_to_decide` → 推进 cursor、清 `awaitingContextExpansion`，避免无限扩大。这不是 error，不触发 halt——Proposer 已明确判断"信息不足"，推进 cursor 是正确行为。

**rejected（Proposer 已判断但被拒）**

- 推进 cursor（见 §3 表格），记 events（decision=`rejected`）。不重试——重跑同输入大概率同结果。
- 不自动告警；rejected 模式靠人工查 `chat_memory_events` 发现。

**deferred（预算阻塞）**

- 不推进 cursor，记 events（decision=`deferred`）。触发 compaction task。compaction 成功释放容量 → 下一 tick 重跑同一消息窗口；compaction 返回 `noop`/`unable_to_decide`（无合并空间）→ 改 `rejected` 推进；compaction 技术性失败 → 按 error 策略处理。

## 4. Core 写入机制

`core` 的新增只接受 `long_term_fact` 一种 evidenceKind：长期事实，包括明确表达的（用户描述"我叫小明"、assistant 设定人格"这个世界有魔法"）和从行为推断的（用户多次在冲突中回避→倾向回避冲突）。对已有 core item 的改写基于 `user_correction` 或 `assistant_correction`，走 `updateItem`（见 [state-contract.md](state-contract.md) §6 policy table）——`addItem + user_correction/assistant_correction` 不再允许，因为"修正"语义上隐含"纠正已存在的东西"，应走更新 op；若纠正后要新增一条全新 core item，本质就是一条新的 `long_term_fact`。

`assistant_correction` 与 `user_correction` 权限相同，均可修正所有 core 子数组（`worldFacts`/`userProfile`/`assistantProfile`/`relationship`）。

单次临时剧情、一次性情绪、单场景互动不得进入 core。行为推断只在窗口内有清晰、显著的行为模式时才成立，一次性动作不构成 trait。这靠 Proposer 的 prompt 约束 + Reducer 的 evidenceKind policy gate 共同保证。`memory_compaction` 只能用于合并已有 core item，不得作为新增长期事实的证据类型。

core 的去重完全由 Proposer 在自己的 `writableState` 范围内顺带完成（§1.2），Reducer 不做 core item 的文本相似度去重——纯代码字符串相似度既与 Proposer 的语义去重重叠，又有把两条相近但不同的长期事实误判为重复的风险。若重复 item 溜进来，最终由 `compactionProposer` 的 `mergeItems` 兜底合并。Reducer 保持纯代码、不做语义判断的职责边界（§1.3）。

> 跨 tick 重复模式累积晋升（N=3/K=2）需要确定性 ledger + 结构化标签匹配（非语义匹配）才能可靠实现，首版不做，留作未来探索。行为推断在单个 contextWindow 内完成，不依赖跨 tick 累积。

## 5. 删除与遗忘

遗忘是确定性策略，不是摘要模型的副作用。

- `scene` 字段被新状态覆盖（`setField`）。
- `recentEpisodes` 按窗口自然滚出（Reducer 清理超出上限的旧 item）；只有真正关键的 episode 由 `episodeProposer` 主动输出 `addItem` 到 `longTerm.milestones`。
- `todos` 只能因完成、取消或失效而移除（`completeTodo`/`cancelTodo`/`expireTodo`）；`updateItem` 只修订待办内容或时间字段。
- `standingAgreements` 只能因取消或修订而移除或改变（`cancelAgreement`/`updateItem`）。
- `milestones` 位于长期区，默认不删除，只允许 `mergeItems` 和基于 `user_correction`/`assistant_correction` 的 `updateItem`。
- `core` 不存在真正删除 op；用户或 assistant 表达删除意图时，Proposer 输出 `updateItem` 在 value 中写明修正/作废语义。所有 core 子数组均接受 `user_correction`/`assistant_correction`（见 [state-contract.md](state-contract.md) §6）。

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

- **Section 连续多次 error**：按 §3.1 升级阈值触发 halt，保留旧 state。halt 后该 `userId/presetId` 的聊天接口拒绝新消息，等手动 resume。
- **持续性错误**（`output_schema_invalid`）：直接触发 halt，不重试。
- **resume**：手动重置 `meta.halted` 和 `consecutiveErrors` 后入队正常 tick，从 cursor 位置继续处理，不跳过任何消息。
