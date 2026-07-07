# Memory Control v2 状态契约

本文是 Memory Control v2 的**静态契约权威来源**：所有数据 shape、枚举、查表、校验算法和存储落点都在这里定义一次。写入流程见 [write-protocol.md](write-protocol.md)，顶层判断见 [../memory-control-v2-overview.md](../memory-control-v2-overview.md)。

跨文档惯例：本文已定义的契约，其他文档只引用章节号，不重述。

## 1. 权威状态与存储落点

Memory v2 的权威状态是单一 `memory_state` JSONB blob，保存当前完整 memory state，由 Reducer 原子写回。旧 `rolling_summary` 和 `core_memory` 只能作为 legacy 字段存在，不再参与 v2 写入决策。

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
      location: null,
      time: null,
      mood: null,
      note: null,
      lastEvidence: null,       // { messageId, quote }
      updatedAtMessageId: null
    },
    participants: {
      user: { emotion: null, action: null, intent: null, lastEvidence: null, updatedAtMessageId: null },
      assistant: { emotion: null, action: null, intent: null, lastEvidence: null, updatedAtMessageId: null }
    }
  },
  working: {
    todos: [],                  // item 数组
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
    perSectionCursor: {},      // { section: coveredUntilMessageId }
    recovery: {}               // { section: { consecutiveErrors, awaitingContextExpansion, lastErrorReason, lastErrorTickId } }，见 §9.2
  }
}
```

每个可追踪 item 结构：

```js
{
  id: "todos:uuid-xxx",         // Reducer 生成，全局唯一
  text: "归还橡皮",              // 高密度关键词式描述
  evidenceRefs: [{ messageId: 121, quote: "明天提醒我把橡皮还给她" }],
  evidenceKind: "user_request", // 见第 3 节
  createdAtMessageId: 121,
  updatedAtMessageId: 121,
  expiresAtTime: null,          // 可选，ISO 8601 timestamp。短期待办用。由 Proposer 在 addItem 的 value 中基于 task.now 计算（如"两周后去钓鱼"→ task.now + 14天 + 1天，+1天因活动当天仍是活跃期），Reducer 校验为合法未来时间戳
  tags: ["短期"]                 // 可选
}
```

`scene` 和 `participants` 是当前状态，用轻量字段表达，但记录最后证据与更新时间。`todos` 与 `recentEpisodes` 是工作区记忆；`milestones` 与 core 各数组位于长期区并保留 item 级证据。

## 2. 记忆分层

| Section          | 存储位置                        | 作用                           | 生命周期       | 写入原则                                                 |
| ---------------- | ------------------------------- | ------------------------------ | -------------- | -------------------------------------------------------- |
| `scene`          | `current.scene`                 | 当前地点、时间、氛围、环境锚点 | 高频、覆盖式   | 存完整当前状态；无变化不改                               |
| `participants`   | `current.participants`          | 用户和助手当前情绪、动作、意图 | 高频、覆盖式   | 只记录当前状态，不承载长期人格                           |
| `todos`          | `working.todos`                 | 未完成承诺、约定、澄清项       | 中频、事件型   | 完成取消过期即从数组移除（需终止证据）；auto-expire 除外 |
| `recentEpisodes` | `working.recentEpisodes`        | 最近几次有意义互动             | 高频、滑动窗口 | 普通 episode 到期自然滚出；重要 episode 可晋升 milestone |
| `milestones`     | `longTerm.milestones`           | 关系或剧情关键转折             | 低频、归档型   | 长期保存，默认新增或合并；普通日常不得进入               |
| `core`           | `longTerm.*`（不含 milestones） | 长期事实、偏好、人格、关系模式 | 低频、保守     | 只接受明确设定或用户修正                                 |

每个 section 拥有独立 `coveredUntilMessageId`（存于 `meta.perSectionCursor`）。section 之间 cursor 独立推进，互不阻塞；所有写入（普通 task 与 compaction task）共用同一 `userId/presetId` 串行队列，保证 `memory_state` 单行写回无竞争。一个 section 被 `deferred` 不阻塞同 tick 内其它 eligible section 的处理与 cursor 推进，仅该 section 自身等待 compaction 释放容量后重跑。

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
| `participant_change`     | 用户或 assistant 当前情绪、动作、意图变化                                                                                                                                                                                                      |
| `recent_episode`         | 最近发生的有意义互动                                                                                                                                                                                                                           |
| `relationship_milestone` | 关系或剧情关键转折                                                                                                                                                                                                                             |
| `user_correction`        | 用户明确修正旧记忆或设定                                                                                                                                                                                                                       |
| `assistant_correction`   | assistant 明确修正已有记忆（场景、状态、待办、经历、里程碑、长期事实等）                                                                                                                                                                       |
| `long_term_fact`         | 长期事实，包括明确表达的（"我叫小明"）和从行为推断的（多次回避冲突→倾向回避冲突）。evidenceRefs 的 quote 始终是 raw message 短片段——对陈述是原话，对推断是体现该行为的原话（如"我冲过去把门踹开了"）；推断理由写在 value.text 中，不放在 quote |
| `memory_compaction`      | 基于已有 memory item 的预算维护与去重合并                                                                                                                                                                                                      |

### 3.1 Per-Proposer 派生 evidenceKind enum

上表是 Reducer 查 policy table（§6）用的 master enum。每个 Proposer 的 output schema enum 只列自己合法的子集，避免 LLM 看到无关选项。派生关系由 §6 policy table 决定，本节为开发者/LLM 提供速查：

| Proposer               | 合法 evidenceKind                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentStateProposer` | `scene_change`, `participant_change`, `user_correction`, `assistant_correction`                                                                                                                     |
| `todoProposer`         | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`, `todo_completion`, `todo_cancel`, `todo_expiration`, `user_correction`, `assistant_correction`, `memory_compaction` |
| `episodeProposer`      | `recent_episode`, `relationship_milestone`, `user_correction`, `assistant_correction`, `memory_compaction`                                                                                          |
| `coreProposer`         | `long_term_fact`, `user_correction`, `assistant_correction`, `memory_compaction`                                                                                                                    |
| `compactionProposer`   | `memory_compaction`                                                                                                                                                                                 |

## 4. Patch Op 合法值与约束

下表同时服务两个视角：Reducer 按 op 校验字段结构，schema/prompt 作者按 Proposer 查合法 op。Reducer 的 section+op 合法性最终查 §6 policy table。

| op             | 含义                       | 适用 Proposer                                                                     |
| -------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `setField`     | 设置覆盖式状态字段         | `currentStateProposer`                                                            |
| `clearField`   | 清除已失效的覆盖式状态字段 | `currentStateProposer`                                                            |
| `addItem`      | 新增 item                  | `todoProposer`, `episodeProposer`, `coreProposer`                                 |
| `updateItem`   | 局部更新已有 item          | `todoProposer`, `episodeProposer`, `coreProposer`                                 |
| `mergeItems`   | 合并重复或高度重叠 item    | `todoProposer`, `episodeProposer`, `coreProposer`, `compactionProposer`           |
| `completeTodo` | 将待办完成并从数组移除     | `todoProposer`                                                                    |
| `cancelTodo`   | 将待办取消并从数组移除     | `todoProposer`                                                                    |
| `expireTodo`   | 将短期待办失效并从数组移除 | `todoProposer`                                                                    |

字段必填规则：

- `path`：对 `setField`/`clearField`/`updateItem` 必填。对 `scene`/`participants` 是字段名（如 `location`、`mood`、`user.emotion`）。对 `core` 的所有 op（`addItem`/`updateItem`/`mergeItems`）也必填，值为长期区子数组名：`worldFacts`/`userProfile`/`assistantProfile`/`relationship`。`milestones` 虽存于 `longTerm`，但作为独立 section 操作，`addItem` 不需要 `path`。`todos`/`recentEpisodes` 的 `addItem` 也不需要 `path`（单一数组）。
- `itemId`：对 `updateItem`/`completeTodo`/`cancelTodo`/`expireTodo` 必填（单个 item 的 id）。
- `itemIds`（数组）：对 `mergeItems` 必填，指定要合并的多个 itemId。`value` 是合并后的新 item 值，至少包含 `text`。merged item 的 `evidenceRefs` 必须是所有 source items 的 `evidenceRefs` 的并集，Reducer 强制校验完整性。
- `value`：对 `setField`/`addItem`/`updateItem` 必填。
- `evidenceRefs`：至少包含一个 `{ messageId, quote }`，除非该 op 是 Reducer 自行触发的过期清理。普通写入 patch 的 `evidenceRefs` 必须来自 Proposer envelope 的 `evidenceMessages`（见 §5）。
- `quote`：必须是短片段（<=80 字符），不保存大段原文。
- `evidenceKind: "memory_compaction"` 只允许用于 `mergeItems`。其 `evidenceRefs` 必须来自维护模式 `writableState` 中被合并 source items 的既有证据，并由 envelope 的 `evidenceMessages` 校验，不能引用新的对话片段或 read-only context 来制造新事实。

## 5. Proposer 输入/输出信封

Proposer 输入使用统一 envelope，区分三类信息：**writable target**（本次允许写入的 section/path）、**read-only memory context**（帮助理解对话背景的只读 memory 片段）、**evidence messages**（用于写入校验的 raw messages）。`task.mode` 是判别字段，决定 `trigger`、`writableState` 和 `evidenceMessages` 的语义。

### 5.1 信封结构（普通模式）

```json
{
  "task": {
    "tickId": 12345,
    "userId": 1,
    "presetId": "default",
    "schemaVersion": 2,
    "targetMessageId": 124,
    "proposer": "episodeProposer",
    "mode": "normal",
    "targetSections": ["recentEpisodes", "milestones"],
    "targetPaths": [],
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
          "evidenceRefs": [{ "messageId": 110, "quote": "我不是想和你吵" }],
          "evidenceKind": "recent_episode",
          "createdAtMessageId": 110,
          "updatedAtMessageId": 110,
          "expiresAtTime": null,
          "tags": []
        }
      ]
    },
    "longTerm": {
      "milestones": [
        {
          "id": "milestone:2",
          "text": "关系转折: 第一次明确互相信任",
          "evidenceRefs": [{ "messageId": 80, "quote": "我愿意相信你" }],
          "evidenceKind": "relationship_milestone",
          "createdAtMessageId": 80,
          "updatedAtMessageId": 80,
          "expiresAtTime": null,
          "tags": []
        }
      ]
    }
  },
  "readOnlyContext": {
    "current": {
      "scene": {
        "location": "屋顶",
        "time": "深夜",
        "mood": "雨后安静",
        "note": null,
        "lastEvidence": { "messageId": 119, "quote": "你为什么不说话" },
        "updatedAtMessageId": 119
      },
      "participants": {
        "user": {
          "emotion": "不安 > 释然",
          "action": "低头 > 抬头",
          "intent": "寻求确认",
          "lastEvidence": { "messageId": 121, "quote": "我刚才其实很怕你会走" },
          "updatedAtMessageId": 121
        },
        "assistant": {
          "emotion": "耐心",
          "action": "等待",
          "intent": "安抚",
          "lastEvidence": { "messageId": 122, "quote": "我没有走" },
          "updatedAtMessageId": 122
        }
      }
    },
    "working": {
      "todos": [
        {
          "id": "todos:abc-1",
          "text": "以后沉默时先开口",
          "evidenceRefs": [{ "messageId": 123, "quote": "那你以后能不能别沉默那么久" }],
          "evidenceKind": "user_request",
          "createdAtMessageId": 123,
          "updatedAtMessageId": 124,
          "expiresAtTime": null,
          "tags": []
        }
      ]
    },
    "longTerm": {
      "relationship": [
        {
          "id": "core:relationship:3",
          "text": "关系模式: 慢热 | 安全感确认后更依赖",
          "evidenceRefs": [{ "messageId": 50, "quote": "我一般慢热，熟了才会比较依赖人" }],
          "evidenceKind": "long_term_fact",
          "createdAtMessageId": 50,
          "updatedAtMessageId": 50,
          "expiresAtTime": null,
          "tags": []
        }
      ],
      "userProfile": [
        {
          "id": "core:user:5",
          "text": "偏好: 低压陪伴 | 不喜欢被逼问",
          "evidenceRefs": [{ "messageId": 45, "quote": "我不喜欢被一直追问" }],
          "evidenceKind": "long_term_fact",
          "createdAtMessageId": 45,
          "updatedAtMessageId": 45,
          "expiresAtTime": null,
          "tags": []
        }
      ],
      "assistantProfile": [
        {
          "id": "core:assistant:1",
          "text": "人格: 温和 | 主动给空间",
          "evidenceRefs": [{ "messageId": 30, "quote": "我会等你准备好" }],
          "evidenceKind": "long_term_fact",
          "createdAtMessageId": 30,
          "updatedAtMessageId": 30,
          "expiresAtTime": null,
          "tags": []
        }
      ]
    }
  },
  "evidenceMessages": [
    { "id": 119, "role": "user", "contentKind": "raw", "content": "你为什么不说话，是不是又觉得我很烦？" },
    { "id": 120, "role": "assistant", "contentKind": "raw", "content": "我没有觉得你烦，只是在想怎么开口。" },
    { "id": 121, "role": "user", "contentKind": "raw", "content": "我刚才其实很怕你会走，所以才一直不敢抬头。" },
    { "id": 122, "role": "assistant", "contentKind": "raw", "content": "我没有走，我只是想等你愿意看我的时候再靠近。" },
    { "id": 123, "role": "user", "contentKind": "raw", "content": "那你以后能不能别沉默那么久，我会乱想。" },
    { "id": 124, "role": "assistant", "contentKind": "raw", "content": "好，以后我会先开口，不让你一个人等。" }
  ]
}
```

字段说明：

- `task`：本次 proposer、mode、target sections/paths、observed message ids、`trigger` 和 `now`（ISO 8601 wall-clock 时间戳，供 Proposer 计算 `expiresAtTime` 等相对时间字段）。
- `writableState`：本次允许写入的目标 section/path 当前状态。item 一律携带 §1 定义的完整字段（`id`/`text`/`evidenceRefs`/`evidenceKind`/`createdAtMessageId`/`updatedAtMessageId`/`expiresAtTime`/`tags`，无值字段显式传 null）。
- `readOnlyContext`：可读取的背景 memory，用于理解对话，不得作为新事实证据。item 同样携带完整字段（与 writableState 同构），固定范围见 §5.3。
- `evidenceMessages`：用于 quote 校验的 raw messages。普通模式下与 `observedMessageIds` 一一对应——同 M 条消息的完整内容（ID 列表供 cursor/lag 逻辑用，完整内容供 Proposer 阅读和 Reducer quote 校验用）；维护模式下是 `writableState` source items 既有 `evidenceRefs` 对应的 raw messages。
- `evidenceRefs.messageId` 对 Proposer 的语义：writableState 和 readOnlyContext 中旧 item 的 `evidenceRefs.messageId`（如上例的 110、80、50、45、30）通常不在当前 tick 的 `evidenceMessages` 中——它们来自更早的 tick。Proposer 只应读 `quote` 做上下文理解（溯源语气、辅助去重），不应尝试通过 messageId 回查旧消息。messageId 对 Reducer 有意义（校验新 patch 的 quote），对 Proposer 是只读元数据。

### 5.2 维护模式字段语义

`compactionProposer` 使用 `mode: "maintenance"` 的同形 envelope。各字段在维护模式下的取值与约束：

| Envelope 字段                         | 维护模式取值 / 范围                                                                                                                               | 约束                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `task.proposer`                       | `compactionProposer`                                                                                                                              | 只由 Reducer 长度预算门触发，不参与普通 lag 轮询                                                |
| `task.mode`                           | `"maintenance"`                                                                                                                                   | Reducer 按维护模式切换 policy：只允许安全合并，不允许新增事实                                   |
| `task.targetSections` / `targetPaths` | 被预算阻塞的 section/path                                                                                                                         | `targetPaths` 对 `core` 必填；禁止跨 section 或跨 core path 合并                                |
| `task.observedMessageIds`             | `[]`                                                                                                                                              | 维护任务不观察新的最近对话窗口                                                                  |
| `task.trigger`                        | `{ type: "lengthBudget", limit, blockedPatchSummary }`                                                                                            | `blockedPatchSummary` 只解释触发原因，不能作为 compaction 证据来源                              |
| `writableState`                       | 目标 section/path 的既有 items 全集                                                                                                               | 不按数量、相似度或 `blockedPatchSummary` 语义筛选；item 必须带 §1 完整字段（与普通模式同构）     |
| `readOnlyContext`                     | `current.scene`、`current.participants`、`working.todos` active 子集、`working.recentEpisodes`、`longTerm.milestones`、非目标 core sibling arrays | 只用于防止误合并，不能作为 evidenceRefs 来源；范围由目标 section/path 固定决定                  |
| `evidenceMessages`                    | `writableState` source items 既有 `evidenceRefs` 对应的 raw messages                                                                              | 只供 Reducer 校验 quote；Proposer 不得从这里摘录新事实                                          |

维护模式示例：

```json
{
  "task": {
    "tickId": 12346,
    "userId": 1,
    "presetId": "default",
    "schemaVersion": 2,
    "targetMessageId": 124,
    "proposer": "compactionProposer",
    "mode": "maintenance",
    "targetSections": ["core"],
    "targetPaths": ["userProfile"],
    "observedMessageIds": [],
    "trigger": {
      "type": "lengthBudget",
      "limit": 15,
      "blockedPatchSummary": {
        "op": "addItem",
        "path": "userProfile",
        "value": { "text": "偏好: 夜间长聊 | 需要慢热陪伴" },
        "evidenceKind": "long_term_fact"
      }
    },
    "now": "2026-07-06T22:30:00Z"
  },
  "writableState": {
    "longTerm": {
      "userProfile": [
        {
          "id": "core:1",
          "text": "偏好: 晚上聊天 | 慢热",
          "evidenceRefs": [{ "messageId": 88, "quote": "我晚上比较想聊天" }],
          "evidenceKind": "long_term_fact",
          "createdAtMessageId": 88,
          "updatedAtMessageId": 88,
          "expiresAtTime": null,
          "tags": []
        },
        {
          "id": "core:9",
          "text": "关系模式: 需要慢慢熟悉后再依赖",
          "evidenceRefs": [{ "messageId": 101, "quote": "我一般慢热" }],
          "evidenceKind": "long_term_fact",
          "createdAtMessageId": 101,
          "updatedAtMessageId": 101,
          "expiresAtTime": null,
          "tags": []
        }
      ]
    }
  },
  "readOnlyContext": {
    "current": {
      "scene": {
        "location": null,
        "time": "深夜",
        "mood": "安静",
        "note": null,
        "lastEvidence": null,
        "updatedAtMessageId": null
      },
      "participants": {
        "user": {
          "emotion": "放松",
          "action": null,
          "intent": null,
          "lastEvidence": null,
          "updatedAtMessageId": null
        },
        "assistant": {
          "emotion": null,
          "action": null,
          "intent": null,
          "lastEvidence": null,
          "updatedAtMessageId": null
        }
      }
    },
    "working": {
      "todos": [],
      "recentEpisodes": [
        {
          "id": "episode:8",
          "text": "深夜闲聊 | 用户放松状态",
          "evidenceRefs": [{ "messageId": 115, "quote": "今晚聊得很舒服" }],
          "evidenceKind": "recent_episode",
          "createdAtMessageId": 115,
          "updatedAtMessageId": 115,
          "expiresAtTime": null,
          "tags": []
        }
      ]
    },
    "longTerm": {
      "milestones": [
        {
          "id": "milestone:2",
          "text": "关系转折: 第一次明确互相信任",
          "evidenceRefs": [{ "messageId": 80, "quote": "我愿意相信你" }],
          "evidenceKind": "relationship_milestone",
          "createdAtMessageId": 80,
          "updatedAtMessageId": 80,
          "expiresAtTime": null,
          "tags": []
        }
      ],
      "worldFacts": [],
      "assistantProfile": [
        {
          "id": "core:assistant:1",
          "text": "人格: 温和 | 主动给空间",
          "evidenceRefs": [{ "messageId": 30, "quote": "我会等你准备好" }],
          "evidenceKind": "long_term_fact",
          "createdAtMessageId": 30,
          "updatedAtMessageId": 30,
          "expiresAtTime": null,
          "tags": []
        }
      ],
      "relationship": [
        {
          "id": "core:rel:3",
          "text": "关系模式: 慢热 | 安全感确认后更依赖",
          "evidenceRefs": [{ "messageId": 95, "quote": "熟了才会比较依赖人" }],
          "evidenceKind": "long_term_fact",
          "createdAtMessageId": 95,
          "updatedAtMessageId": 95,
          "expiresAtTime": null,
          "tags": []
        }
      ]
    }
  },
  "evidenceMessages": [
    { "id": 88, "role": "user", "contentKind": "raw", "content": "我晚上比较想聊天，白天容易分心" },
    { "id": 101, "role": "user", "contentKind": "raw", "content": "我一般慢热，熟了才会比较依赖人" }
  ]
}
```

### 5.3 各 Proposer 的 readOnlyContext 固定范围

`readOnlyContext` 的 section/path 范围由 Proposer 类型和目标 section/path 固定决定，不随 observed messages 语义变化：

| Proposer               | Writable target                | Read-only context                                                                                                                                  |
| ---------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentStateProposer` | `scene`, `participants`        | `working.recentEpisodes`、`working.todos` active 子集、`longTerm.relationship`                                                                     |
| `todoProposer`         | `todos`                        | `current.scene`、`current.participants`、`working.recentEpisodes`、`longTerm.relationship`、`longTerm.userProfile`                                 |
| `episodeProposer`      | `recentEpisodes`, `milestones` | `current.scene`、`current.participants`、`working.todos` active 子集、`longTerm.relationship`、`longTerm.userProfile`、`longTerm.assistantProfile` |
| `coreProposer`         | `core`                         | `current.scene`、`current.participants`、`working.recentEpisodes`、`longTerm.milestones`、非目标 core sibling arrays                               |
| `compactionProposer`   | 被预算阻塞的 section/path      | `current.scene`、`current.participants`、`working.todos` active 子集、`working.recentEpisodes`、`longTerm.milestones`、非目标 core sibling arrays  |

core sibling arrays 指 `longTerm.worldFacts`、`longTerm.userProfile`、`longTerm.assistantProfile`、`longTerm.relationship` 中除本次 `targetPaths` 外的数组。例如目标 path 为 `userProfile` 时，sibling arrays 为 `worldFacts`、`assistantProfile`、`relationship`。

normal 模式下 `coreProposer` 的 `targetPaths` 为 `[]`，表示全部 core 子数组均为 writable target——Proposer 可向任意子数组输出 patch。此时不存在"非目标 sibling"，`readOnlyContext` 不包含任何 core 子数组（已有 core 数据全部在 `writableState` 中，不重复放入 `readOnlyContext`，见 §5.4）。维护模式下 `targetPaths` 必填且只含一个 path（见 §5.2），其余子数组作为 sibling 出现在 `readOnlyContext` 中。

### 5.4 边界规则

**写入范围**

- `sectionResults` 只能包含 `task.targetSections`；Proposer 可读取 `readOnlyContext`，但不得输出非 target section 的 patch。
- target section/path 的当前状态只放在 `writableState`；若某固定背景范围概念上包含 target，本次仍以 `writableState` 为准，不在 `readOnlyContext` 重复放一份。

**证据（普通模式）**

- `task.trigger` 为 `{ type: "lagThreshold" }`。普通写入 patch 的 `evidenceRefs.messageId` 必须来自 `evidenceMessages`；不得引用 `readOnlyContext` 中 item 的历史证据来证明新事实。

**证据（维护模式）**

- `task.trigger` 为 `{ type: "lengthBudget", limit, blockedPatchSummary }`。维护 patch 的 `evidenceRefs` 只能复制 `writableState` 中 source items 的既有 `evidenceRefs`；`evidenceMessages` 只供 Reducer 校验这些既有证据的 quote，不能被 Proposer 用来摘录新事实。
- `blockedPatchSummary` 只解释触发原因，不能作为 compaction 证据来源。

**readOnlyContext 组装**

- `readOnlyContext` 必须带结构化 section 名称，不能把 Renderer 文本或旧 summary 整段塞给 Proposer。
- 固定范围以完整 segment 为单位：一个 section/path 一旦纳入，全量输入该 segment 当前 items（含 §1 定义的完整字段，无值字段显式传 null），不做 last N、相似度筛选或按 `blockedPatchSummary` 语义筛选。
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
- `patches` 数组中每个 patch 含 `op`、`path`/`itemId`/`itemIds`（按 §4 必填规则）、`value`（按 §4 必填规则）、`evidenceKind`（§3 枚举）、`evidenceRefs`（至少 1 项，每项含 `messageId` integer 和 `quote` string max 80 字符）。
- `evidenceKind` 是 Reducer 做 policy gate 的枚举输入（§6）。Reducer 不把它当可信度分数；真实证据仍必须通过 `messageId + quote` 校验（§7）。
- `patchId` 由 Reducer 生成，Proposer 不需要输出，用于 event log 引用。
- `core` section 的 patch 额外需要 `path` 指定 `longTerm` 下的子数组（`worldFacts`/`userProfile`/`assistantProfile`/`relationship`）。示例：

```json
{
  "op": "addItem",
  "path": "userProfile",
  "value": { "text": "性格: 内向(初识) > 依赖(熟悉后) | 恐高" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我其实挺内向的，但熟了就会很粘人" }]
}
```

- `compactionProposer` 的 schema 额外限制：只能输出 `mergeItems`，且 `evidenceKind` 只能是 `memory_compaction`。维护模式 `observedMessageIds=[]`，compactionProposer 无法见证新的用户修正，因此 `user_correction` 不适用——用户修正走 normal proposer。输出 `addItem`、通用删除、跨 section 合并或跨 core path 合并均非法。
- 如果 adapter 返回 `ok` 但 `sectionResults` 缺了某个 target section（schema 约束未拦住的漏输出），Reducer 视为该 section `rejected`（reason=`schema_invalid`），按标准 `rejected` 规则推进 cursor，落 events 表。推进理由：adapter 已返回 `ok`（LLM 调用成功），漏输出属于 schema 约束未拦住的罕见边缘，重跑同输入不一定能修复且不值得为此卡住整个 section；正确做法是修正 schema 约束使其强制 required sections，从根源杜绝漏输出。

compaction 输出示例（仍使用 `sectionResults`，但只允许 `mergeItems`）：

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

## 6. Patch Policy Table

Reducer 按 `section + op + evidenceKind` 查此表判断是否允许写入。不在表中的组合：Reducer 拒绝并记录 `rejected`（reason: `policy_not_allowed`）。

| section / op                                        | 允许的 evidenceKind                                                                                                                            | 备注                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scene.setField` / `scene.clearField`               | `scene_change`, `user_correction`, `assistant_correction`                                                                                      | 覆盖式状态；旧场景不得凭空延续；correction 用于修正错误记忆的场景                                                                                                     |
| `participants.setField` / `participants.clearField` | `participant_change`, `user_correction`, `assistant_correction`                                                                                | 只写当前状态，不写长期人格；correction 用于修正错误记忆的状态                                                                                                         |
| `todos.addItem`                                     | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`                                                                 | 模糊愿望不写入                                                                                                                                                        |
| `todos.updateItem`                                  | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`, `user_correction`, `assistant_correction`                      | 更新待办                                                                                                                                                              |
| `todos.mergeItems`                                  | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment`, `user_correction`, `assistant_correction`, `memory_compaction` | 合并重复待办                                                                                                                                                          |
| `todos.completeTodo`                                | `todo_completion`                                                                                                                              | 完成必须有终止证据                                                                                                                                                    |
| `todos.cancelTodo`                                  | `todo_cancel`, `user_correction`, `assistant_correction`                                                                                       | 修正优先                                                                                                                                                              |
| `todos.expireTodo`                                  | `todo_expiration`                                                                                                                              | 仅短期待办允许失效                                                                                                                                                    |
| `recentEpisodes.addItem`                            | `recent_episode`                                                                                                                               | 滑动窗口，普通 episode 到期滚出                                                                                                                                       |
| `recentEpisodes.updateItem`                         | `recent_episode`, `user_correction`, `assistant_correction`                                                                                    |                                                                                                                                                                       |
| `recentEpisodes.mergeItems`                         | `recent_episode`, `user_correction`, `assistant_correction`, `memory_compaction`                                                               | 溢出由滑动窗口处理；`memory_compaction` 为保留扩展（compaction 暂不针对本 section），normal proposer 去重用 `recent_episode`/`user_correction`/`assistant_correction` |
| `milestones.addItem`                                | `relationship_milestone`                                                                                                                       | 普通日常不得进入                                                                                                                                                      |
| `milestones.updateItem`                             | `user_correction`, `assistant_correction`                                                                                                      | 里程碑保守更新                                                                                                                                                        |
| `milestones.mergeItems`                             | `user_correction`, `assistant_correction`, `memory_compaction`                                                                                 | 仅合并重叠里程碑，不自动删除                                                                                                                                          |
| `core.addItem`                                      | `long_term_fact`                                                                                                                               | 长期事实（含行为推断），单次临时剧情不得进入                                                                                                                          |
| `core.updateItem`                                   | `user_correction`, `assistant_correction`                                                                                                      | core 只能被明确修正改变                                                                                                                                               |
| `core.mergeItems`                                   | `user_correction`, `assistant_correction`, `memory_compaction`                                                                                 | 仅合并同 path 下重叠 item                                                                                                                                             |

## 7. Evidence 校验：Quote 模糊匹配

Reducer 校验 `evidenceRefs.quote` 是否能在对应 `messageId` 的 raw message 内容中找到。普通模式和维护模式都从 envelope 的 `evidenceMessages` 查找；维护模式下的 `evidenceMessages` 是 `writableState` source items 既有 evidenceRefs 对应的 raw messages。LLM 经常改写 quote，精确匹配会大量误判，因此采用模糊匹配：

1. **归一化**：去除 quote 和 message content 的空白、标点、大小写差异。归一化函数：`str.toLowerCase().replace(/[\s，。！？、,.!?;:""'']/g, "")`。
2. **子串匹配**：如果归一化后的 quote 是归一化后 message content 的子串，则匹配成功。
3. **相似度匹配**：如果子串匹配失败，计算归一化 quote 与 message content 所有等长子串的最大相似度（基于 Levenshtein 距离）：`1 - levenshtein(normalizedQuote, normalizedSubstring) / normalizedQuote.length`。对于长 message，只取与 quote 等长的窗口做比较，避免全文 Levenshtein 的性能问题。相似度 >= 0.75 则匹配成功。
4. **匹配失败**：该 patch 记录 `rejected`（reason: `quote_not_found`），cursor 按 [write-protocol.md](write-protocol.md) §3 规则处理。

阈值 0.75 可调：假阳性过高调到 0.8，假阴性过高调到 0.7。

## 8. Section 长度预算

| Section                     | item 数量上限 | 溢出处理                                       |
| --------------------------- | ------------- | ---------------------------------------------- |
| `scene`                     | -             | 单对象，无 item 数量限制，字段级覆盖           |
| `participants`              | -             | 单对象，无 item 数量限制，字段级覆盖           |
| `todos`                     | 15            | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `recentEpisodes`            | 5             | Reducer 自动滚出最旧 item（滑动窗口）          |
| `longTerm.milestones`       | 20            | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.worldFacts`       | 10            | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.userProfile`      | 15            | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.assistantProfile` | 15            | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.relationship`     | 10            | 暂缓新增，触发 compaction task；失败后最终拒绝 |

`recentEpisodes` 的滑动窗口由 Reducer 在每次 apply 后执行：如果 item 数 > 5，移除最旧的（按 `createdAtMessageId` 排序），被移除的 item 不记录事件（自然遗忘）。

`recentEpisodes` 存储上限 5 但 Renderer 只渲染最近 3 条（见 [rendering-and-context.md](rendering-and-context.md) §5）。差额 2 条为 Proposer 的 `readOnlyContext` 提供额外上下文连续性，避免窗口边界处信息断裂；主聊天模型只看 3 条以保持上下文紧凑。

`expiresAtTime` 过期清理（见 [write-protocol.md](write-protocol.md) §1.3 步骤 7）同样不产生事件行。Reducer 每次 apply 后扫描 `expiresAtTime < now`（wall-clock）的 todo 从数组移除。这两类"自然遗忘"不产生审计事件是刻意取舍：它们是确定性策略驱动的例行清理，记录会淹没 events 表的 patch 决策行。如需排查某 item 为何消失，可从 `memory_state` 快照和 `createdAtMessageId`/`expiresAtTime` 推断。

其它 section 溢出时不立即把当前消息视为已处理。Reducer 先记录 `deferred` 事件并触发 `compactionProposer` 维护任务。维护任务只能通过 `mergeItems + evidenceKind: "memory_compaction"` 合并同 section/同 path 下的重复或高度重叠 item，不能使用通用删除，也不能把新事实写入长期记忆。compaction task 有界执行：同一 section/path 对同一阻塞窗口最多尝试 1 次。若维护任务 `accepted` 并释放容量，原 section 在下一次 tick 重新处理同一消息窗口（`deferred` 已阻止 cursor 推进，无论同 tick 是否存在 `accepted` patch，见 [write-protocol.md](write-protocol.md) §3）；若维护任务 `noop`/`unable_to_decide`，或释放容量后仍超限，则原新增 patch 最终 `rejected: length_budget_exceeded` 并推进 cursor；若维护任务技术性失败（`error`），按 [write-protocol.md](write-protocol.md) §3.1 error 恢复策略处理。避免永久卡住。

## 9. 审计与运营日志

Memory v2 把"patch 决策"与"LLM 运营事件"分两类记录。前者是 Proposer 产出判断后 Reducer 的写入决策，后者是 Proposer 调用本身的技术性结果（成功、失败、信息不足）。两者查询模式不同：查 memory 演化走 events 表，查 provider 健康度走 ops_log。

Reducer 写回 `memory_state` 时，`meta.recovery` 的更新与 cursor 推进在同一事务内完成，保证"cursor 推进 ⇔ 计数器重置"原子一致，不会出现 cursor 推进了但恢复态没清的中间态。

### 9.1 patch 决策表

每个 patch 产生一行 event；`noop` 产生一行占位（`decision=noop`，`patch_id` 为 null）。一个 section 一个 tick 可能有多个 patch（如 `todoProposer` 同时 `addItem` 一个新待办 + `completeTodo` 另一个旧待办），因此可能有多行 event。section 级 cursor 推进是派生的：看该 section 该 tick 的所有 event 行聚合（[write-protocol.md](write-protocol.md) §3）。

```sql
CREATE TABLE chat_memory_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  tick_id         BIGINT NOT NULL,
  section         TEXT NOT NULL,
  decision        TEXT NOT NULL,           -- accepted | rejected | deferred | noop
  patch_id        TEXT,                    -- Reducer 生成的 patch 唯一 id（如有）
  op              TEXT,                    -- patch op（如有）
  item_id         TEXT,                    -- 目标 item id（如有）
  evidence_kind   TEXT,                    -- evidenceKind（如有）
  reject_reason   TEXT,                    -- 拒绝原因码（仅 rejected 时）
  maintenance_task_id TEXT,                -- 关联 compaction task（如有）
  patch_summary   JSONB,                   -- patch 的精简摘要（op + value + evidenceRefs）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_events_user_preset
  ON chat_memory_events(user_id, preset_id, created_at DESC);

CREATE INDEX idx_memory_events_section_decision
  ON chat_memory_events(user_id, preset_id, section, decision);
```

`decision` 合法值（per-patch，非 section 聚合）：

- `accepted`：该 patch 被 apply。
- `rejected`：该 patch 被拒（policy/quote/schema 等）。一个 section 一个 tick 的多个 patch 可能部分 `accepted` 部分 `rejected`，各自落行。
- `deferred`：该 patch（`addItem`）被长度预算阻塞，已触发 compaction task。
- `noop`：Proposer 明确判断该 section 无变化。占位行，`patch_id`/`op`/`item_id`/`evidence_kind`/`patch_summary` 为 null。一个 section 一个 tick 最多一行 noop。

section 级 cursor 推进是派生的：该 section 该 tick 有任一 `deferred` 行则不推进，无论是否存在 `accepted` 行；无 `deferred` 时，有任一 `accepted`/`noop`/`rejected` 行即推进（见 [write-protocol.md](write-protocol.md) §3）。

`reject_reason` 合法值（仅 `rejected` 时填写）：

- `schema_invalid`：patch 结构不合规。
- `message_id_not_found`：evidenceRefs 的 messageId 不存在。
- `quote_not_found`：quote 模糊匹配失败。
- `policy_not_allowed`：section + op + evidenceKind 不在 policy table。
- `item_not_found`：itemId 指向不存在的 item。
- `length_budget_exceeded`：section item 数量超上限；首次为 `deferred`，compaction 无合并空间后为最终 `rejected`。

`item_id` 列：对单 item 操作（`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`）存目标 item id；对 `mergeItems` 存 `itemIds.join(",")`；对 `addItem`/`setField`/`clearField`/`noop` 存 null。完整信息在 `patch_summary` JSONB 中。

### 9.2 运营事件表与恢复态

```sql
CREATE TABLE chat_memory_ops_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  preset_id       TEXT NOT NULL,
  tick_id         BIGINT NOT NULL,
  section         TEXT NOT NULL,
  proposer        TEXT NOT NULL,
  outcome         TEXT NOT NULL,           -- ok | llm_call_failed | safety_policy_blocked | output_schema_invalid | unable_to_decide | halted
  attempt         INTEGER NOT NULL,        -- 本次 tick 的第几次尝试
  detail          JSONB,                   -- provider finish_reason / 错误消息 / 扩展上下文大小等
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_ops_log_health
  ON chat_memory_ops_log(user_id, preset_id, created_at DESC);

CREATE INDEX idx_memory_ops_log_outcome
  ON chat_memory_ops_log(user_id, preset_id, outcome, created_at DESC);
```

`outcome` 合法值：

- `ok`：Proposer 正常返回结构化输出（无论结果是 patches 还是 noop）。此后控制权交给 Reducer，patch 决策落在 events 表，不再在 ops_log 记录。
- `llm_call_failed`：网络/超时/provider 异常，瞬时性。
- `safety_policy_blocked`：provider 安全策略拦截（finish_reason 含 content_filter 或 refusal）。
- `output_schema_invalid`：provider 返回了内容但 adapter 无法解析为 §5.5 schema。与 events 表的 `schema_invalid`（Reducer 校验 patch 字段结构）区分：本码发生在 patch 产生之前，由 adapter 识别。schema-constrained output 正常情况下不应出现此错误，出现即 provider/schema 配置 bug，视为持续性，不重试同输入。
- `unable_to_decide`：Proposer 自认信息不足。首次记录并扩窗口重试一次；二次仍 `unable_to_decide` → 推进 cursor。ops_log outcome 始终记 `unable_to_decide`（记实际发生的事），不触发 halt。
- `halted`：仅用于瞬时错误（`llm_call_failed`/`safety_policy_blocked`）达 `consecutiveErrors` 阈值（3 次）后触发 halt（`meta.halted=true`）。`output_schema_invalid` 直接触发 halt 时也使用此 outcome。`unable_to_decide` 路径不使用此 outcome（它推进 cursor 而非 halt）。halt 作用于该 `userId/presetId` 的会话——`meta.halted` 存在于单个 `memory_state`，true 时该会话的聊天接口拒绝新消息，不影响其他会话。

ops_log 只记 Proposer 调用层的结果。patch 是否被 Reducer 接受、拒绝、暂缓，查 events 表。

`meta.recovery`（§1 概念形态）是 tick orchestrator 读写恢复态的载体，与 ops_log 配合：

```js
recovery: {
  [section]: {
    consecutiveErrors: 0,            // error 连续计数，达阈值（write-protocol.md §3.1）升级推进
    awaitingContextExpansion: false, // unable_to_decide 首次后置 true，下 tick 发扩大的 contextWindow
    lastErrorReason: null,          // 最近一次 outcome（非 ok）
    lastErrorTickId: null
  }
}
```

语义：

- `consecutiveErrors`：仅瞬时 error outcome（`llm_call_failed`/`safety_policy_blocked`）时 +1，`accepted`/`rejected`/`noop`/`deferred` 时重置为 0。`output_schema_invalid` 不走此计数器——它是持续性错误，直接触发 halt（见 [write-protocol.md](write-protocol.md) §3.1）。达 [write-protocol.md](write-protocol.md) §3.1 阈值（3 次）后触发 halt（`meta.halted=true`），`consecutiveErrors` 保留不清零，等手动 resume 时重置。
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
- `output_schema_invalid`：provider 返回了内容但 adapter 无法解析为 §5.5 schema。schema-constrained output 正常情况下不应出现此错误，出现即 provider/schema 配置 bug。命名上与 events 表的 `schema_invalid`（Reducer 校验 patch 字段结构）区分：本码发生在 patch 产生之前，由 adapter 识别。
- `llm_call_failed`：网络异常、超时、provider 5xx、其它未归类异常。

tick orchestrator 行为：

- `status: "ok"` → tick orchestrator 检查 output 的 `sectionResults`：`unable_to_decide` 的 section 由 tick orchestrator 直接处理（写 ops_log + 更新 `meta.recovery`，按 [write-protocol.md](write-protocol.md) §3.1 恢复策略），**不交 Reducer**；`patches`/`noop` 的 section 才交 Reducer 处理（patch 决策落 events 表）。Reducer 永远不接触 `unable_to_decide`。
- `status: "error"` → 不交给 Reducer，直接写 ops_log（outcome=对应 reason）、更新 `meta.recovery`、按 [write-protocol.md](write-protocol.md) §3.1 恢复策略决定是否重试或触发 halt。

Reducer 永远只处理 `status: "ok"` 的输出，不会看到空输出或伪造输出。adapter 在 `status: "error"` 时由 tick orchestrator 直接处理，不把错误结果传给 Reducer；adapter 返回 `ok` 但 output 残缺（schema 未拦住的漏输出）的情况见 §5.5，由 Reducer 记 `rejected: schema_invalid`。
