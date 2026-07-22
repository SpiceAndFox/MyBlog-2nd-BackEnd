# Active Forget、Privacy Hard Delete 与 Retention 算法

Memory Control 2.01 不实现 context-suppression tombstone；本文只定义 active-state forget/correction、privacy hard delete 和 retention。

## 1. Update/Correct

- Semantic correct 与 update 均编译为 `updateItem/setField`；
- active object 只显示新 value；
- item update 将旧 sourceRefs 与本 change sourceRefs 合并去重；scene set 使用本次 compiled sources；
- 旧 event/snapshot 不改写；
- 不生成 correction tombstone；
- 旧 raw source、RAG chunk 和 Recall 仍可出现；
- rebuild 可以再次从旧 raw source 归纳出旧内容。

这是 2.01 明确接受的语义，不属于 privacy guarantee。

## 2. Forget

- 所有 item section 都允许 `forgetItem`；
- scene forget 编译为 clearField；
- forget 只移除当前 active item/field；
- forget 指令的 sourceRefs 保存在 accepted event normalized operation；
- 不修改 raw messages，不遍历 provenance graph，不写 tombstone，不通知 RAG projection；
- 后续 normal task或 rebuild 可能重新形成相同 Memory。

如未来需要防复活或历史检索 suppression，必须从 deferred 方案重新进入主设计，不得在 2.01 中局部恢复半套 tombstone。

## 3. RAG/Recall

RAG/Recall 不执行 correction/forget source filtering。Source refs 仍可用于：

- generation/boundary一致性；
- 来源展示或调试；
- privacy purge verification；
- raw source mutation 后的 rebuild。

## 4. Privacy Hard Delete

Privacy hard delete 与普通 forget 完全不同，必须物理清除指定内容在以下位置的副本：

- raw messages；
- Memory state/events/snapshots；
- durable task `task_payload` 中的 public input/private ref map/message metadata；
- `stage_payload` 中的 unable/Semantic result、compiled proposal、expanded artifact及其 message metadata；
- context-quality diagnostics、diagnostic checkpoints、recovery notifications；
- RAG/Recall 派生数据；
- 受控 debug store。

禁止将完整 raw prompt、Renderer artifact、Semantic IR、compiled proposal、state diff 或 message content 写入不可按 scope 删除的 append-only 日志。

Source delete 与普通 Memory task 共用 scope 串行 lane。受控流程：

```text
delete raw source / capture affectedFromMessageId
→ sourceGeneration + 1 / select latest safe snapshot anchor
→ purge old derived history and register durable operation
→ purge and verify all registered external stores
→ draining remaining raw source from anchor cursors
→ validate
→ completed
```

安全 anchor 只能来自受影响消息之前，并必须重新验证其全部 raw provenance；详细条件见 [Source Rebuild 与 Projection](source-rebuild-and-projection.md)。候选 snapshot 在 Memory 派生历史被物理清理前读取，随后以新的 generation/revision 写回为唯一 anchor，因此复用未受影响前缀不会保留待删除的旧 audit rows。没有安全候选时 authority 必须从空 state 初始化。

这里的 draining 仍属于 rebuild，但只重放 anchor 未覆盖的 source 后缀。不能因为最新 snapshot 本身未受影响就直接完成 operation：被删除或编辑的位置及其后续消息仍需重新归纳，RAG 和其他 generation-bound 派生状态也必须完成 purge/重建验证。

任一 store 残留时保持 operation incomplete。整个 scope 删除可在 verified 后直接完成，不需要 rebuild。2.01 无 tombstone store，privacy 实现不得因此漏掉新增 artifact/IR/compiled payload。

## 5. Retention

1. 当前 generation 至少保留一个 schema-valid完整 anchor snapshot；
2. anchor 提升前验证新 snapshot 等于从旧 anchor 连续 replay 的结果；
3. 只需保留 `result_revision > anchor.revision` 的连续 groups；
4. `result_revision=null` 审计 group可独立按策略清理；
5. 旧 generation 只有在当前 rebuild 校验完成、无 worker读取且审计/privacy允许时清理；
6. 非终态 task、被 active task 引用的 parent/predecessor、retained event group 引用的 task不得删除；
7. 删除 events 前先同步 diagnostic projection；
8. task payload/stage payload retention必须覆盖 base/expanded Renderer artifact、unable/Semantic result和 compiled proposal；
9. 清理不得破坏 phase identity 或 commit-outcome recovery。

## 6. Harness

覆盖 all-section forget、scene clear、无 tombstone副作用、允许 rebuild复活、privacy全 store purge/verify、base/expanded artifact、unable/IR/compiled payload删除、anchor提升和连续 replay。
