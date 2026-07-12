# Source Rebuild 与 Projection 算法

本文是 source mutation、sourceGeneration、rebuild、force drain 以及 RAG/Recall projection drain 的单一权威来源。State、task、target status 和 projection checkpoint 的静态 shape 见 [状态契约](../state-contract.md) §1、§9。

## 1. Source Generation

`memory_state.meta.sourceGeneration` 是 Memory、RAG 与 Recall 共享的 raw-source 世代。普通追加 User/Assistant message 不增加 generation，只唤醒 normal worker。

任何有效 source 的编辑、删除、恢复、改变归属/可见性或排序语义变化都自动 `sourceGeneration + 1` 并 rebuild，即使变更触及的 source 尚未被某个 Memory target cursor 覆盖，因为 RAG/Recall 可能已经处理了 Memory 尚未处理的消息：

- 编辑历史消息；
- regenerate 导致截断或删除后续消息；
- 删除历史消息；
- session trash、restore 或 permanent delete；
- 消息 preset 归属或可见性变化；
- raw source 排序语义变化。

服务器维护脚本还可因 state/schema 损坏、关键 Proposer prompt/model 更换、不兼容的 Memory schema/compaction 语义变化、人工判断无法局部修复，或 v2 首次从 raw history 建立 state而显式 rebuild。

## 2. Source Mutation 原子事务

自动 source mutation 必须进入同一 `userId/presetId` 串行队列（与普通 task、maintenance task 共用），禁止在队列外先修改消息再 best-effort 处理 Memory。

source mutation 在一个数据库事务中完成以下动作：

1. 提交 raw source 变化；
2. 捕获变化后的有效 source boundary；
3. `sourceGeneration + 1`；
4. 取消旧 generation 的全部非终态 Memory tasks（normal/maintenance/system_cleanup）；
5. 初始化该 generation 的空 state 与六个 target cursor；
6. 写下一个全局 revision 的完整 snapshot；
7. 将六个 target status 更新为同 generation 的 `rebuilding` 并保存 captured boundary。

Generation 初始化 revision 不伪造某个正式 section/target 的 event group，后续恢复从该完整 snapshot 开始且禁止跨 generation replay。任一步失败都整体 rollback。当前 generation 仍有任一 `rebuilding` target 即为持久化 dirty 状态，不另设全局 dirty flag。

## 3. Rebuild 与 Force Drain

Rebuild worker 从当前 generation 的有效 raw messages 重放，并调用 `forceDrainTo(capturedBoundaryMessageId)`，忽略 `lagThreshold` 直到六个 target cursor 都到达 captured boundary。

`forceDrainTo(boundaryMessageId)` 只是 worker 内部能力：绕过普通 eligible/`lagThreshold` 门槛和 `rebuilding/halted` 的普通调度门控，重复使用既有 durable normal tasks 和六条 target pipeline，直到所有 target cursor 到达指定边界。该旁路只对已授权的 rebuild/维护入口开放，普通 Observer 仍不得为 rebuilding/halted target 创建 proposal。

Force-drain task 成功提交中间批次时 target 保持 `rebuilding`，到达并校验自身 captured boundary 后才恢复 `healthy`。完成后必须校验 state/schema、generation、snapshot、event/revision 连续性和全部 target cursors；每个 target 只有在自身校验通过后才能清除 `rebuild_boundary_message_id` 并恢复 `healthy`。

generation 期间再次变化时，本轮所有结果 stale，必须丢弃并由新 generation 重启流程。`forceDrainTo` 只用于 source rebuild、服务器维护脚本排查和一次性迁移；不新增 Flush 子系统、Flush task type、状态机或持久化表。

## 4. RAG/Recall Projection Drain

RAG 与 Recall invalidation 不依赖通用 outbox。两者各自持久化独立 projection checkpoint，至少包含 `processedGeneration` 与 `processedBoundaryMessageId`；不得从 Memory target cursor 推定 projection 处理进度。

worker 在启动、周期轮询和进程内 wake-up 时，把 checkpoint 与权威 `sourceGeneration` 和当前 source boundary 比较：

1. generation 不同：projection 进入 rebuilding，失效旧派生数据并重建当前 generation；
2. generation 相同：普通追加按 `processedBoundaryMessageId` 增量追平；
3. 每轮先捕获 generation/boundary；
4. 提交 projection 结果前再次校验 generation；
5. generation 再次变化时，本轮结果 stale，不得推进旧 generation checkpoint；
6. 只有仍一致且追平 captured boundary后，才能原子推进 checkpoint 并恢复 projection worker 的 healthy 状态。

进程内 wake-up 只降低延迟；启动与周期轮询时的 checkpoint 比较才是 correctness 保证。主聊天查询时的 `requiredBoundary` 和告警算法见 [Context Coverage](context-coverage.md)。

## 5. 一次性迁移

v2 是新的权威 memory 设计，不以 v1 兼容为目标。一次性迁移不是长期运行时子系统，也不新增专用 task type：

```text
停止对外服务
→ 更新 schema/代码
→ 物理删除旧 rolling/core Memory 数据
→ 从 raw messages 初始化 v2 state
→ rebuild/force drain
→ 校验 generation/state/snapshots/events/cursors 与 projection checkpoints
→ 启动服务
```

Rebuild 未追平或校验失败时不得启动对外聊天服务。旧 `rolling_summary` 和 `core_memory` 不直接转换为 v2 state；回放仍按批次跑 v2 pipeline（Observer → 专用 Proposer → Reducer），不设计“文本转结构”的特殊路径，也不继承旧 `meta.recovery`、halt 或 error count。

## 6. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.10、§4。

