# Memory Control v2 状态契约

本文是 Memory Control v2 的**静态契约权威来源**：所有数据 shape、枚举、查表、校验算法和存储落点都在这里定义一次。写入流程见 [write-protocol.md](write-protocol.md)，顶层判断见 [../memory-control-v2-overview.md](../memory-control-v2-overview.md)。

跨文档惯例：本文已定义的契约，其他文档只引用章节号，不重述。

## 1. 权威状态与存储落点

PostgreSQL 中的结构化 `memory_state` 是新系统唯一的当前 Memory authority，保存当前完整 memory state，由 Reducer 原子写回。旧 `rolling_summary` 和 `core_memory` 不转换为新系统 authority，也不与新 Memory 同时注入。最终迁移时停止旧 worker/注入并物理删除旧 Memory 数据；新系统从 raw messages 重建。

user/preset 下的对话跨 session 语义连续。session 只是按天或 UI 划分的存储单元，不是 Memory 或 scene 的语义边界。sessionId 只保留在消息中，不复制到 evidence、event 或 Recall provenance；这些结构通过 messageId / source messageIds 追溯来源。

在现有 `chat_preset_memory` 表新增一列：

- `memory_state JSONB`：完整权威 memory state。

Renderer 输出不作为独立权威列落库。主聊天热路径读取 `memory_state` 后实时调用纯代码 Renderer 生成上下文文本。

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
    halted: false,             // 该 userId/presetId 的 halt flag，true 时该会话的聊天接口拒绝新消息，见 §9.2
    targetCursors: {},         // { targetKey: coveredUntilMessageId }，targetKey 见 §2，联合处理的 section 共享一个 cursor
    recovery: {}               // { targetKey: { consecutiveErrors, awaitingContextExpansion, lastErrorReason, lastErrorTickId } }，见 §9.2
  }
}
```

每个可追踪 item 结构：

```js
{
  id: "todo:uuid-xxx",          // Reducer 生成，全局唯一
  text: "归还橡皮",              // 高密度关键词式描述
  evidenceGroups: [
    {
      evidenceKind: "user_request",
      refs: [{ messageId: 121, quote: "明天提醒我把橡皮还给她" }]
    }
  ],
  createdAtMessageId: 121,
  updatedAtMessageId: 121,
  status: "active",             // 仅 todo：active | overdue；到期时 Reducer 原位更新
  becameOverdueAt: null,        // 仅 todo：首次进入 overdue 的时间
  expiresAtTime: null           // 可选，ISO 8601 timestamp。短期待办用。由 Reducer 从 patch value 的 expiresAt 结构化表达式计算（见 §4），不由 LLM 直接输出时间戳
}
```

`evidenceGroups` 是权威 state 中 item 的证据结构。每个 group 携带自己的 `evidenceKind` + `refs`，是一个可审计、可 recall 的证据单元；group 内多个 ref 共同支撑该单元。普通非 `mergeItems` patch 输出 `evidenceRefs`，Reducer 校验通过后将该数组连同 `patch.evidenceKind` 包装成一个新的 `evidenceGroup`追加到 item。`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`，Reducer 从 source items 继承 `evidenceGroups`，各 group 保留各自 evidenceKind。

item 派生字段由 Reducer 在 apply 时维护：`createdAtMessageId` 取首个写入 group 的最小 messageId（addItem 设定，updateItem 不改；mergeItems 取 source items 中最早的 `createdAtMessageId`）；`updatedAtMessageId` 取全部 `evidenceGroups.refs.messageId` 的最大值。

`scene` 是当前状态，每个字段独立记录值、证据与更新时间。正式 section 共九个：`scene`、`todos`、`standingAgreements`、`recentEpisodes`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`。`previousScene` 和 todo 的 `status=overdue` 是 Reducer 维护的衍生状态，不进入 Proposer `sectionResults`，不拥有 target 或 cursor。

`current`、`working`、`longTerm` 和 `meta` 只是 `memory_state` 的物理存储容器名，不是正式 section 或 target。它们不得作为 patch/event/policy 的 `section`、`task.targetKey` 或 `sectionResults` key；其中的正式 section 始终使用上述九个逻辑名称直接寻址。

`current.previousScene` 为 `null` 或“与 `current.scene` 相同的四个字段快照 + `expiredAt`”对象；字段级 value/evidenceRef/updatedAtMessageId 原样保留。它只能由 Reducer 的 scene TTL lifecycle 写入。`scene_expired` / `expired_scene_evicted` cleanup event 的 `section` 仍记为 `scene`。

Todo `addItem` 时由 Reducer 强制初始化 `status="active"`、`becameOverdueAt=null`；Proposer 不得输出或修改这两个字段。到期后 Reducer 原位改为 overdue。`completeTodo`/`cancelTodo` 可作用于 active 或 overdue item；容量维护与 `mergeItems` 只处理 active todo，不合并 overdue todo。

以下语义不可改变：

- `current.scene` 与 session 完全解耦。
- scene 到期时 Reducer 将完整旧值写入 `current.previousScene`；它不是正式 section，后续新到期场景直接替换旧值并记录 cleanup event。
- todo 到期时留在 `working.todos`，Reducer 将其 `status` 从 `active` 改为 `overdue` 并设置 `becameOverdueAt`；不跨数组迁移。
- `recentEpisodes` 与 `milestones` 联合处理但分别存储。
- `userProfile` 与 `assistantProfile` 都允许 User 和 Assistant 双方全权 add/update/forget。
- `worldFacts` 与 `relationship` 同样允许双方 add/update/forget。
- evidence role 按数据库真实消息校验，但不用 role 限制 User/Assistant 对两个 Profile 的操作权。

add/update 的具体 policy 见 §6；forget 的 tombstone/suppression 语义由后续修订落地。

## 2. 记忆分层

| Section              | 存储位置                        | 作用                             | 生命周期       | 写入原则                                                                       |
| -------------------- | ------------------------------- | -------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `scene`              | `current.scene`                 | 当前地点、时间、氛围、环境锚点   | 高频、覆盖式   | 字段级覆盖；字段级证据                                                         |
| `todos`              | `working.todos`                 | 明确待完成事项；含 active/overdue 状态 | 中频、事件型 | 完成或取消后移除；到期时 Reducer 原位标记 `status=overdue`，仍可 complete/cancel |
| `standingAgreements` | `working.standingAgreements`    | 持续互动约定、相处规则、长期承诺 | 中低频、事件型 | 新增、修订、取消；不使用完成语义                                               |
| `recentEpisodes`     | `working.recentEpisodes`        | 最近几次有意义互动               | 高频、滑动窗口 | 普通 episode 到期自然滚出；重要 episode 可晋升 milestone                       |
| `milestones`         | `longTerm.milestones`           | 关系或剧情关键转折               | 低频、归档型   | 长期保存，默认新增或合并；普通日常不得进入                                     |
| `worldFacts`         | `longTerm.worldFacts`           | 世界设定与持续客观事实           | 低频、保守     | 新增只接受 `long_term_fact`；修订接受双方 correction                           |
| `userProfile`        | `longTerm.userProfile`          | 用户长期档案与稳定特征           | 低频、保守     | 新增只接受 `long_term_fact`；修订接受双方 correction                           |
| `assistantProfile`   | `longTerm.assistantProfile`     | Assistant 长期档案与稳定特征     | 低频、保守     | 新增只接受 `long_term_fact`；修订接受双方 correction                           |
| `relationship`       | `longTerm.relationship`         | 持续关系模式与关系事实           | 低频、保守     | 新增只接受 `long_term_fact`；修订接受双方 correction                           |

每个 target 拥有独立 `coveredUntilMessageId`（存于 `meta.targetCursors`）。一个 Proposer 联合处理的多个 section 共享一个 target cursor，禁止"共享 Proposer + 独立 section cursor"。target 之间 cursor 独立推进，互不阻塞；所有写入（普通 task 与 compaction task）共用同一 `userId/presetId` 串行队列，保证 `memory_state` 单行写回无竞争。一个 target 被 `deferred` 不阻塞同 tick 内其它 eligible target 的处理与 cursor 推进，仅该 target 自身等待 compaction 释放容量后重跑。Compaction task 不拥有独立 raw-message cursor；它是被 capacity-blocked normal task 派生出的维护任务。

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
| `profileRelationshipProposer`  | `long_term_fact`, `user_correction`, `assistant_correction`                                                                                                                    |
| `worldFactProposer`            | `long_term_fact`, `user_correction`, `assistant_correction`                                                                                                                    |
| `compactionProposer`           | `memory_compaction`                                                                                                                                                            |

## 4. Patch Op 合法值与约束

下表同时服务两个视角：Reducer 按 op 校验字段结构，schema/prompt 作者按 Proposer 查合法 op。Reducer 的 section+op 合法性最终查 §6 policy table。

| op                | 含义                       | 适用 Proposer                                                                                |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `setField`        | 设置覆盖式状态字段         | `currentStateProposer`                                                                       |
| `clearField`      | 清除已失效的覆盖式状态字段 | `currentStateProposer`                                                                       |
| `addItem`         | 新增 item                  | `todoProposer`, `agreementProposer`, `episodeProposer`, `profileRelationshipProposer`, `worldFactProposer`                       |
| `updateItem`      | 局部更新已有 item          | `todoProposer`, `agreementProposer`, `episodeProposer`, `profileRelationshipProposer`, `worldFactProposer`                       |
| `mergeItems`      | 合并重复或高度重叠 item    | `todoProposer`, `agreementProposer`, `episodeProposer`, `profileRelationshipProposer`, `worldFactProposer`, `compactionProposer` |
| `completeTodo`    | 将待办完成并从数组移除     | `todoProposer`                                                                               |
| `cancelTodo`      | 将待办取消并从数组移除     | `todoProposer`                                                                               |
| `expireTodo`      | 将短期待办失效并从数组移除 | `todoProposer`                                                                               |
| `cancelAgreement` | 将持续约定取消并从数组移除 | `agreementProposer`                                                                          |

字段必填规则：

- `path`：只对 `scene.setField`/`scene.clearField` 必填，值为 `location`/`time`/`mood`/`note`。所有 item section（`todos`、`standingAgreements`、`recentEpisodes`、`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`）都由 `sectionResults` 的 section key 直接寻址，不使用 `path`。
- `itemId`：对 `updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`cancelAgreement` 必填（单个 item 的 id）。
- `itemIds`（数组）：对 `mergeItems` 必填，指定要合并的多个 itemId，数组长度 ≥ 2。`value` 是合并后的新 item 值，至少包含 `text`。merged item 的 `evidenceGroups` 由 Reducer 从 source items 自动继承，保留 group 边界。
- `value`：对 `setField`/`addItem`/`updateItem` 必填。`addItem`/`updateItem` 的 `value` 是一个对象，至少包含 `text`。`todos` 的 `addItem`/`updateItem` 的 `value` 可选包含 `expiresAt` 结构化表达式，由 Reducer 计算为 `expiresAtTime`：
  - `{ "mode": "absolute", "date": "YYYY-MM-DD" }`：绝对日期。Reducer 计算 `date + 1天`（buffer，活动当天仍活跃）为 `expiresAtTime`。`date` 在过去则 reject（reason: `invalid_expiry_in_past`）。
  - `{ "mode": "relative", "days": N }` / `{ "months": N }` / `{ "years": N }`：相对时长，字段可组合。`days`/`months`/`years` 至少出现一个，否则 `rejected: schema_invalid`。多字段组合时计算顺序为 `years → months → days → +1天 buffer`。Reducer 从 `task.now` 计算 `now + 时长 + 1天`（buffer）为 `expiresAtTime`。计算结果在过去则 reject（reason: `invalid_expiry_in_past`）。
  - 缺省：无过期。
  - LLM 只提取语义（"两周后"→`{ "days": 14 }`、"十号"→`{ "mode": "absolute", "date": "2026-07-10" }`），不做日期算术。Reducer 负责计算和格式化。
- `evidenceRefs`：除 `mergeItems` 外，Proposer patch 至少包含一个 `{ messageId, quote }`。Reducer 自行触发的 todo/scene lifecycle 变化不是 Proposer patch，使用 system cleanup event。普通写入 patch 的 `evidenceRefs` 必须来自 Proposer envelope 的 `observedMessages`（见 §5）。对会写入 item 的普通 patch，Reducer 将该数组连同 `patch.evidenceKind` 包装成一个新的 `evidenceGroup`。
- `scene.setField`/`scene.clearField` 的 `evidenceRefs` 必须恰好 1 条。Reducer 将其写入目标字段的 `evidenceRef`。
- `quote`：必须是能够支持 patch 的最短连续原文片段，最多 200 个 Unicode code points；Reducer 不自动裁剪，完整校验见 §7。
- `evidenceKind: "memory_compaction"` 只允许用于 `mergeItems`。Proposer 不输出 `evidenceRefs`；Reducer 根据 `itemIds` 从权威 state 读取 source items 的既有 `evidenceGroups` 并写入 merged item。

## 5. Proposer 输入/输出信封

Proposer 输入使用统一 envelope，区分三类信息：**writable target**（本次允许写入的 sections）、**read-only memory context**（帮助理解对话背景的只读 memory 片段）、**observed messages**（普通模式下 LLM 可见的原始消息观察窗口）。`task.mode` 是判别字段，决定 `trigger`、`writableState`、`readOnlyContext` 和 `observedMessages` 的语义。

Proposer 输入中的 state item 使用 redacted view，不包含 `evidenceGroups`。redacted view 分两级：

- **writableState item**：保留 `id`（Proposer 需要 id 来输出 `updateItem`/`mergeItems`/`completeTodo` 等 patch）：

```js
{
  id: "todo:uuid-xxx",
  text: "归还橡皮",
  createdAtMessageId: 121,
  updatedAtMessageId: 121,
  expiresAtTime: null
}
```

- **readOnlyContext item**：不含 `id`（readOnlyContext 的 section 不是 writable target，Proposer 不应对其输出 patch，去掉 id 从结构上防止误用）：

```js
{
  text: "沉默时先开口说明状态",
  createdAtMessageId: 116,
  updatedAtMessageId: 116,
  expiresAtTime: null
}
```

Proposer 输入中的 `scene` 字段使用 `{ value, updatedAtMessageId }`，不包含字段级 `evidenceRef`。

### 5.1 信封结构（普通模式）

```json
{
  "task": {
    "tickId": 12345,
    "userId": 1,
    "presetId": "default",
    "schemaVersion": 2,
    "targetKey": "episodes",
    "cursorBefore": 118,
    "targetMessageId": 124,
    "proposer": "episodeProposer",
    "mode": "normal",
    "targetSections": ["recentEpisodes", "milestones"],
    "observedMessageIds": [119, 120, 121, 122, 123, 124],
    "trigger": { "type": "lagThreshold" },
    "now": "2026-07-06T22:30:00Z"
  },
  "writableState": {
    "working": {
      "recentEpisodes": [
        {
          "id": "episode:7",
          "text": "雨夜争执 > 和解 | 用户表达不安",
          "createdAtMessageId": 110,
          "updatedAtMessageId": 110,
          "expiresAtTime": null
        }
      ]
    },
    "longTerm": {
      "milestones": [
        {
          "id": "milestone:2",
          "text": "关系转折: 第一次明确互相信任",
          "createdAtMessageId": 80,
          "updatedAtMessageId": 80,
          "expiresAtTime": null
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
          "expiresAtTime": null
        }
      ],
      "standingAgreements": [
        {
          "text": "沉默时先开口说明状态",
          "createdAtMessageId": 116,
          "updatedAtMessageId": 116,
          "expiresAtTime": null
        }
      ]
    },
    "longTerm": {
      "relationship": [
        {
          "text": "关系模式: 慢热 > 安全感确认后更依赖",
          "createdAtMessageId": 50,
          "updatedAtMessageId": 60,
          "expiresAtTime": null
        }
      ],
      "userProfile": [
        {
          "text": "偏好: 不喜欢被连续追问",
          "createdAtMessageId": 45,
          "updatedAtMessageId": 45,
          "expiresAtTime": null
        }
      ],
      "assistantProfile": [
        {
          "text": "人格: 主动给空间",
          "createdAtMessageId": 30,
          "updatedAtMessageId": 30,
          "expiresAtTime": null
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

- `task`：本次 `targetKey`、该 target 的 `cursorBefore`、proposer、mode、target sections、observed message ids、`trigger` 和 `now`（ISO 8601 wall-clock 时间戳，供 Reducer 从 `expiresAt` 相对表达式计算 `expiresAtTime`）。一个 normal task 恰好对应一个 target，因此只有一个 `cursorBefore`、一个 new batch 和一个 `targetMessageId`；`cursorBefore` 必须等于任务创建时 `meta.targetCursors[targetKey]` 的值。
- `writableState`：本次允许写入的目标 sections 当前状态。item 使用 §5 的 writableState redacted view（含 id）；无值字段显式传 null。
- `readOnlyContext`：可读取的背景 memory，用于理解对话，不得作为新事实证据。item 使用 §5 的 readOnlyContext redacted view（不含 id），固定范围见 §5.3。
- `observedMessages`：普通模式下 LLM 可见的原始消息观察窗口，与 `observedMessageIds` 一一对应。每项携带真实 `role`、`createdAt` 和 `contentHash`；`contentHash` 固定为 raw `content` 的 UTF-8 SHA-256，格式为 `sha256:` 加 64 位小写十六进制。task payload 在 proposal-time 捕获这些字段，Reducer apply 时按 §7 与数据库当前行重新核对；其后如何随 durable task 持久化由第 4/5 批定义。普通写入 patch 的 `evidenceRefs.messageId` 必须来自 `observedMessages`。窗口组装规则见 [write-protocol.md](write-protocol.md) §2。

### 5.2 维护模式字段语义

`compactionProposer` 使用 `mode: "maintenance"` 的同形 envelope。各字段在维护模式下的取值与约束：

| Envelope 字段                         | 维护模式取值 / 范围                 | 约束                                                             |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `task.proposer`                       | `compactionProposer`                | 只由 Reducer 长度预算门触发，不参与普通 lag 轮询                 |
| `task.mode`                           | `"maintenance"`                     | Reducer 按维护模式切换 policy：只允许安全合并，不允许新增事实    |
| `task.targetKey`                      | 来源 normal task 的 targetKey       | 仅用于关联被阻塞 target、event 和 ops log；compaction 不读取或推进该 cursor |
| `task.targetMessageId`                | 来源 normal task 的 targetMessageId | 只标识被阻塞 proposal 的 raw-message 边界，用于关联、幂等和后续 replay；不是 compaction cursor，不用于读取 raw messages 或推进 cursor |
| `task.targetSections`                 | 仅含被预算阻塞的一个 section        | 禁止跨 section 合并；envelope 不再设置额外的 path 分组字段      |
| `task.observedMessageIds`             | `[]`                                | 维护任务不观察新的最近对话窗口                                   |
| `task.trigger`                        | `{ type: "lengthBudget", dimension, limit }` | `dimension` 为 `maxItems` 或 `maxRenderedChars`；`limit` 是对应配置值 |
| `writableState`                       | 目标 section 的既有 items 全集      | item 使用 §5 redacted view                                       |
| `readOnlyContext`                     | `{}`                                | 维护任务只在目标 source items 内判断合并                         |
| `observedMessages`                    | `[]`                                | 维护任务不读取 raw messages                                      |

维护模式下，`writableState` 不包含既有 `evidenceGroups`。`compactionProposer` 只输出可合并的 `itemIds` 与合并后的 `value.text`，不输出 `evidenceRefs`。Reducer 根据 `itemIds` 从权威 `memory_state` 读取 source items，继承 source `evidenceGroups`。

维护模式示例：

```json
{
  "task": {
    "tickId": 12346,
    "userId": 1,
    "presetId": "default",
    "schemaVersion": 2,
    "targetKey": "profileRelationship",
    "targetMessageId": 124,
    "proposer": "compactionProposer",
    "mode": "maintenance",
    "targetSections": ["userProfile"],
    "observedMessageIds": [],
    "trigger": {
      "type": "lengthBudget",
      "dimension": "maxRenderedChars",
      "limit": 1200
    },
    "now": "2026-07-06T22:30:00Z"
  },
  "writableState": {
    "longTerm": {
      "userProfile": [
        {
          "id": "userProfile:1",
          "text": "偏好: 晚上聊天",
          "createdAtMessageId": 88,
          "updatedAtMessageId": 88,
          "expiresAtTime": null
        },
        {
          "id": "userProfile:2",
          "text": "关系模式: 需要慢慢熟悉后再依赖",
          "createdAtMessageId": 101,
          "updatedAtMessageId": 101,
          "expiresAtTime": null
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

`profileRelationshipProposer` 的 `targetSections` 为 `["userProfile", "assistantProfile", "relationship"]`，三个正式 section 共享 `profileRelationship` cursor；`worldFactProposer` 的 `targetSections` 为 `["worldFacts"]`。两者分别把对方 writable sections 放入 `readOnlyContext`：前者只读 `worldFacts`，后者只读 `userProfile`、`assistantProfile`、`relationship`；两者还都包含 `current.scene`、`working.recentEpisodes`、`working.standingAgreements` 和 `longTerm.milestones` 作为语义背景。维护模式下 `compactionProposer` 的 `readOnlyContext` 固定为空对象。

### 5.4 边界规则

**写入范围**

- `sectionResults` 只能包含 `task.targetSections`；Proposer 可读取 `readOnlyContext`，但不得输出非 target section 的 patch。
- target sections 的当前状态只放在 `writableState`；若某固定背景范围概念上包含 target，本次仍以 `writableState` 为准，不在 `readOnlyContext` 重复放一份。

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
- `patches` 数组中每个 patch 含 `op`、`path`（仅 scene 字段操作）/`itemId`/`itemIds`（按 §4 必填规则）、`value`（按 §4 必填规则，`todos` 的 `addItem`/`updateItem` 可选含 `expiresAt` 结构化表达式）、`evidenceKind`（§3 枚举）。除 `mergeItems` 外，每个 patch 还必须含 `evidenceRefs`（至少 1 项，每项含 `messageId` integer 和 `quote` string；quote 最多 200 个 Unicode code points）。
- `evidenceRefs` 是 Proposer patch 字段，不是 item 的权威存储字段。Reducer 对普通非 `mergeItems` patch 校验通过后，将该数组连同 `patch.evidenceKind` 包装为一个 `evidenceGroup` 写入 item；`mergeItems` 的 evidenceGroups 从 source items 继承，各 group 保留各自 evidenceKind。
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

- `compactionProposer` 的 schema 额外限制：只能输出 `mergeItems`，且 `evidenceKind` 只能是 `memory_compaction`。输出 `addItem`、通用删除、跨 section 合并、`user_correction` 或 `evidenceRefs` 均非法。compaction section 的 `status` 必须是 `patches | unable_to_compact` 之一（不同于普通 Proposer 的 `patches | noop | unable_to_decide`）。
- `sectionResults` 必须恰好覆盖 `task.targetSections`。缺少 target section、包含非 target section、目标 section 缺少 `status`，均由 tick orchestrator 归类为 `output_schema_invalid`，不交 Reducer，不推进 cursor，并按 §9.2 触发 halt。

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

compaction 返回 `unable_to_compact` 时，`sectionResults` 中该 section 的 `status` 为 `unable_to_compact`，不含 `patches`。由 tick orchestrator 直接处理（写 ops_log + 触发 halt），不交 Reducer。

## 6. Patch Policy Table

Reducer 按 `section + op + evidenceKind` 查此表判断是否允许写入。不在表中的组合：Reducer 拒绝并记录 `rejected`（reason: `policy_not_allowed`）。

| section / op                          | 允许的 evidenceKind                                                                                                                            | 备注                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `scene.setField` / `scene.clearField` | `scene_change`, `user_correction`, `assistant_correction`                                                                                      | 字段级覆盖；字段级证据             |
| `todos.addItem`                       | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`                                                                 | 必须是可完成、可取消或可过期的事项 |
| `todos.updateItem`                    | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`, `user_correction`, `assistant_correction`                      | 更新待办                           |
| `todos.mergeItems`                    | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`, `user_correction`, `assistant_correction`, `memory_compaction` | 仅合并重复的 active 待办           |
| `todos.completeTodo`                  | `todo_completion`                                                                                                                              | 完成必须有终止证据                 |
| `todos.cancelTodo`                    | `todo_cancel`, `user_correction`, `assistant_correction`                                                                                       | 取消待办                           |
| `todos.expireTodo`                    | `todo_expiration`                                                                                                                              | 短期待办失效                       |
| `standingAgreements.addItem`          | `standing_agreement`                                                                                                                           | 新增持续互动约定                   |
| `standingAgreements.updateItem`       | `standing_agreement`, `user_correction`, `assistant_correction`                                                                                | 修订持续互动约定                   |
| `standingAgreements.mergeItems`       | `standing_agreement`, `user_correction`, `assistant_correction`, `memory_compaction`                                                           | 合并重复约定                       |
| `standingAgreements.cancelAgreement`  | `agreement_cancel`, `user_correction`, `assistant_correction`                                                                                  | 取消持续互动约定                   |
| `recentEpisodes.addItem`              | `recent_episode`                                                                                                                               | 滑动窗口                           |
| `recentEpisodes.updateItem`           | `recent_episode`, `user_correction`, `assistant_correction`                                                                                    | 更新近期经历                       |
| `recentEpisodes.mergeItems`           | `recent_episode`, `user_correction`, `assistant_correction`, `memory_compaction`                                                               | 合并重叠近期经历                   |
| `milestones.addItem`                  | `relationship_milestone`                                                                                                                       | 关系或剧情关键转折                 |
| `milestones.updateItem`               | `user_correction`, `assistant_correction`                                                                                                      | 修订里程碑                         |
| `milestones.mergeItems`               | `user_correction`, `assistant_correction`, `memory_compaction`                                                                                 | 合并重叠里程碑                     |
| `worldFacts.addItem` / `userProfile.addItem` / `assistantProfile.addItem` / `relationship.addItem` | `long_term_fact` | 新增长期事实 |
| `worldFacts.updateItem` / `userProfile.updateItem` / `assistantProfile.updateItem` / `relationship.updateItem` | `user_correction`, `assistant_correction` | 修订对应长期事实 |
| `worldFacts.mergeItems` / `userProfile.mergeItems` / `assistantProfile.mergeItems` / `relationship.mergeItems` | `user_correction`, `assistant_correction`, `memory_compaction` | 仅合并同一正式 section 内的重叠 item |

对 `worldFacts`、`userProfile`、`assistantProfile`、`relationship`，User 和 Assistant 双方拥有相同的 add/update 权限：`addItem + long_term_fact` 的证据可以来自任一真实 role；`updateItem + user_correction` 由 user 的修正消息支持，`updateItem + assistant_correction` 由 assistant 的修正消息支持。Reducer 必须按数据库真实 role 校验 evidenceKind，但不得用消息 role 限制双方只能维护某一个 Profile。forget 不在本表提前开放，其 tombstone/suppression 与双方 forget policy 在第 10 批同批定义。

## 7. Evidence 校验：Quote 模糊匹配

Reducer 校验普通非 `mergeItems` patch 的 evidence source 与 quote。普通模式下，patch evidence 可以来自 newBatch 或 overlap，但每个 `evidenceRefs.messageId` 都必须属于本 task 的 `observedMessages`；不要求至少一条 evidence 来自 newBatch。校验通过后，Reducer 将该 patch 的 `evidenceRefs` 连同 `patch.evidenceKind` 包装为一个新的 `evidenceGroup` 追加到 item；item 派生字段（`createdAtMessageId`/`updatedAtMessageId`）的维护规则见 §1。

`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`。Reducer 校验 source items 存在且带有结构合法的 `evidenceGroups`，继承到 merged item 并保留 group 边界；merged item 派生字段见 §1。source evidence 已在写入 source item 时通过 quote 校验。

### 7.1 Evidence source 一致性

对每个普通 evidenceRef，Reducer 必须重新读取数据库消息并依次校验：

1. `messageId` 存在于 proposal-time task payload 捕获的 `observedMessageIds/observedMessages`，并且数据库消息仍存在。
2. 数据库消息的 `userId`、`presetId` 与 task scope 完全相同。
3. 数据库消息的 `role`、`createdAt`、raw content SHA-256 与 proposal-time task payload 捕获的 observed message 完全相同。
4. 任一 scope/metadata/hash 不一致时拒绝对应 patch，reason=`evidence_source_mismatch`；messageId 不属于 task 或数据库消息不存在时使用 `message_id_not_found`。Reducer 不用 envelope 中的 role 覆盖数据库真实 role。
5. evidenceKind 带有明确发言方语义时按数据库真实 role 校验；例如 `user_correction` 只接受 user evidence，`assistant_correction` 只接受 assistant evidence。`long_term_fact` 对 user/assistant 都合法。role 与 evidenceKind 不匹配时拒绝，reason=`evidence_role_mismatch`。

### 7.2 Quote 长度、归一化与信息量

quote 按 Unicode code point（`Array.from(str).length`），不是 UTF-16 code unit 计数：

归一化允许忽略的标点集固定为：

```js
QUOTE_IGNORABLE_PUNCTUATION = [
  ",", ".", "!", "?", ";", ":", "\"", "'", "(", ")", "[", "]", "-",
  "，", "。", "！", "？", "；", "：", "“", "”", "‘", "’", "（", "）",
  "【", "】", "《", "》", "〈", "〉", "、", "…", "—"
]
```

该常量属于共享集中配置，正式值只能由统一 matcher 读取；Provider 或调用点不得增删字符或另写归一化逻辑。

1. 原始 quote 必须非空，且不能只有 Unicode whitespace、punctuation 或 symbol。
2. 原始 quote 最多 200 个 Unicode code points；超出时拒绝对应 patch，reason=`quote_too_long`，不得自动裁剪。
3. `normalizeEvidenceText(str)` 是唯一归一化函数：先做 locale-independent `toLowerCase()`，再按 Unicode code point 移除 Unicode `White_Space` property 字符和 `QUOTE_IGNORABLE_PUNCTUATION` 中的字符；不做 NFKC/NFKD、同义词替换、数字转换或 Provider 专属预处理。所有 Provider 与调用点共用同一实现。
4. 归一化 quote 中 Unicode property 不属于 `White_Space`、`Punctuation`、`Symbol` 的字符为“信息字符”；少于 3 个时拒绝对应 patch，reason=`quote_too_short`。

### 7.3 统一 Levenshtein 匹配

所有长度的合法 quote 使用同一匹配规则，不设置“短文本精确、长文本模糊”的双路径：

1. 将 normalized quote 与 normalized raw content 都拆成 Unicode code point 数组。
2. 在 normalized raw content 中枚举与 quote 等长的连续窗口；子串完全相同等价于 similarity=1 的快速路径，不是另一套接受规则。raw content 短于 quote 时没有合法窗口，直接匹配失败。
3. 每个窗口计算 `similarity = 1 - levenshtein(quote, window) / quote.length`，取最大值。
4. 默认阈值为 0.75，并从集中配置读取；最大 similarity >= 阈值时接受，否则拒绝对应 patch，reason=`quote_not_found`。

模糊匹配只能容忍复制偏差，不能解决否定词删除、数字/姓名替换等低编辑距离但高语义影响的问题。系统明确接受这一剩余风险，不引入否定词专项规则、“高风险事实”识别或 NLI/自然语言蕴含验证，也不得宣称 Reducer 已证明 quote 语义蕴含 patch。

## 8. Memory 容量与长度预算

除后续批次明确的确定性例外外，每个会进入主聊天上下文的 item section 都使用同一容量 shape：

```js
{
  maxItems,
  maxRenderedChars
}
```

`scene` 是固定字段对象而非 item section，因此不使用 `maxItems`，但其可能被 Renderer 输出的 scene values 受独立 `maxRenderedChars` 约束。

容量计算规则：

1. `maxItems` 统计该 section 受基础容量门约束的当前 items 数量。
2. `maxRenderedChars` 按 Unicode code points 统计 Renderer 可能输出的语义文本：当前 item section 计 `item.text`，scene 计非 null 的 field `value`。Renderer 的标题、连接词、模板标点不计。
3. quote、evidenceGroups、hash、ID、provenance、event、task/proposal、compaction audit 等不会作为 Memory 语义文本渲染的内容不计。
4. proposal apply 后任一维度超过配置上限即视为超容量；普通 item section 进入 deferred/compaction 流程，maintenance trigger 用 `dimension=maxItems|maxRenderedChars` 标明阻塞维度。
5. Memory 业务层不设置 proposal 或 envelope 总字符上限，也不要求 LLM 精确控制 proposal 总字符数。Provider 的 context/output 物理上限属于 Adapter/Provider 能力边界，不得转化成 Memory section 容量。
6. 所有 item section 的 `maxItems` / `maxRenderedChars` 以及 scene 的 `maxRenderedChars` 都从集中配置读取，禁止散落硬编码。除 quote 最大 200 已确定外，本批不确定具体容量默认值；默认值需结合真实历史分布后写入配置文档。

`recentEpisodes` 滑动窗口、`current.previousScene` 单值替换、todo `status=overdue` 的容量统计与渲染限制是确定性例外，其完整规则在第 6 批与领域生命周期一起落地。本批只确立基础双维容量，不能据此让这些例外调用 compactionProposer。

## 9. 审计与运营日志

Memory v2 把"patch 决策"与"LLM 运营事件"分两类记录。前者是 Proposer 产出判断后 Reducer 的写入决策，后者是 patch 产生之前的调用失败、结构化输出失败、信息不足和 halt。两者查询模式不同：查 memory 演化走 events 表，查 provider 健康度走 ops_log。

同一 tick 的 `memory_state` 写回、cursor 决策、`meta.recovery` 更新、events/ops_log 行必须原子提交，不产生 state 已变更但 cursor/recovery/log 未同步的中间态。

### 9.1 patch 决策表

每个 patch 产生一行 event；`noop` 产生一行占位（`decision=noop`，`patch_id` 为 null）。一个 section 一个 tick 可能有多个 patch（如 `todoProposer` 同时 `addItem` 一个新待办 + `completeTodo` 另一个旧待办），因此可能有多行 event。target 级 cursor 推进是派生的：按 `target_key` 聚合 event，并结合该 proposal 的全部 section status 与 ops outcome 判断（[write-protocol.md](write-protocol.md) §3）。

```sql
CREATE TABLE chat_memory_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  tick_id         BIGINT NOT NULL,
  target_key      TEXT NOT NULL,             -- scene | todos | standingAgreements | episodes | profileRelationship | worldFacts；maintenance event 记录来源 normal target
  section         TEXT NOT NULL,
  decision        TEXT NOT NULL,           -- accepted | rejected | deferred | noop
  patch_id        TEXT,                    -- Reducer 生成的 patch 唯一 id（如有）
  op              TEXT,                    -- patch op（如有）
  item_id         TEXT,                    -- 目标 item id（如有）
  evidence_kind   TEXT,                    -- evidenceKind（如有）
  reject_reason   TEXT,                    -- 拒绝原因码（仅 rejected 时）
  maintenance_task_id TEXT,                -- 关联 compaction task（如有）
  patch_summary   JSONB,                   -- patch 的精简摘要（op + value + evidenceRefs if present）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_events_user_preset
  ON chat_memory_events(user_id, preset_id, created_at DESC);

CREATE INDEX idx_memory_events_target_decision
  ON chat_memory_events(user_id, preset_id, target_key, decision);
```

`decision` 合法值（per-patch，非 section 聚合）：

- `accepted`：该 patch 被 apply。
- `rejected`：该 patch 被拒（policy/quote/schema 等）。一个 section 一个 tick 的多个 patch 可能部分 `accepted` 部分 `rejected`，各自落行。
- `deferred`：该 patch（`addItem`）被长度预算阻塞，已触发 compaction task。
- `noop`：Proposer 明确判断该 section 无变化。占位行，`patch_id`/`op`/`item_id`/`evidence_kind`/`patch_summary` 为 null。一个 section 一个 tick 最多一行 noop。

target 级 cursor 推进按 `target_key` 聚合，并同时检查该 normal proposal 的全部 `sectionResults` 与 pre-patch outcome：任一 section 为 `unable_to_decide`、任务发生 `error`，或任一 event 为 `deferred` / `rejected: length_budget_exceeded` 时均不推进。只有 proposal 的所有 target sections 都形成可推进终局，且至少产生一行 `accepted`/`noop`/普通 `rejected` event 时才推进（见 [write-protocol.md](write-protocol.md) §3）。不能只凭某一 section 的 accepted event 推进联合 target。

`reject_reason` 合法值（仅 `rejected` 时填写）：

- `schema_invalid`：patch 结构不合规。
- `message_id_not_found`：evidenceRefs 的 messageId 不存在。
- `evidence_source_mismatch`：数据库消息的 scope、role、createdAt 或 raw content hash 与 proposal-time observed message 不一致。
- `evidence_role_mismatch`：evidenceKind 的明确发言方语义与数据库真实 role 不一致。
- `quote_too_short`：归一化 quote 少于 3 个信息字符，或原始 quote 为空/只有 whitespace、punctuation、symbol。
- `quote_too_long`：原始 quote 超过 200 个 Unicode code points。
- `quote_not_found`：quote 模糊匹配失败。
- `policy_not_allowed`：section + op + evidenceKind 不在 policy table。
- `item_not_found`：itemId 指向不存在的 item。
- `length_budget_exceeded`：section 的 `maxItems` 或 `maxRenderedChars` 超上限；首次为 `deferred`，compaction 返回 `unable_to_compact` 或合并后仍超限后为最终 `rejected`，触发 halt。
- `invalid_expiry_in_past`：`expiresAt` 计算出的 `expiresAtTime` 不在未来。

`item_id` 列：对单 item 操作（`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`）存目标 item id；对 `mergeItems` 存 `itemIds.join(",")`；对 `addItem`/`setField`/`clearField`/`noop` 存 null。完整信息在 `patch_summary` JSONB 中。

### 9.2 运营事件表与恢复态

```sql
CREATE TABLE chat_memory_ops_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  tick_id         BIGINT NOT NULL,
  target_key      TEXT NOT NULL,
  section         TEXT,
  proposer        TEXT NOT NULL,
  outcome         TEXT NOT NULL,           -- llm_call_failed | safety_policy_blocked | output_schema_invalid | unable_to_decide | unable_to_compact
  attempt         INTEGER NOT NULL,        -- 本次 tick 的第几次尝试
  detail          JSONB,                   -- provider finish_reason / 错误消息 / 扩展上下文大小等
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_ops_log_health
  ON chat_memory_ops_log(user_id, preset_id, created_at DESC);

CREATE INDEX idx_memory_ops_log_outcome
  ON chat_memory_ops_log(user_id, preset_id, outcome, created_at DESC);
```

`target_key` 是 ops log 的必填归属。`section` 只在 outcome 能明确归属某个正式 section 时填写，并且只能是九个正式 section 之一；provider/network error、proposer/tickId 不匹配、整体输出无法解析、缺少整个 `sectionResults` 等 task 级 outcome 填 `NULL`。禁止用 `episodes`、`profileRelationship` 等 targetKey 代填 `section`。

`outcome` 合法值：

- `llm_call_failed`：网络/超时/provider 异常，瞬时性。
- `safety_policy_blocked`：provider 安全策略拦截（finish_reason 含 content_filter 或 refusal）。
- `output_schema_invalid`：provider 返回了内容但 adapter/tick orchestrator 无法验证为 §5.5 schema。与 events 表的 `schema_invalid`（Reducer 校验 patch 字段结构）区分：本码发生在 patch 产生之前。该 outcome 同步设置 `meta.halted=true`。
- `unable_to_decide`：Proposer 自认信息不足。首次记录并扩窗口重试一次；二次仍 `unable_to_decide` → 推进 cursor。ops_log outcome 始终记 `unable_to_decide`（记实际发生的事），不触发 halt。
- `unable_to_compact`：compactionProposer 判定无安全合并空间，触发 halt。

ops_log 只记 patch 产生之前的非正常结果。patch 是否被 Reducer 接受、拒绝、暂缓，查 events 表。halt 状态由 `meta.halted` 表达（见 §1），不在 ops_log 中重复记录。

`meta.recovery`（§1 概念形态）是 tick orchestrator 读写恢复态的载体，与 ops_log 配合：

```js
recovery: {
  [targetKey]: {
    consecutiveErrors: 0,            // error 连续计数，达阈值（write-protocol.md §3.1）升级推进
    awaitingContextExpansion: false, // unable_to_decide 首次后置 true，下 tick 发扩大的 contextWindow
    lastErrorReason: null,          // 最近一次非正常 outcome
    lastErrorTickId: null
  }
}
```

语义：

- `consecutiveErrors`：仅瞬时错误（adapter 返回 `llm_call_failed`/`safety_policy_blocked`）发生时 +1，与 ops_log 行的 outcome 标签解耦；`accepted`/`rejected`/`noop`/`deferred` 时重置为 0。`output_schema_invalid` 不走此计数器——持续性错误，直接触发 halt（见 [write-protocol.md](write-protocol.md) §3.1）。达 [write-protocol.md](write-protocol.md) §3.1 阈值（3 次）后设置 `meta.halted=true`，`consecutiveErrors` 保留不清零，等手动 resume 时重置。
- `awaitingContextExpansion`：首次 `unable_to_decide` 置 true、不推进 cursor。下一 tick Observer 读到 true → 发扩大的 contextWindow（如 +10）。二次仍 `unable_to_decide` → 推进 cursor、清 false。任何 patch 决策（accepted/rejected/noop/deferred）也清 false。
- 两者独立：一个管 error 路径，一个管 unable_to_decide 路径，不互相干扰。

详细调试信息（完整 patch、完整 state diff、prompt 内容等）用 `logger` 输出到应用日志，不进表。

## 10. Provider Adapter 契约

Proposer 的 LLM 调用必须经由归一化的 Provider Adapter 层，而非在 tick orchestrator 里直接调 provider SDK。Adapter 把不同 provider 的响应与错误映射为统一结果，使上层无需关心 `finish_reason` 取值差异，也让 `safety_policy_blocked` 等错误有明确的识别与传递路径。

Adapter 输入：Proposer prompt（system + user）+ 输出 schema（§5.5）。Adapter 输出：

```js
// 成功
{ status: "ok", output: { /* §5.5 的 Proposer 输出结构 */ } }

// 失败
{ status: "error", reason: "llm_call_failed" | "safety_policy_blocked" | "output_schema_invalid", detail: { /* finish_reason / 错误消息 / 原始响应片段 */ } }
```

识别规则：

- `safety_policy_blocked`：provider 返回 `finish_reason`/`stop_reason` 含 `content_filter`，或返回 refusal 标记，或输入被 provider 拒绝。此错误必须显式记录，不得伪装成 noop 或静默跳过（见 [write-protocol.md](write-protocol.md) §6）。
- `output_schema_invalid`：provider 返回了内容但 adapter/tick orchestrator 无法验证为 §5.5 schema。命名上与 events 表的 `schema_invalid`（Reducer 校验 patch 字段结构）区分：本码发生在 patch 产生之前。
- `llm_call_failed`：网络异常、超时、provider 5xx、其它未归类异常。

tick orchestrator 行为：

- `status: "ok"` → tick orchestrator 校验 `output.proposer === task.proposer` 且 `output.tickId === task.tickId`，不匹配时写 ops_log（outcome=`output_schema_invalid`）并触发 halt，不交 Reducer；校验通过后检查 output 的 `sectionResults`：缺少 target section、包含非 target section 或目标 section 缺少 `status` 时，写 ops_log（outcome=`output_schema_invalid`）并触发 halt，不交 Reducer；`unable_to_decide` 的 section 由 tick orchestrator 直接处理（写 ops_log + 更新 `meta.recovery`，按 [write-protocol.md](write-protocol.md) §3.1 恢复策略），**不交 Reducer**；compactionProposer 的 section 返回 `unable_to_compact` 时，tick orchestrator 写 ops_log（outcome=`unable_to_compact`），触发 halt，不交 Reducer；`patches`/`noop` 的 section 才交 Reducer 处理（patch 决策落 events 表）。Reducer 永远不接触 `unable_to_decide` 与 `unable_to_compact`。
- `status: "error"` → 不交给 Reducer，直接写 ops_log（outcome=对应 reason）、更新 `meta.recovery`、按 [write-protocol.md](write-protocol.md) §3.1 恢复策略决定是否重试或触发 halt。

Reducer 永远只处理 `status: "ok"` 且 section 状态为 `patches`/`noop` 的输出，不会看到空输出、伪造输出、`unable_to_decide` 或残缺 `sectionResults`。adapter 在 `status: "error"` 时由 tick orchestrator 直接处理，不把错误结果传给 Reducer。
