# Memory Control v2 状态契约

本文定义 Memory Control v2 的权威状态形态。它承接顶层设计中的状态 schema、section、item、evidenceKind、patch op 和长度预算。顶层判断见 [../plan.md](../plan.md)，写入执行顺序见 [write-protocol.md](write-protocol.md)。

## 1. 权威状态与存储落点

Memory v2 的权威状态是单一 `memory_state` JSONB blob。它保存当前完整 memory state，并由 Reducer 原子写回。旧 `rolling_summary` 和 `core_memory` 只能作为 legacy 字段存在，不再参与 v2 写入决策。

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

| Section          | 存储位置                    | 作用                           | 生命周期       | 写入原则                                                 |
| ---------------- | --------------------------- | ------------------------------ | -------------- | -------------------------------------------------------- |
| `scene`          | `current.scene`             | 当前地点、时间、氛围、环境锚点 | 高频、覆盖式   | 存完整当前状态；无变化不改                               |
| `participants`   | `current.participants`      | 用户和助手当前情绪、动作、意图 | 高频、覆盖式   | 只记录当前状态，不承载长期人格                           |
| `todos`          | `working.todos`             | 未完成承诺、约定、澄清项       | 中频、事件型   | 支持创建、完成、取消、过期；删除必须有终止证据           |
| `recentEpisodes` | `working.recentEpisodes`    | 最近几次有意义互动             | 高频、滑动窗口 | 普通 episode 到期自然滚出；重要 episode 可晋升 milestone |
| `milestones`     | `longTerm.milestones`       | 关系或剧情关键转折             | 低频、归档型   | 长期保存，默认新增或合并；普通日常不得进入               |
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

---

## 4. Patch Op 合法值

| op              | 允许 section                                    | 含义                         |
| --------------- | ----------------------------------------------- | ---------------------------- |
| `setField`      | `scene`, `participants`                         | 设置覆盖式状态字段           |
| `clearField`    | `scene`, `participants`                         | 清除已失效的覆盖式状态字段   |
| `addItem`       | `todos`, `recentEpisodes`, `milestones`, `core` | 新增 item                    |
| `updateItem`    | `todos`, `recentEpisodes`, `milestones`, `core` | 局部更新已有 item            |
| `mergeItems`    | `todos`, `recentEpisodes`, `milestones`, `core` | 合并重复或高度重叠 item      |
| `completeTodo`  | `todos`                                         | 将待办标记为完成             |
| `cancelTodo`    | `todos`                                         | 将待办标记为取消             |
| `expireTodo`    | `todos`                                         | 将短期待办标记为失效         |
| `correctItem`   | `todos`, `milestones`, `core`                   | 基于用户明确修正纠错         |

Patch 约束：

- `op` 必须属于上表。
- `path` 对 `setField`、`clearField`、`updateItem` 必填。`path` 对 `scene`/`participants` 是字段名（如 `location`、`mood`、`user.emotion`）。`path` 对 `core` section 的所有 op（`addItem`/`updateItem`/`mergeItems`/`correctItem`）也必填，值为长期区子数组名：`worldFacts`/`userProfile`/`assistantProfile`/`relationship`。`milestones` 虽存于 `longTerm`，但作为独立 section 操作，`addItem` 不需要 `path`。其他 section（`todos`/`recentEpisodes`）的 `addItem` 也不需要 `path`（单一数组）。
- `itemId` 对 `updateItem`、`completeTodo`、`cancelTodo`、`expireTodo`、`correctItem` 必填（单个 item 的 id）。
- `itemIds`（数组）对 `mergeItems` 必填，指定要合并的多个 itemId。`value` 是合并后的新 item 值，至少包含 `text`。
- `value` 对 `setField`、`addItem`、`updateItem`、`correctItem` 必填。
- `evidenceRefs` 至少包含一个 `{ messageId, quote }`，除非该 op 是 Reducer 自行触发的过期清理。
- `quote` 必须是短片段（<=80 字符），不保存大段原文。
- `evidenceKind: "memory_compaction"` 只允许用于 `mergeItems`。其 `evidenceRefs` 必须来自被合并 source items 的既有证据，不能引用新的对话片段来制造新事实。

---

## 5. Section 长度预算

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

其它 section 溢出时不立即把当前消息视为已处理。Reducer 先记录 `deferred` 事件并触发 `compactionProposer` 维护任务。维护任务只能通过 `mergeItems + evidenceKind: "memory_compaction"` 合并同 section/同 path 下的重复或高度重叠 item，不能使用通用删除，也不能把新事实写入长期记忆。

compaction task 有界执行：同一 section/path 对同一阻塞窗口最多尝试 1 次。若维护任务 `accepted` 并释放容量，原 section 在下一次 tick 重新处理同一消息窗口；若维护任务 `noop`、`unable_to_decide`、`error`，或释放容量后仍超限，则原新增 patch 最终 `rejected: length_budget_exceeded` 并推进 cursor，避免永久卡住。
