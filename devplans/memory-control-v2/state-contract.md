# Memory Control v2 状态契约

本文是 Memory Control v2 的**静态契约权威来源**：所有数据 shape、枚举、查表、校验算法和存储落点都在这里定义一次。写入流程见 [write-protocol.md](write-protocol.md)，顶层判断见 [../plan.md](../plan.md)。

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
    perSectionCursor: {}        // { section: coveredUntilMessageId }
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
  expiresAtMessageId: null,     // 可选，短期待办用。由 Proposer 在 addItem 的 value 中设置，Reducer 校验为正整数
  tags: ["短期"]                 // 可选
}
```

`scene` 和 `participants` 是当前状态，用轻量字段表达，但记录最后证据与更新时间。`todos` 与 `recentEpisodes` 是工作区记忆；`milestones` 与 core 各数组位于长期区并保留 item 级证据。

## 2. 记忆分层

| Section          | 存储位置                        | 作用                           | 生命周期       | 写入原则                                                 |
| ---------------- | ------------------------------- | ------------------------------ | -------------- | -------------------------------------------------------- |
| `scene`          | `current.scene`                 | 当前地点、时间、氛围、环境锚点 | 高频、覆盖式   | 存完整当前状态；无变化不改                               |
| `participants`   | `current.participants`          | 用户和助手当前情绪、动作、意图 | 高频、覆盖式   | 只记录当前状态，不承载长期人格                           |
| `todos`          | `working.todos`                 | 未完成承诺、约定、澄清项       | 中频、事件型   | 支持创建、完成、取消、过期；删除必须有终止证据           |
| `recentEpisodes` | `working.recentEpisodes`        | 最近几次有意义互动             | 高频、滑动窗口 | 普通 episode 到期自然滚出；重要 episode 可晋升 milestone |
| `milestones`     | `longTerm.milestones`           | 关系或剧情关键转折             | 低频、归档型   | 长期保存，默认新增或合并；普通日常不得进入               |
| `core`           | `longTerm.*`（不含 milestones） | 长期事实、偏好、人格、关系模式 | 低频、保守     | 只接受明确设定或用户修正                                 |

每个 section 拥有独立 `coveredUntilMessageId`（存于 `meta.perSectionCursor`）。section 之间独立推进，互不阻塞；写入执行仍受同一 `userId/presetId` 串行队列约束。

## 3. Evidence Kind 合法值

| evidenceKind             | 说明                                      |
| ------------------------ | ----------------------------------------- |
| `user_request`           | 用户明确请求系统/角色稍后做某事           |
| `user_commitment`        | 用户明确承诺稍后做某事                    |
| `assistant_commitment`   | assistant 明确承诺稍后做某事              |
| `todo_completion`        | 待办已完成                                |
| `todo_cancel`            | 待办被取消                                |
| `todo_expiration`        | 短期待办自然失效或被澄清为不再需要        |
| `scene_change`           | 地点、时间、环境或氛围明确变化            |
| `participant_state`      | 用户或 assistant 当前情绪、动作、意图变化 |
| `recent_episode`         | 最近发生的有意义互动                      |
| `relationship_milestone` | 关系或剧情关键转折                        |
| `user_correction`        | 用户明确修正旧记忆或设定                  |
| `long_term_fact`         | 用户/设定明确表达的长期事实               |
| `memory_compaction`      | 基于已有 memory item 的预算维护与去重合并 |

## 4. Patch Op 合法值与约束

| op             | 允许 section                                    | 含义                         |
| -------------- | ----------------------------------------------- | ---------------------------- |
| `setField`     | `scene`, `participants`                         | 设置覆盖式状态字段           |
| `clearField`   | `scene`, `participants`                         | 清除已失效的覆盖式状态字段   |
| `addItem`      | `todos`, `recentEpisodes`, `milestones`, `core` | 新增 item                    |
| `updateItem`   | `todos`, `recentEpisodes`, `milestones`, `core` | 局部更新已有 item            |
| `mergeItems`   | `todos`, `recentEpisodes`, `milestones`, `core` | 合并重复或高度重叠 item      |
| `completeTodo` | `todos`                                         | 将待办标记为完成             |
| `cancelTodo`   | `todos`                                         | 将待办标记为取消             |
| `expireTodo`   | `todos`                                         | 将短期待办标记为失效         |
| `correctItem`  | `todos`, `milestones`, `core`                   | 基于用户明确修正纠错         |

字段必填规则：

- `path`：对 `setField`/`clearField`/`updateItem` 必填。对 `scene`/`participants` 是字段名（如 `location`、`mood`、`user.emotion`）。对 `core` 的所有 op（`addItem`/`updateItem`/`mergeItems`/`correctItem`）也必填，值为长期区子数组名：`worldFacts`/`userProfile`/`assistantProfile`/`relationship`。`milestones` 虽存于 `longTerm`，但作为独立 section 操作，`addItem` 不需要 `path`。`todos`/`recentEpisodes` 的 `addItem` 也不需要 `path`（单一数组）。
- `itemId`：对 `updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`correctItem` 必填（单个 item 的 id）。
- `itemIds`（数组）：对 `mergeItems` 必填，指定要合并的多个 itemId。`value` 是合并后的新 item 值，至少包含 `text`。
- `value`：对 `setField`/`addItem`/`updateItem`/`correctItem` 必填。
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
    "trigger": { "type": "lagThreshold" }
  },
  "writableState": {
    "working": {
      "recentEpisodes": [
        {
          "id": "episode:7",
          "text": "雨夜争执 > 和解 | 用户表达不安",
          "evidenceRefs": [{ "messageId": 110, "quote": "我不是想和你吵" }],
          "evidenceKind": "recent_episode",
          "createdAtMessageId": 110
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
          "createdAtMessageId": 80
        }
      ]
    }
  },
  "readOnlyContext": {
    "current": { "scene": {}, "participants": {} },
    "working": { "todos": [] },
    "longTerm": {
      "relationship": [{ "id": "core:relationship:3", "text": "关系模式: 慢热 | 安全感确认后更依赖" }],
      "userProfile": [{ "id": "core:user:5", "text": "偏好: 低压陪伴 | 不喜欢被逼问" }]
    }
  },
  "evidenceMessages": [
    { "id": 121, "role": "user", "contentKind": "raw", "content": "我刚才其实很怕你会走，所以才一直不敢抬头。" },
    { "id": 122, "role": "assistant", "contentKind": "raw", "content": "我没有走，我只是想等你愿意看我的时候再靠近。" }
  ]
}
```

字段说明：

- `task`：本次 proposer、mode、target sections/paths、observed message ids 和 `trigger`。
- `writableState`：本次允许写入的目标 section/path 当前状态；item 一律保留 `evidenceRefs` 和 `evidenceKind`。
- `readOnlyContext`：可读取的背景 memory，用于理解对话，不得作为新事实证据。
- `evidenceMessages`：用于 quote 校验的 raw messages。普通模式下是最近对话 raw messages；维护模式下是 `writableState` source items 既有 `evidenceRefs` 对应的 raw messages。

### 5.2 维护模式字段语义

`compactionProposer` 使用 `mode: "maintenance"` 的同形 envelope。各字段在维护模式下的取值与约束：

| Envelope 字段 | 维护模式取值 / 范围 | 约束 |
| --- | --- | --- |
| `task.proposer` | `compactionProposer` | 只由 Reducer 长度预算门触发，不参与普通 lag 轮询 |
| `task.mode` | `"maintenance"` | Reducer 按维护模式切换 policy：只允许安全合并，不允许新增事实 |
| `task.targetSections` / `targetPaths` | 被预算阻塞的 section/path | `targetPaths` 对 `core` 必填；禁止跨 section 或跨 core path 合并 |
| `task.observedMessageIds` | `[]` | 维护任务不观察新的最近对话窗口 |
| `task.trigger` | `{ type: "lengthBudget", limit, blockedPatchSummary }` | `blockedPatchSummary` 只解释触发原因，不能作为 compaction 证据来源 |
| `writableState` | 目标 section/path 的既有 items 全集 | 不按数量、相似度或 `blockedPatchSummary` 语义筛选；item 必须带 `evidenceRefs` 和 `evidenceKind` |
| `readOnlyContext` | `current.scene`、`current.participants`、`working.todos` active 子集、`working.recentEpisodes`、`longTerm.milestones`、非目标 core sibling arrays | 只用于防止误合并，不能作为 evidenceRefs 来源；范围由目标 section/path 固定决定 |
| `evidenceMessages` | `writableState` source items 既有 `evidenceRefs` 对应的 raw messages | 只供 Reducer 校验 quote；Proposer 不得从这里摘录新事实 |

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
    }
  },
  "writableState": {
    "longTerm": {
      "userProfile": [
        {
          "id": "core:1",
          "text": "偏好: 晚上聊天 | 慢热",
          "evidenceRefs": [{ "messageId": 88, "quote": "我晚上比较想聊天" }],
          "evidenceKind": "long_term_fact"
        },
        {
          "id": "core:9",
          "text": "关系模式: 需要慢慢熟悉后再依赖",
          "evidenceRefs": [{ "messageId": 101, "quote": "我一般慢热" }],
          "evidenceKind": "long_term_fact"
        }
      ]
    }
  },
  "readOnlyContext": {
    "current": { "scene": { "time": "深夜", "mood": "安静" }, "participants": { "user": { "emotion": "放松" } } },
    "longTerm": {
      "milestones": [{ "id": "milestone:2", "text": "关系转折: 第一次明确互相信任" }],
      "relationship": [{ "id": "core:rel:3", "text": "关系模式: 慢热 | 安全感确认后更依赖" }]
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
| `compactionProposer`   | 被预算阻塞的 section/path      | `current.scene`、`current.participants`、`working.todos` active 子集、`working.recentEpisodes`、`longTerm.milestones`、非目标 core sibling arrays |

core sibling arrays 指 `longTerm.worldFacts`、`longTerm.userProfile`、`longTerm.assistantProfile`、`longTerm.relationship` 中除本次 `targetPaths` 外的数组。例如目标 path 为 `userProfile` 时，sibling arrays 为 `worldFacts`、`assistantProfile`、`relationship`。

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
- 固定范围以完整 segment 为单位：一个 section/path 一旦纳入，全量输入该 segment 当前 items，不做 last N、相似度筛选或按 `blockedPatchSummary` 语义筛选。
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
- `patches` 数组中每个 patch 含 `op`、`path`/`itemId`/`itemIds`（按 §4 必填规则）、`value`、`evidenceKind`（§3 枚举）、`evidenceRefs`（至少 1 项，每项含 `messageId` integer 和 `quote` string max 80 字符）。
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

- `compactionProposer` 的 schema 额外限制：只能输出 `mergeItems`，且 `evidenceKind` 只能是 `memory_compaction` 或基于明确用户修正的 `user_correction`。输出 `addItem`、通用删除、跨 section 合并或跨 core path 合并均非法。
- 如果某个 Proposer 没输出目标 section 的结果，Reducer 视为该 section `error`，不猜测推进。

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

| section / op                                        | 允许的 evidenceKind                                                                               | 备注                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| `scene.setField` / `scene.clearField`               | `scene_change`                                                                                    | 覆盖式状态；旧场景不得凭空延续  |
| `participants.setField` / `participants.clearField` | `participant_state`                                                                               | 只写当前状态，不写长期人格      |
| `todos.addItem`                                     | `user_request`, `user_commitment`, `assistant_commitment`                                         | 模糊愿望不写入                  |
| `todos.updateItem`                                  | `user_request`, `user_commitment`, `assistant_commitment`, `user_correction`                      | 更新待办                        |
| `todos.mergeItems`                                  | `user_request`, `user_commitment`, `assistant_commitment`, `user_correction`, `memory_compaction` | 合并重复待办                    |
| `todos.completeTodo`                                | `todo_completion`                                                                                 | 完成必须有终止证据              |
| `todos.cancelTodo`                                  | `todo_cancel`, `user_correction`                                                                  | 用户修正优先                    |
| `todos.expireTodo`                                  | `todo_expiration`                                                                                 | 仅短期待办允许失效              |
| `todos.correctItem`                                 | `user_correction`                                                                                 | 待办纠错                        |
| `recentEpisodes.addItem`                            | `recent_episode`                                                                                  | 滑动窗口，普通 episode 到期滚出 |
| `recentEpisodes.updateItem`                         | `recent_episode`, `user_correction`                                                               |                                 |
| `recentEpisodes.mergeItems`                         | `recent_episode`, `user_correction`, `memory_compaction`                                          | 普通溢出优先由滑动窗口处理      |
| `milestones.addItem`                                | `relationship_milestone`, `user_correction`                                                       | 普通日常不得进入                |
| `milestones.updateItem` / `correctItem`             | `user_correction`                                                                                 | 里程碑保守更新                  |
| `milestones.mergeItems`                             | `user_correction`, `memory_compaction`                                                            | 仅合并重叠里程碑，不自动删除    |
| `core.addItem`                                      | `long_term_fact`, `user_correction`                                                               | 单次临时剧情不得进入            |
| `core.updateItem` / `correctItem`                   | `user_correction`                                                                                 | core 只能被用户修正改变         |
| `core.mergeItems`                                   | `user_correction`, `memory_compaction`                                                            | 仅合并同 path 下重叠 item       |

## 7. Evidence 校验：Quote 模糊匹配

Reducer 校验 `evidenceRefs.quote` 是否能在对应 `messageId` 的 raw message 内容中找到。普通模式和维护模式都从 envelope 的 `evidenceMessages` 查找；维护模式下的 `evidenceMessages` 是 `writableState` source items 既有 evidenceRefs 对应的 raw messages。LLM 经常改写 quote，精确匹配会大量误判，因此采用模糊匹配：

1. **归一化**：去除 quote 和 message content 的空白、标点、大小写差异。归一化函数：`str.toLowerCase().replace(/[\s，。！？、,.!?;:""'']/g, "")`。
2. **子串匹配**：如果归一化后的 quote 是归一化后 message content 的子串，则匹配成功。
3. **相似度匹配**：如果子串匹配失败，计算归一化 quote 与 message content 所有等长子串的最大相似度（基于 Levenshtein 距离）：`1 - levenshtein(normalizedQuote, normalizedSubstring) / normalizedQuote.length`。对于长 message，只取与 quote 等长的窗口做比较，避免全文 Levenshtein 的性能问题。相似度 >= 0.75 则匹配成功。
4. **匹配失败**：该 patch 记录 `rejected`（reason: `quote_not_found`），cursor 按 [write-protocol.md](write-protocol.md) §3 规则处理。

阈值 0.75 可调：假阳性过高调到 0.8，假阴性过高调到 0.7。

## 8. Section 长度预算

| Section          | item 数量上限 | 溢出处理                                       |
| ---------------- | ------------- | ---------------------------------------------- |
| `scene`          | -             | 单对象，无 item 数量限制，字段级覆盖           |
| `participants`   | -             | 单对象，无 item 数量限制，字段级覆盖           |
| `todos`          | 15            | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `recentEpisodes` | 5             | Reducer 自动滚出最旧 item（滑动窗口）          |
| `longTerm.milestones` | 20       | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.worldFacts` | 10       | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.userProfile` | 15      | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.assistantProfile` | 15  | 暂缓新增，触发 compaction task；失败后最终拒绝 |
| `longTerm.relationship` | 10      | 暂缓新增，触发 compaction task；失败后最终拒绝 |

`recentEpisodes` 的滑动窗口由 Reducer 在每次 apply 后执行：如果 item 数 > 5，移除最旧的（按 `createdAtMessageId` 排序），被移除的 item 不记录事件（自然遗忘）。

其它 section 溢出时不立即把当前消息视为已处理。Reducer 先记录 `deferred` 事件并触发 `compactionProposer` 维护任务。维护任务只能通过 `mergeItems + evidenceKind: "memory_compaction"` 合并同 section/同 path 下的重复或高度重叠 item，不能使用通用删除，也不能把新事实写入长期记忆。compaction task 有界执行：同一 section/path 对同一阻塞窗口最多尝试 1 次。若维护任务 `accepted` 并释放容量，原 section 在下一次 tick 重新处理同一消息窗口；若维护任务 `noop`/`unable_to_decide`/`error`，或释放容量后仍超限，则原新增 patch 最终 `rejected: length_budget_exceeded` 并推进 cursor，避免永久卡住。

## 9. 审计事件表

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

`item_id` 列：对单 item 操作（`updateItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`correctItem`）存目标 item id；对 `mergeItems` 存 `itemIds.join(",")`；对 `addItem`/`setField`/`clearField` 存 null。完整信息在 `patch_summary` JSONB 中。

详细调试信息（完整 patch、完整 state diff、prompt 内容等）用 `logger` 输出到日志，不进表。
