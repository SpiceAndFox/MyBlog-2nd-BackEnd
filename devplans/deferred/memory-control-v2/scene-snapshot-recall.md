# Scene Snapshot 与 Recall 功能设计（延后）

## 文档定位

本文定义情感类 AI Chat 的场景快照（Scene Snapshot）与回忆召回（Recall）候选方案。它建立在 [Memory Control 2.01](../../memory-control-v2/state-contract.md) 之上，使用持久化 item 的扁平 `sourceRefs[].messageId` 作为 raw-message join key。

本文不是 2.01 首版要求。当前 RAG/Recall 边界以 [Context Coverage](../../memory-control-v2/algorithms/context-coverage.md) 为准；本方案重新进入 active devplan 时，必须再次评估是否仍需要独立 Snapshot store。

## 1. 目标与约束

长期 Memory item 只有高密度语义文本和 raw `sourceRefs`，不保存 quote、evidence group 或 Memory-to-Memory 图。若产品需要“想起当时发生了什么”，可由 source messageId 定位原始消息，并用 Scene Snapshot 补充当时的场景状态。

候选方案必须满足：

- `memory_state` 仍是当前 Memory authority，Snapshot 只是可重建 projection；
- Recall 只读取当前 `sourceGeneration` 下的 snapshot 与 raw source；
- 一个 `sourceRef` 是一个精确 anchor，不重新引入 evidence group；
- correction/forget 不创建 tombstone，也不从 raw history 或 RAG/Recall 中抹除内容；
- privacy hard delete 与 raw source 编辑/删除继续使相应派生数据失效。

## 2. 数据模型

```sql
CREATE TABLE chat_scene_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  preset_id         TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  start_message_id  BIGINT NOT NULL,
  end_message_id    BIGINT,
  scene             JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scene_snapshots_lookup
  ON chat_scene_snapshots(user_id, preset_id, source_generation, start_message_id DESC);

CREATE UNIQUE INDEX idx_scene_snapshots_active
  ON chat_scene_snapshots(user_id, preset_id, source_generation)
  WHERE end_message_id IS NULL;
```

字段语义：

| 字段 | 说明 |
| --- | --- |
| `source_generation` | 生成 snapshot 时的权威 raw-source generation；Recall 只读取当前 generation |
| `start_message_id` | 触发本次已接受 scene 状态变化的最早 raw source messageId |
| `end_message_id` | 下一次 scene 状态变化前的最后一条消息；`null` 表示仍活跃 |
| `scene` | 本次 event group 提交后的完整非空 scene，shape 与 `memory_state.current.scene` 相同 |

Snapshot 按 `(user_id, preset_id)` 隔离，不按 session 隔离。

## 3. Snapshot Projection

### 3.1 输入

Snapshot writer 只消费已提交 event group：

- event group 含 accepted `scene.setField` 或 `scene.clearField` 时，视为一次 scene 状态变化；
- 2.01 不区分普通 update 与 correction，不读取 `evidenceKind`；
- `system_cleanup: scene_expired` 关闭当前 snapshot，不创建空 snapshot；
- `expired_scene_evicted` 不额外创建或关闭 snapshot。

### 3.2 写入规则

对一个含 scene 变化的已提交 event group：

1. 从 accepted scene events 的 `normalized_operation.sourceRefs` 取最小 messageId 作为 transition anchor；
2. 关闭当前 generation 的旧 active snapshot，令 `end_message_id = max(old.start_message_id, anchor - 1)`；
3. 读取该 event group 提交后的完整 scene；
4. scene 至少一个字段非空时，创建 `start_message_id=anchor` 的新 active snapshot；scene 全空时不创建空 snapshot；
5. 同一 event group 的多个 scene field patch 只生成一个最终 snapshot。

Projection 使用独立 checkpoint 与事务。失败不回滚已提交 Memory revision，但 Recall 必须保持 degraded/rebuilding，并从旧 checkpoint 重试。重复消费同一 event group 必须幂等。

### 3.3 TTL

`system_cleanup: scene_expired` 按 event 中的 `expiredAt` 关闭 active snapshot。可使用 `createdAt <= expiredAt` 的最大有效 messageId 作为结束点；若不存在更晚消息，至少取 `start_message_id`。

## 4. Recall 工作流

```text
用户消息
  → 触发检测
  → 定位 Memory item 或 RAG hit
  → 展开 raw source anchors
  → 查询 Scene Snapshot 与 raw message windows
  → 合并并裁剪
  → 注入 recall segment
```

### 4.1 触发与定位

触发策略可选：主聊天 function call、轻量回忆意图分类或 RAG 命中。结构化定位命中 active Memory item 时，系统读取它的 `sourceRefs`；RAG 命中 raw chunk 时直接使用 chunk messageIds。

2.01 没有 evidence group。不得把同一 item 的全部 sourceRefs 简单扩成从最小到最大 messageId 的单一窗口，因为多次 update 后的 anchors 可能相距很远。

### 4.2 Anchor 分窗

对去重并校验过的 anchors：

1. 每个 messageId 建立独立的前后 `N` 条 raw message 候选窗口；
2. 合并重叠或相邻的窗口，得到稳定 recall blocks；
3. 每个 block 按其 anchors 查询对应 snapshot，并按时间排序；
4. 总 blocks 超过 `K` 或总字符超预算时，按触发相关度与时间排序裁剪，但每个保留 block 必须完整覆盖其 anchor；
5. 不截断单条 raw message，不把未校验的 `contentHash` 不匹配行当作 anchor。

这套规则保留 2.01 的扁平 provenance，不在 Recall 层恢复 evidence group。

### 4.3 Snapshot 查询

```sql
SELECT * FROM chat_scene_snapshots
WHERE user_id = ? AND preset_id = ?
  AND source_generation = ?
  AND start_message_id <= ?
  AND (end_message_id >= ? OR end_message_id IS NULL)
ORDER BY start_message_id DESC
LIMIT 1;
```

消息早于第一条 snapshot 时，scene 返回空，仅渲染 raw messages。

### 4.4 Raw 查询与渲染

每个 recall block 的 raw 查询必须显式携带 `(user_id, preset_id, sourceGeneration, lowerBound, upperBound)`，只读取当前有效 User/Assistant source。渲染形态固定为：

```text
[回忆]
场景: 屋顶 | 深夜 | 雨后安静
---
用户: ……
assistant: ……
```

- snapshot 不存在时省略场景行；
- 多个 block 按时间顺序分块；
- 相同 raw message 只渲染一次；
- recall segment 使用独立逻辑预算，但仍受主模型物理 context 上限约束；
- 查询上界继承 [Context Coverage](../../memory-control-v2/algorithms/context-coverage.md) 的 RAG/Recall cutoff，不能读取 recent window 之后的隐藏未来消息。

## 5. 与 2.01 的边界

### 5.1 不修改核心写链

Semantic Proposer、Compiler、Validator/Reducer 的职责不变。Snapshot 是提交后的 projection，不参与 semantic schema、source validation、policy、capacity、cursor 或 revision 决策。

### 5.2 Forget 与 Correction

- active item 被 forget 后，结构化 Memory item 不再作为 Recall 入口；
- item update/correct 后，active item 的 `sourceRefs` 是旧/新 raw sources 的并集；
- 这些动作不删除 raw history，也不阻止 RAG 从原始消息召回；
- 若未来产品要求“忘记后也不能从 Recall/RAG 复现”，必须采用 [Correction / Forget Suppression](correction-forget-suppression.md) 的完整延后设计，不能在本 projection 内偷偷增加局部 tombstone。

### 5.3 Source Mutation 与 Privacy

消息编辑、删除、restore、归属/可见性或排序变化会增加 `sourceGeneration`。旧 generation snapshot/checkpoint 立即失效，projection 按当前有效 raw messages 重建。

Privacy hard delete 必须物理删除相应 snapshots、Recall cache/index 和 debug 副本，并从剩余 source 重建；这与普通 forget 不同。

### 5.4 Retention

Snapshot 不进入 `memory_state`，也不参与 compaction。未来若清理旧 snapshot，必须保留当前 generation 的可重建 checkpoint 语义，并确保 Recall 不返回已删除 raw source 的孤立快照。

## 6. 首版候选范围与验收

若本方案重新进入 active devplan，最小范围是：

- snapshot 表、projection checkpoint 与幂等 writer；
- accepted scene event/TTL cleanup 的投影；
- 以 `sourceRefs[].messageId` 或 RAG hit 为 anchor 的 Recall API；
- 固定分窗、合并、cutoff 与字符预算算法；
- generation rebuild、projection lag、privacy purge 测试。

最低验收：

- 同一 event group 多个 scene patch 只生成一个最终 snapshot；
- set/clear/correct 均不依赖 `evidenceKind`；
- 相距很远的 sourceRefs 不生成巨大连续窗口；
- source hash/generation 不一致时不返回陈旧 Recall；
- forget 不创建 tombstone，privacy hard delete 会物理清除；
- Snapshot projection 失败不回滚 Memory commit，但查询明确 degraded/rebuilding。

## 7. 重新评估条件

- 用户明确需要通过结构化 Memory 精确回溯旧场景；
- 纯 RAG 无法稳定提供场景边界或精确 source anchor；
- snapshot 存储、重建和 context 预算已有可测量收益；
- Correction / Forget 是否应影响 Recall 已形成独立产品决策。
