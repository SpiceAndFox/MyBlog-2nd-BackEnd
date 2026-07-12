# Task 执行、Cursor 与幂等算法

本文是 normal/maintenance/system-cleanup task 的创建与恢复、cursor 推进、revision stale、successor task、retry/resume、phase identity、事务结果和 crash recovery 的单一权威来源。Task、target status、event group、ops log 的 DDL 与枚举见 [状态契约](../state-contract.md) §9。

## 1. 串行与 Task 创建

当前只支持单实例。同一 `userId/presetId` 的普通 task、maintenance task、system cleanup 和 source mutation 共用同一个进程内串行队列。进程内队列只负责运行时串行，不是 crash recovery authority；durable task、per-target status 和 ops log 才是运行恢复 authority。

Observer 可以一次发现多个 eligible targets，但只能先排 intent。每个 durable task 必须在进入 user/preset 串行执行位时用最新 state 创建并固化 `base_revision/cursor_before/task_payload`，不能在一个 tick 开头为多个 targets 预先固化同一个 baseRevision。

`task_id` 与 `dedupe_key` 在任务首次创建后保持稳定。相同调度事实的重复 wake-up 必须命中同一 dedupe key 并读取既有 task，不得新建第二行：

- normal task 的 key 至少绑定 generation、target、`cursor_before` 与 `target_message_id`；
- maintenance task 还绑定 `parent_task_id`、阻塞 section 与 `resume_epoch`；
- system cleanup task 绑定确定性 cleanup 边界。

key 的具体编码由实现集中定义，不进入 Prompt。

## 2. Proposer 调度窗口

检测频率与上下文窗口是两个独立参数：

- `lagThreshold`（N）：检测频率。`lag = 该 user/preset 下 id > coveredUntilMessageId 的消息数量`，lag >= N 时该 target eligible。
- `contextWindow`（M ≥ N）：发给 Proposer 的观察窗口大小上限。
- `newBatch`：从 `coveredUntilMessageId` 之后按 `id ASC` 取最早的 `min(N, lag)` 条未处理消息。
- `overlap`：从 `coveredUntilMessageId` 及之前取最近的 `M - newBatch.length` 条消息，按 `id ASC` 放在 `newBatch` 前。
- `observedMessageIds = overlap + newBatch`，`targetMessageId = max(newBatch.id)`。窗口内 `id > coveredUntilMessageId` 的消息是本轮新消息，`id <= coveredUntilMessageId` 的消息只作重叠上下文。普通写入 patch 的 evidenceRefs 可以引用 observedMessages 中的任意消息（含重叠部分），但 patch 应反映本轮新消息。

上述查询都基于跨 session 的完整有效 source，不做 user-boundary 裁剪。普通聊天中 `0 < lag < lagThreshold` 的尾批允许暂留；后续消息到达后再一起处理。若尾批离开 recent window，主聊天由 [Context Coverage](context-coverage.md) 的 per-target GapBridge 补齐，不通过修改 cursor 或提前调用 Proposer 来掩盖 gap。

Source rebuild、一次性迁移和服务器维护排查不受普通 `lagThreshold` 限制，调用 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) 的 `forceDrainTo(capturedBoundaryMessageId)`。

Observer 将 eligible targets 列为 `eligibleTasks`，每个 normal target 对应一个 task 和一个专用 Proposer。只有目标 section 出现在该 Proposer 的输入和输出契约中；非目标 section 不出现在 `sectionResults` 中。目标 section 是否实际变化，由对应 Proposer 读取 envelope 后输出 patch 或 noop，Observer 不预判。

触发与上下文窗口建议（可调）：

| targetKey | lagThreshold | contextWindow | 理由 |
| --- | --- | --- | --- |
| `scene` | 4 | 6 | 场景变化高频，及时捕捉；窗口小，当前状态为主 |
| `todos` | 6 | 12 | 待办中频；窗口略大以判断完成/取消 |
| `standingAgreements` | 8 | 12 | 持续约定中低频；窗口用于判断修订/取消 |
| `episodes` | 10 | 15 | 近期经历中频 |
| `profileRelationship` | 8 | 20 | 长期档案低频但需较多上下文判断 |
| `worldFacts` | 8 | 20 | 世界设定低频但需较多上下文判断 |

## 3. Cursor 推进

`cursor` 指当前 target 的 `coveredUntilMessageId`，存于 `meta.targetCursors[targetKey]`。

核心原则：Proposer 已经看过消息并给出了明确判断（patches 或 noop），且 Reducer 不需要外部维护任务才能完成决策，则消息视为已处理，cursor 推进。Proposer 无法判断（`unable_to_decide`）、技术性失败（`error`）、预算维护暂缓（`deferred`）时不推进。

| 决策 | Cursor 行为 | 落地表 | 触发条件 |
| --- | --- | --- | --- |
| `accepted` | 推进 | events | 至少一个 patch 被 apply |
| `noop` | 推进 | events | Proposer 明确说无变化；记 `decision=noop` 占位行 |
| `rejected` | 推进 | events | patches 全被拒（policy/quote/schema/item 校验等） |
| `deferred` | 不推进 | events | item patch 被长度预算阻塞，已触发 maintenance task |
| `unable_to_decide` | 不推进 | ops_log | Proposer 自认判断不了；扩大上下文重试，仍无法判断后推进 cursor |
| `unable_to_compact` | 不推进 | ops_log | compactionProposer 判定无安全合并空间；halt 对应 target |
| `error` | 不推进 | ops_log | Provider Adapter 返回错误；按本文件恢复策略处理 |

cursor 按整个 normal proposal 的 target 级结果聚合，而不是按单个 section 或单行 event 判断。联合 target 的所有 `sectionResults` 必须都形成可推进终局：任一 section 为 `unable_to_decide`、任务发生 `error`，或任一 patch 为 `deferred` 时，整个 target cursor 不推进。全部 section 均已终局且不存在上述阻塞结果时，有任一 `accepted`/`noop`/普通 `rejected` event 即推进。

一个 section 的 `patches` 数组里可能多个 patch 独立校验，部分 `accepted`、部分普通 `rejected` 时可以推进；有任一 `deferred` 时不推进。Capacity-blocked 时禁止 accepted + deferred 非原子混合提交，完整规则见 [Compaction 与 Proposal Replay](compaction-and-replay.md)。

## 4. Revision、Generation 与 Cursor Stale

提交事务必须先按 `task_id` 锁定并读取 task，再校验 source generation、target `cursor_before`、当前 revision 与该 stage 的预期执行 revision。

- task generation 与 `memory_state.meta.sourceGeneration` 不同：task stale，必须取消且不得 replay/apply。
- normal task 首次提交时，若当前 revision 与 task 创建时的 `base_revision` 相同：允许继续校验和提交。
- normal task 首次提交时，若当前 revision 不同但 generation 仍匹配：不得直接 apply，也不得简单失败；创建 successor task。
- compaction/replay：按各阶段开始时捕获的最新 revision 创建下一 revision；其他 target 导致的 revision 增长不单独使 proposal stale。其余 stale 条件见 [Compaction 与 Proposal Replay](compaction-and-replay.md)。
- cursorBefore 失配：不得 apply，记录 `stale_result`。

### 4.1 Successor Task

当 normal task 首次提交时发现当前 revision ≠ task 创建时的 `base_revision`（且 `sourceGeneration` 仍匹配）：

1. 取消旧 task（status=`cancelled`）；
2. 创建 successor task：新 `task_id`、新 `dedupe_key`、`predecessor_task_id` 指向旧 task；
3. successor task 以当前最新 revision 作为新 `base_revision`；
4. 重新读取 state、重新组装 envelope并重新调用 Proposer；
5. 旧 task 的 `stage_payload.persistedProposal`（如有）不复用；
6. successor task 的 `dedupe_key` 必须与旧 task 不同，例如加入 predecessor_task_id 或新 base_revision。

readOnlyContext 可能已因其他 target 的 revision 而变化，因此必须重新组装，不能在新 revision 上直接 apply 旧 proposal。

## 5. Retry 与 Resume

任何成功 revision 都必须在同一事务把对应 durable task 写到终态，并将该 target 的 `consecutiveErrors` 重置为 0、清除 retry 时间；不能先提交 state/snapshot，再异步修复 task/status。

### 5.1 Provider Adapter Error

- tick orchestrator 不把 error 交给 Reducer。它在一个运行状态事务中写 ops log、更新 durable task 的 attempt/notBefore/status，并更新对应 per-target status；cursor 不推进，revision/snapshot 不增加。
- 可重试调用失败（`llm_call_failed`/`safety_policy_blocked`/`max_output_truncated`）：target status 的 `consecutiveErrors + 1`，task 进入 `retry_wait` 并写有限指数退避的 `notBefore/nextRetryAt`。三类原因分别记录指标。
- `output_schema_invalid`：task 进入 failed，对应 target status 直接进入 halted；不重试同输入。
- 可重试错误的 `consecutiveErrors` 达 3 后，只将对应 target 置为 halted；其他 targets 不受影响。

### 5.2 unable_to_decide

1. 首次：写 ops log，把当前 durable task 的 `contextExpansionAttempt` 从 0 更新为 1；不修改 per-target 长期错误计数或 `memory_state`。
2. 下一 attempt 读取该字段并发送扩大的 contextWindow。
3. 扩大 1 次仍 `unable_to_decide`：以一个只推进该 target cursor 的 revision 终结 task，并在同事务写 event group、snapshot、task 终态和 healthy target status。

### 5.3 Rejected

普通 rejected 推进 cursor并写 event，不重试；重跑同输入大概率得到相同结果。Rejected 不自动告警，依靠 `chat_memory_events` 和指标排查。

### 5.4 手动 Resume

```text
CLI: node scripts/memory-v2-resume.js --userId=1 --presetId=default --targetKey=todos
API: POST /admin/memory/resume { userId, presetId, targetKey }
```

- `retry_wait` target：重置为 `healthy`、清错误计数/nextRetryAt，并将可恢复 task 重新置为 queued。
- 容量/compaction/replay 失败导致的 `halted` target：重置为 `capacity_blocked`，创建新的 maintenance child task；不复用已终态旧 task。完整规则见 [Compaction 与 Proposal Replay](compaction-and-replay.md)。
- `output_schema_invalid` 导致的 halted target：修复 model/prompt/schema/adapter 根因后重置为 `healthy`，创建新 normal task；旧 task 保留审计。
- Provider 可重试错误连续达到阈值导致的 halted target：排除 Provider/网络/输出预算故障后重置为 `healthy`，创建新 normal task；旧 task 保留审计。

Resume 不改 `memory_state`，不产生 revision/snapshot，不重置其他 targets。worker 从 durable task 或该 target cursor 继续，不跳过消息。

## 6. Maintenance Resume Epoch

当 maintenance task 已进入终态（`compaction_applied`/`compaction_failed`）且 parent normal task 仍处于 `capacity_blocked` 时，resume 不复用原 maintenance task：

1. 创建新 maintenance child task；
2. 新 `task_id`；
3. `resume_epoch = 前一个 + 1`；
4. `parent_task_id` 指向同一 normal task；
5. 新 child task 的 `dedupe_key` 包含新 `resume_epoch`；
6. parent normal task 的 `stage_payload.maintenanceTaskId` 更新为新 child task ID；
7. 原 maintenance task 的终态保留用于审计。

## 7. Phase Identity 与提交结果

每个 task phase 使用稳定的 event group identity。同一 phase/task/patchId 的重复 delivery、进程恢复或提交结果不确定时，先读取既有终态：已提交则返回原结果，未提交才继续；不得产生第二组 events、第二个 state revision、重复 snapshot 或重复 cursor 推进。

运行失败 outcome：

- `reducer_failed`：Reducer 执行过程中发生纯代码异常；不增加 revision/snapshot。
- `transaction_failed`：数据库事务在 COMMIT 前明确失败且已确认回滚，如死锁、序列化异常或事务执行阶段连接断开；在回滚后按 task phase identity 重新校验状态。
- `commit_outcome_unknown`：COMMIT 已发送但连接断开，无法确认提交结果。worker 必须先按 event group 的 phase identity 查询是否已持久化；若已提交则返回既有结果，未提交则在当前最新 revision 基础上重试。

## 8. 原子提交与 Crash Recovery

1. Revision 事务：`memory_state` post-state、generation/revision、完整 snapshot、event group/events、cursor、task 终态和对应 target status 同事务提交。
2. Generation 初始化事务：raw source mutation、generation/revision、空 state/cursors、完整 snapshot、旧 task 取消和六个 rebuilding target rows 同事务提交；不创建虚假 semantic event group。
3. 无 revision 事务：Provider/schema 等运行失败只更新 durable task、per-target status 和 ops log；deferred group 还必须与原 task stage、派生 maintenance task 同事务提交。
4. 语义恢复：从当前 generation 最新 schema-valid snapshot 开始，按 result_revision 连续 replay normalized operations；不得跨 generation。
5. 运行恢复：从非终态 durable task、per-target status 与 ops log 恢复 retry/halt/context-expansion，不从 snapshot 推断运行状态。

## 9. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.3、§3.5、§3.7、§3.10。
