# Scene Snapshot 与 Recall 功能设计

## 文档定位

本文定义情感类 AI Chat 的场景快照（Scene Snapshot）与回忆召回（Recall）功能。该功能建立在 [Memory Control v2](memory-control-v2/state-contract.md) 之上，利用 memory item 的 `evidenceGroups.refs.messageId` 作为 join key，将结构化 memory 与原始消息拼合为可回溯的"回忆"上下文。

本文只定义 Scene Snapshot / Recall 的数据表、写入副作用与召回流程。Memory v2 的核心契约以 [state-contract.md](memory-control-v2/state-contract.md) 为准。

## 1. 目标与动机

### 1.1 问题

Memory v2 的长期 item（`milestones`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`）携带 `evidenceGroups`，其中每个 ref 的 `quote` 是短片段。对长期 item 而言，quote 脱离场景后上下文价值很薄——"我愿意相信你"这五个字不比 text "关系转折: 第一次明确互相信任" 多传递什么信息。

但 `evidenceGroups.refs.messageId` 是精确指针，指向产生这条记忆的原始消息。一个 `evidenceGroup` 是一个 recall 单元；group 内多个 ref 共同构成一次可回溯证据。

### 1.2 目标

建立场景快照表，记录每次场景变化时的完整 `scene` 状态及其对应的 messageId 区间。提供 recall 功能：给定一个 evidenceGroup 或 messageId，能还原当时的场景状态和原始消息窗口，拼合成一段"回忆"注入主聊天上下文。

### 1.3 价值

- **长期 item 的 quote 不再需要承载上下文**——回溯能力由 evidenceGroup + scene_snapshots 承担，quote 只保留短锚点
- **主聊天模型可以"想起"具体往事**——不只是看到高密度 text，而是看到当时的场景和原话
- **与 RAG 互补**——RAG 做语义召回，recall 做精确回溯；memory item 是结构化索引，scene_snapshots 是场景容器，raw messages 是细节填充

## 2. 数据模型

### 2.1 chat_scene_snapshots 表

```sql
CREATE TABLE chat_scene_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  preset_id         TEXT NOT NULL,
  start_message_id  BIGINT NOT NULL,    -- 该场景开始的 messageId（scene_change 证据的 messageId）
  end_message_id    BIGINT,             -- 该场景结束的 messageId（null = 当前活跃场景）
  scene             JSONB NOT NULL,     -- { location, time, mood, note }，字段结构同 memory_state.current.scene
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scene_snapshots_lookup
  ON chat_scene_snapshots(user_id, preset_id, start_message_id DESC);

CREATE INDEX idx_scene_snapshots_active
  ON chat_scene_snapshots(user_id, preset_id)
  WHERE end_message_id IS NULL;
```

### 2.2 字段语义

| 字段 | 说明 |
| --- | --- |
| `start_message_id` | 触发场景变化的那条消息的 id（scene_change patch 的 evidenceRefs[0].messageId） |
| `end_message_id` | 下一次场景变化的前一条消息 id，或 scene TTL 到期前最后一条有效消息 id。null 表示尚未被下一场景/到期 cleanup 关闭 |
| `scene` | 场景变化**后**的完整 scene 状态（patch apply 后的快照），结构与 `memory_state.current.scene` 同构 |

scene 字段与 session 无关：`current.scene` 是 user/preset 级状态，与 session 完全解耦（见 [memory-control-v2-overview.md](memory-control-v2-overview.md) §5）。snapshot 的 `start_message_id` / `end_message_id` 是消息 id 区间，不受 session 边界影响。

### 2.3 生命周期

一个场景从 `scene_change` 触发开始，到下一次 `scene_change` 或确定性 scene TTL 到期结束：

```
msg 1-79:  无场景快照（首次场景变化前，scene 全 null）
msg 80:    scene_change → snapshot A: start=80, end=null
msg 121:   scene_change → snapshot A: end=120, snapshot B: start=121, end=null
msg 200:   scene_change → snapshot B: end=199, snapshot C: start=200, end=null
...        当前活跃: snapshot C
```

`end_message_id` 的计算：Snapshot writer 在创建新 snapshot 时，将上一条活跃 snapshot 的 `end_message_id` 设为 `新snapshot.start_message_id - 1`。

若先发生 `system_cleanup: scene_expired`，writer 按 cleanup 的 `expiredAt` 关闭活跃 snapshot：取该 user/preset 下 `createdAt <= expiredAt` 的最大有效 messageId 作为 `end_message_id`；若区间内只有 start message，至少取 `start_message_id`。TTL 到期只关闭旧 snapshot，不创建一个“空场景 snapshot”。后续 scene_change 再创建新的活跃 snapshot。

## 3. Snapshot 写入时机

### 3.1 触发条件

memory apply 成功提交后，以下任一条件触发 snapshot writer：

1. 至少一个 `scene.setField` 或 `scene.clearField` patch 被 `accepted`，且 `evidenceKind = "scene_change"`：关闭旧 snapshot 并创建新 snapshot。
2. 提交了 `system_cleanup: scene_expired`：只关闭当前活跃 snapshot。`expired_scene_evicted` 只是替换 `memory_state.current.previousScene` 的审计，不创建/关闭额外 snapshot。

`user_correction` / `assistant_correction` 只更新 `memory_state.current.scene`。

### 3.2 写入流程

Snapshot writer 在 memory 事务提交后执行，关闭旧 snapshot 与创建新 snapshot 使用独立事务：

1. **关闭旧 snapshot**：查找 `(user_id, preset_id)` 下 `end_message_id IS NULL` 的 snapshot，将其 `end_message_id` 设为 `本次 scene_change 的 messageId - 1`。
2. **创建新 snapshot**：插入新行，`start_message_id` = 本次 scene_change 的 messageId，`scene` = apply 后的完整 scene 状态，`end_message_id = null`。

### 3.3 多个 scene_change patch 在同一 tick

一个 tick 可能有多个 scene_change patch（如 `setField location` + `setField mood`，来自不同 messageId 的证据）。处理规则：

- 取所有 scene_change patch 中最早的 `evidenceRefs[0].messageId` 作为新 snapshot 的 `start_message_id`。
- `scene` 取 apply 后的最终状态（所有 patch 已应用）。

### 3.4 首次场景变化

对话开始时 scene 全 null，没有 snapshot。第一次 scene_change 创建第一条 snapshot。此前的消息（msg 1 到 start_message_id-1）没有场景快照——recall 这些消息时 `scene` 字段返回 null，只返回 raw messages。

### 3.5 失败处理

Snapshot 写入失败**不阻塞 memory 写入**。写入失败时记录 warn 日志，不影响 cursor 推进或主链路。

## 4. Recall 工作流

### 4.1 整体流程

```
用户消息 → [触发检测] → [定位 memory item] → [查 scene snapshot] → [拉 raw messages] → [拼合 recall 上下文] → [注入 context]
```

### 4.2 触发检测（实现可选）

何时触发 recall 是主聊天链路的决策，不在本文强制规定。可选方案：

- **方案 A：主聊天模型 function calling**。主聊天模型识别用户在回忆往事时，调用 `recall_memory` function，参数为关键词或大致时间描述。系统根据参数匹配 memory item。
- **方案 B：轻量分类器**。在主聊天前加一个轻量分类，检测消息是否包含回忆意图（"还记得"、"上次"、"那天"等），触发后由系统自动匹配。
- **方案 C：RAG 语义匹配**。用用户消息对 memory items（`milestones`、`recentEpisodes`、`worldFacts`、`userProfile`、`assistantProfile`、`relationship`）做语义搜索，命中阈值时触发 recall。

首版建议方案 A（如果主聊天模型支持 function calling）或方案 C（如果已有 RAG 基础设施）。方案 B 增加链路复杂度，不推荐首版。

### 4.3 定位 memory item

给定触发信号后，需要定位到具体的 memory item，并进一步得到一个或多个 `evidenceGroups`。定位方式取决于触发方案：

- 方案 A：function 参数直接匹配 memory item 的 text
- 方案 C：语义搜索结果即为 memory item

定位结果是少量候选 `evidenceGroups`。每个 group 有 1-N 个 refs，每个 ref 有 `messageId` 和 `quote`。如果命中的是 item 而不是 group，系统展开该 item 的 `evidenceGroups`，按触发信号与 `quote`/raw message 的匹配度选择候选；无法细分时取最近的 K 个 group。

### 4.4 查 scene snapshot

对每个候选 `evidenceGroup.refs[i].messageId`，查 `chat_scene_snapshots`：

```sql
SELECT * FROM chat_scene_snapshots
WHERE user_id = ? AND preset_id = ?
  AND start_message_id <= ?
  AND (end_message_id >= ? OR end_message_id IS NULL)
ORDER BY start_message_id DESC
LIMIT 1;
```

结果是该 messageId 所属场景的 snapshot（可能为空——消息在首次 scene_change 之前）。同一 group 内多个 ref 命中同一 snapshot 时去重；跨 snapshot 时按 messageId 顺序保留多个场景块。

### 4.5 拉 raw messages

以 `evidenceGroup` 为单位，取 `min(refs.messageId)` 和 `max(refs.messageId)`，拉覆盖整个 group 的原始消息窗口：

```sql
SELECT * FROM chat_messages
WHERE user_id = ? AND preset_id = ?
  AND id BETWEEN ? - ? AND ? + ?
ORDER BY id ASC;
```

参数依次为 `minMessageId`、`N`、`maxMessageId`、`N`。`N` 建议默认 10。group 内所有 ref 必须落在窗口内；超出预算时优先保留覆盖全部 ref 的最短窗口，再向两端裁剪。

### 4.6 拼合 recall 上下文

将 scene snapshot + raw messages 拼合为可读文本：

```
[回忆: 屋顶之夜]
场景: 屋顶 | 深夜 | 雨后安静
---
用户: 你为什么不说话，是不是又觉得我很烦？
assistant: 我没有觉得你烦，只是在想怎么开口。
用户: 我刚才其实很怕你会走，所以才一直不敢抬头。
assistant: 我没有走，我只是想等你愿意看我的时候再靠近。
用户: 那你以后能不能别沉默那么久，我会乱想。
assistant: 好，以后我会先开口，不让你一个人等。
```

渲染规则：

- 场景行：从 snapshot 的 `scene` 字段渲染，格式与 [rendering-and-context.md](memory-control-v2/rendering-and-context.md) §5 的 `[当前状态]` 模板一致。
- 分隔线后：raw messages 按 id ASC 排列，`用户:` / `assistant:` 前缀。
- 如果没有 snapshot（消息在首次 scene_change 之前），省略场景行，只渲染 raw messages。
- 如果一个 evidenceGroup 跨多个 snapshot，按时间顺序渲染多个场景块。
- 如果命中多个 evidenceGroups，按 group 分块渲染，最多渲染 K 个 group。

### 4.7 注入 context

Recall 上下文作为独立 context segment 注入，与 `memory` segment 并列：

| Segment | 注入时机 | 内容 |
| --- | --- | --- |
| `memory` | 始终（超过轮数阈值后） | 当前 memory_state 的实时 render |
| `recall` | 触发时（见 §4.2） | 场景快照 + raw messages 拼合的回忆文本 |
| RAG | 按现有逻辑 | 语义召回的相关片段 |

`recall` segment 的 token 预算需要与 `memory` segment 和 RAG 协调。建议 `recall` 单独预算（如 2000 token），不挤占 `memory` 的预算。如果 recall 内容超过预算，优先保留覆盖 group refs 的最短窗口，再从两端裁剪。

## 5. 与 Memory v2 的衔接

### 5.1 不修改 memory_state

Scene snapshots 不进入 `memory_state`。`memory_state` 保持当前状态 + 工作区 + 长期 item 的精简结构。Snapshots 是独立的衍生数据，由 post-commit snapshot writer 写入 `chat_scene_snapshots` 表。

scene 与 session 解耦：`current.scene` 是 user/preset 级状态，session 不是 scene 的语义边界（见 [memory-control-v2-overview.md](memory-control-v2-overview.md) §5）。snapshot 按 `(user_id, preset_id)` 隔离，不按 session 隔离。

### 5.2 不修改 Reducer 的核心职责

Reducer 的核心校验链（schema → messageId → quote → policy → 冲突 → lifecycle → 预算 → apply → 事件）不变。Snapshot 写入是 memory 事务提交后的副作用，不影响校验决策。`scene_expired`、`expired_scene_evicted`、`todo_became_overdue`、`recent_episode_evicted` 仍以 Memory v2 的 system cleanup event/revision/snapshot 为权威；本 Recall 派生表不得改变这些状态。

### 5.3 evidenceGroups.refs.messageId 的角色变化

| | 无 recall | 有 recall |
| --- | --- | --- |
| `quote` | 审计短锚点 | 审计短锚点 |
| `messageId` | Reducer 校验 + 审计 | Reducer 校验 + 审计 + **recall join key** |
| `evidenceGroup` | 证据集合 | **recall 单元** |

recall 功能让 messageId 从"校验用数字"升级为"回溯用指针"，让 evidenceGroup 成为可还原上下文的最小单位。

### 5.4 与 RAG 边界的关系

[rendering-and-context.md](memory-control-v2/rendering-and-context.md) §3 已定义 RAG 边界："RAG 负责召回具体旧场景、原话和细节"。Recall 功能正好落在这个边界上，是 RAG 的结构化增强：

- **纯 RAG**：语义搜索 raw messages，高召回但可能不精确
- **Recall**：通过 memory item 的 evidenceGroup 精确定位，高精度但需要 memory item 作为索引

两者互补：RAG 适合"模糊想起"，recall 适合"精确回溯"。首版可以先做 recall，RAG 集成是后续独立工作。

## 6. 边界与约束

### 6.1 不做场景预测

Snapshots 只记录已发生的场景变化，不预测未来场景。`end_message_id IS NULL` 表示尚未被下一次 scene_change 或 scene TTL cleanup 关闭；它本身不能越过 Memory v2 的 effective-view 过期判断而把已到期 scene 声称为当前场景。

`memory_state.current.previousScene` 只是 Renderer 使用的单值“已过期场景/上次已知场景”，由 scene TTL 到期时确定性覆盖；新 scene 到期会替换旧值并写 `expired_scene_evicted`。它不是正式 section，也不是 Recall 历史存储。完整的多场景时间线仍以 `chat_scene_snapshots` 为准，不能用 previousScene 替代 snapshots。

### 6.2 不做 participants snapshot

首版不做 `chat_participant_snapshots`。

### 6.3 跨会话 recall 与隔离边界

Snapshots 按 `(user_id, preset_id)` 隔离，不按 session 隔离。session 只是按天或 UI 划分的存储单元，不是 Memory 或 scene 的语义边界（见 [memory-control-v2-overview.md](memory-control-v2-overview.md) §5）。同一 `(user_id, preset_id)` 下跨 session 的 recall 正常支持。不同 preset 的场景互不可见，这与 memory_state 的隔离边界一致。

### 6.4 消息编辑/删除的失效处理

如果用户编辑或删除了 recall 窗口内的消息，recall 拉取的 raw messages 会反映编辑后的内容或缺失。这与现有 RAG 的行为一致——recall 不做消息版本控制，依赖 `chat_messages` 表的当前状态。

Snapshot 本身不受消息编辑影响——它记录的是场景变化时刻的状态，不是消息内容。但如果 scene_change 的证据消息被删除，该 snapshot 的 `start_message_id` 可能指向不存在的消息。recall 时 snapshot 仍然有效（场景状态是独立的），只是 raw messages 拉取可能少一条。

### 6.5 Snapshot 不参与 compaction

Snapshots 是只追加的日志型数据，不压缩、不合并。一个长会话可能积累几十到几百条 snapshot（取决于场景变化频率），每条数据量小。

如果未来需要清理旧 snapshot，可以按 `created_at` 保留最近 N 天，或按 `start_message_id` 保留最近 M 条。首版不做自动清理。

## 7. 首版范围

### 7.1 首版做

- `chat_scene_snapshots` 表与索引
- Snapshot writer 在 scene_change apply 提交后写 snapshot（关闭旧 + 创建新）
- Recall API：给定 evidenceGroup 或 messageId，返回 scene snapshot + raw messages
- Recall context segment：拼合文本，按需注入主聊天上下文
- 触发检测：至少实现方案 A（function calling）或方案 C（RAG 语义匹配）之一

### 7.2 首版不做

- `chat_participant_snapshots`
- Snapshot 自动清理
- message_id 按 (user_id, preset_id) 分序列号（全局 PK 够用，recall 的范围查询走 `WHERE user_id=? AND preset_id=? AND id BETWEEN ?` 已足够高效）
- recentEpisodes 滚出滑动窗口时归档到 snapshots（recentEpisodes 有自己的 evidenceGroups，recall 可直接用）

### 7.3 验收标准

- memory apply 提交 scene_change patch 后，snapshot writer 写入对应新行，旧活跃 snapshot 的 `end_message_id` 已关闭
- 给定一个 memory item 的 evidenceGroups，recall API 能按 group 返回对应场景 snapshot 和 raw messages
- Recall context segment 的文本格式稳定，相同输入产生相同输出
- Snapshot 写入失败不阻塞 memory 写入，不影响 cursor 推进
- 消息在首次 scene_change 之前时，recall 返回空 snapshot + raw messages（不报错）

## 8. 未来扩展

| 扩展 | 触发条件 | 说明 |
| --- | --- | --- |
| recentEpisodes 归档 | recentEpisodes 滚出后仍有 recall 需求 | 滚出时将 episode 的 evidenceGroups 写入独立归档表，recall 可查更早的 episode |
| 跨 preset recall | 用户切换角色后想回忆前一个角色的互动 | 需要跨 preset 的 memory item 索引，边界复杂，暂不规划 |
| conversation_seq | cursor/lag/scene 区间需要连续无间隙的会话内序列号 | 全局 message_id + per-conversation seq 折中方案，优化范围查询和调试体验 |
| Snapshot 自动清理 | 存储增长过快 | 按 created_at 或 start_message_id 保留最近 N 条，旧数据归档到冷存储 |

---
