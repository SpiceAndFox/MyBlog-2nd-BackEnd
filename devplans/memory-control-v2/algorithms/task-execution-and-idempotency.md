# Task 执行、Cursor 与幂等算法

本文是 2.01 normal/maintenance/system-cleanup task 创建、Renderer artifact、Semantic/Compiler阶段、cursor、retry/resume、phase identity 和 crash recovery 的单一权威来源。

## 1. 串行与 Task 创建

当前只支持单实例。同一 `userId/presetId` 的 normal、maintenance、system cleanup 和 source mutation 共用一个进程内串行 lane。进程内队列不是恢复 authority；durable task、per-target status、ops log、events/snapshots才是。

Observer 可以一次发现多个 eligible target，但只能先排 intent。每个 task 进入串行位后，以最新 state 创建并固化：

```text
sourceGeneration
baseRevision
cursorBefore / targetMessageId
Renderer artifact publicInput
private writable/read-only ref map
messageMeta
normalContextWindow
```

同一调度事实的重复 wake-up 命中同一 dedupe key。Normal key至少绑定 generation/target/cursorBefore/targetMessageId；maintenance 还绑定 parent/section/resumeEpoch；cleanup 绑定 deterministic boundary。

## 2. 调度窗口

- `lagThreshold=N` 决定调用频率；
- `contextWindow=M` 决定 observed window；
- newBatch 从 cursor 后取最早 `min(N,lag)` 条；
- overlap 从 cursor 及之前补足到 M；
- `targetMessageId=max(newBatch.id)`。

这些边界继续决定 cursor覆盖和任务调度，但不再限制 change source：direct source 可以来自本 task 显示的 overlap/newBatch任一消息；support source 可展开到 observed window之外。

建议默认值继续保留：

| target | lagThreshold/contextWindow |
| --- | --- |
| scene | 4 / 16 |
| todos | 8 / 48 |
| standingAgreements | 16 / 64 |
| episodes | 32 / 96 |
| profileRelationship | 32 / 128 |
| worldFacts | 16 / 96 |

Force drain忽略 lagThreshold 到 captured boundary。

## 3. Normal Stage

```text
pending
→ proposing
→ semantic_result_persisted
→ compiling
→ compiled_proposal_persisted
→ reducing
├→ committed
├→ capacity_blocked → replaying_compiled_proposal → committed | replay_failed
└→ failed/cancelled
```

持久化边界：

1. Provider成功且 Semantic Schema通过后，短事务保存 `semanticResult`；
2. Compiler成功且 compiled schema通过后，短事务保存 `compiledProposal`；
3. Reducer事务开始前两者都必须 durable；
4. crash恢复看到 Semantic result时不重调LLM，重新执行确定性 Compiler；
5. 看到 compiled proposal时不重调LLM/Compiler，直接 Reducer；
6. successor/显式 context expansion是允许重新调用LLM的例外。

## 4. Cursor

| 终局 | Cursor |
| --- | --- |
| accepted/noop/普通 rejected | 推进 |
| capacity deferred | 不推进 |
| 首次 unable | 不推进，扩展一次 |
| 二次 unable | cursor-only revision推进 |
| Provider/schema/compile/runtime error | 不推进 |
| unable_to_compact/replay_failed | 不推进 |

联合 target 必须所有 sections共同形成可推进终局。Capacity-blocked 禁止 accepted+deferred 混合提交。

取消 new-batch evidence gate不改变 cursor：只要 Proposer已经处理本轮 target boundary并产生合法终局，即可推进，即使 accepted change完全由 old direct/support source支持。

## 5. Stale 与 Successor

提交/compile前按 task行锁校验：

- generation mismatch：cancel旧 task；
- cursor mismatch：cancel旧 task；
- normal首次执行 revision mismatch：cancel旧 task并创建 successor；
- compaction/replay按阶段捕获的最新 revision和专用条件校验。

Successor：

1. 新 taskId/dedupe key；
2. predecessor指向旧 task；
3. 读取最新 state；
4. 重新生成 Renderer artifact/ref map；
5. 重新调用 Proposer和Compiler；
6. 不复用旧 Semantic IR、compiled proposal或refs。

## 6. Provider 与 Semantic Schema Error

- `llm_call_failed/safety_policy_blocked/max_output_truncated`：按有限指数退避；达到 task/consecutive阈值后 halt对应 target；
- Provider输出本地 Semantic Schema invalid：最多一次 durable schema repair；
- repair feedback只保存有界 path/message，不保存非法输出原文；
- 重试耗尽：`semantic_schema_invalid`，task failed/target halted；
- 输入 artifact/schema invalid是内部错误，不重试LLM。

Maintenance child重试时 target保持 capacity_blocked，不切成普通 retry_wait。

## 7. Compiler Error

`ref_resolution_failed/source_validation_failed/date_anchor_invalid/compile_invariant_failed` 是确定性错误：

- 先重校 stale；若 state已变化走 stale/successor；
- 否则 task failed、target halted、ops log记录有界 detail；
- 不自动重复调用LLM/Compiler；
- 不推进 cursor，不写 event/revision/snapshot；
- 修复代码/schema/source根因后手动 resume创建新 normal task。

## 8. unable_to_decide

首次 unable：

1. `context_expansion_attempt=1`；
2. 只向前扩展 observed raw messages到原 contextWindow两倍，不超过 captured target boundary；
3. Memory public text与 private ref map沿用首次 artifact；
4. expanded public input持久化，retry/restart复用；
5. 不修改 target长期错误计数。

二次 unable：重新做 generation/cursor/revision校验；revision变化走 successor，否则提交 cursor-only revision/event group/snapshot/task/status，不伪造 noop event。

## 9. Resume

- retry_wait：清 notBefore并重新排原 task，target保持 degraded到成功；
- capacity/replay halted：创建新 maintenance child，resumeEpoch+1；
- normal Provider/schema/Compiler halted：根因修复后创建新 normal task，重新 render/propose/compile；
- maintenance Provider/schema/Compiler halted：根因修复后创建新 maintenance task；有 blocked parent 时增加 resumeEpoch，不复用终态 child；
- Resume不直接改 state/revision/cursor，不影响其他 targets。

## 10. Phase Identity

每个 task phase使用稳定 event-group identity。同 phase重复 delivery或 COMMIT结果不确定时先读取既有终态：

- 已提交：返回原结果；
- 未提交：基于当前 state重新校验后继续；
- 不产生重复 event/revision/snapshot/cursor推进。

Capacity-blocked audit、maintenance apply和 final replay是不同稳定 phase。

## 11. 原子事务

- revision事务：state、snapshot、group/events、cursor、task终态、target status；
- generation事务：raw mutation、new generation空 state、snapshot、旧 task取消、六 target rebuilding；
- no-revision事务：Provider/schema/compile error只更新 task/status/ops；
- deferred事务：audit group、parent stage、child task、target capacity_blocked；
- Semantic/compiled产物各自先短事务持久化，再跨越下一不可重复边界。

## 12. Harness

覆盖 artifact/ref稳定、stage恢复、不重复LLM/Compiler、cursor聚合、successor生成新refs、schema repair、compile halt、unable expansion、capacity replay、phase identity和commit outcome unknown。
