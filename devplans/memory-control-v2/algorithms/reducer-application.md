# Reducer Apply 算法

本文是 2.01 compiled proposal 校验、模拟、apply、event 和 revision 提交顺序的单一权威来源。

## 1. 职责边界

Reducer 是纯代码 State Applier。它不接收 Semantic IR，不调用 LLM，不解析 short ref，不做 quote/evidenceKind/new-batch 校验，也不做开放式语义冲突或相似度判断。

Compiler 只生成候选 compiled patch；Reducer/事务仍掌握最终写入权。

## 2. 权威执行顺序

1. **task/stale 校验**：锁 task，校验 schema version=`"2.01"`、generation、cursor、revision 与 phase identity。
2. **compiled schema**：校验 section、op、path/itemId/itemIds、value、sourceRefs 的精确 shape。
3. **source integrity**：normal non-merge patch 的 sourceRefs 非空、去重有序，并与 Compiler source bundle/数据库复核结果一致。该步骤只防止 compiled payload 被破坏，不重新做语义选择。
4. **section/op policy**：按 [状态契约 §6](../state-contract.md) 的 `section + op` 表校验；不读取 role/evidenceKind。
5. **目标与结构冲突**：item/path 存在性、同 bundle 重复操作、跨 section merge、Todo/Agreement terminal 权限、pending proposal item 保护。
6. **精确重复**：add/update 后与同 section 其他 active item 的 Unicode 规范化 text 完全相同时 `duplicate_item`；不做 canonicalKey 或 semantic similarity。
7. **模拟 apply**：按 patch 顺序在 state clone 上模拟。
8. **provenance**：add 使用 change sources；update 合并旧/新 sources；merge 继承 source items；forget/terminal sources 留在 event；scene set 使用 sources，clear 清空 active field。
9. **领域生命周期**：应用 Todo overdue/revive、Scene TTL 和 recentEpisodes 滑动窗口，任何持久化变化生成 cleanup event。
10. **容量**：scene patch 逐字段检查；其他 section 对完整模拟 post-state 检查。Item capacity 超限进入 compaction，禁止 accepted+deferred 混合提交。
11. **事件**：每 compiled patch 一行 decision；noop 占位；accepted/system cleanup 保存完整 normalized operation。
12. **revision 事务**：原子提交 post-state、snapshot、event group/events、cursor、task 终态和 target status。

顺序不可随意调整。

## 3. Apply 规则

### 3.1 Item

- add：Reducer 生成全局唯一 ID；`createdAtMessageId=min(new sources)`；
- update：保留 ID/createdAt，更新领域 value，sources union+dedup，`updatedAtMessageId=max(all sources)`；
- forget：从所有 item sections移除目标 item，不写 tombstone；
- Todo/Agreement terminal：移除目标 item；
- merge：生成新 ID，继承 sources和领域字段，移除 source items。

### 3.2 Scene

- setField：覆盖 value，保存 compiled sourceRefs，updatedAtMessageId 取最大 source ID；
- clearField：写 `{value:null,sourceRefs:[],updatedAtMessageId:null}`；
- clear/forget 动作来源保留在 accepted event normalized operation；
- 不 suppress 被替换 field 的旧 sources。

### 3.3 Correction

Semantic correct 在 Compiler 中已转换为普通 update/set。Reducer、event、snapshot 和 state 不保留 correction 与普通 update 的差异。

## 4. Capacity

- scene 超限 patch 以 `capacity_exceeded` rejected，同 bundle 其他 patch 可继续，cursor按普通 rejected 语义推进；
- recentEpisodes 超限由 lifecycle 淘汰最旧项；
- 其他 item section 超限时完整 proposal deferred；
- capacity replay 使用持久化 compiled proposal，不重新调用 Proposer/Compiler。

## 5. 不再执行的规则

2.01 Reducer 删除：

```text
quote matcher
evidenceKind policy/role matrix
observedMessages membership gate
new-batch/overlap_only_evidence gate
observedPattern message-count gate
facet/canonicalKey/factBasis validation
duplicate_profile_key
correction/forget tombstone write
suppressed source query gate
```

## 6. Harness

覆盖 compiled schema、source payload tampering、all-section forget、provenance union、scene multi-source、exact duplicate、生命周期、capacity、event replay 和逐写入点事务 rollback。
