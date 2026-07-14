# Memory Control v2 状态契约

本文是 Memory Control v2 的**静态契约权威来源**：所有数据 shape、枚举、policy table、DDL、索引和存储落点都在这里定义一次。确定性算法与状态机见 [算法契约索引](algorithms/README.md)，写入编排见 [write-protocol.md](write-protocol.md)，顶层判断见 [../memory-control-v2-overview.md](../memory-control-v2-overview.md)。

跨文档惯例：本文已定义的契约，其他文档只引用章节号，不重述。

## 1. 权威状态与存储落点

PostgreSQL 中的结构化 `memory_state` 是新系统唯一的当前 Memory authority，保存当前完整 memory state，由 Reducer 原子写回。旧 `rolling_summary`、`core_memory` 和 v1 checkpoint 只是派生数据，不转换为新系统 authority，也不与新 Memory 同时注入；v1 runtime 停用并显式确认后可以独立清除。`chat_messages` 中的 User/Assistant 原文是 rebuild authority，任何 Memory 退役、演练或切换操作都不得修改或删除；raw source 只有在独立的用户隐私删除/消息管理操作明确授权时才可变化。

user/preset 下的对话跨 session 语义连续。session 只是按天或 UI 划分的存储单元，不是 Memory 或 scene 的语义边界。sessionId 只保留在消息中，不复制到 evidence、event 或 Recall provenance；这些结构通过 messageId / source messageIds 追溯来源。

在现有 `chat_preset_memory` 表新增一列：

- `memory_state JSONB`：完整权威 memory state。

Renderer 输出不作为独立权威列落库。主聊天热路径读取 `memory_state` 后实时调用纯代码 Renderer 生成上下文文本。

§9 的 snapshots 是按 revision 保存的恢复记录，不是第二份“当前 state” authority，也不直接注入上下文；正常读取始终以 `chat_preset_memory.memory_state` 当前行作为 authority。

`memory_state` blob 内置 `version` 字段作为 schema version。Reducer 按 `version` 选择 schema holder，`version` 升级必须走显式迁移函数。

概念形态：

```js
{
  version: 2,
  current: {
    scene: {
      location: { value: null, evidenceRef: null, updatedAtMessageId: null },
      time: { value: null, evidenceRef: null, updatedAtMessageId: null },
      mood: { value: null, evidenceRef: null, updatedAtMessageId: null },
      note: { value: null, evidenceRef: null, updatedAtMessageId: null }
    },
    previousScene: null         // Reducer 维护的上一条已过期场景，不是 section、没有 cursor
  },
  working: {
    todos: [],                  // item 数组；status: active | overdue
    standingAgreements: [],     // item 数组
    recentEpisodes: []          // item 数组，滑动窗口
  },
  longTerm: {
    milestones: [],             // item 数组，长期归档
    worldFacts: [],             // item 数组
    userProfile: [],            // item 数组
    assistantProfile: [],       // item 数组
    relationship: []            // item 数组
  },
  meta: {
    revision: 0,               // 全局单调 Memory revision；每个成功 revision 都有同号完整 post-state snapshot
    sourceGeneration: 0,       // 单调 source 世代；raw source 失效重建时 +1，普通追加不变
    targetCursors: {}          // { targetKey: coveredUntilMessageId }，targetKey 见 §2，联合处理的 section 共享一个 cursor
  }
}
```

`memory_state.meta.sourceGeneration` 是 Memory 与 RAG 判断 raw source 是否仍有效的共享权威世代；查询时 Recall 继承 RAG 对该世代的 cutoff。任何有效 source 的编辑、删除、恢复、改变归属/可见性或排序语义变化都单调 `+1`；普通追加 User/Assistant message 不改变 generation。即使变更触及的 source 尚未被某个 Memory target cursor 覆盖，也必须 `+1`，因为 RAG 可能已经处理了 Memory 尚未处理的消息。`memory_state.meta` 不保存 `halted`、错误计数、retry 或 context-expansion 等运行恢复状态；这些状态的 authority 是 §9 的 durable task、per-target status 和 ops log。

每个可追踪 item 结构：

```js
{
  id: "todo:uuid-xxx",          // Reducer 生成，全局唯一
  text: "归还橡皮",              // 高密度关键词式描述
  evidenceGroups: [
    {
      evidenceKind: "user_commitment",
      refs: [{ messageId: 121, contentHash: "sha256:...", quote: "我明天会把橡皮还给她" }]
    }
  ],
  createdAtMessageId: 121,
  updatedAtMessageId: 121,
  actor: "user",               // 仅 todo：实际执行者 user | assistant | both
  requester: "user",            // 仅 todo：提出请求或承诺的一方 user | assistant
  status: "active",             // 仅 todo：active | overdue；到期时 Reducer 原位更新
  becameOverdueAt: null,        // 仅 todo：首次进入 overdue 的时间
  dueAt: null                   // 仅 todo：deadline 的 ISO 8601 timestamp；null 表示无期限
}
```

`evidenceGroups` 是权威 state 中 item 的证据结构。每个 group 携带自己的 `evidenceKind` + `refs`，是一个可审计、可 recall 的证据单元；group 内多个 ref 共同支撑该单元。普通 add/update item patch 输出 `{ messageId, quote }` 形式的 `evidenceRefs`；Reducer 校验数据库消息后，为每个持久化 ref 补入当时已校验的 `contentHash`，再将其与 `patch.evidenceKind` 包装成新的 `evidenceGroup` 追加到 item。`forgetItem` 的新 evidence 只证明 forget 指令，不追加到已移除 item；`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`，Reducer 从 source items 继承 `evidenceGroups`，各 group 保留各自 evidenceKind。持久化的 `messageId + contentHash` 也是 correction/forget 生成 context-suppression tombstone 的确定性 source key。

item 派生字段由 Reducer 在 apply 时维护：`createdAtMessageId` 取首个写入 group 的最小 messageId（addItem 设定，updateItem 不改；mergeItems 取 source items 中最早的 `createdAtMessageId`）；`updatedAtMessageId` 取全部 `evidenceGroups.refs.messageId` 的最大值。

`scene` 是当前状态，每个字段独立记录值、证据与更新时间。正式 section 共九个：`scene`、`todos`、`standingAgreements`、`recentEpisodes`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`。`previousScene` 和 todo 的 `status=overdue` 是 Reducer 维护的衍生状态，不进入 Proposer `sectionResults`，不拥有 target 或 cursor。

`current`、`working`、`longTerm` 和 `meta` 只是 `memory_state` 的物理存储容器名，不是正式 section 或 target。它们不得作为 patch/event/policy 的 `section`、`task.targetKey` 或 `sectionResults` key；其中的正式 section 始终使用上述九个逻辑名称直接寻址。

`current.previousScene` 为 `null` 或“与 `current.scene` 相同的四个字段快照 + `expiredAt`”对象；字段级 value/evidenceRef/updatedAtMessageId 原样保留。它只能由 Reducer 的 scene TTL lifecycle 写入。到期写入使用 §9.2 的 `system_cleanup: scene_expired` event；若覆盖非 null 的旧值，同一 cleanup revision 还必须写 `system_cleanup: expired_scene_evicted` event。

Todo `addItem` 必须提供 `actor` 与 `requester`，Reducer 强制初始化 `status="active"`、`becameOverdueAt=null`；Proposer 不得输出或修改这两个 lifecycle 字段。`actor` 合法值为 `user | assistant | both`，`requester` 合法值为 `user | assistant`。到达 `dueAt` 后 Reducer 原位改为 overdue。`completeTodo`/`cancelTodo` 可作用于 active 或 overdue item；`updateItem` 设置 `dueChange.mode=set` 且新 dueAt 在未来时可作用于 overdue item，Reducer 原位将 `status` 从 `overdue` 改回 `active` 并清空 `becameOverdueAt`，写 `system_cleanup: todo_revived_from_overdue` event。容量维护与 `mergeItems` 只处理 active todo，不合并 overdue todo。

以下语义不可改变：

- `current.scene` 与 session 完全解耦。
- scene 到期时 Reducer 将完整旧值写入 `current.previousScene`；它不是正式 section，后续新到期场景直接替换旧值并记录 cleanup event。
- todo 到期时留在 `working.todos`，Reducer 将其 `status` 从 `active` 改为 `overdue` 并设置 `becameOverdueAt`；不跨数组迁移。
- `recentEpisodes` 与 `milestones` 联合处理但分别存储。
- `userProfile` 与 `assistantProfile` 都允许 User 和 Assistant 双方全权 add/update/forget。
- `worldFacts` 与 `relationship` 同样允许双方 add/update/forget。
- evidence role 按数据库真实消息校验，但不用 role 限制 User/Assistant 对两个 Profile 的操作权。

add/update/forget 的具体 policy 见 §6；forget 必须与 [write-protocol.md](write-protocol.md) §5 的 tombstone/suppression 事务一起提交。

## 2. 记忆分层

| Section              | 存储位置                        | 作用                             | 生命周期       | 写入原则                                                                       |
| -------------------- | ------------------------------- | -------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `scene`              | `current.scene`                 | 当前地点、时间、氛围、环境锚点   | 高频、覆盖式   | 字段级覆盖；字段级证据                                                         |
| `todos`              | `working.todos`                 | 明确待完成事项；含 active/overdue 状态 | 中频、事件型 | 完成或取消后移除；到期时 Reducer 原位标记 `status=overdue`，仍可 complete/cancel |
| `standingAgreements` | `working.standingAgreements`    | 持续互动约定、相处规则、长期承诺 | 中低频、事件型 | 新增、修订、取消；不使用完成语义                                               |
| `recentEpisodes`     | `working.recentEpisodes`        | 最近几次有意义互动               | 高频、滑动窗口 | 普通 episode 到期自然滚出；重要 episode 可晋升 milestone                       |
| `milestones`         | `longTerm.milestones`           | 关系或剧情关键转折               | 低频、归档型   | 长期保存，默认新增或合并；普通日常不得进入                                     |
| `worldFacts`         | `longTerm.worldFacts`           | 世界设定与持续客观事实           | 低频、保守     | 新增只接受 `long_term_fact`；修订/forget 接受双方对应 kind                     |
| `userProfile`        | `longTerm.userProfile`          | 用户长期档案与稳定特征           | 低频、保守     | 新增只接受 `long_term_fact`；修订/forget 接受双方对应 kind                     |
| `assistantProfile`   | `longTerm.assistantProfile`     | Assistant 长期档案与稳定特征     | 低频、保守     | 新增只接受 `long_term_fact`；修订/forget 接受双方对应 kind                     |
| `relationship`       | `longTerm.relationship`         | 持续关系模式与关系事实           | 低频、保守     | 新增只接受 `long_term_fact`；修订/forget 接受双方对应 kind                     |

每个 target 拥有独立 `coveredUntilMessageId`（存于 `meta.targetCursors`）。一个 Proposer 联合处理的多个 section 共享一个 target cursor，禁止"共享 Proposer + 独立 section cursor"。target 之间 cursor 独立推进，互不阻塞；所有写入（普通 task、maintenance task 与 source mutation 处理）共用同一 `userId/presetId` 串行队列，保证 `memory_state` 单行写回无竞争。source mutation（编辑历史、删除、恢复、改变归属/可见性或排序语义）也必须进入该队列，禁止在队列外先修改消息再 best-effort 处理 Memory。一个 target 被 `deferred` 不阻塞同 tick 内其它 eligible target 的处理与 cursor 推进，仅该 target 自身等待 compaction 释放容量后 replay 原 proposal。Maintenance task 不拥有独立 raw-message cursor；它是被 capacity-blocked normal task 派生出的维护任务。

target 与 Proposer、section 的对应关系见 [write-protocol.md](write-protocol.md) §1.2。

## 3. Evidence Kind 合法值

| evidenceKind             | 说明                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_request`           | 用户明确请求系统/角色稍后做某事                                                                                                                                                                                                                |
| `user_commitment`        | 用户明确承诺稍后做某事                                                                                                                                                                                                                         |
| `assistant_request`      | assistant 明确请求用户稍后做某事                                                                                                                                                                                                               |
| `assistant_commitment`   | assistant 明确承诺稍后做某事                                                                                                                                                                                                                   |
| `todo_completion`        | 待办已完成                                                                                                                                                                                                                                     |
| `todo_cancel`            | 待办被取消                                                                                                                                                                                                                                     |
| `todo_expiration`        | 短期待办自然失效或被澄清为不再需要                                                                                                                                                                                                             |
| `scene_change`           | 地点、时间、环境或氛围明确变化                                                                                                                                                                                                                 |
| `standing_agreement`     | 持续互动约定、相处规则或长期承诺形成或修订                                                                                                                                                                                                     |
| `agreement_cancel`       | 持续互动约定被明确取消或作废                                                                                                                                                                                                                   |
| `recent_episode`         | 最近发生的有意义互动                                                                                                                                                                                                                           |
| `relationship_milestone` | 关系或剧情关键转折                                                                                                                                                                                                                             |
| `user_correction`        | 用户明确修正旧记忆或设定                                                                                                                                                                                                                       |
| `assistant_correction`   | assistant 明确修正已有记忆（场景、待办、约定、经历、里程碑、长期事实等）                                                                                                                                                                       |
| `user_forget`            | 用户明确要求忘记已有长期事实或档案 item                                                                                                                                                                                                         |
| `assistant_forget`       | assistant 明确撤回并要求忘记已有长期事实或档案 item                                                                                                                                                                                             |
| `long_term_fact`         | 长期事实，包括明确表达的（"我叫小明"）和从行为推断的（多次回避冲突→倾向回避冲突）。evidenceRefs 的 quote 始终是 raw message 短片段——对陈述是原话，对推断是体现该行为的原话（如"我冲过去把门踹开了"）；推断理由写在 value.text 中，不放在 quote |
| `memory_compaction`      | 基于已有 memory item 的预算维护与去重合并                                                                                                                                                                                                      |

Evidence role 使用数据库真实消息校验：带 `user_` / `assistant_` 发言方语义的 kind 必须与对应真实 role 一致；`long_term_fact` 不绑定单方，User 与 Assistant 的消息都可支持 `worldFacts`、`userProfile`、`assistantProfile`、`relationship` 的新增。role 是 evidenceKind 真实性约束，不是“User 只能维护 userProfile / Assistant 只能维护 assistantProfile”的 section 权限边界。

### 3.1 Per-Proposer 派生 evidenceKind enum

上表是 Reducer 查 policy table（§6）用的 master enum。每个 Proposer 的 output schema enum 列自己合法的子集（per-Proposer 并集，非 per-op）；同一 Proposer 内某 op 的 evidenceKind 合法性由 §6 policy table 在 Reducer 侧裁决。派生关系由 §6 决定，本节为速查：

| Proposer               | 合法 evidenceKind                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `currentStateProposer` | `scene_change`, `user_correction`, `assistant_correction`                                                                                                                      |
| `todoProposer`         | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`, `todo_completion`, `todo_cancel`, `todo_expiration`, `user_correction`, `assistant_correction` |
| `agreementProposer`    | `standing_agreement`, `agreement_cancel`, `user_correction`, `assistant_correction`                                                                                            |
| `episodeProposer`              | `recent_episode`, `relationship_milestone`, `user_correction`, `assistant_correction`                                                                                          |
| `profileRelationshipProposer`  | `long_term_fact`, `user_correction`, `assistant_correction`, `user_forget`, `assistant_forget`                                                                                |
| `worldFactProposer`            | `long_term_fact`, `user_correction`, `assistant_correction`, `user_forget`, `assistant_forget`                                                                                |
| `compactionProposer`           | `memory_compaction`                                                                                                                                                            |

## 4. Patch Op 合法值与约束

下表同时服务两个视角：Reducer 按 op 校验字段结构，schema/prompt 作者按 Proposer 查合法 op。Reducer 的 section+op 合法性最终查 §6 policy table。

| op                | 含义                       | 适用 Proposer                                                                                |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `setField`        | 设置覆盖式状态字段         | `currentStateProposer`                                                                       |
| `clearField`      | 清除已失效的覆盖式状态字段 | `currentStateProposer`                                                                       |
| `addItem`         | 新增 item                  | `todoProposer`, `agreementProposer`, `episodeProposer`, `profileRelationshipProposer`, `worldFactProposer`                       |
| `updateItem`      | 局部更新已有 item          | `todoProposer`, `agreementProposer`, `episodeProposer`, `profileRelationshipProposer`, `worldFactProposer`                       |
| `forgetItem`      | 忘记已有长期 item 并抑制其 source | `profileRelationshipProposer`, `worldFactProposer`                                                    |
| `mergeItems`      | 合并重复或高度重叠 item    | `compactionProposer` |
| `completeTodo`    | 将待办完成并从数组移除     | `todoProposer`                                                                               |
| `cancelTodo`      | 将待办取消并从数组移除     | `todoProposer`                                                                               |
| `expireTodo`      | 将短期待办失效并从数组移除 | `todoProposer`                                                                               |
| `cancelAgreement` | 将持续约定取消并从数组移除 | `agreementProposer`                                                                          |

字段必填规则：

- `path`：只对 `scene.setField`/`scene.clearField` 必填，值为 `location`/`time`/`mood`/`note`。所有 item section（`todos`、`standingAgreements`、`recentEpisodes`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`）都由 `sectionResults` 的 section key 直接寻址，不使用 `path`。
- `itemId`：对 `updateItem`/`forgetItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`cancelAgreement` 必填（单个 item 的 id）。
- `itemIds`（数组）：对 `mergeItems` 必填，指定要合并的多个 itemId，数组长度 ≥ 2。`value` 是合并后的新 item 值，至少包含 `text`。merged item 的 `evidenceGroups` 由 Reducer 从 source items 自动继承，保留 group 边界。Todo 只允许合并 `status=active` 且 `actor`、`requester`、`dueAt` 三者分别相同的 items；Reducer 将三字段原样继承到 merged item，不接受 Proposer 改写。
- `value`：对 `setField`/`addItem`/`updateItem` 必填。普通 item 的 `addItem`/`updateItem` value 至少包含 `text`。Todo 使用更窄的结构：
  - `todos.addItem`：`value` 必须包含 `text`、`actor`、`requester`；可选 `dueAt` 表达式，缺省时持久化为 `null`。
  - `todos.updateItem`：`value` 至少包含 `dueChange`，并可包含 `text`、`actor`、`requester`。`dueChange` 是显式判别 union：`{ "mode": "keep" }`、`{ "mode": "clear" }` 或 `{ "mode": "set", "dueAt": <表达式> }`；禁止用字段省略同时表达“不修改”和“清空”。
  - `dueAt` 表达式为 `{ "mode": "absolute", "date": "YYYY-MM-DD" }`，或 `{ "mode": "relative", "days"?: N, "months"?: N, "years"?: N }`。relative 的三个时长字段至少出现一个，计算顺序为 `years → months → days`。
  - absolute date 的 deadline 是该日期在用户时区下结束后的首个日界线（即用户时区次日 00:00）；用户时区来自 User 的 IANA time-zone 字段（默认 UTC），并在 task 创建时固化。relative deadline 以本 patch `evidenceRefs` 中 messageId 最大的 evidence message 的数据库 `createdAt` 为 anchor，在 anchor 基础上按该固化时区做日历运算。relative `months`/`years` 运算遵循日历月规则：若结果日期不存在（如 1 月 31 日 + 1 个月），取目标月的最后一天（2 月 28 日或 29 日）。日历运算保留 anchor 的本地时、分、秒和毫秒；结果落入 DST overlap 时选择较早 instant，落入 DST gap 时按 transition gap 向后顺延（Temporal `compatible` 语义）。禁止使用 task/worker 执行时间作 anchor。Reducer 只负责确定性日期计算和 ISO 8601 格式化；已到期的结果仍可写入，并由同一事务或随后 housekeeping 原位标记 overdue，不能因历史回放发生在 deadline 之后而拒绝事实。
- `evidenceRefs`：除 `mergeItems` 外，Proposer patch 至少包含一个 `{ messageId, quote }`。Reducer 自行触发的 todo/scene lifecycle 变化不是 Proposer patch，使用 system cleanup event。普通写入 patch 的 `evidenceRefs` 必须来自 Proposer envelope 的 `observedMessages`（见 §5）。对会写入 item 的普通 patch，Reducer 将该数组连同 `patch.evidenceKind` 包装成一个新的 `evidenceGroup`，并为持久化 refs 补入已校验的数据库 `contentHash`。`forgetItem` 的 evidenceRefs 证明本次 forget 指令；被 suppress 的 source 则从目标 item 的既有完整 `evidenceGroups` 收集，不能由 Proposer 自报。
- `scene.setField`/`scene.clearField` 的 `evidenceRefs` 必须恰好 1 条。`setField` 将已校验 ref 写入目标字段的 `evidenceRef`；`clearField` 将当前字段重置为 `{ value:null, evidenceRef:null, updatedAtMessageId:null }`，clear 指令证据保留在 accepted event 的 `patch_summary/normalized_operation` 中，不作为“当前空值”的 provenance。
- `quote`：必须是能够支持 patch 的最短连续原文片段，最多 200 个 Unicode code points；Reducer 不自动裁剪，完整校验见 §7。
- `evidenceKind: "memory_compaction"` 只允许用于 `mergeItems`。Proposer 不输出 `evidenceRefs`；Reducer 根据 `itemIds` 从权威 state 读取 source items 的既有 `evidenceGroups` 并写入 merged item。

## 5. Proposer 输入/输出信封

Proposer 输入使用统一 envelope，区分三类信息：**writable target**（本次允许写入的 sections）、**read-only memory context**（帮助理解对话背景的只读 memory 片段）、**observed messages**（普通模式下 LLM 可见的原始消息观察窗口）。`task.mode` 是判别字段，决定 `trigger`、`writableState`、`readOnlyContext` 和 `observedMessages` 的语义。

Proposer 输入中的 state item 使用 redacted view，不包含 `evidenceGroups`。redacted view 分两级：

- **writableState item**：保留 `id`（Proposer 需要 id 来输出 `updateItem`/`forgetItem`/`mergeItems`/`completeTodo` 等 patch）：

```js
{
  id: "todo:uuid-xxx",
  text: "归还橡皮",
  createdAtMessageId: 121,
  updatedAtMessageId: 121,
  actor: "user",
  requester: "assistant",
  status: "active",
  becameOverdueAt: null,
  dueAt: null
}
```

- **readOnlyContext item**：不含 `id`（readOnlyContext 的 section 不是 writable target，Proposer 不应对其输出 patch，去掉 id 从结构上防止误用）：

```js
{
  text: "沉默时先开口说明状态",
  createdAtMessageId: 116,
  updatedAtMessageId: 116
}
```

Proposer 输入中的 `scene` 字段使用 `{ value, updatedAtMessageId }`，不包含字段级 `evidenceRef`。

### 5.1 信封结构（普通模式）

```json
{
  "task": {
    "taskId": "018f2f5e-7f2a-7b11-9c31-111111111111",
    "tickId": 12345,
    "userId": 1,
    "presetId": "default",
    "schemaVersion": 2,
    "sourceGeneration": 0,
    "baseRevision": 0,
    "targetKey": "episodes",
    "cursorBefore": 118,
    "targetMessageId": 124,
    "proposer": "episodeProposer",
    "mode": "normal",
    "targetSections": ["recentEpisodes", "milestones"],
    "observedMessageIds": [119, 120, 121, 122, 123, 124],
    "trigger": { "type": "lagThreshold" },
    "now": "2026-07-06T22:30:00Z",
    "userTimeZone": "Asia/Shanghai"
  },
  "writableState": {
    "working": {
      "recentEpisodes": [
        {
          "id": "episode:7",
          "text": "雨夜争执 > 和解 | 用户表达不安",
          "createdAtMessageId": 110,
          "updatedAtMessageId": 110
        }
      ]
    },
    "longTerm": {
      "milestones": [
        {
          "id": "milestone:2",
          "text": "关系转折: 第一次明确互相信任",
          "createdAtMessageId": 80,
          "updatedAtMessageId": 80
        }
      ]
    }
  },
  "readOnlyContext": {
    "current": {
      "scene": {
        "location": {
          "value": "屋顶",
          "updatedAtMessageId": 118
        },
        "time": {
          "value": "深夜",
          "updatedAtMessageId": 118
        },
        "mood": {
          "value": "雨后安静",
          "updatedAtMessageId": 119
        },
        "note": { "value": null, "updatedAtMessageId": null }
      }
    },
    "working": {
      "todos": [
        {
          "text": "归还橡皮",
          "createdAtMessageId": 112,
          "updatedAtMessageId": 112,
          "actor": "user",
          "requester": "assistant",
          "status": "active",
          "becameOverdueAt": null,
          "dueAt": null
        }
      ],
      "standingAgreements": [
        {
          "text": "沉默时先开口说明状态",
          "createdAtMessageId": 116,
          "updatedAtMessageId": 116
        }
      ]
    },
    "longTerm": {
      "relationship": [
        {
          "text": "关系模式: 慢热 > 安全感确认后更依赖",
          "createdAtMessageId": 50,
          "updatedAtMessageId": 60
        }
      ],
      "userProfile": [
        {
          "text": "偏好: 不喜欢被连续追问",
          "createdAtMessageId": 45,
          "updatedAtMessageId": 45
        }
      ],
      "assistantProfile": [
        {
          "text": "人格: 主动给空间",
          "createdAtMessageId": 30,
          "updatedAtMessageId": 30
        }
      ]
    }
  },
  "observedMessages": [
    { "id": 119, "role": "user", "createdAt": "2026-07-06T22:20:00Z", "contentKind": "raw", "content": "你为什么不说话，是不是又觉得我很烦？", "contentHash": "sha256:8ca61a01fbd79970364c38917cd1f3ebe96713f724af71caa698d65e10e84ce5" },
    { "id": 120, "role": "assistant", "createdAt": "2026-07-06T22:21:00Z", "contentKind": "raw", "content": "我没有觉得你烦，只是在想怎么开口。", "contentHash": "sha256:d17d057c96c43dce7c9d5a0a1ea53750fad74d5fac47613e203c04767b2c4245" },
    { "id": 121, "role": "user", "createdAt": "2026-07-06T22:22:00Z", "contentKind": "raw", "content": "我刚才其实很怕你会走，所以才一直不敢抬头。", "contentHash": "sha256:ea43e034be8421d57eb9551b5a582829265d6dd29413ec7d1c186d42b045c29b" },
    { "id": 122, "role": "assistant", "createdAt": "2026-07-06T22:23:00Z", "contentKind": "raw", "content": "我没有走，我只是想等你愿意看我的时候再靠近。", "contentHash": "sha256:59746af1c43cf67fc4361fcf756f97cf8b93579a5661191045cb6c6c3e45b829" },
    { "id": 123, "role": "user", "createdAt": "2026-07-06T22:24:00Z", "contentKind": "raw", "content": "那你以后能不能别沉默那么久，我会乱想。", "contentHash": "sha256:e1b948767b9ae12d4a781c67e9935ae854b0256d5d70c56c39016ecf8c553ede" },
    { "id": 124, "role": "assistant", "createdAt": "2026-07-06T22:25:00Z", "contentKind": "raw", "content": "好，以后我会先开口，不让你一个人等。", "contentHash": "sha256:befdcb11c89b8ade33628f58d69e66a9c84e0f3257f8d6014b7a7aacf6e004df" }
  ]
}
```

字段说明：

- `task`：携带 durable `taskId`、创建时的 `sourceGeneration/baseRevision`、本次 `targetKey`、该 target 的 `cursorBefore`、proposer、mode、target sections、observed message ids、`trigger` 和 `now`。一个 normal task 恰好对应一个 target，因此只有一个 `cursorBefore`、一个 new batch 和一个 `targetMessageId`；正常 apply 前必须重新校验 generation、revision 与 target cursor，任一不匹配都不得直接 apply。compaction 后 replay 原 proposal 时，`baseRevision` 只用于审计，但 `sourceGeneration` 仍必须匹配；其余 stale 判定见 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md) §2。
- `writableState`：本次允许写入的目标 sections 当前状态。item 使用 §5 的 writableState redacted view（含 id）；无值字段显式传 null。
- `readOnlyContext`：可读取的背景 memory，用于理解对话，不得作为新事实证据。item 使用 §5 的 readOnlyContext redacted view（不含 id），固定范围见 §5.3。
- `observedMessages`：普通模式下 LLM 可见的原始消息观察窗口，与 `observedMessageIds` 一一对应。每项携带真实 `role`、`createdAt` 和 `contentHash`；`contentHash` 固定为 raw `content` 的 UTF-8 SHA-256，格式为 `sha256:` 加 64 位小写十六进制。这些 proposal-time 字段写入 §9.3 durable task 的 immutable `task_payload`，Reducer apply 时与数据库当前行重新核对。普通写入 patch 的 `evidenceRefs.messageId` 必须来自 `observedMessages`。窗口组装规则见 [write-protocol.md](write-protocol.md) §2。

### 5.2 维护模式字段语义

`compactionProposer` 使用 `mode: "maintenance"` 的同形 envelope。各字段在维护模式下的取值与约束：

| Envelope 字段                         | 维护模式取值 / 范围                 | 约束                                                             |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `task.proposer`                       | `compactionProposer`                | 只由 Reducer 长度预算门触发，不参与普通 lag 轮询                 |
| `task.mode`                           | `"maintenance"`                     | Reducer 按维护模式切换 policy：只允许安全合并，不允许新增事实    |
| `task.targetKey`                      | 来源 normal task 的 targetKey       | 仅用于关联被阻塞 target、event 和 ops log；compaction 不读取或推进该 cursor |
| `task.targetMessageId`                | 来源 normal task 的 targetMessageId | 只标识被阻塞 proposal 的 raw-message 边界，用于关联、幂等和后续 replay；不是 compaction cursor，不用于读取 raw messages 或推进 cursor |
| `task.parentTaskId`                   | 来源 normal task 的 taskId          | maintenance durable task 的父任务关联                                   |
| `task.resumeEpoch`                    | 首次为 0，人工 resume 每次 +1       | 与 parentTaskId、section 共同参与 maintenance dedupe identity            |
| `task.targetSections`                 | 仅含被预算阻塞的一个 section        | 禁止跨 section 合并；envelope 不再设置额外的 path 分组字段      |
| `task.observedMessageIds`             | `[]`                                | 维护任务不观察新的最近对话窗口                                   |
| `task.trigger`                        | `{ type: "lengthBudget", dimension, limit }` | `dimension` 为 `maxItems` 或 `maxRenderedChars`；`limit` 是对应配置值 |
| `writableState`                       | 目标 section 的全部可合并 items     | item 使用 §5 redacted view；todos 只包含 `status=active` 的 items |
| `readOnlyContext`                     | `{}`                                | 维护任务只在目标 source items 内判断合并                         |
| `observedMessages`                    | `[]`                                | 维护任务不读取 raw messages                                      |

维护模式下，`writableState` 不包含既有 `evidenceGroups`。`compactionProposer` 只输出可合并的 `itemIds` 与合并后的 `value.text`，不输出 `evidenceRefs`。Reducer 根据 `itemIds` 从权威 `memory_state` 读取 source items，继承 source `evidenceGroups`。

维护模式示例：

```json
{
  "task": {
    "taskId": "018f2f5e-7f2a-7b11-9c31-222222222222",
    "tickId": 12346,
    "userId": 1,
    "presetId": "default",
    "schemaVersion": 2,
    "sourceGeneration": 0,
    "baseRevision": 0,
    "targetKey": "profileRelationship",
    "targetMessageId": 124,
    "parentTaskId": "018f2f5e-7f2a-7b11-9c31-111111111111",
    "resumeEpoch": 0,
    "proposer": "compactionProposer",
    "mode": "maintenance",
    "targetSections": ["userProfile"],
    "observedMessageIds": [],
    "trigger": {
      "type": "lengthBudget",
      "dimension": "maxRenderedChars",
      "limit": 1200
    },
    "now": "2026-07-06T22:30:00Z",
    "userTimeZone": "Asia/Shanghai"
  },
  "writableState": {
    "longTerm": {
      "userProfile": [
        {
          "id": "userProfile:1",
          "text": "偏好: 晚上聊天",
          "createdAtMessageId": 88,
          "updatedAtMessageId": 88
        },
        {
          "id": "userProfile:2",
          "text": "关系模式: 需要慢慢熟悉后再依赖",
          "createdAtMessageId": 101,
          "updatedAtMessageId": 101
        }
      ]
    }
  },
  "readOnlyContext": {},
  "observedMessages": []
}
```

示例中的 `limit` 只展示 envelope shape，不代表容量默认值；正式值必须来自 §8 的集中配置。

### 5.3 各 Proposer 的 readOnlyContext 固定范围

`readOnlyContext` 的 section 范围由 Proposer 类型和目标 sections 固定决定，不随 observed messages 语义变化：

| Proposer                    | Writable target                                        | Read-only context                                                                                                                              |
| --------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentStateProposer`      | `scene`                                                | `working.recentEpisodes`                                                                                                                       |
| `todoProposer`              | `todos`                                                | `current.scene`、`working.standingAgreements`、`working.recentEpisodes`、`longTerm.userProfile`、`longTerm.assistantProfile`                   |
| `agreementProposer`         | `standingAgreements`                                   | `current.scene`、`working.todos` active 子集、`working.recentEpisodes`、`longTerm.relationship`、`longTerm.userProfile`、`longTerm.assistantProfile` |
| `episodeProposer`           | `recentEpisodes`, `milestones`                         | `current.scene`、`working.todos` active 子集、`working.standingAgreements`、`longTerm.relationship`、`longTerm.userProfile`、`longTerm.assistantProfile` |
| `profileRelationshipProposer` | `userProfile`、`assistantProfile`、`relationship`    | `current.scene`、`working.recentEpisodes`、`working.standingAgreements`、`longTerm.milestones`、`longTerm.worldFacts`                        |
| `worldFactProposer`         | `worldFacts`                                           | `current.scene`、`working.recentEpisodes`、`working.standingAgreements`、`longTerm.milestones`、`longTerm.userProfile`、`longTerm.assistantProfile`、`longTerm.relationship` |
| `compactionProposer`        | 被预算阻塞的单个 section                               | `{}`                                                                                                                                           |

`profileRelationshipProposer` 的 `targetSections` 为 `["userProfile", "assistantProfile", "relationship"]`，三个正式 section 共享 `profileRelationship` cursor；`worldFactProposer` 的 `targetSections` 为 `["worldFacts"]`。两者分别把对方 writable sections 放入 `readOnlyContext`：前者只读 `worldFacts`，后者只读 `userProfile`、`assistantProfile`、`relationship`；两者还都包含 `current.scene`、`working.recentEpisodes`、`working.standingAgreements` 和 `longTerm.milestones` 作为语义背景。维护模式下 `compactionProposer` 的 `readOnlyContext` 固定为空对象。Todo 的 maintenance writableState 只包含 active items；overdue items 不参与 active 容量门且不可被 merge，因此不向 compactionProposer 暴露。

### 5.4 边界规则

**写入范围**

- `sectionResults` 只能包含 `task.targetSections`；Proposer 可读取 `readOnlyContext`，但不得输出非 target section 的 patch。
- target sections 的当前状态只放在 `writableState`；若某固定背景范围概念上包含 target，本次仍以 `writableState` 为准，不在 `readOnlyContext` 重复放一份。
- `todoProposer` 的 `writableState.working.todos` 中 overdue todo 只包含最近 N 条（按 `becameOverdueAt DESC`、itemId 稳定打破平局），N 与 Renderer 的 overdue 渲染窗口一致，从集中配置读取；active todo 仍全量传入。其他 Proposer 的 readOnlyContext 中 `working.todos` 仍只包含 active 子集。

**证据（普通模式）**

- `task.trigger` 为 `{ type: "lagThreshold" }`。普通写入 patch 的 `evidenceRefs.messageId` 必须来自 `observedMessages`；不得引用 `readOnlyContext` 中 item 的历史证据来证明新事实。
- `writableState` 与 `readOnlyContext` 不暴露既有 `evidenceGroups`。

**证据（维护模式）**

- `task.trigger` 为 `{ type: "lengthBudget", dimension, limit }`，其中 `dimension` 为 `maxItems | maxRenderedChars`。维护 patch 不输出 `evidenceRefs`；Reducer 从 source items 自动继承 `evidenceGroups`。

**readOnlyContext 组装**

- `readOnlyContext` 必须带结构化 section 名称，不能把 Renderer 文本或旧 summary 整段塞给 Proposer。
- 固定范围以完整 section 为单位：一旦纳入，全量输入该 section 当前 items 的 redacted view（不含 `id`，见 §5），无值字段显式传 null，不做 last N、相似度筛选或关键词筛选。
- `readOnlyContext` 可以相对充分，但必须由纯代码按 §5.3 固定范围从 `memory_state` 结构化组装。禁止把 Renderer 文本、旧 summary 或未分区的整块 `memory_state` 无差别塞入。
- envelope 不保留 `omitted` 清单。调用方不向 LLM 解释哪些 section 没给；Proposer 只能基于实际收到的固定范围判断。

**判断不足时**

- 如果 read-only 背景不足，Proposer 应输出 `unable_to_decide`，而不是把背景猜成事实。

### 5.5 Proposer 输出契约

Proposer 输出必须通过 provider 支持的 schema-constrained structured output 返回（实现可以是 function/tool calling 或 JSON schema response format，由 provider adapter 决定；禁止裸 prompt + `JSON.parse` 作为主路径）。输出形态：

```json
{
  "tickId": 12345,
  "proposer": "episodeProposer",
  "sectionResults": {
    "recentEpisodes": {
      "status": "patches",
      "patches": [
        {
          "op": "addItem",
          "value": { "text": "屋顶和解: 用户承认害怕被离开 | assistant 等待并靠近" },
          "evidenceKind": "recent_episode",
          "evidenceRefs": [{ "messageId": 121, "quote": "很怕你会走" }]
        }
      ]
    }
  }
}
```

- 每个目标 section 的 `status` 必须是 `patches | noop | unable_to_decide` 之一。非目标 section 不出现在 `sectionResults` 中。
- `patches` 数组中每个 patch 含 `op`、`path`（仅 scene 字段操作）/`itemId`/`itemIds`（按 §4 必填规则）、`value`（按 §4 必填规则；todo add 必须含 actor/requester，todo update 必须含 dueChange）、`evidenceKind`（§3 枚举）。除 `mergeItems` 外，每个 patch 还必须含 `evidenceRefs`（至少 1 项，每项含 `messageId` integer 和 `quote` string；quote 最多 200 个 Unicode code points）。
- `evidenceRefs` 是 Proposer patch 字段，不是 item 的权威存储字段。Reducer 对普通非 `mergeItems` patch 校验通过后，add/update item 的 refs 补入已校验的数据库 `contentHash`，再与 `patch.evidenceKind` 包装为 `evidenceGroup`；scene 字段操作沿用字段级 evidenceRef。`forgetItem` 的新 evidence 只证明 forget 指令，不追加到已移除 item。`mergeItems` 的 evidenceGroups 从 source items 继承，各 group 保留各自 evidenceKind。
- `evidenceKind` 是 Reducer 做 policy gate 的枚举输入（§6）。Reducer 不把它当可信度分数；普通写入证据仍必须通过 `messageId + quote` 校验（§7）。
- `patchId` 由 Reducer 生成，Proposer 不需要输出，用于 event log 引用。
- 长期 item 直接由 `sectionResults` 的 `userProfile` / `assistantProfile` / `relationship` / `worldFacts` key 寻址，不使用 `core` 或 `path`。例如以下 patch 位于 `sectionResults.userProfile.patches`：

```json
{
  "op": "addItem",
  "value": { "text": "性格: 内向(初识) > 依赖(熟悉后)" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我其实挺内向的，但熟了就会很粘人" }]
}
```

- `compactionProposer` 的 schema 额外限制：只能输出 `mergeItems`，且 `evidenceKind` 只能是 `memory_compaction`。输出 `addItem`、`forgetItem`、通用删除、跨 section 合并、`user_correction` 或 `evidenceRefs` 均非法。compaction section 的 `status` 必须是 `patches | unable_to_compact` 之一（不同于普通 Proposer 的 `patches | noop | unable_to_decide`）。
- `sectionResults` 必须恰好覆盖 `task.targetSections`。缺少 target section、包含非 target section、目标 section 缺少 `status`，均由 tick orchestrator 归类为 `output_schema_invalid`，不交 Reducer、不推进 cursor；首次 Provider 输出边界错误可按 §10 的有界规则持久化后重试，耗尽后按 §9.3-§9.5 原子更新 task、对应 target status 与 ops log，不产生 revision/snapshot。

compaction 输出示例（`patches` 状态，仍使用 `sectionResults`，但只允许 `mergeItems`）：

```json
{
  "tickId": 12346,
  "proposer": "compactionProposer",
  "sectionResults": {
    "userProfile": {
      "status": "patches",
      "patches": [
        {
          "op": "mergeItems",
          "itemIds": ["userProfile:1", "userProfile:2"],
          "value": { "text": "偏好/关系模式: 夜间更适合长聊 | 慢热后依赖" },
          "evidenceKind": "memory_compaction"
        }
      ]
    }
  }
}
```

compaction 返回 `unable_to_compact` 时，`sectionResults` 中该 section 的 `status` 为 `unable_to_compact`，不含 `patches`。由 tick orchestrator 直接处理：写 ops log、终结 maintenance task、halt 对应 target，不交 Reducer，也不产生 revision/snapshot。

## 6. Patch Policy Table

Reducer 按 `section + op + evidenceKind` 查此表判断是否允许写入。不在表中的组合：Reducer 拒绝并记录 `rejected`（reason: `policy_not_allowed`）。

| section / op                          | 允许的 evidenceKind                                                                                                                            | 备注                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `scene.setField` / `scene.clearField` | `scene_change`, `user_correction`, `assistant_correction`                                                                                      | 字段级覆盖；字段级证据             |
| `todos.addItem`                       | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`                                                                 | 必须是可完成、可取消或可过期的事项 |
| `todos.updateItem`                    | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`, `user_correction`, `assistant_correction`                      | 更新待办                           |
| `todos.mergeItems`                    | `memory_compaction` | 仅合并重复且 actor/requester/dueAt 分别相同的 active 待办 |
| `todos.completeTodo`                  | `todo_completion`                                                                                                                              | 完成必须有终止证据                 |
| `todos.cancelTodo`                    | `todo_cancel`, `user_correction`, `assistant_correction`                                                                                       | 取消待办                           |
| `todos.expireTodo`                    | `todo_expiration`                                                                                                                              | 短期待办失效                       |
| `standingAgreements.addItem`          | `standing_agreement`                                                                                                                           | 新增持续互动约定                   |
| `standingAgreements.updateItem`       | `standing_agreement`, `user_correction`, `assistant_correction`                                                                                | 修订持续互动约定                   |
| `standingAgreements.mergeItems`       | `memory_compaction`                                                           | 合并重复约定                       |
| `standingAgreements.cancelAgreement`  | `agreement_cancel`, `user_correction`, `assistant_correction`                                                                                  | 取消持续互动约定                   |
| `recentEpisodes.addItem`              | `recent_episode`                                                                                                                               | 滑动窗口                           |
| `recentEpisodes.updateItem`           | `recent_episode`, `user_correction`, `assistant_correction`                                                                                    | 更新近期经历                       |
| `milestones.addItem`                  | `relationship_milestone`                                                                                                                       | 关系或剧情关键转折                 |
| `milestones.updateItem`               | `user_correction`, `assistant_correction`                                                                                                      | 修订里程碑                         |
| `milestones.mergeItems`               | `memory_compaction`                                                                                 | 合并重叠里程碑                     |
| `worldFacts.addItem` / `userProfile.addItem` / `assistantProfile.addItem` / `relationship.addItem` | `long_term_fact` | 新增长期事实 |
| `worldFacts.updateItem` / `userProfile.updateItem` / `assistantProfile.updateItem` / `relationship.updateItem` | `user_correction`, `assistant_correction` | 修订对应长期事实 |
| `worldFacts.forgetItem` / `userProfile.forgetItem` / `assistantProfile.forgetItem` / `relationship.forgetItem` | `user_forget`, `assistant_forget` | 移除 item；必须同事务写 source suppression tombstone |
| `worldFacts.mergeItems` / `userProfile.mergeItems` / `assistantProfile.mergeItems` / `relationship.mergeItems` | `memory_compaction` | 仅合并同一正式 section 内的重叠 item |

对 `worldFacts`、`userProfile`、`assistantProfile`、`relationship`，User 和 Assistant 双方拥有相同的 add/update/forget 权限：`addItem + long_term_fact` 的证据可以来自任一真实 role；update/forget 分别使用与真实发言方一致的 `user_correction`/`assistant_correction` 或 `user_forget`/`assistant_forget`。Reducer 必须按数据库真实 role 校验 evidenceKind，但不得用消息 role 限制双方只能维护某一个 Profile。`forgetItem` 只有在 [write-protocol.md](write-protocol.md) §5 的 item 移除、event/snapshot 与 suppression tombstone 能原子提交时才可 accepted。

## 7. Evidence 校验：Quote 模糊匹配

Evidence source 校验、quote 归一化、信息量判断和统一 Levenshtein 匹配的算法权威来源为 [Evidence 校验与 Quote 匹配算法](algorithms/evidence-validation.md)。本文件只保留 evidence/evidenceKind/reject reason 的静态 shape 与枚举。

## 8. Memory 容量与长度预算

除本节下述确定性例外外，每个会进入主聊天上下文的 item section 都使用同一容量 shape：

```js
{
  maxItems,
  maxRenderedChars
}
```

`scene` 是固定字段对象而非 item section，因此不使用 `maxItems`，但其可能被 Renderer 输出的 scene values 受独立 `maxRenderedChars` 约束。

容量计算规则：

1. `maxItems` 统计该 section 受基础容量门约束的当前 items 数量。
2. `maxRenderedChars` 按 Unicode code points 统计 Renderer 可能输出的语义文本：普通 item section 计 `item.text`；todo 还计 actor/requester 及非 null dueAt 的渲染值；scene 计非 null 的 field `value`。Renderer 的标题、字段标签、连接词、模板标点不计。
3. quote、evidenceGroups、hash、ID、provenance、event、task/proposal、compaction audit 等不会作为 Memory 语义文本渲染的内容不计。
4. proposal apply 后任一维度超过配置上限即视为超容量；普通 item section 进入 deferred/compaction 流程，maintenance trigger 用 `dimension=maxItems|maxRenderedChars` 标明阻塞维度。`scene` 不可 compaction；Reducer 按 patch 顺序模拟字段操作，若某个 `setField` 会令 scene values 总字符数超过 `scene.maxRenderedChars`，只拒绝该 patch（reason=`capacity_exceeded`）并恢复该字段的 pre-patch 值，同 bundle 中其它合法 patch 仍可独立 accepted/rejected。
5. Memory 业务层不设置 proposal 或 envelope 总字符上限，也不要求 LLM 精确控制 proposal 总字符数。Provider 的 context/output 物理上限属于 Adapter/Provider 能力边界，不得转化成 Memory section 容量。
6. 所有 item section 的 `maxItems` / `maxRenderedChars` 以及 scene 的 `maxRenderedChars` 都从集中配置读取，禁止散落硬编码。除 quote 最大 200 已确定外，本批不确定具体容量默认值；默认值需结合真实历史分布后写入配置文档。

确定性例外：

1. `recentEpisodes` 仍同时受 `maxItems + maxRenderedChars` 约束，但超限时由 Reducer 按 `createdAtMessageId`（再以 itemId 打破平局）滚出最旧 items，直到两项限制均满足，并为每个滚出项写 `system_cleanup: recent_episode_evicted`；不触发 compactionProposer。
2. `current.previousScene` 是单值字段，新 scene 到期时直接替换旧值；不参与 scene 的 `maxRenderedChars` 容量门，也不触发 compactionProposer。
3. `todos.maxItems/maxRenderedChars` 只统计并约束 `status=active` 的 items。overdue items 不占 active 容量、不触发 compaction；Renderer 对 overdue 子集使用独立的 `maxRenderedItems + maxRenderedChars` 配置。

> **容量 halt 策略说明**：当前 compaction/replay 失败后 halt 对应 target 的策略是临时方案，用于在计划前期通过真实运行数据确定合适容量默认值。待容量默认值稳定后，再引入自动降级策略（见 [容量降级策略（延后）](../deferred/memory-control-v2/capacity-degradation.md)）。

## 9. Revision、Snapshot、Event 与运行恢复状态

DDL 的数据库层责任是字段类型、nullable/default、主键、唯一约束、显式外键和索引；带条件的 stage/decision/outcome 枚举与跨字段状态机不变量由 contracts/Repository/应用事务层校验。生产启服前的 schema checker 必须逐表验证本节全部表和字段、关键 nullable/default 以及全部显式索引，不能只检查 v1 字段是否已删除。若未来允许模块外直接写这些表，必须先把相应应用层枚举与跨字段约束下沉为数据库 `CHECK`/trigger，不得绕过当前写入边界。

Memory 恢复分为两条独立 authority：

- **语义 state**：`memory_state` + 每 revision 完整 snapshot + revision event group/events。
- **运行状态**：durable task + per-target status + ops log。

运行失败不得写回 `memory_state.meta`。只有成功提交新的权威 state/cursor 才增加 revision 并写 snapshot；Provider/schema 等尚未产生语义提交的失败只更新运行状态。

### 9.1 Revision 与完整 post-state snapshot

```sql
CREATE TABLE chat_memory_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  revision        BIGINT NOT NULL,
  schema_version  INTEGER NOT NULL,
  state           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, revision)
);
```

规则：

1. `memory_state.meta.revision` 从首次初始化的 0 开始跨 generation 单调递增；首次 state 同步写 revision 0 完整 snapshot。自动 rebuild 初始化新 generation 时使用前一 revision `+1`，不得重置 revision；snapshot 内的 generation/revision 必须与行值一致。
2. 一个 task bundle 即使包含多个 patch/event，也最多形成一个新 revision 和一份 snapshot；该事务中的所有 accepted operation 与 cursor 终态共同属于同一个 event group。
3. revision N 的 post-state snapshot 已天然构成 revision N+1 的 pre-state；禁止为每次提交再复制一份 pre-state snapshot。
4. accepted patch、system cleanup、cursor 推进或 source generation 初始化导致 `memory_state` 变化时形成 revision。纯 Provider/schema 失败、retry_wait、halt、只写 ops log 等不改变 state/cursor 的运行状态更新不形成 revision 或 snapshot。
5. snapshot 包含全部语义 section、`meta.sourceGeneration`、`meta.revision` 和全部 target cursors；不包含 task retry、错误计数、halt、nextRetryAt 等运行状态。
6. checkpoint 与 snapshot 是同一个概念，不再建立 per-section 或文本 checkpoint。

### 9.2 Revision event group 与 events

一个 task bundle 的决策先归入 event group；`result_revision` 非 null 表示该 group 提交了新 state，null 表示只有 deferred/rejected 等审计结果而没有 state/cursor revision。一个经历 capacity-blocked 的多阶段 normal task 允许拥有两个 event group：`result_revision=null` 的"capacity-blocked 审计 group"（只为触发容量阻塞的 patch 写 `deferred`）和 `result_revision` 非 null 的"最终 replay group"（为全部 patch 写最终 `accepted/rejected/noop`）。maintenance task 的 compaction apply 各自形成独立 event group；若 maintenance patches 全部 rejected，必须以 `result_revision=null` 持久化 maintenance 审计 group/events，并与 task/target 失败终态及 ops log 同事务提交。

Source generation 初始化是唯一不创建 semantic event group 的 state revision：raw-source mutation 事务直接写新 generation 的空 state 与完整 snapshot，并以 generation/revision 明确形成恢复边界。事件 replay 从该 snapshot 开始且禁止跨 generation，因此不伪造某个正式 section/target 的 cleanup event。

```sql
CREATE TABLE chat_memory_event_groups (
  event_group_id  UUID PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  task_id         UUID NOT NULL,
  target_key      TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  schema_version  INTEGER NOT NULL,
  base_revision   BIGINT NOT NULL,            -- group 实际事务开始时的最新全局 revision；不等同于 task 创建时的 base_revision
  result_revision BIGINT,
  cursor_before   BIGINT,
  cursor_after    BIGINT,
  group_kind      TEXT NOT NULL,           -- proposal | maintenance | system_cleanup
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, result_revision)
);
```

`base_revision` 语义：每个 event group 的 `base_revision` 是该 group 实际提交事务开始时的最新全局 revision，不是 normal task 创建时捕获的 `chat_memory_tasks.base_revision`。普通首次提交时两者恰好相等；compaction apply group 和 replay group 取各自事务开始时的最新 revision，因为其他 target 或 compaction 本身可能已推进 revision。对所有 `result_revision IS NOT NULL` 的 event group，必须满足 `result_revision = base_revision + 1`；`result_revision IS NULL` 的审计 group 仍记录事务开始时的最新 revision。`source_generation` 必须匹配当前 state；任何 group/task 都不得跨 generation 关联或 replay。

每个 patch 产生一行 event；`noop` 产生一行占位。Reducer 自行改变持久化 state 时必须产生 `system_cleanup` event，禁止 silent mutation。

二次 `unable_to_decide` 等“无 semantic operation、只推进 cursor”的 revision 可以拥有零条 `chat_memory_events`；其原因保留在 ops log，event group 的 `cursor_before/cursor_after` 与 result_revision 足以确定性 replay。不得伪造 noop 或 accepted event 来填充空 group。

```sql
CREATE TABLE chat_memory_events (
  id              BIGSERIAL PRIMARY KEY,
  event_group_id  UUID NOT NULL REFERENCES chat_memory_event_groups(event_group_id),
  event_index     INTEGER NOT NULL,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  task_id         UUID NOT NULL,
  tick_id         BIGINT,
  target_key      TEXT NOT NULL,             -- scene | todos | standingAgreements | episodes | profileRelationship | worldFacts；maintenance event 记录来源 normal target
  section         TEXT NOT NULL,
  event_kind      TEXT NOT NULL,             -- proposal_decision | system_cleanup
  decision        TEXT NOT NULL,             -- accepted | rejected | deferred | noop | system_cleanup
  patch_id        TEXT,                    -- Reducer 生成的 patch 唯一 id（如有）
  op              TEXT,                    -- patch op（如有）
  item_id         TEXT,                    -- 目标 item id（如有）；mergeItems 时为 null
  result_item_id  TEXT,                    -- add/merge 后的新 item id（如有）
  merged_from_item_ids JSONB,              -- mergeItems 的完整 source item ID 数组（如有）
  evidence_kind   TEXT,                    -- evidenceKind（如有）
  reject_reason   TEXT,                    -- 拒绝原因码（仅 rejected 时）
  maintenance_task_id UUID,                -- 关联 maintenance task（如有）
  patch_summary   JSONB,                   -- patch 的精简摘要（op + value + evidenceRefs if present）
  normalized_operation JSONB,              -- accepted/system cleanup 的完整确定性 replay operation
  cleanup_type    TEXT,                     -- 仅 system_cleanup；合法领域类型见下文
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_events_user_preset
  ON chat_memory_events(user_id, preset_id, created_at DESC);

CREATE INDEX idx_memory_events_target_decision
  ON chat_memory_events(user_id, preset_id, target_key, decision);

CREATE UNIQUE INDEX idx_memory_events_group_order
  ON chat_memory_events(event_group_id, event_index);

CREATE UNIQUE INDEX idx_memory_events_group_patch
  ON chat_memory_events(event_group_id, patch_id)
  WHERE patch_id IS NOT NULL;
```

`decision` 合法值（per-patch，非 section 聚合）：

- `accepted`：该 patch 被 apply。
- `rejected`：该 patch 被拒（policy/quote/schema 等）。一个 section 一个 tick 的多个 patch 可能部分 `accepted` 部分 `rejected`，各自落行。
- `deferred`：该 item patch 被长度预算阻塞，capacity-blocked 审计 group 中写 `deferred`（`result_revision=null`），已触发 maintenance task。
- `noop`：Proposer 明确判断该 section 无变化。占位行，`patch_id`/`op`/`item_id`/`evidence_kind`/`patch_summary` 为 null。一个 section 一个 tick 最多一行 noop。
- `system_cleanup`：Reducer/housekeeping 的确定性持久化变化；必须携带 `cleanup_type` 与完整 `normalized_operation`，不伪装成普通 message evidence。

领域 lifecycle 固定使用以下 `cleanup_type`：

- `scene_expired`：把到期的完整 `current.scene`（含字段 provenance）写入 `current.previousScene`，令 `expiredAt = scene anchor message.createdAt + 配置 TTL`，再把 current.scene 四个固定字段分别重置为 `{ value:null, evidenceRef:null, updatedAtMessageId:null }`。
- `expired_scene_evicted`：上述写入覆盖了非 null 的旧 `previousScene`；与 `scene_expired` 写在同一 cleanup revision/event group，不调用 compaction。
- `todo_became_overdue`：当 `now >= dueAt` 且 item 仍为 active 时，原位设 `status="overdue"`、`becameOverdueAt=dueAt`；保留 itemId、actor、requester、dueAt 和全部 provenance。重复 housekeeping 必须 noop，不能重写首次时间。
- `todo_revived_from_overdue`：当 overdue todo 的 `updateItem` 设置 `dueChange.mode=set` 且新 dueAt 在未来时，原位设 `status="active"`、`becameOverdueAt=null`；保留 itemId、actor、requester、dueAt（新值）和全部 provenance。
- `recent_episode_evicted`：`recentEpisodes` 超过 §8 滑动窗口限制时滚出最旧 item；每个被移除 item 各写一行 event。

Cleanup event 使用正式 section/target 映射：两个 scene cleanup 均为 `section=scene,target_key=scene`；todo cleanup 为 `section=todos,target_key=todos`；episode cleanup 为 `section=recentEpisodes,target_key=episodes`。System cleanup task 不拥有或推进 raw-message cursor。

Scene/Todo housekeeping 读取同一事务捕获的 `now`。若 lifecycle 变化由一个 proposal 的模拟 post-state 直接触发（例如新增已到 deadline 的 todo 或 recentEpisodes apply 后超窗口），对应 `system_cleanup` events 与 proposal decisions 共用该 proposal event group、revision 和完整 snapshot，保证最终 post-state 原子满足 lifecycle/容量规则。没有 proposal 的后台 housekeeping 才创建 `group_kind=system_cleanup` 的独立 revision/group。两种路径都复用同一纯代码 lifecycle 函数；无变化不创建空 revision。

Replay 与 ID 规则：

1. 只有 `accepted` 和 `system_cleanup` event 携带可 apply 的完整 `normalized_operation`；event replay 不重新调用 LLM。
2. add event 的 `result_item_id` 不得为 null。Reducer 在事务中先预留 event IDs、生成最终 item IDs、构造 state，再插入 events，解决 eventId/itemId/provenance 的循环依赖。
3. 语义 replay 只消费 `result_revision IS NOT NULL` 的 groups，按 `event_index` replay normalized operations，再校验并应用 `cursor_after`；`result_revision IS NULL` 的 groups 只用于审计/运行恢复，不占 revision 序列。必须验证 schema version、revision 连续性、cursor 连续性以及 group/task/target 一致性。
4. compaction/replay 的专用 revision 阶段在 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md) 定义：compaction apply 和原 proposal replay 在同一 source generation 内各自形成明确 revision，并各自同步 snapshot；capacity-blocked 审计 group 的 `result_revision` 为 null，最终 replay group 基于执行时最新全局 revision。本批不引入 state hash。
5. 提交事务必须先按 `task_id` 锁定并读取 task，再校验 source generation、target `cursor_before`、当前 revision 与该 stage 的预期执行 revision；normal successor 与 revision stale 见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) §4，compaction/replay 的专用 stale 条件见 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md) §2。
6. 每个 task phase 使用稳定的 event group identity；同一 group 内的 `patch_id` 以及非 null `result_revision` 都有唯一约束。capacity-blocked 审计与最终 replay 是两个稳定 phase/group，因此允许同一原 patchId 在两组中分别出现 deferred 与最终 decision。Phase identity、重复 delivery、提交结果不确定与新 maintenance child 的幂等规则见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) §6–§8。

target 级 cursor 推进按 `target_key` 聚合，并同时检查该 normal proposal 的全部 `sectionResults` 与 pre-patch outcome。普通 proposal attempt 中，任一 section 为 `unable_to_decide`、任务发生 `error`，或任一 event 为 `deferred` 时均不推进；只有所有 target sections 都形成可推进终局，且至少产生一行 `accepted`/`noop`/普通 `rejected` event 时才推进。唯一例外是 §9.2 已定义的二次 `unable_to_decide` 终结分支：扩大一次上下文后仍无法判断时，可以创建零条 event 的 cursor-only revision，并以 event group 的 `cursor_before/cursor_after` 确定性 replay（见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) §3、§5.2）。除该特例外，不能只凭某一 section 的 accepted event 推进联合 target。可 compaction 的 item section 容量超限不产生 patch 级 `rejected`，而是由 `deferred`（审计 group）和 task 级 `compaction_failed` / `replay_failed` 表达（见 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md)）；不可 compaction 的 `scene` 是明确例外：单字段超限写 `rejected: capacity_exceeded`，按普通 rejected 语义推进 cursor，且不创建 maintenance task。

`reject_reason` 合法值（仅 `rejected` 时填写）：

- `schema_invalid`：patch 结构不合规。
- `message_id_not_found`：evidenceRefs 的 messageId 不存在。
- `evidence_source_mismatch`：数据库消息的 scope、role、createdAt 或 `contentHash` 与 proposal-time observed message 不一致。
- `evidence_role_mismatch`：evidenceKind 的明确发言方语义与数据库真实 role 不一致。
- `quote_too_short`：归一化 quote 少于 3 个信息字符，或原始 quote 为空/只有 whitespace、punctuation、symbol。
- `quote_too_long`：原始 quote 超过 200 个 Unicode code points。
- `quote_not_found`：quote 模糊匹配失败。
- `policy_not_allowed`：section + op + evidenceKind 不在 policy table。
- `invalid_state_transition`：section + op + evidenceKind 本身合法，但目标 item 当前 lifecycle 状态不允许该操作（例如 overdue todo 执行 `expireTodo`，或以 keep/clear/已过期 dueAt 执行 `updateItem`）。
- `item_not_found`：itemId 指向不存在的 item。
- `item_protected_by_pending_proposal`：compaction patch 的 itemIds 与该 target 的 pending proposal 引用的 itemId 集合相交（见 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md) §2）。
- `capacity_exceeded`：仅用于不可 compaction 的 `scene`；该字段 patch 会令 scene values 的语义文本超过集中配置的 `maxRenderedChars`，因此拒绝且不创建 maintenance task。
`item_id` 列：对单 item 操作（`updateItem`/`forgetItem`/`completeTodo`/`cancelTodo`/`expireTodo`）存目标 item id；对 `mergeItems` 存 null（source item IDs 由 `merged_from_item_ids` 列存储）；对 `addItem`/`setField`/`clearField`/`noop` 存 null。完整信息在 `patch_summary` JSONB 中。`merged_from_item_ids` 列：仅 `mergeItems` event 使用，存储持久化 patch 中的稳定顺序 source item ID 数组；其他 event 为 null。

### 9.3 Durable task

```sql
CREATE TABLE chat_memory_tasks (
  task_id                    UUID PRIMARY KEY,
  dedupe_key                 TEXT NOT NULL,
  user_id                    BIGINT NOT NULL,
  preset_id                  TEXT NOT NULL,
  target_key                 TEXT NOT NULL,
  source_generation          BIGINT NOT NULL,
  task_type                  TEXT NOT NULL,     -- normal | maintenance | system_cleanup
  parent_task_id             UUID,              -- maintenance task 指向来源 normal task（如有）
  predecessor_task_id        UUID,              -- successor task 指向被取消的旧 task（如有，见规则 8）
  resume_epoch               INTEGER NOT NULL DEFAULT 0,  -- maintenance task 的 resume 轮次；normal/system_cleanup 固定 0，每次人工 resume 创建新 child 时 +1（见规则 9）
  status                     TEXT NOT NULL,     -- queued | running | retry_wait | succeeded | failed | cancelled
  stage                      TEXT NOT NULL,
  cursor_before              BIGINT,
  target_message_id          BIGINT,
  base_revision              BIGINT NOT NULL,
  task_payload               JSONB NOT NULL,    -- immutable proposal-time input/evidence metadata（创建后不可变）
  stage_payload              JSONB,             -- 当前阶段运行数据：normalContextWindow、persistedProposal、expandedEnvelope、maintenanceTaskId、identities、compaction 进度等；可变
  attempt                    INTEGER NOT NULL DEFAULT 0,
  context_expansion_attempt  INTEGER NOT NULL DEFAULT 0,
  not_before                 TIMESTAMPTZ,
  last_error_reason          TEXT,
  result_revision            BIGINT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_tasks_recovery
  ON chat_memory_tasks(status, not_before, updated_at);

CREATE UNIQUE INDEX idx_memory_tasks_scope_dedupe
  ON chat_memory_tasks(user_id, preset_id, dedupe_key);
```

Task 行是运行阶段、attempt、notBefore 和 proposal/window 局部恢复状态的 authority；进程内队列或计数器不是 authority。字段之间的顺序敏感约束、stage 状态机、dedupe key、successor、resume epoch、cursor 与 crash recovery 见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md)；capacity-blocked 的 stage payload、maintenance child 和 replay 见 [Compaction 与 Proposal Replay 算法](algorithms/compaction-and-replay.md)。

### 9.4 Per-target status

```sql
CREATE TABLE chat_memory_target_status (
  user_id             BIGINT NOT NULL,
  preset_id           TEXT NOT NULL,
  target_key          TEXT NOT NULL,
  source_generation   BIGINT NOT NULL,
  rebuild_boundary_message_id BIGINT,
  status              TEXT NOT NULL,     -- healthy | retry_wait | capacity_blocked | halted | rebuilding
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  last_error_reason   TEXT,
  last_task_id        UUID,
  next_retry_at       TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, target_key)
);
```

Recovery 字段归属固定为：

| 旧语义 | 新 authority |
| --- | --- |
| `consecutiveErrors` | per-target status |
| `awaitingContextExpansion` | durable task 的 `context_expansion_attempt` + `stage_payload.expandedEnvelope` |
| `lastErrorReason` / halt 原因 | per-target status + ops log |
| `lastErrorTickId` | ops log 的 taskId/attempt；target status 保存 `last_task_id` |
| retry attempt / notBefore | durable task |
| 完整错误历史 | ops log |

每个 target 独立维护 status；不存在 `memory_state.meta.halted` 或 user/preset 全局 halt。某 target halted 不修改其它 target 的 status/cursor，也不删除其最后一次稳定 state。`capacity_blocked` 表示 normal task 处于 `capacity_blocked` 或 `replaying_original_proposal` 阶段，或 maintenance task 处于 `compacting`/退避等待阶段；Observer 不为 `capacity_blocked` target 创建新 normal task。maintenance child 因 Provider 可重试错误进入 `retry_wait` 时，child task 的 `not_before` 仍是细粒度重试 authority，但 target 必须保持 `capacity_blocked`，不能退化为普通 `retry_wait`；parent/replay 在 child 到期并成功前不得继续。容量/compaction/replay 导致的 halted 在 resume 时变为 `capacity_blocked`；`output_schema_invalid` 或 Provider 重试/连续失败达到阈值导致的 halted，在根因排除后仍保持 `halted` 并创建新的 normal task。所有分支都只有恢复 task 成功、cursor 推进并提交 snapshot 后才恢复 `healthy`，旧 task 保留审计。恢复算法见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) §5；用户侧映射与 Renderer 告警见 [write-protocol.md](write-protocol.md) §8.1。

`source_generation` 必须等于该 row 所属 state 的当前 generation。Source rebuild 开始时，六个 target 在 raw-source mutation 同一事务进入 `rebuilding`，保存同一个 captured `rebuild_boundary_message_id` 并清除旧 task/error 状态；任一 target 未 force-drain 到该边界前不得恢复 `healthy`。因此“Memory dirty”是由当前 generation 下仍存在 `rebuilding` target 确定性派生的运行状态，不再增加第二个全局 dirty flag。

创建 v2 state 时必须为六个 normal target 各初始化一行 `healthy / consecutive_errors=0`。task 进入 retry_wait 时 task.not_before 与 target.next_retry_at 必须表达同一重试边界；当前 task 是细粒度 authority，target row 是调度/健康汇总，二者在同一事务更新。

### 9.5 Ops log

```sql
CREATE TABLE chat_memory_ops_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  task_id         UUID NOT NULL,
  tick_id         BIGINT,
  target_key      TEXT NOT NULL,
  section         TEXT,
  proposer        TEXT,
  outcome         TEXT NOT NULL,           -- llm_call_failed | safety_policy_blocked | max_output_truncated | output_schema_invalid_retry | output_schema_invalid | unable_to_decide | unable_to_compact | stale_result | reducer_failed | transaction_failed | commit_outcome_unknown
  attempt         INTEGER NOT NULL,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_ops_log_health
  ON chat_memory_ops_log(user_id, preset_id, target_key, created_at DESC);

CREATE INDEX idx_memory_ops_log_outcome
  ON chat_memory_ops_log(user_id, preset_id, outcome, created_at DESC);
```

`target_key` 和 `task_id` 是 ops log 的必填归属。`section` 只在 outcome 能明确归属某个正式 section 时填写；task 级 outcome 填 `NULL`，禁止用 targetKey 代填。ops log 保存完整错误历史但不单独决定当前 status；当前运行状态以 task/target status 为准。

通用 outcome 至少包括：

- `llm_call_failed`、`safety_policy_blocked`、`max_output_truncated`、`output_schema_invalid_retry`、`output_schema_invalid`：Provider/schema 失败。`max_output_truncated`（Provider 明确因 max tokens/output length 停止）与 schema invalid 分开统计，即使残片可解析也不作为完整 proposal。前三者按退避策略可重试；`output_schema_invalid_retry` 表示首次 Provider 输出边界失败获得的唯一即时重试，最终 `output_schema_invalid` 表示输入边界错误或输出重试耗尽；
- `unable_to_decide`：Proposer 自认信息不足，扩窗口 attempt 属于 task；
- `unable_to_compact`：compactionProposer 判定无安全合并空间，对应 maintenance task/target 进入失败或 halt；
- `stale_result`：revision/cursor/generation 校验失败后丢弃旧执行结果；
- `reducer_failed`：Reducer 执行过程中发生纯代码异常（非业务拒绝），如内存错误、数据结构不兼容等；不增加 revision/snapshot；
- `transaction_failed`：数据库事务在 COMMIT 前明确失败且已确认回滚（非业务逻辑拒绝），如死锁、序列化异常或事务执行阶段连接断开；必须在回滚后按 task phase identity 重新校验状态；
- `commit_outcome_unknown`：数据库连接在 COMMIT 发送后断开，无法确认提交结果。worker 必须先按 event group 的 phase identity 查询是否已持久化（`result_revision` 是否存在），不能直接重试写入；若已提交则返回既有结果，未提交则在当前最新 revision 基础上重试。

后续批次可增加专用 outcome，但不得复用这些值表达不同语义。

### 9.6 原子提交与 Crash Recovery

Revision 事务、generation 初始化事务、无 revision 事务、phase identity、COMMIT 结果不确定与运行恢复的完整规范见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) §7–§8；source generation 变化与 rebuild/force-drain 见 [Source Rebuild 与 Projection 算法](algorithms/source-rebuild-and-projection.md)。本节的 DDL 字段必须按这些算法共同提交，不得把 snapshot 当成运行状态 authority。

调试信息只记录结构化元数据（taskId、targetKey、reason、attempt、reject_reason 等），用 `logger` 输出到应用日志，不进表。禁止将完整 raw prompt、完整 state diff 或完整 message content 写入 append-only 应用日志，因为这些日志无法按用户或消息精确删除，与 [Suppression 与 Retention 算法](algorithms/suppression-and-retention.md) 的 privacy hard delete 要求冲突。如需持久化完整调试 payload 用于离线分析，必须使用可按 `(user_id, preset_id)` 索引和删除的受控 debug 存储表，并在 privacy hard delete 时一并清除。

### 9.7 RAG Projection Checkpoint

RAG 是持久化派生 projection；Recall/Scene Recall 是查询时 enrichment，继承 RAG cutoff，不建立独立 checkpoint。不得从 Memory target cursor 推定 RAG 处理进度：

```sql
CREATE TABLE chat_context_projection_checkpoints (
  user_id                      BIGINT NOT NULL,
  preset_id                    TEXT NOT NULL,
  projection_key               TEXT NOT NULL,  -- rag
  processed_generation         BIGINT NOT NULL,
  processed_boundary_message_id BIGINT,
  processed_tombstone_id       BIGINT NOT NULL DEFAULT 0,
  status                       TEXT NOT NULL,  -- healthy | degraded | rebuilding
  last_error_reason            TEXT,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, projection_key)
);
```

`processed_generation` 必须与 `memory_state.meta.sourceGeneration` 比较。`processed_tombstone_id` 独立记录该 projection 已物理消费的 suppression tombstone 水位：即使 generation 与 raw-source boundary 均未变化，只要存在更大的 tombstone id，worker 仍必须执行派生数据失效/删除并在同一事务推进该水位。查询末端 tombstone gate 始终是 correctness 保证，物理清理只用于收敛残留。完整 drain、generation 重校与 checkpoint 推进见 [Source Rebuild 与 Projection 算法](algorithms/source-rebuild-and-projection.md)。

### 9.8 Context-suppression tombstone

Forget/correction 的 source suppression tombstone 是独立于 `memory_state`、跨 `sourceGeneration` 保留的 durable sidecar（语义见 [Suppression 与 Retention 算法](algorithms/suppression-and-retention.md)）：

```sql
CREATE TABLE chat_context_suppression_tombstones (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  message_id      BIGINT NOT NULL,
  content_hash    TEXT NOT NULL,
  reason          TEXT NOT NULL,           -- forget | correction
  source_item_id  TEXT,
  source_section  TEXT,
  created_revision BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, message_id, content_hash)
);

CREATE INDEX idx_suppression_tombstones_lookup
  ON chat_context_suppression_tombstones(user_id, preset_id, message_id);
```

同一 `(user_id, preset_id, message_id, content_hash)` 重复写入必须幂等（`UNIQUE` 约束保证）。Tombstone 不修改 raw chat message，也不删除历史 event/snapshot；它只作为 RAG/Recall 查询末端和 rebuild 候选过滤的 correctness gate。Privacy hard delete 时，tombstone 本身也必须物理清除。

### 9.9 Context-quality diagnostics

GapBridge omitted、projection lag、scene capacity rejection 等 context 质量诊断是独立于 `memory_state`、semantic event 和 Memory ops log 的持久化 sidecar（语义见 [Context Coverage 算法](algorithms/context-coverage.md)和[异常诊断投影](algorithms/diagnostic-projection.md)）：

```sql
CREATE TABLE chat_context_quality_diagnostics (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,           -- target | projection | system
  subject_key     TEXT NOT NULL,           -- targetKey、projectionKey，或 system 诊断键
  diagnostic_type TEXT NOT NULL,           -- gap_bridge_omitted | projection_lag | scene_capacity_exceeded | state_* | ...
  source_generation BIGINT,
  request_id      TEXT,
  target_cursor   BIGINT,                  -- target cursor/boundary（gap_bridge_omitted、scene_capacity_exceeded 使用）
  processed_boundary_message_id BIGINT,    -- projection 的 processedBoundary（仅 projection_lag 使用）
  omitted_upper_message_id BIGINT,         -- GapBridge 的省略上界 messageId，用于确定 resolved 条件
  recent_window_start BIGINT,              -- 当时的 recent window 起点 messageId
  original_gap_count INTEGER,
  original_gap_chars INTEGER,
  retained_boundary BIGINT,
  retained_count  INTEGER,
  omitted_count   INTEGER,
  omitted_chars   INTEGER,
  truncated       BOOLEAN NOT NULL DEFAULT FALSE,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb, -- 诊断类型专用的结构化开发/运维信息
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_context_diagnostics_active
  ON chat_context_quality_diagnostics(user_id, preset_id, subject_kind, subject_key, resolved, created_at DESC);

CREATE UNIQUE INDEX idx_context_diagnostics_one_active
  ON chat_context_quality_diagnostics(user_id, preset_id, subject_kind, subject_key, diagnostic_type)
  WHERE resolved = FALSE;
```

字段说明：

- `subject_kind` / `subject_key`：标识本诊断归属的主体。`target` + targetKey（如 `todos`）用于 GapBridge omitted、scene capacity 等 per-target 诊断；`projection + rag` 用于 projection lag；Recall 继承该健康状态；`system + memory_state` 用于无法归属具体 target/projection 的 authority-state 诊断。
- `source_generation`：记录创建/最近更新该诊断时的 source generation。可在 state 尚不存在时为 `NULL`；generation 初始化后，旧的非空 generation active 诊断必须直接 resolve，且不得为这种失效诊断创建“已恢复”通知。
- `omitted_upper_message_id`：GapBridge 省略的上界 messageId（即 last omitted messageId）。resolved 条件是 `target_cursor >= omitted_upper_message_id`，而非依赖 `recent_window_start - 1` 间接推导。
- `omitted_upper_message_id` 和 gap 统计字段仅用于 `diagnostic_type = gap_bridge_omitted`；`target_cursor` 还被 `scene_capacity_exceeded` 用来记录最近处理 event group 的 `cursor_after`。`processed_boundary_message_id` 仅用于 `projection_lag`。GapBridge/projection 诊断保存 `recent_window_start`，projection 以它计算本次 `requiredBoundary`。
- `diagnostic_type = scene_capacity_exceeded` 表示最近有一个或多个 scene 字段 patch 因长度预算被拒绝；`detail.rejectedPaths` 保存仍待成功写入的字段，`detail.sourceEventGroupId/sourceGeneration/sourceRevision` 保存最近来源。它由[异常诊断投影](algorithms/diagnostic-projection.md)从已提交 event 派生，不由 Reducer 或 capacity maintenance 事务直接写入。

同一 `(user_id, preset_id, subject_kind, subject_key, diagnostic_type)` 最多存在一条 active 记录，写入必须使用数据库唯一约束支持的原子 upsert。诊断记录保持 active（`resolved=FALSE`），直到满足对应类型的明确 resolved 条件：GapBridge omitted 由 cursor 覆盖其省略上界，或在锁定当前 generation/state 后查询原省略 source 区间为空来证明缺口已消失；不得仅因一次历史 `upToMessageId` 查询返回空而清除。projection lag 由本次 required boundary 已覆盖证明；`scene_capacity_exceeded` 仅在 `detail.rejectedPaths` 中每个字段都出现后续 accepted scene patch 后恢复；authority-state 诊断仅在合法 state 恢复后清除。不能只因请求结束而清除。

异常投影拥有独立持久化 checkpoint：

```sql
CREATE TABLE chat_memory_diagnostic_projection_checkpoints (
  user_id           BIGINT NOT NULL,
  preset_id         TEXT NOT NULL,
  projection_key    TEXT NOT NULL,          -- scene_capacity_diagnostics
  processed_event_id BIGINT NOT NULL DEFAULT 0,
  last_error_reason TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, projection_key)
);
```

成功投影时，checkpoint 推进、diagnostic 更新/恢复和 recovery notification 必须在同一投影事务中提交。投影失败不得影响已提交的 Memory task，且不得推进 `processed_event_id`；失败原因用独立 best-effort 事务写入 `last_error_reason`。runtime poll、启动 reconciliation 和 context assembly 均可按 checkpoint 幂等重试。

### 9.10 Recovery notification

恢复通知记录"Memory 已追平到相应 boundary"的 delivery 状态，提供 best-effort once 通知语义（语义见 [write-protocol.md](write-protocol.md) §8.1 规则 3）：

```sql
CREATE TABLE chat_memory_recovery_notifications (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,           -- target | projection | system
  subject_key     TEXT NOT NULL,           -- targetKey、projectionKey，或 system 诊断键
  notification_type TEXT NOT NULL,         -- recovered
  boundary_message_id BIGINT NOT NULL DEFAULT 0,  -- 0 表示无具体 boundary（如全量恢复）
  source_generation BIGINT NOT NULL,
  delivered       BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, preset_id, subject_kind, subject_key, notification_type, source_generation, boundary_message_id)
);

CREATE INDEX idx_recovery_notifications_pending
  ON chat_memory_recovery_notifications(user_id, preset_id, delivered, created_at DESC);
```

`boundary_message_id` 使用 `NOT NULL DEFAULT 0` 而非 nullable，确保 PostgreSQL `UNIQUE` 约束对无具体 boundary 的通知也能正确去重（PostgreSQL 中多个 NULL 不被视为相等）。

恢复事务提交时同事务写入 notification 行（`delivered=FALSE`）。context compiler 在下次响应中读取未投递 notification 并把 notification ID/文案放入响应 payload；响应传输成功后，由响应层 best-effort 将对应行更新为 `delivered=TRUE, delivered_at=NOW()`。数据库事务不跨越网络响应边界。

`subject_kind/subject_key` 与健康来源一致：Memory target 使用 `target + targetKey`，RAG 及其查询时 Recall 使用 `projection + rag`，无法归属前两者的全局恢复使用 `system + <diagnosticKey>`。通知语义为 **best-effort once**：系统保证同一恢复事件只创建一行 notification（`UNIQUE` 约束）；存在下一次成功响应时至少尝试投递一次。不保证恰好一次 delivery——并发响应可能同时读到未投递行，或响应已成功但 `delivered` 更新前进程崩溃，因而允许重复投递。这是当前为降低复杂度明确接受的语义；如需恰好一次，需要另行引入客户端 ACK/幂等消费。Privacy hard delete 时 notification 行也必须清除。

### 9.11 Privacy operation

```sql
CREATE TABLE chat_memory_privacy_operations (
  user_id             BIGINT NOT NULL,
  preset_id           TEXT NOT NULL,
  operation_id        UUID NOT NULL,
  operation_mode      TEXT NOT NULL, -- rebuild | delete_scope | reset_authority
  source_generation   BIGINT,
  boundary_message_id BIGINT,
  status              TEXT NOT NULL, -- purging | verified | draining | completed
  last_error_reason   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id)
);
```

该表不引用 preset 外键，使整个 preset 被物理删除后仍可恢复外部 store 的 purge verification。详细状态机见 [Suppression、Hard Delete 与 Retention](algorithms/suppression-and-retention.md) §5。

### 9.12 Retention 不变量

Snapshot/event/task/ops log 的 anchor 提升、连续 replay 链和可清理条件见 [Suppression 与 Retention 算法](algorithms/suppression-and-retention.md) §6。DDL 与外键/引用策略必须保证该算法不会删除仍被 active task 或 retained event group 依赖的数据。

## 10. Provider Adapter 契约

Proposer 的 LLM 调用必须经由 Memory 专用的归一化 Provider Adapter 层，而非复用裸文本解析路径或在 tick orchestrator 里直接调 provider SDK。配置以显式 adapter ID 选择协议实现；Adapter 必须使用 provider 原生 JSON schema、tool 或 function structured-output 能力，并在返回后再做本地 schema 校验。未知 adapter 在配置加载时拒绝；已知 adapter 对具体 Provider/model 的真实能力由完整 schema preflight 验证，不能由布尔环境变量自行宣称。Adapter 把不同 provider 的响应与错误映射为统一结果，使上层无需关心 `finish_reason` 取值差异。

DeepSeek 首版使用 `deepseek-strict-tools`：端点必须为官方 `/beta` strict tool calling，指定 `strict=true` 并强制调用唯一输出 tool；schema compiler 将业务 schema 转换为 Provider 支持的子集。DeepSeek 传输 schema 中，`const` 转换为带显式 primitive `type` 的单值 `enum`，原本只有 `enum` 的节点也必须补出同质 primitive `type`；混合类型 enum 不得猜测转换。`anyOf` 的每个直接分支必须有 `type` 或 `$ref`，由可选 object 展开或业务 union 产生的纯嵌套 `anyOf` 必须展平。上述规则只约束 Provider 传输方言，不改变 §5.5 的业务 schema；未由 Provider 强制的长度、数组等约束仍由本地完整契约校验。高频 Memory 调用通过独立 Provider 配置显式发送 `thinking.type=disabled`；不得继承主聊天的 thinking 设置。OpenAI-compatible 原生 JSON Schema 端点使用独立的 `openai-json-schema` adapter。

Adapter 输入：Proposer prompt（system + user）+ 输出 schema（§5.5）。Adapter 输出：

```js
// 成功
{ status: "ok", output: { /* §5.5 的 Proposer 输出结构 */ } }

// 失败
{ status: "error", reason: "llm_call_failed" | "safety_policy_blocked" | "max_output_truncated" | "output_schema_invalid", detail: { /* finish_reason / 错误消息 / 原始响应片段 */ } }
```

识别规则：

- `safety_policy_blocked`：provider 返回 `finish_reason`/`stop_reason` 含 `content_filter`，或返回 refusal 标记，或输入被 provider 拒绝。此错误必须显式记录，不得伪装成 noop 或静默跳过（见 [write-protocol.md](write-protocol.md) §6）。
- `max_output_truncated`：provider 明确因 max tokens/max output length 停止，或响应元数据表明 structured payload 被输出上限截断。即使残片碰巧能被解析，也不得作为完整 proposal 交给 Reducer；该原因必须与一般 schema invalid 分开统计。
- `output_schema_invalid`：输入 envelope 不符合契约，或 provider 返回了内容但 adapter/tick orchestrator 无法验证为 §5.5 schema。命名上与 events 表的 `schema_invalid`（Reducer 校验 patch 字段结构）区分：本码发生在 patch 产生之前。输入边界错误立即 halt；输出边界错误最多获得一次持久化即时重试，首次记录为 `output_schema_invalid_retry`，耗尽后才记录最终错误并 halt。
- `llm_call_failed`：网络异常、超时、provider 5xx、其它未归类异常。

Provider/model 的物理 context window、最大输出和 schema/tool 限制由 Adapter 在请求前校验并按上述统一结果处理；这些上限不得折算、复用或写回为 §8 的 Memory section `maxItems/maxRenderedChars` 容量规则。

Provider wire schema 可以为适配已知方言限制而使用可逆的、更窄表示，但必须在业务 schema 校验前归一化，且不得放宽 §5.5。例如 DeepSeek strict tools 不支持数组 cardinality 约束时，scene patch 在 wire 上使用单个 `evidenceRef` 对象，Adapter 立即归一化为 canonical `evidenceRefs: [ref]`；Reducer、durable proposal 和 event 中只允许 canonical 结构。此转换必须由完整 Provider preflight 覆盖。

启用 Memory runtime 时，完整 Provider preflight 是服务监听前的启动门；仅运行独立 probe CLI 不构成启服条件。preflight 成功结果只对当前进程、adapter/model/schema 组合有效。运行请求还必须在传输前检查集中配置的输入能力上限，并显式发送集中配置的最大输出上限；DeepSeek Memory 调用的 `thinking.type` 固定为 `disabled`。

tick orchestrator 行为：

- `status: "ok"` → tick orchestrator 校验 `output.proposer === task.proposer` 且 `output.tickId === task.tickId`，再校验 `sectionResults` 完整覆盖 target sections。不匹配或结构残缺时，不交 Reducer；同事务写 ops log、将 task 置为 failed，并把对应 target status 置为 halted。`unable_to_decide` 写 ops log 并更新 task 的 `context_expansion_attempt`；compactionProposer 返回 `unable_to_compact` 时更新 task/target status。只有 `patches`/`noop` 交 Reducer。
- `status: "error"` → 不交给 Reducer；按 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md) §5 在同一运行状态事务更新 durable task、per-target status 与 ops log，决定 retry_wait 或 halted，不增加 Memory revision/snapshot。

Reducer 永远只处理 `status: "ok"` 且 section 状态为 `patches`/`noop` 的输出，不会看到空输出、伪造输出、`unable_to_decide` 或残缺 `sectionResults`。adapter 在 `status: "error"` 时由 tick orchestrator 直接处理，不把错误结果传给 Reducer。
