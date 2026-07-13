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

`rebuild_boundary_message_id` 是独立于 task 是否 pending 的 durable reconciliation 触发器。runtime 启动恢复和周期 task reconciliation 必须枚举已初始化 scope；只要当前 generation 的 target rows 仍保存同一个非空 rebuild boundary，就必须在该 scope 的串行 lane 中重新调用 `forceDrainTo`，即使崩溃前最后一个 durable task 已经终态或当前没有 pending task。task recovery 负责恢复单个 phase，target boundary reconciliation 负责恢复整个 rebuild 循环，二者缺一不可。reconciliation 遇到尚未到期的 `retry_wait/notBefore` 必须原样返回 incomplete，不能绕过 durable 退避直接调用 Provider。

generation 期间再次变化时，本轮所有结果 stale，必须丢弃并由新 generation 重启流程。`forceDrainTo` 只用于 source rebuild、服务器维护脚本排查和一次性迁移；不新增 Flush 子系统、Flush task type、状态机或持久化表。

## 4. RAG/Recall Projection Drain

RAG 与 Recall invalidation 不依赖通用 outbox。两者各自持久化独立 projection checkpoint，至少包含 `processedGeneration`、`processedBoundaryMessageId` 与 `processedTombstoneId`；不得从 Memory target cursor 推定 projection 处理进度。

worker 在启动、周期轮询和进程内 wake-up 时，把 checkpoint 与权威 `sourceGeneration` 和当前 source boundary 比较：

1. generation 不同：projection 进入 rebuilding，失效旧派生数据并重建当前 generation；
2. generation 相同：普通追加按 `processedBoundaryMessageId` 增量追平；
3. 每轮先捕获 generation/boundary；
4. 提交 projection 结果前再次校验 generation；
5. generation 再次变化时，本轮结果 stale，不得推进旧 generation checkpoint；
6. 只有仍一致且追平 captured boundary后，才能原子推进 checkpoint 并恢复 projection worker 的 healthy 状态。

Suppression tombstone 的消费与 raw-source boundary 独立。即使 generation/boundary 均未变化，只要最新 tombstone id 大于 `processedTombstoneId`，worker 就必须在 projection 提交事务中物理失效/删除命中的派生数据，并推进 tombstone 水位；失败时两者一起回滚。查询时 source-key gate 仍必须保留，不能用物理删除完成来替代 correctness gate。

进程内 wake-up 只降低延迟；启动与周期轮询时的 checkpoint 比较才是 correctness 保证。主聊天查询时的 `requiredBoundary` 和告警算法见 [Context Coverage](context-coverage.md)。

## 5. 一次性迁移

v2 是新的权威 Memory 设计，不以 v1 兼容为目标。迁移不新增长期 task type，也不把 v1 文本转换成 v2 state。迁移数据分为两类：

- **必须保留的 source**：`chat_messages` 中有效的 User/Assistant 原文及其会话归属。Memory 清理、rehearsal 和 cutover 均不得修改或删除这些数据；独立的用户隐私删除/消息管理流程不属于 Memory 迁移。
- **应清除的 v1 派生数据**：`rolling_summary`、`core_memory`、对应更新时间/cursor/dirty/rebuild 字段和 v1 checkpoint。这些数据不再作为 authority，也不用于 v2 rebuild。

### 5.1 v1 派生数据退役

v1 清理与 v2 启服是两个独立动作。确认 v1 worker 和上下文注入已经停用后，应用一次性 schema migration `002-drop-memory-v1.sql`：

```text
确认 v1 runtime 已停用
→ 备份并明确确认移除 v1 schema
→ 删除 rolling/core Memory 字段与 v1 checkpoint 表
→ 校验数据库不存在 v1 列或 checkpoint 表
```

该 migration 使用 `IF EXISTS` 保持可重复执行，不触碰 `chat_messages`、v2 state/event/snapshot/task 或 RAG/Recall 数据。执行后不再支持回退到 v1 摘要系统，但不会自动启用 v2，也不能绕过 v2 的 rebuild/校验门。

### 5.2 v2 正式切换

生产历史副本 rehearsal 只验证 v2 rebuild，不负责保留或恢复 v1 派生数据。正式切换流程为：

```text
停止对外服务并冻结 raw boundary
→ 更新 schema/代码
→ 确认 v1 派生数据已清除（未清除则执行 5.1）
→ 从保留的 raw messages 初始化 v2 state
→ rebuild/force drain
→ 校验 generation/state/snapshots/events/cursors 与 projection checkpoints
→ 启动服务
```

回放按批次运行正式 v2 pipeline（Observer → 专用 Proposer → Reducer），不继承旧 `meta.recovery`、halt 或 error count。Rebuild 未追平或任一校验失败时不得启动对外聊天服务，即使 v1 派生数据已经清除也不能放宽该门。

生产环境的具体命令、备份点、停启服证明、报告归档和失败处置需等 migration CLI 与真实 RAG/Recall projection adapter 完成装配后定稿，当前登记在 [Memory v2 生产切换执行手册（Deferred）](../../deferred/memory-v2-production-migration-runbook.md)，不得用尚未验证的临时命令代替正式 runbook。

## 6. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.10、§4。
