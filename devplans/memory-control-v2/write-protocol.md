# Memory Control 2.01 写入协议

本文定义 2.01 写入链路与组件编排。Semantic IR、Renderer artifact 和 Compiler 见 [Semantic 写入契约](semantic-write-contract.md)；持久化 shape 与 DDL 见 [状态契约](state-contract.md)；算法与状态机见 [算法契约索引](algorithms/README.md)。

## 1. 写入流水线

```text
Observer
→ ProposerTaskRenderer
→ Semantic Proposer
→ Deterministic Compiler
→ Validator / Reducer
→ Persistence
```

1. **Observer**：读取 state、target status、cursor 与 raw messages，计算 eligible intents。
2. **ProposerTaskRenderer**：生成可读 Memory、稳定 refs、消息文本及私有 ref/source metadata。
3. **Semantic Proposer**：按记忆族输出 `changes/noop/unable_to_decide`；change 只含领域 action、短 ref、text、领域字段与 source selectors。
4. **Compiler**：解析目标和 support refs、查询并校验 raw source、规范化日期、生成 compiled proposal。
5. **Reducer**：执行纯代码结构/状态/容量校验并原子提交 state、events、snapshot、cursor、task 和 target status。

主聊天 Renderer 不属于写入流水线；它在 context assembly 时读取最新 authority state 实时渲染。

职责边界：

- Observer 不做语义信号检测；
- Proposer 不输出真实 itemId、op、evidenceKind、quote 或 contentHash；
- Compiler 不做开放式语义判断，不写数据库；
- Reducer 不调用 LLM，不证明 text 被 source 语义蕴含；
- 诊断投影只观察已提交 events，不参与 Reducer 事务。

## 2. Observer 与 Task 创建

Observer 沿用 per-target lag 机制：

1. `lag = 当前 scope 中 messageId > target cursor 的有效 User/Assistant raw message 数`；
2. 达到 target `lagThreshold` 且 target status 允许 normal 调度时形成 intent；
3. intent 进入同一 `userId/presetId` 串行执行位后，才以最新 state 创建 durable task；
4. task 创建事务捕获 `sourceGeneration/baseRevision/cursorBefore/targetMessageId/userTimeZone`、observed window，并生成 Renderer artifact；
5. 不得在 tick 开头为多个 targets 预先固化同一 revision。

Task payload 是 immutable authority，至少包含：

```text
task metadata
public proposer input
private writable/read-only ref map
messageMeta
normalContextWindow
```

Provider 调用只接收 public input。私有 ref map、contentHash、真实 itemId 与 provenance 不进入 prompt。

## 3. Proposer 路由

| targetKey / 类型 | Proposer | sections |
| --- | --- | --- |
| `scene` | `currentStateProposer` | `scene` |
| `todos` | `todoProposer` | `todos` |
| `standingAgreements` | `agreementProposer` | `standingAgreements` |
| `episodes` | `episodeProposer` | `recentEpisodes`, `milestones` |
| `profileRelationship` | `profileRelationshipProposer` | `userProfile`, `assistantProfile`, `relationship` |
| `worldFacts` | `worldFactProposer` | `worldFacts` |
| maintenance | `compactionProposer` | 单个 compactable item section |

Normal Proposer 保留 per-section `changes | noop | unable_to_decide`；compaction 使用 `changes | unable_to_compact`。普通 Proposer 不输出 `merge`，compactionProposer 只输出 `merge`。

每个 change 至少具有直接消息或 read-only support 来源；compaction 是明确例外，其来源由 source items 继承。direct source 不要求位于 new batch；support-only change 合法。

## 4. Compiler 编排

Provider output 先通过 Semantic Schema 校验。合法 Semantic IR 必须用短事务写入 `stage_payload.semanticResult`，task 进入 `semantic_result_persisted`，然后才运行 Compiler。

Compiler：

1. 读取 immutable artifact；
2. 解析 writable target ref；
3. 展开 read-only support provenance；
4. 读取直接与间接 source 的当前数据库行；
5. 校验 scope、role、createdAt、contentHash；
6. 合并去重 source refs；
7. 规范化 Todo 日期；
8. 映射 action 到 op；
9. 输出 compiled proposal。

合法 compiled proposal 用短事务写入 `stage_payload.compiledProposal`，task 进入 `compiled_proposal_persisted`。恢复扫描看到该阶段时直接进入 Reducer，不再次调用 Proposer 或 Compiler。

在 compile 前或 compile/commit 时发现 generation、revision 或 cursor stale：

- generation/cursor 不匹配：取消旧 task并记录 stale；
- normal task revision 不匹配：创建 successor，以最新 state 重新 render 并重新调用 Proposer；
- 不复用旧 task 的 refs、Semantic IR 或 compiled proposal。

确定性 `ref_resolution_failed/source_validation_failed/date_anchor_invalid/compile_invariant_failed` 不推进 cursor、不产生 revision/snapshot/event，task failed、对应 target halted并写 ops log，不做无意义自动重试。

## 5. Reducer 与 Policy

Reducer 只接收 compiled proposal。权威执行顺序见 [Reducer Apply 算法](algorithms/reducer-application.md)。

Policy 从 `section + op + evidenceKind` 简化为 `section + op + 当前领域状态`：

- item section 全部允许 add/update/forget；
- scene 允许 set/clear；
- todos 额外允许 complete/cancel/expire；
- standingAgreements 额外允许 cancel；
- maintenance 只允许同 section merge；
- exact normalized text duplicate 继续由纯代码拒绝；
- 不做 semantic similarity、canonicalKey 或 observedPattern evidence count。

Reducer apply 时：

- add 建立新 item 与本 change 的 sourceRefs；
- update 合并旧 provenance和本 change sources；
- correct 已在 Compiler 中变成 update，不可再区分；
- forget/terminal action 从 active state 移除对象，动作来源保留在 event；
- merge 继承 source items 的全部 provenance；
- correction/forget 不创建 context-suppression tombstone。

## 6. Cursor

Cursor 仍按 normal target 聚合，不按单 patch/section单独推进：

| 结果 | Cursor |
| --- | --- |
| 至少一个 accepted，且无 deferred/unable/error | 推进 |
| `noop` | 推进 |
| 普通 compiled patch rejected | 推进 |
| capacity `deferred` | 不推进 |
| 首次 `unable_to_decide` | 不推进并扩展一次上下文 |
| 二次 `unable_to_decide` | cursor-only revision 推进 |
| Provider/schema/compile/runtime error | 不推进 |
| `unable_to_compact` | 不推进并 halt target |

联合 target 的所有 section 必须共同形成可推进终局。`episodes` 两个 sections 与 `profileRelationship` 三个 sections 各自只推进一次共享 cursor。

取消 new-batch source gate只改变“change 可以引用什么”，不改变任务为何被调度或 cursor 覆盖到哪里。

## 7. Compaction 与 Capacity

- `recentEpisodes` 继续由 Reducer 确定性滑动淘汰；
- 其余 compactable item section 超过 `maxItems/maxRenderedChars` 时，完整 normal compiled proposal进入 deferred；
- maintenance Renderer 给 source items 分配 writable short refs；
- compactionProposer 输出 `merge refs + text`；
- Compiler 映射成 `mergeItems + itemIds`；
- Reducer 继承 sourceRefs；
- pending proposal item 保护、resume epoch、hygiene 与 lengthBudget 模式继续有效；
- compaction 后 replay 已持久化的原 compiled proposal，不重新调用 normal Proposer/Compiler。

Profile/Relationship merge 不再要求 facet/canonicalKey 相等；Prompt 仍要求只合并语义重复且无损的 item。

## 8. Forget、Correction 与 Privacy

- 所有 item sections 可 explicit forget；scene forget 等价于 clear；
- correction/update 只改变 active value；forget 只移除 active object；
- 不写 suppression tombstone；
- RAG/Recall/rebuild 不因 correction/forget 过滤 raw source；
- raw source 后续可能再次促成相同 Memory，这是 2.01 明确接受的行为；
- privacy hard delete 仍物理删除 raw source、state/events/snapshots、task artifact、Semantic IR、compiled proposal、RAG 与受控 debug 数据。

## 9. 失败与恢复

Adapter `deferred/provider_queue_full` 是本地 admission backpressure，不是 Provider/schema 失败，也不是 capacity deferred。Task 保持非终态并返回 queued，后续由 worker/recovery 重投；它不增加 attempt/error counter，不改变 target status/cursor/revision/event/snapshot。

Provider/schema 失败沿用现有分类：

- `llm_call_failed`；
- `safety_policy_blocked`；
- `max_output_truncated`；
- `output_schema_invalid_retry`；
- `semantic_schema_invalid`（修复重试耗尽后的终态）。

新增 Compiler 分类：

- `ref_resolution_failed`；
- `source_validation_failed`；
- `date_anchor_invalid`；
- `compile_invariant_failed`。

编译错误与 Provider 错误都不能伪装成 noop。技术失败保留最后稳定 state，只影响对应 target。进程重启从 durable stage 恢复；进程内队列不是 authority。

Revision/snapshot/event、phase identity、transaction failure、commit outcome unknown、successor、manual resume 和 source rebuild 继续沿用现有算法。

## 10. 健康与指标

用户侧仍只暴露 `healthy | degraded | rebuilding`。Target 内部状态仍为 `healthy | retry_wait | capacity_blocked | halted | rebuilding`，聚合、持续告警和恢复通知语义不变。

删除指标：

- quote similarity/too-short/too-long/not-found；
- evidenceKind/policy matrix；
- suppression tombstone lag。

新增指标：

- Semantic change/noop/unable rate；
- direct/support/mixed source 使用率；
- support expansion source count；
- ref/source/date compile failure；
- Semantic IR 与 compiled proposal 字符数；
- Compiler latency。

其余 per-target calls/tokens/latency、capacity、replay、stale、queue、GapBridge、rebuild/projection lag 与 degraded duration 继续保留。

## 11. 集中配置

继续集中管理 section 容量、Scene TTL、Todo overdue window、target lag/context window、Provider、retry/backoff、schema repair、compaction、poll、retention 与健康告警参数。

删除 quote matcher 和 suppression 专用配置。短 ref 前缀/编号算法、Compiler source 查询批次上限和诊断 detail 上限应由共享常量定义，禁止各 Proposer 自行实现。
