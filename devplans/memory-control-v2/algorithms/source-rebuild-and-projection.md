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

1. 锁定当前 authority state，提交 raw source 变化，并确定最早受影响的 `affectedFromMessageId`；
2. 捕获变化后的有效 source boundary，令 `sourceGeneration + 1`；
3. 在旧 generation 中寻找严格位于受影响点之前的最新安全 snapshot；
4. privacy 流程如需清理旧派生历史，先保留候选 snapshot 的内存副本，再清理 events、snapshots、tasks、projection 与 sidecar；
5. 将安全 snapshot 克隆成新 generation 的 anchor；如果没有安全 snapshot，则初始化 version=`"2.01"` 的空 state/cursors；
6. 取消旧 generation 非终态 tasks；
7. 使用当前全局 `revision + 1` 写 authority state 和完整 anchor snapshot，六个 target status 进入 rebuilding 并保存变化后的 boundary。

安全 snapshot 必须同时满足：

- snapshot schema、generation、revision 与旧 authority 一致且 state 通过完整契约校验；
- 六个 target cursor 都 `< affectedFromMessageId`，并且不超过变化后的有效 source boundary；
- state 中每个 `sourceRef.messageId` 都 `< affectedFromMessageId`；
- 所有 source refs 在变化后的 raw source 中仍存在，且 `contentHash` 完全一致。

snapshot 只要违反任一条件就不能作为 anchor。实现可以继续检查更早的候选；仍找不到时必须安全降级为空 state 全量 rebuild，不能猜测或部分删除 snapshot 内容。没有明确失效边界的 manual/schema recovery rebuild 同样从空 state 开始。

Generation 初始化不伪造 event group。任一步失败整体 rollback。

## 3. Rebuild 与 Force Drain

“snapshot 未被影响”表示 snapshot 所覆盖的 source 前缀无需重新计算，不表示整个 source mutation 可以跳过 rebuild。新 generation 仍必须从 anchor 中保存的各 target cursor 向变化后的 boundary 重放，因为被编辑的消息可能形成新的 Memory，且修改点之后的归纳可能依赖新的对话语义。对于这种情况，rebuild 的工作量只包含未被 snapshot 覆盖的后缀；只有找不到安全 anchor 时才从 cursor 0 重放全部历史。

如果 source mutation 后六个保留 cursor 已经全部到达新的 boundary，force drain 不创建 Provider task，只执行新 generation 的 snapshot/event-chain 与 target 状态校验。常规消息编辑不会命中这个零重放分支：安全 cursor 必须小于被编辑 messageId，而变化后的 boundary 仍包含该消息，因此至少要重放从编辑点开始的后缀。

即使 raw mutation 最终没有改变某个 target 的 active Memory，也不能直接沿用旧 generation：旧 task、RAG projection、diagnostic 与 source-generation fence 仍需失效并重新建立一致性。

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

覆盖 source mutation原子性、安全 snapshot 选择、candidate provenance/hash 复核、无安全 anchor 时从零降级、old task stale、force drain recovery、无 suppression terminal filter、RAG generation/boundary checkpoint、无 suppress adapter、privacy purge与 2.01 rebuild gate。
