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
base messageMeta
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
| profileRelationship | 32 / 64 |
| worldFacts | 16 / 96 |

Force drain忽略 lagThreshold 到 captured boundary。

`profileRelationship` 仍是一个持久化 target、一个 cursor 和一次原子提交；Provider Adapter 在 task 内依次调用 User Profile、Assistant Profile、Relationship 三个单 section 专家。三个专家都读取同一完整 observed window 与同一份基线 Memory，分别通过本地 schema/ref 校验后才合并成联合结果。任何一个调用失败或 unable 都不会部分应用其他 section。32/64 使每条消息通常被两个相邻批次覆盖；更早历史由已沉淀 section 递归承载，不靠无限放大 raw window 重读。

## 3. Normal Stage

```text
pending
→ proposing
├→ compiler-ready result
│   → semantic_result_persisted
│   → compiling
│   → compiled_proposal_persisted
│   → reducing
│   ├→ status=succeeded,stage=committed
│   ├→ stage=capacity_blocked → replaying_compiled_proposal → status=succeeded,stage=committed | status=failed,stage=replay_failed
│   └→ status=failed | status=cancelled
└→ contains unable_to_decide
    → unable_result_persisted
    ├→ first unable → context_expanding → context_expanded → proposing
    └→ second unable → status=succeeded,stage=unable_cursor_committed
```

持久化边界：

1. Provider成功且 Semantic Schema通过后，先分类结果：normal 任一 section `unable_to_decide` 或 maintenance `unable_to_compact` 时短事务保存 `unableResult`；否则保存 `semanticResult + semanticInputVariant`；
2. `unableResult` 不是 compiler-ready。Normal 首次 unable 继续 durable context expansion，二次 unable 继续 cursor-only事务；maintenance unable直接进入其 lengthBudget/hygiene终局；
3. Compiler成功且 compiled schema通过后，短事务保存 `compiledProposal`；
4. Reducer事务开始前 compiler-ready Semantic result与 compiled proposal都必须 durable；
5. crash恢复看到 compiler-ready Semantic result时不重调LLM，重新执行确定性 Compiler；
6. 看到 compiled proposal时不重调LLM/Compiler，直接 Reducer；
7. 恢复看到 unable result时不得运行 Compiler；normal 按 expansion attempt继续扩窗或 cursor-only分支，maintenance 按 mode进入 compaction_failed或 hygiene_noop终局；
8. successor/显式 context expansion是允许重新调用LLM的例外。

## 4. Cursor

| 终局 | Cursor |
| --- | --- |
| accepted/noop/普通 rejected | 推进 |
| capacity deferred | 不推进 |
| 首次 unable | 不推进，扩展一次 |
| 二次 unable | cursor-only revision推进 |
| Provider/schema/compile/runtime error | 不推进 |
| length-budget unable_to_compact/replay_failed | 不推进 |

Hygiene maintenance 不拥有 normal cursor；其 `unable_to_compact` 以 `stage=hygiene_noop|hygiene_skipped` 终结并保持 target healthy，不适用上表的 length-budget halt语义。

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

- Adapter 返回 `deferred/provider_queue_full` 时，表示本地 admission backpressure：当前 task 保持非终态并返回 queued，后续重新投递；不增加 Provider attempt/consecutive errors，不消耗 schema repair，不写错误 ops outcome，不改变 target status/cursor/revision/event/snapshot。该状态与 capacity deferred 无关；
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

1. 联合结果任一 section unable 时，整个结果不可 compile；同一结果内其他 section 的 changes/noop不部分应用；
2. 短事务保存 `unableResult`，task进入 `unable_result_persisted`；
3. `context_expansion_attempt=1`；
4. 只向前扩展 observed raw messages到原 contextWindow两倍，不超过 captured target boundary；
5. Memory public text与 private ref map沿用首次 artifact；
6. 将 `expandedArtifact.publicInput` 与覆盖其中全部消息的 `expandedArtifact.messageMeta` 在同一短事务持久化，task进入 `context_expanded`；不得只保存 expanded message文本；
7. expanded Provider retry/restart始终复用该 artifact，不按变化后的窗口重建；
8. expanded调用产生 compiler-ready结果时，保存 `semanticInputVariant=expanded`；
9. 不修改 target长期错误计数。

二次 unable：短事务更新 `unableResult` 后重新做 generation/cursor/revision校验；revision变化走 successor，否则原子丢弃该次结果中所有 section 的候选 changes/noop，提交 cursor-only revision/event group/snapshot/task/status，不伪造 noop event，也不运行 Compiler。

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

覆盖 artifact/ref稳定、expanded artifact/messageMeta持久化、unable stage恢复且不进入Compiler、联合 changes+unable原子处理、不重复LLM/Compiler、cursor聚合、successor生成新refs、schema repair、compile halt、capacity replay、phase identity和commit outcome unknown。
