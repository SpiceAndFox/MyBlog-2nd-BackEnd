# Memory Control v2 写入协议

本文定义 Memory Control v2 的写入链路和 Reducer 治理规则。状态 shape 见 [state-contract.md](state-contract.md)，prompt 细节见 [proposer-prompt.md](proposer-prompt.md)，渲染接入见 [rendering-and-context.md](rendering-and-context.md)。

## 1. 写入流水线

Memory v2 的写入链路固定为 4 步：

1. **Observer**（纯代码）：读取最近对话、当前 state、各 section cursor，按 lag 阈值计算 eligible proposer tasks，组装结构化输入。
2. **Proposer**（按记忆族调用，schema-constrained structured output）：每个专用 Proposer 只处理自己负责的 section，输出 patch / noop / unable_to_decide，并附 evidenceKind 和 evidenceRefs。
3. **Reducer**（纯代码）：schema 校验 → messageId 存在性 → quote 模糊匹配 → policy gate（按 evidenceKind 查表）→ 结构化冲突检测 → apply。
4. **Renderer**（纯代码模板）：读取最新 `memory_state`，实时渲染为主聊天模型可读的 memory 文本。

职责边界：

- **Observer 只算 lag，不做信号检测**。是否需要更新某 section 由对应专用 Proposer 看到消息后自行判断。
- **Proposer 只提出候选 patch + evidenceKind 枚举分类**，不判断最终可信度，不输出自由置信度分数。不同记忆族使用不同 prompt/schema，避免单个万能 Proposer 被过多规则污染。
- **Reducer 不做开放式自然语言理解**，只检查 schema、messageId 存在性、quote 模糊匹配、policy 查表、同字段/同 itemId 的结构化冲突。
- **Renderer 不暴露 patch log、event log 或 reducer 细节**给主聊天模型。

### 1.1 Observer

Observer 的职责是构造一次 memory tick 的结构化输入。它只做三件事：

1. 对每个 section 计算 `lag = recent window 末端 message id - 该 section 的 coveredUntilMessageId`，lag 超过阈值的 section 为 eligible。
2. 按 Proposer family 聚合 eligible sections，生成 `eligibleTasks`。
3. 为每个 eligible task 收集 observedMessageIds（lag 范围内的消息），组装结构化 JSON 输入。

Observer 不检测 `userCorrection`、`todoSignal` 等语义信号——这些由 Proposer 看到消息后自行判断。Observer 只记录每个 section 的 `eligibilityReason: "lagThreshold"`。

接口见第 9 节。

### 1.2 Proposer

Proposer 按记忆族拆分调用，**每个调用都必须使用 provider 支持的 schema-constrained structured output** 强制输出 schema，不能靠裸 prompt + 文本解析。这可以是 function/tool calling，也可以是 JSON schema response format；具体走哪种接口由 provider adapter 决定。

首版固定 5 个 Proposer：

| Proposer | 负责 section | 更新特征 |
| -------- | ------------ | -------- |
| `currentStateProposer` | `scene`, `participants` | 高频、覆盖式、当前状态 |
| `todoProposer` | `todos` | 中频、事件型、需要完成/取消/过期 |
| `episodeProposer` | `recentEpisodes`, `milestones` | 近期经历与长期里程碑的晋升判断 |
| `coreProposer` | `core` | 低频、保守、长期事实和用户修正 |
| `compactionProposer` | `todos`, `recentEpisodes`, `milestones`, `core` | 维护型、只处理预算压力下的合并精简 |

前 4 个 Proposer 是正常写入 Proposer，由 Observer 按 lag 调度。`compactionProposer` 是维护 Proposer，只由 Reducer 的长度预算门触发，不参与普通 lag 轮询。

Proposer 的拆分边界是 section family，不是字段级。`scene.location`、`scene.mood`、`participants.user.emotion` 等字段仍由同一个 `currentStateProposer` 处理，避免字段级调用过碎。

每个 Proposer 看到自己负责的 eligible sections 后，自行决定每个 section 输出什么：

- 如果该 section 有变化：输出 `patches` 数组，每个 patch 含 `op`、`path`/`itemId`、`value`、`evidenceKind`、`evidenceRefs`。
- 如果该 section 无变化：输出 `status: "noop"`。
- 如果证据不足无法判断：输出 `status: "unable_to_decide"`。

Proposer 输出 `evidenceKind`（见 [state-contract.md](state-contract.md) 的 Evidence Kind 合法值），这是 Reducer 做 policy gate 的枚举输入。Reducer 不把它当可信度分数；真实证据仍必须通过 `messageId + quote` 校验。

如果某个 Proposer 没输出目标 section 的结果，Reducer 视为该 section `error`，不猜测推进。

具体 structured output schema 见第 9 节，prompt 设计见 [proposer-prompt.md](proposer-prompt.md)。

### 1.3 Reducer

Reducer 是纯代码的 Policy Gate + State Applier。它不使用 LLM，不做开放式自然语言判断，不做语义冲突检测，不做语义匹配。

Reducer 必须按顺序执行：

1. **schema 校验**：patch 的 op、path/itemId、value 是否符合 [state-contract.md](state-contract.md) 的 Patch Op 约束。
2. **messageId 存在性校验**：evidenceRefs 中的 messageId 是否在 observedMessageIds 范围内且真实存在。
3. **quote 模糊匹配**：evidenceRefs 中的 quote 是否能在对应 message 中找到（匹配策略见第 10 节）。
4. **policy gate**：按 section + op + evidenceKind 查第 11 节的 policy table，判断是否允许。
5. **结构化冲突检测**：只检查同字段覆盖（`setField`）、同 itemId 操作（`updateItem`/`completeTodo` 等）、同 section/path 合并、itemId 是否真实存在和操作顺序合法性。不做语义冲突检测。
6. **长度预算**：各 section item 数量上限。`recentEpisodes` 超限时确定性滚出最旧 item；其它 section 新增超限时返回 `deferred: length_budget_exceeded` 并触发 compaction task，维护失败后才最终拒绝新增。
7. **过期清理**：Reducer 自行触发，扫描 `expiresAtMessageId` 已过期的 todo，从数组中移除。这是纯确定性清理，不需要 evidenceRefs，不产生事件行（自然遗忘）。
8. **apply**：通过校验的 patch 应用到 state，生成新 state。
9. **事件记录**：每个 patch 的决策写入 `chat_memory_events`。

职责顺序敏感，不可随意调换。

### 1.4 Renderer

Renderer 把结构化 `memory_state` 渲染为主聊天模型可读的稳定文本。Renderer 输出不是权威状态，不写入独立 DB 列。

Renderer 是纯代码模板，不调用 LLM。具体模板见 [rendering-and-context.md](rendering-and-context.md)。

Renderer 必须：

- 按 `memory_state` 的结构层级区分长期核心记忆、工作区记忆与近期状态。
- 用明确标题标出哪些是当前状态、哪些是历史背景。
- 不判断状态是否过期，不调用 LLM；状态失效、清理和覆盖由 Reducer 维护。
- 避免因为渲染文案把旧场景强行延续到当前回复。
- 保持文本稳定：相同 `memory_state` 与相同 renderer 代码必须生成相同文本。

## 2. 路由与触发

v2 不为每个字段单独调用 Proposer，也不使用单个万能 Proposer。每次 memory tick 按 eligible sections 调度一个或多个专用 Proposer，输出各自负责 section 的 patch bundle。

`eligible = lag 超过阈值`

- 每个 section 有独立 lag 阈值。`lag = recent window 末端 message id - 该 section 的 coveredUntilMessageId`。
- Observer 将 eligible sections 聚合成 `eligibleTasks`，每个 task 对应一个 Proposer。
- 只有目标 section 出现在该 Proposer 的输入和输出契约中。
- 非目标 section 不出现在 Proposer 输出的 `sectionResults` 中，其 cursor 不推进。
- **目标 section 是否实际发生变化，由对应 Proposer 看到 messages 后自行决定**（输出 patch 或 noop），不由 Observer 预判。

lag 阈值建议（可调）：

| Section          | lag 阈值（消息数） | 理由                           |
| ---------------- | ------------------ | ------------------------------ |
| `scene`          | 4                  | 场景变化高频，及时捕捉         |
| `participants`   | 4                  | 人物状态变化高频               |
| `todos`          | 6                  | 待办中频，不需要每轮都看       |
| `recentEpisodes` | 4                  | 近期经历高频                   |
| `milestones`     | 10                 | 里程碑位于长期区，但晋升判断来自 episode flow |
| `core`           | 8                  | core 低频，但需要定期检查修正  |

### 2.1 Compaction task

`compactionProposer` 不是普通写入 Proposer，不由 lag 阈值调度。它只在 Reducer 的长度预算门发现 `addItem` 会超过上限时触发，用来释放容量或确认没有安全压缩空间。

触发流程：

1. 普通 Proposer 输出 `addItem`，且目标 section/path 已达到 item 数量上限。
2. Reducer 不立即最终拒绝，也不推进该 section cursor，而是记录 `decision: "deferred"`、`reject_reason: "length_budget_exceeded"`，并创建一个 compaction task。
3. compaction task 由同一 `userId/presetId` 串行队列执行，输入只包含目标 section/path 的现有 items、被阻塞 patch 的精简摘要、source item 的既有 evidenceRefs 及其 raw messages。
4. `compactionProposer` 只能输出 `mergeItems` 或 `noop` / `unable_to_decide`。禁止输出 `addItem`、通用删除、跨 section 合并或跨 core path 合并。
5. Reducer 对 compaction patch 继续执行 schema、messageId、quote、policy 和结构化冲突校验。`memory_compaction` 的 evidenceRefs 必须来自被合并 source items 的既有证据。
6. 如果 compaction 成功释放容量，原 section 保持 cursor 不变，在下一次 tick 重新处理同一消息窗口；如果 compaction 失败或无法释放容量，原新增 patch 最终 `rejected: length_budget_exceeded` 并推进 cursor。

遗忘边界：

- `recentEpisodes` 的遗忘仍由 Reducer 按滑动窗口确定性滚出，不需要 compactionProposer。
- `todos` 不能因为容量压力被静默删除，只能完成、取消、过期或合并重复项。
- `milestones` 和 `core` 不能自动遗忘；compactionProposer 只能合并明显重叠项，不能删除长期事实。
- 如果没有安全合并空间，系统应保留旧 state、记录告警，并让后续新增继续按预算规则被拒绝，而不是让 LLM 为了腾位置改写长期档案。

## 3. Cursor 推进规则

核心原则：**Proposer 已经看过消息并给出了明确判断（patches 或 noop），且 Reducer 不需要外部维护任务才能完成决策，则消息视为已处理，cursor 推进。** 只有 Proposer 无法判断（`unable_to_decide`）、技术性失败（`error`）或预算维护暂缓（`deferred`）才不立即推进。

| Reducer 决策   | Cursor 行为    | 触发条件                                                     |
| -------------- | -------------- | ------------------------------------------------------------ |
| `accepted`     | 推进           | 至少一个 patch 被 apply                                      |
| `rejected`     | 推进           | patches 状态但全被拒（policy/quote/duplicate 等），或 compaction 已有界失败后的最终预算拒绝 |
| `deferred`     | 不推进         | 新增被长度预算阻塞，已触发 compaction task                  |
| `error`        | 重试后推进     | schema/llm/provider 技术性失败                               |

- `accepted`：推进 cursor。
- `noop`（Proposer 明确说无变化）：推进 cursor。Reducer 不产生事件行（或产生 `decision=accepted, op=null` 的占位行，供审计对齐 tick）。
- `rejected`（patches 状态但全被拒）：**推进 cursor**。Proposer 已看过消息并给出了判断，即使 patch 全被拒，消息也已被处理。被拒的 patch 记录事件行（含 reject_reason）。重跑同样消息大概率得到类似结果——`policy_not_allowed` 是系统性错误（Proposer 不理解 policy 约束），`duplicate_item` 是确定性拒绝（item 已存在），`quote_not_found` 虽可能因 LLM 随机性下次摘录不同 quote，但不值得为此卡住整个 section。`length_budget_exceeded` 只有在 compaction 已尝试且失败后才作为最终 rejected 推进。
- `deferred`：**不推进 cursor**。该 section 等待 compaction task 有界执行；compaction 成功后重新跑同一窗口，compaction 失败后改为最终 rejected 并推进。
- `unable_to_decide`：**不推进 cursor**。Proposer 自认判断不了，下次 tick 有新消息辅助判断可能成功。连续 2 次 `unable_to_decide` 后推进 cursor（避免永久卡死），记录 skipped event。
- `error`：重试 1 次。仍失败则记录 error event，推进 cursor（避免永久卡死），该 section 保留上一次稳定 `memory_state`。

连续多次 error 的 section：记录告警日志，保留旧 state，其它 section 继续推进。不需要独立的"冻结"状态——cursor 推进后下次 tick 自然重新评估。

## 4. Core 写入机制

`core` 的内容新增与内容改写只允许两类写入：

1. **`long_term_fact`**：用户或设定文本明确表达的长期事实。例如"我叫小明"、"我讨厌早起"、"这个世界有魔法"。
2. **`user_correction`**：用户明确修正旧记忆或设定。例如"不对，我之前说的是喜欢秋天不是春天"。

单次临时剧情、一次性情绪、单场景互动不得进入 core。这靠 Proposer 的 prompt 约束 + Reducer 的 evidenceKind policy gate 共同保证。`memory_compaction` 只能用于合并已有 core item，不得作为新增长期事实的证据类型。

Core patch 与已有 core item 的 `text` 完全相同或高度相似时（纯代码字符串相似度判断），Reducer 视为重复，拒绝新增并记录事件。**不做语义冲突检测**——如果 Proposer 输出了语义冲突但文本不同的 core item，Reducer 不会拦截，这依赖 Proposer prompt 约束自行避免。

> **未来探索（不在首版）**：跨 tick 重复模式累积晋升（N=3/K=2）。需要确定性 ledger + 结构化标签匹配（非语义匹配）才能可靠实现，首版不做。

## 5. 删除与遗忘

遗忘是确定性策略，不是摘要模型的副作用。

- `scene` 和 `participants` 被新状态覆盖（`setField`）。
- `recentEpisodes` 按窗口自然滚出（Reducer 清理超出上限的旧 item）；只有真正关键的 episode 由 `episodeProposer` 主动输出 `addItem` 到 `longTerm.milestones`。
- `todos` 只能因完成、取消、失效或澄清而删除（`completeTodo`/`cancelTodo`/`expireTodo`/`correctItem`）。
- `milestones` 位于长期区，默认不删除，只允许 `mergeItems` 和基于 `user_correction` 的 `correctItem`。
- `core` 删除最保守，必须来自 `user_correction`。

禁止 Proposer 使用通用 `removeItem`。删除必须表达为更窄的语义 op（见 [state-contract.md](state-contract.md) 的 Patch Op 约束）。

`compactionProposer` 也不例外：它的主要能力是 `mergeItems`，不是删除。容量压力不能成为长期记忆静默遗忘的理由。

## 6. NSFW 与安全策略

情感 RP 里的成人内容不能被 memory 层静默丢弃。对成年且 consensual 的成人互动，Observer 和 Renderer 以客观、摘要化方式记录事件本质、双方意愿、关系变化和稳定偏好，不摘录大段感官描写。

Reducer 不对成人内容做社会规范层面的二次审查；它只校验证据引用、policy gate、冲突和删除规则。Provider 安全策略造成的拦截必须显式记录为 `error` 事件（reason: `safety_policy_blocked`），不得伪装成 noop 或静默跳过。

## 7. 迁移原则

v2 是新的权威 memory 设计，不以 v1 兼容为目标。

旧 `rolling_summary` 和 `core_memory` 不直接转换为 v2 state。需要迁移旧会话时，从原始 `chat_messages` 回放：对旧消息按批次跑 v2 pipeline（Observer → 专用 Proposer → Reducer），生成 `memory_state`。

回放成本与正常 tick 相同，不额外设计"文本转结构"的特殊路径。无法回放的旧文本只能作为 legacy reference，不得成为 authoritative memory。

系统上线期间保留 feature flag 保护发布风险，但 feature flag 是发布工具，不是架构目标。最终 active memory path 只有 v2。

## 8. 失败与降级

失败时保留上一次稳定 `memory_state`。系统不回退到旧的全文摘要重写路径。

- **Proposer LLM 调用失败**（网络/超时/safety policy）：记录 `error`，重试 1 次。仍失败则推进目标 section cursor，保留旧 state，记录告警日志。
- **Proposer 输出 schema 非法**（structured output 仍可能返回不合规内容）：记录 `error`，重试 1 次。仍失败则推进 cursor。
- **Patch 被 policy gate 拒绝**：记录 `rejected`，推进 cursor。Proposer 已处理消息，重跑同样输入大概率得到类似结果。
- **长度预算阻塞**：记录 `deferred` 并触发 compaction task。compaction 有界失败后记录最终 `rejected: length_budget_exceeded`，推进 cursor。
- **Compaction task 失败**：记录 `error` 或 `rejected`，保留旧 state，不回退到全文摘要重写；原阻塞 section 按第 3 节规则完成最终预算拒绝。
- **Section 连续多次 error**：记录告警日志，保留旧 state，其它 section 继续推进。
- **全局连续失败**（所有目标 section 连续 error）：记录告警日志，保留旧 state。完全停止 memory 写入只能由人工或明确开关触发。

## 9. Observer 输入与 Proposer 输出

Observer 给 Proposer 的输入（结构化 JSON，非散乱 prompt 片段）：

```json
{
  "tickId": 12345,
  "userId": 1,
  "presetId": "default",
  "schemaVersion": 2,
  "targetMessageId": 124,
  "memoryState": { "version": 2, "current": {}, "working": {}, "longTerm": {}, "meta": {} },
  "eligibleTasks": [
    {
      "proposer": "currentStateProposer",
      "sections": {
        "scene": {
          "coveredUntilMessageId": 118,
          "observedMessageIds": [119, 120, 121, 122, 123, 124],
          "eligibilityReason": "lagThreshold"
        }
      }
    },
    {
      "proposer": "todoProposer",
      "sections": {
        "todos": {
          "coveredUntilMessageId": 100,
          "observedMessageIds": [101, 102, "...", 124],
          "eligibilityReason": "lagThreshold"
        }
      }
    }
  ],
  "messages": [
    { "id": 121, "role": "user", "contentKind": "raw", "content": "明天提醒我把橡皮还给她" },
    { "id": 122, "role": "assistant", "contentKind": "raw", "content": "好，我会记得明天提醒你把橡皮还给她。" }
  ]
}
```

单个 Proposer 输入是 Observer 输入的子集，只包含该 Proposer 的 `sections` 和相关 messages。Proposer 输出必须通过 schema-constrained structured output 返回：

```json
{
  "tickId": 12345,
  "proposer": "todoProposer",
  "sectionResults": {
    "todos": {
      "status": "patches",
      "patches": [
        {
          "op": "addItem",
          "value": { "text": "归还橡皮", "tags": ["短期"] },
          "evidenceKind": "user_request",
          "evidenceRefs": [{ "messageId": 121, "quote": "明天提醒我把橡皮还给她" }]
        }
      ]
    }
  }
}
```

每个目标 section 的 `status` 必须是 `patches | noop | unable_to_decide` 之一。非目标 section 不出现在 `sectionResults` 中。

`patchId` 由 Reducer 生成（Proposer 不需要输出），用于 event log 引用。

`core` section 的 patch 额外需要 `path` 指定 `longTerm` 下的子数组：

```json
{
  "op": "addItem",
  "path": "userProfile",
  "value": { "text": "性格: 内向(初识) > 依赖(熟悉后) | 恐高" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我其实挺内向的，但熟了就会很粘人" }]
}
```

`compactionProposer` 的输入不是最近对话窗口，而是一个维护任务。它包含目标 section/path、被预算阻塞的 patch 摘要、候选 source items、这些 source items 的既有 evidenceRefs，以及用于重新校验 quote 的 raw messages。示例：

```json
{
  "tickId": 12346,
  "proposer": "compactionProposer",
  "maintenanceReason": "length_budget_exceeded",
  "target": { "section": "core", "path": "userProfile", "limit": 15 },
  "blockedPatchSummary": {
    "op": "addItem",
    "value": { "text": "偏好: 夜间长聊 | 需要慢热陪伴" },
    "evidenceKind": "long_term_fact"
  },
  "sourceItems": [
    {
      "id": "core:1",
      "text": "偏好: 晚上聊天 | 慢热",
      "evidenceRefs": [{ "messageId": 88, "quote": "我晚上比较想聊天" }]
    },
    {
      "id": "core:9",
      "text": "关系模式: 需要慢慢熟悉后再依赖",
      "evidenceRefs": [{ "messageId": 101, "quote": "我一般慢热" }]
    }
  ],
  "messages": [
    { "id": 88, "role": "user", "contentKind": "raw", "content": "我晚上比较想聊天，白天容易分心" },
    { "id": 101, "role": "user", "contentKind": "raw", "content": "我一般慢热，熟了才会比较依赖人" }
  ]
}
```

compaction 输出仍使用 `sectionResults`，但只允许 `mergeItems`：

```json
{
  "tickId": 12346,
  "proposer": "compactionProposer",
  "sectionResults": {
    "core": {
      "status": "patches",
      "patches": [
        {
          "op": "mergeItems",
          "path": "userProfile",
          "itemIds": ["core:1", "core:9"],
          "value": { "text": "偏好/关系模式: 夜间更适合长聊 | 慢热后依赖" },
          "evidenceKind": "memory_compaction",
          "evidenceRefs": [
            { "messageId": 88, "quote": "我晚上比较想聊天" },
            { "messageId": 101, "quote": "我一般慢热" }
          ]
        }
      ]
    }
  }
}
```

---

## 10. Quote 模糊匹配策略

Reducer 校验 `evidenceRefs.quote` 是否能在对应 `messageId` 的消息内容中找到。LLM 经常改写 quote，精确匹配会大量误判，因此采用模糊匹配：

### 匹配步骤

1. **归一化**：去除 quote 和 message content 的空白、标点、大小写差异。
2. **子串匹配**：如果归一化后的 quote 是归一化后 message content 的子串，则匹配成功。
3. **相似度匹配**：如果子串匹配失败，计算归一化 quote 与 message content 所有等长子串的最大相似度（基于 Levenshtein 距离）。相似度 >= 0.75 则匹配成功。
4. **匹配失败**：该 patch 记录 `rejected`（reason: `quote_not_found`），cursor 按第 3 节规则处理。

### 实现注意

- 归一化函数：`str.toLowerCase().replace(/[\s，。！？、,.!?;:""'']/g, "")`
- 相似度计算：`1 - levenshtein(normalizedQuote, normalizedSubstring) / normalizedQuote.length`
- 对于长 message，只取 message content 中与 quote 等长的窗口做比较，避免全文 Levenshtein 的性能问题。
- 阈值 0.75 可调。如果实际运行中假阳性过高，调高到 0.8；如果假阴性过高，调低到 0.7。

---

## 11. Section Policy Table

Reducer 按 `section + op + evidenceKind` 查此表判断是否允许写入。

| section / op                                        | 允许的 evidenceKind                                         | 备注                              |
| --------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| `scene.setField` / `scene.clearField`               | `scene_change`                                              | 覆盖式状态；旧场景不得凭空延续    |
| `participants.setField` / `participants.clearField` | `participant_state`                                         | 只写当前状态，不写长期人格        |
| `todos.addItem`                                     | `user_request`, `user_commitment`, `assistant_commitment`   | 模糊愿望不写入                    |
| `todos.updateItem`                                  | `user_request`, `user_commitment`, `assistant_commitment`, `user_correction` | 更新待办                       |
| `todos.mergeItems`                                  | `user_request`, `user_commitment`, `assistant_commitment`, `user_correction`, `memory_compaction` | 合并重复待办                   |
| `todos.completeTodo`                                | `todo_completion`                                           | 完成必须有终止证据                |
| `todos.cancelTodo`                                  | `todo_cancel`, `user_correction`                            | 用户修正优先                      |
| `todos.expireTodo`                                  | `todo_expiration`                                           | 仅短期待办允许失效                |
| `todos.correctItem`                                 | `user_correction`                                           | 待办纠错                          |
| `recentEpisodes.addItem`                            | `recent_episode`                                            | 滑动窗口，普通 episode 到期滚出   |
| `recentEpisodes.updateItem`                         | `recent_episode`, `user_correction`                         |                                   |
| `recentEpisodes.mergeItems`                         | `recent_episode`, `user_correction`, `memory_compaction`    | 普通溢出优先由滑动窗口处理        |
| `milestones.addItem`                                | `relationship_milestone`, `user_correction`                 | 普通日常不得进入                  |
| `milestones.updateItem` / `correctItem`             | `user_correction`                                          | 里程碑保守更新                    |
| `milestones.mergeItems`                             | `user_correction`, `memory_compaction`                     | 仅合并重叠里程碑，不自动删除      |
| `core.addItem`                                      | `long_term_fact`, `user_correction`                         | 单次临时剧情不得进入              |
| `core.updateItem` / `correctItem`                   | `user_correction`                                           | core 只能被用户修正改变           |
| `core.mergeItems`                                   | `user_correction`, `memory_compaction`                      | 仅合并同 path 下重叠 item          |

不在表中的 `section + op + evidenceKind` 组合：Reducer 拒绝并记录 `rejected`（reason: `policy_not_allowed`）。

---

## 12. `chat_memory_events` 表

精简审计表，只记录 patch 决策的核心信息。

```sql
CREATE TABLE chat_memory_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  tick_id         BIGINT NOT NULL,
  section         TEXT NOT NULL,
  decision        TEXT NOT NULL,           -- accepted | rejected | deferred | error
  patch_id        TEXT,                    -- Reducer 生成的 patch 唯一 id（如有）
  op              TEXT,                    -- patch op（如有）
  item_id         TEXT,                    -- 目标 item id（如有）
  evidence_kind   TEXT,                    -- evidenceKind（如有）
  reject_reason   TEXT,                    -- 拒绝/错误原因码
  maintenance_task_id TEXT,                -- 关联 compaction task（如有）
  patch_summary   JSONB,                   -- patch 的精简摘要（op + value + evidenceRefs）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_events_user_preset
  ON chat_memory_events(user_id, preset_id, created_at DESC);

CREATE INDEX idx_memory_events_section_decision
  ON chat_memory_events(user_id, preset_id, section, decision);
```

`reject_reason` 合法值：

- `schema_invalid`：patch 结构不合规
- `message_id_not_found`：evidenceRefs 的 messageId 不存在
- `quote_not_found`：quote 模糊匹配失败
- `policy_not_allowed`：section + op + evidenceKind 不在 policy table
- `item_not_found`：itemId 指向不存在的 item
- `duplicate_item`：core item text 高度相似
- `length_budget_exceeded`：section item 数量超上限；首次为 `deferred`，compaction 有界失败后为最终 `rejected`
- `llm_call_failed`：Proposer LLM 调用失败
- `safety_policy_blocked`：provider 安全策略拦截
- `max_retry_exceeded`：重试耗尽
- `compaction_unavailable`：没有可安全合并的 source items

详细调试信息（完整 patch、完整 state diff、prompt 内容等）用 `logger` 输出到日志，不进表。

`item_id` 列：对单 item 操作（`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`correctItem`）存目标 item id；对 `mergeItems` 存 `itemIds.join(",")`；对 `addItem`/`setField`/`clearField` 存 null。完整信息在 `patch_summary` JSONB 中。

---
