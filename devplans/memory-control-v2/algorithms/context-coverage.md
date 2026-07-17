# Context Coverage 算法（version 3）

本文是主聊天 recent window、`needsMemory`、GapBridge、RAG/Recall 截止点和查询时健康判断的单一权威来源。Coverage 只读取 version 3 的全局 raw scan checkpoint 与 observation-target lifecycle；各 writer 没有独立消息进度。

## 1. Recent Window 与 needsMemory

Context compiler 先从该 user/preset 的有效 user/assistant raw messages 构造跨 session 候选历史，再以集中配置的 Unicode code point 阈值计算 `needsMemory`：

1. raw content 总数不超过阈值：保留全部消息，`needsMemory=false`，不注入 memory 或 GapBridge；
2. 超过阈值：从最新消息向前选择不超过阈值的完整消息，再应用既有 user-boundary 裁剪，`needsMemory=true`；
3. 最新一条消息即使单独超限也完整保留，不截断单条 raw message；provider 物理上限由独立能力层处理；
4. `memory_state.version=3` 且 schema 校验成功时实时 Renderer；state 不存在、version 不支持或 schema 非法时不注入 memory，并记录明确 debug reason。

recent window 可以跨 session；session/turn 只作为 source 完整性元数据，不插入改变语义的控制消息。主聊天的 user-boundary 裁剪不用于 source scan。

令 `R` 为裁剪后 recent window 第一条消息的 messageId。`messageId >= R` 已被 recent window 完整覆盖。无 recent window 时不组装 GapBridge；在正常聊天请求中该情况只会出现在没有有效 raw source 时。

## 2. GapBridge 的双来源覆盖

`needsMemory=true` 时，GapBridge 必须合并两个集合。所有 raw 查询都限定当前 `(userId,presetId,sourceGeneration)` 的有效 source，并验证当前 content hash。

### 2.1 未扫描 raw source

令 `S = chat_memory_source_scan_status.scanned_through_message_id`。集合 A 是：

```text
S < messageId < R
```

范围内的全部完整有效 raw messages。它覆盖 source scanner 尚未登记为 assessment/observation、同时又已掉出 recent window 的消息。`S >= R-1` 时集合 A 为空。scan status 缺失或 generation 不一致时按 `S=0` 处理并标记 rebuilding，不能假定“没有 gap”。

`stable_boundary_message_id` 可以用于解释为什么尾部尚未扫描，但不能缩小集合 A；即使消息仍处 provisional tail，只要已掉出 recent window，也必须桥接或记录 omission。

### 2.2 未落定 observation evidence

集合 B 是当前 generation 中，任一 observation-target 状态为以下之一的 observation 所登记、且位于 recent window 外的全部有效 raw evidence：

```text
ready | processing | waiting | retryable | dead_letter
```

通常约束为 `messageId < R`。`consumed | excluded` 不需要 GapBridge；invalidated/superseded observation 和命中 suppression/privacy gate 的 evidence 不得注入。一个 observation 分配多个 target 时保留完整 target tags，但 raw 消息只出现一次。

`waiting` 是正常业务状态、不使 Memory health degraded，但其尚未形成稳定 state，证据仍需要桥接。`retryable | dead_letter` 同时触发健康告警。open episode arc 自身不是独立注入对象；只有它已登记到上述 observation evidence 时进入集合 B。

### 2.3 合并、去重与可追溯性

集合 A、B 按 `(messageId,contentHash)` 去重，恢复原 raw message 的 role、createdAt 和 content。每条候选附带内部 coverage tags：

- `unscannedSource=true/false`；
- `observationTargets=[{observationId,targetKey,status,observationVersion}]`；
- 相关 `sourceBoundaryMessageId`。

这些 ID/status 只用于诊断，不向主模型宣称为用户事实。最终注入单一 `gapBridge` segment，并按 messageId 升序排列完整 raw messages。GapBridge 不推进 scan checkpoint、不改变 observation-target lifecycle、不写 patch，也不替代后续 scan/cycle。

## 3. 预算与 omission 诊断

GapBridge 使用独立于 Memory section 的 Unicode code point 预算和完整消息条数上限。超预算时不调用 LLM 压缩、不截断消息正文。

选择算法必须确定且避免一种来源完全饿死：

1. 先为集合 B 的每个 active observation 保留最近一条实质 evidence（按最早 pending 时间、observationId 稳定轮转）；
2. 再为集合 A 保留最新未扫描消息；
3. 剩余预算在全部候选中按 messageId 倒序填充；
4. 最后恢复 messageId 升序注入。

单条消息本身超过预算时整条 omitted。任何 omission 都必须持久化到 `chat_context_quality_diagnostics`，统一使用 `boundary_message_id` 和 `detail` 表达覆盖边界。

至少写入：

```js
{
  subjectKind: "sourceScan" | "observationTarget",
  subjectKey: "sourceScan" | "<observationId>:<targetKey>",
  diagnosticType: "gap_bridge_truncated",
  sourceGeneration,
  boundaryMessageId,       // 本 subject 被省略证据的最大 messageId
  detail: {
    requestId,
    recentWindowStartMessageId: R,
    scannedThroughMessageId: S,
    observationVersion: null | 3,
    observationTargetStatus: null | "waiting",
    candidateMessageCount,
    candidateCodePoints,
    retainedMessageCount,
    retainedCodePoints,
    omittedMessageCount,
    omittedCodePoints,
    omittedMessageIds,
    truncated: true
  }
}
```

同 generation、同 subject 的 active row 以原子 upsert 更新；`boundary_message_id` 单调不减，较小/较早请求不得覆盖更大遗漏。`detail.omittedMessageIds` 可按受控上限保存，超限时保存 ranges/hash 和准确计数，不能持久化完整 raw content。

恢复条件按 subject 判定：

- `sourceScan`：checkpoint 已扫描通过 active `boundary_message_id`，或在锁定当前 generation 后证明遗漏 key 已不再是有效 raw source；
- `observationTarget`：对应版本已进入 `consumed | excluded`，被显式 invalidated，或锁定 generation 后证明其全部未落定 registered evidence 已在本次 recent window/GapBridge 完整覆盖；
- generation 改变：旧 diagnostic 失效并 resolve，但新 generation 仍按实际 coverage 重新判断，不能发送“已追平”的恢复通知。

恢复事务必须重新读取 active row，证明其完整边界，而不是根据一次较小查询结果清除。截断不阻断主聊天，但 active source-scan/observation retry 故障应显示“部分早期对话未在上下文中”；纯 waiting 的 truncation 可显示 coverage 告警，却不能把 waiting 本身误报为 worker failure。

## 4. RAG/Recall 查询边界

Memory 保存结构化当前状态；RAG 负责具体旧场景、原话和细节。三类边界：

- `sourceBoundary`：当前 generation 最新有效 source messageId；
- `requiredBoundary`：本次需由 RAG/Recall 覆盖的截止点，`R - 1`；
- `processedBoundary`：projection checkpoint 的 `processed_boundary_message_id`。

有效检索上界为 `min(processedBoundary, requiredBoundary)`。Recall/Scene Recall 是命中 chunk 后的即时 enrichment，没有独立 checkpoint；chunk、附加前后 raw dialogue 和生成 Recall 的每次查询都必须显式携带同一 cutoff。

Memory 的 source scan checkpoint、observation-target lifecycle 与 RAG projection checkpoint 相互独立：scanner 追平不代表 RAG 追平，candidate consumed 也不代表 RAG 已索引；反之亦然。

查询时 projection health：

- `processedGeneration != sourceGeneration` → `rebuilding`；
- generation 相同但 `processedBoundary < requiredBoundary` → `degraded`；
- generation 相同且 `processedBoundary >= requiredBoundary` → query-scoped `healthy`，即使还没追到 `sourceBoundary`。

部分覆盖仍可注入已处理范围，但必须标记不完整。active projection-lag diagnostic 同 generation 保留观察到的最大 `requiredBoundary`；小边界请求可以在自身响应中 healthy，但不得清除更大 active diagnostic。

## 5. 健康标记与恢复通知

Renderer 对 retry/capacity/halted target 渲染最后稳定 state，并显示“该类记忆可能滞后”；rebuilding 显示“该类记忆正在重建”。GapBridge diagnostics 按 subject 聚合到受影响 target；source scan 全局故障影响所有尚未覆盖的新候选。

`waiting` observation 不单独降级；`retryable | dead_letter`、source scan retry/halt、active truncation、projection lag 才按各自原因告警。多个相邻 section 可共用一次标记，不相邻 section 各自标记。

恢复通知按 `subject_kind/subject_key/source_generation/boundary_message_id` best-effort once 创建。只有完整 active boundary 被证明覆盖后才能创建；generation 失效式 resolve 不创建 recovery notification。

## 6. Context 总预算边界与 Harness

当前各 segment 仍使用独立逻辑预算，尚未引入 provider/model 统一总裁剪；GapBridge 与 RAG 的内容重叠暂时允许。延后设计见 [总 Context 预算](../../deferred/memory-control-v2/total-context-budget.md)、[Gap Compressor](../../deferred/memory-control-v2/gap-compressor.md) 与 [GapBridge/RAG 重叠](../../deferred/memory-control-v2/gap-bridge-rag-overlap.md)。

Harness 至少覆盖：scan status 缺失、provisional tail 掉出 recent window、A/B 集合交叠去重、多 target evidence、waiting/retryable/dead-letter、预算公平性、并发 diagnostic 单调边界、generation 切换和 projection 部分覆盖。详见 [Harness 验收契约](../harness.md)。
