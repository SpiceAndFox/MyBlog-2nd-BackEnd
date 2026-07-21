# Source Rebuild 与 Projection 算法

本文是 2.01 source mutation、sourceGeneration、Memory force-drain 和 RAG projection generation/boundary checkpoint 的单一权威来源。

## 1. Source Generation

`memory_state.meta.sourceGeneration` 是 Memory 与 RAG 共用 raw-source 世代。普通 append 不增加 generation；以下有效 source 变化增加并自动 rebuild：

- 编辑消息；
- regenerate 截断/删除后续消息；
- 删除/恢复消息或 session；
- preset 归属、可见性或排序语义变化；
- privacy hard delete 后从剩余 source 重建。

服务器维护还可因 state/schema 损坏、2.01 首次初始化、关键 Prompt/model/Compiler/schema 变化显式 rebuild。

Correction/forget active Memory 不改变 raw source，不增加 generation。

## 2. Source Mutation 原子事务

Source mutation 必须进入 scope 串行 lane，并在一个事务中：

1. 提交 raw source 变化；
2. 捕获新有效 source boundary；
3. `sourceGeneration + 1`；
4. 取消旧 generation 非终态 tasks；
5. 初始化 version=`"2.01"` 空 state/cursors；
6. 写下一个全局 revision 的完整 snapshot；
7. 六个 target status 进入 rebuilding 并保存 boundary。

Generation 初始化不伪造 event group。任一步失败整体 rollback。

## 3. Rebuild 与 Force Drain

Worker 从当前有效 raw messages 重放正式 2.01 pipeline：

```text
Observer window
→ ProposerTaskRenderer
→ Semantic Proposer
→ Compiler
→ Reducer
```

`forceDrainTo(boundary)` 忽略 normal lagThreshold 与 rebuilding调度门，复用 durable normal task，直到所有 target cursor 达到 captured boundary。

中间 revision 提交后 target 保持 rebuilding；自身 cursor、state/schema、snapshot/event chain 校验通过后才恢复 healthy。`rebuild_boundary_message_id` 是 durable reconciliation触发器，即使没有 pending task，startup/periodic reconciliation 也必须继续 force drain。

Generation 再次变化时旧结果 stale，不得写入新 generation。

2.01 rebuild 不执行 correction/forget tombstone gate、terminal suppression filter 或 suppression cleanup revision。曾被 active forget/correct 的内容可以从仍有效 raw source 再次形成。

## 4. RAG Projection Drain

Checkpoint 只包含：

```text
processedGeneration
processedBoundaryMessageId
status
lastErrorReason
```

Worker：

1. generation 不同：失效旧派生数据并 rebuild 当前 generation；
2. generation 相同且 boundary 落后：增量 append；
3. 每轮捕获 generation/boundary；
4. commit 前重新校验；
5. stale 时不推进 checkpoint；
6. commit projection 与推进 checkpoint 原子完成。

2.01 删除 `processedTombstoneId` 和 adapter `suppress()` 阶段。Correction/forget 不唤醒 projection；privacy hard delete 走独立 purge 编排。

进程内 wake-up只降低延迟，startup/periodic checkpoint比较才是 correctness保证。Recall/Scene Recall 继承 RAG cutoff，不建立独立 checkpoint。

## 5. 2.01 开发数据库切换

2.01 不兼容旧 v2 派生数据：

```text
停用旧 Memory runtime
→ 保留 chat_messages raw source
→ 清理旧 v2 authority/task/event/snapshot/sidecar/projection 派生数据
→ 应用 2.01 schema（schema_version TEXT；无 evidence_kind/tombstone/processed_tombstone_id）
→ 初始化 version="2.01" state
→ rebuild/force drain
→ 校验六个 target、state/snapshot/event chain 与 RAG checkpoint
→ 启用 runtime
```

不转换旧 rolling/core 或旧 v2 state/proposal。切换失败时不得把服务标记为可启用。

## 6. Harness

覆盖 source mutation原子性、old task stale、force drain recovery、无 suppression terminal filter、RAG generation/boundary checkpoint、无 suppress adapter、privacy purge与 2.01 rebuild gate。
