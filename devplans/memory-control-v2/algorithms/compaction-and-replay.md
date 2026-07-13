# Compaction 与 Proposal Replay 算法

本文是 capacity-blocked、maintenance task、compaction、pending proposal 保护和原 proposal replay 的单一权威来源。Task/patch/event 数据 shape 见 [状态契约](../state-contract.md) §4、§5.2、§6、§8、§9。

## 1. 触发边界

`compactionProposer` 不是普通写入 Proposer，不由 lag 阈值调度。它只在 Reducer 的长度预算门发现 item patch 会超过上限时触发，用来释放容量或确认没有安全压缩空间。

状态分属两类 task 和 per-target status，不是单条链。`target_halted` 不是 task stage，只是 per-target status（`capacity_blocked` 或 `halted`）。maintenance task 必须持久化 `parent_task_id` 指向来源 normal task；normal task 的 `stage_payload` 持久化当前 `maintenance_task_id`。

**Normal task stage**（`task_type=normal`）：

```text
pending → proposing → proposal_persisted
→ capacity_blocked
→ replaying_original_proposal
├→ succeeded
└→ replay_failed
```

**Maintenance task stage**（`task_type=maintenance`）：

```text
pending → compacting
├→ compaction_applied       # 至少一个 patch apply 成功（其他可能因保护而 reject，见步骤 5）
└→ compaction_failed        # 全部 patch 被保护或无安全合并空间
```

## 2. 权威流程

1. normal proposal 中的 item patch 经模拟 apply 后，目标 section 将超过 `maxItems` 或 `maxRenderedChars`；不只检查 `addItem`，会增长渲染文本的 `updateItem` 等操作同样受容量门约束。Reducer 对完整 proposal 的最终模拟 post-state 做容量检查。
2. 如果任一 section 超容量，本轮不 apply proposal 中的任何 patch（禁止 accepted + deferred 非原子混合提交）。normal task 进入 `capacity_blocked` stage，per-target status 进入 `capacity_blocked`。capacity-blocked 事务只为触发容量阻塞的 patch 写 `decision: "deferred"`、`result_revision=null` 的 event group（"capacity-blocked 审计 group"）；其他 patch 暂不写最终 decision，完整 proposal 写入 normal task 的 `stage_payload.persistedProposal`（`task_payload` 在 task 创建时固化后不可变，不存放 Proposer 运行时输出）。同事务创建 maintenance task（`task_type=maintenance`、`parent_task_id` 指向 normal task），normal task 的 `stage_payload.maintenanceTaskId` 持久化对应 maintenance task ID。cursor 不推进。
3. maintenance task 按 `task.targetSections` 固定顺序，每次只压缩一个阻塞 section。maintenance task 与普通 task 共用同一 `userId/presetId` 串行队列，使用 [状态契约](../state-contract.md) §5.2 的 maintenance 模式 envelope；trigger 的 `dimension` 记录本次阻塞来自 `maxItems` 还是 `maxRenderedChars`。其 `targetKey` 只关联来源 normal target；`targetMessageId` 只复制来源 normal proposal 的阻塞边界，用于关联、幂等和后续 replay。两者均不表示 compaction 拥有或推进 raw-message cursor，compaction 也不据此读取 raw messages。
4. `compactionProposer` 的 section `status` 为 `patches` 或 `unable_to_compact`。`status` 为 `patches` 时，patch 的 `op` 只能是 `mergeItems`。
5. Reducer 对 compaction patch 继续执行 schema、itemIds、policy、结构化冲突和 source evidence 完整性校验。`memory_compaction` 的 evidenceGroups 由 Reducer 根据 `itemIds` 从 source items 继承。Pending proposal 保护：Reducer 对 compaction patch 的 `itemIds` 与该 target 所有 pending（capacity_blocked/compacting）proposal 引用的 itemId 集合做交集校验——这是纯代码硬校验，不是 prompt 约束。相交的 compaction patch 被 reject，reason=`item_protected_by_pending_proposal`；该 compaction patch 不 apply，同一 maintenance task 的其他 patch 仍可正常 apply。一个 maintenance task 的全部 patch 均因保护而 reject 时，视同 `unable_to_compact`，进入 `compaction_failed`。
6. compaction apply 成功后形成 maintenance task 的 revision+snapshot（`compaction_applied`）。每次 compaction revision 后重新预检完整 proposal 的模拟 post-state；仍有其他阻塞 section 时继续创建下一个 maintenance task（按 `targetSections` 固定顺序），而不是立即 `replay_failed`。所有阻塞 section 都释放容量后，normal task 从 `capacity_blocked` 进入 `replaying_original_proposal`。
7. replay 从数据库读取原 proposal，在当前 state 上先对完整 proposal 重做纯代码预检，预检通过后才确定性 replay；不得重新调用原 Proposer。replay 时使用原稳定 `patchId` 为全部 patch 写最终 `accepted/rejected/noop` events（"最终 replay group"），replay revision 基于执行时最新全局 revision 创建。replay 的 stale 判定只看以下条件：
   - task/proposal 的 `sourceGeneration` 仍等于当前 `memory_state.meta.sourceGeneration`；generation 不同立即取消旧 normal/maintenance task，不跨 generation replay；
   - 当前 target cursor 仍等于原 `cursorBefore`；
   - proposal 仍是该 target 的活动 proposal（normal task 非终局）；
   - 引用 item 仍存在并通过当前 state 的纯代码预检；
   - schema/source hashes 仍兼容，且 replay 前重新应用与首次 commit 相同的 context-suppression tombstone gate；已被 suppression 的 source 不得因 replay 绕过首次提交边界。

   generation 相同时，其他 target 导致的 revision 增长不使 proposal stale；原始 `baseRevision` 只用于审计。
8. 如果 compactionProposer 返回 `unable_to_compact`（无安全合并空间），maintenance task 进入 `compaction_failed`，per-target status 进入 `halted`。如果 compaction `accepted` 但 replay 预检仍因容量不足而失败，normal task 进入 `replay_failed`（reason=`capacity_still_exceeded`），per-target status 进入 `halted`。replay 的其他非 stale 确定性失败同样进入 `replay_failed`，并记录精确 reason。如果 compaction 发生技术性失败（LLM 调用/schema/provider），按 [Task 执行、Cursor 与幂等](task-execution-and-idempotency.md) 的 error 恢复策略处理。

## 3. 有界执行与 Resume

maintenance task 有界执行：尝试上限按 `(parentTaskId, section)` 计算，同一 section 对同一阻塞窗口最多尝试 1 次。resume 创建新 maintenance child task 重新进入 compaction，不复用已终态的旧 maintenance task；新 child task 的 `resume_epoch` = 前一个 + 1，`dedupe_key` 包含新 `resume_epoch`，因此不会命中旧 task 的幂等终态。resume 将 per-target status 从 `halted` 变为 `capacity_blocked`，不立即设 healthy，只有原 proposal 成功 replay、cursor 推进并提交 snapshot 后才恢复 `healthy`。

当前 compaction/replay 失败后 halt 对应 target 的策略是临时方案，用于在计划前期通过真实运行数据确定合适容量默认值。待容量默认值稳定后，再引入自动降级策略，见 [容量降级策略（延后）](../../deferred/memory-control-v2/capacity-degradation.md)。

## 4. 遗忘边界

- `recentEpisodes` 的遗忘仍由 Reducer 按滑动窗口确定性滚出，不需要 compactionProposer。
- `todos` 不能因为容量压力被静默删除；只有 active item 可参与 compaction，且必须满足 [领域生命周期](domain-lifecycle.md) 的 Todo status × op 约束。
- `standingAgreements` 不能因为容量压力被静默删除，只能取消、修订或合并重复项。
- `milestones`、`worldFacts`、`userProfile`、`assistantProfile` 和 `relationship` 不能自动遗忘；compactionProposer 只能在同一 section 内合并明显重叠项。

## 5. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.5、§3.6、§4。
