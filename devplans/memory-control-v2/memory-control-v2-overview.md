# Memory Control 2.01 顶层设计

## 文档定位

本文定义情感类 AI Chat 的 Memory Control 2.01 顶层架构、权威状态、写入边界、可靠性机制和不可破坏的设计约束。

详细契约：

- [Semantic 写入契约](semantic-write-contract.md)：ProposerTaskRenderer、稳定短引用、Semantic IR、Compiler、compiled patch 与 source validation；
- [状态契约](state-contract.md)：`memory_state`、provenance、section、持久化 patch、event/task/sidecar DDL；
- [写入协议](write-protocol.md)：Observer、Proposer、Compiler、Reducer、cursor、compaction 与失败降级；
- [算法契约索引](algorithms/README.md)：确定性算法、状态转移、幂等和运行不变量；
- [渲染与上下文接入](rendering-and-context.md)：主聊天 Renderer、Memory segment、RAG 与 raw source 边界；
- [Proposer Prompt 契约](proposer-prompt.md)：各 Semantic Proposer 的语义准入与输出权限；
- [Harness 验收契约](harness.md)：Compiler/Reducer/Renderer/pipeline fixtures 与恢复测试。

Memory Control 2.01 是对原 v2 语义写入协议的替换，不兼容旧 v2 state/task/proposal/event/snapshot。当前使用可重建的开发数据库，切换时直接清理旧 v2 派生数据并从 raw messages rebuild，不设计双读、backfill 或兼容 schema。

## 1. 核心判断

Memory 不是一段可反复全文重写的摘要，而是一组可审计、可局部更新、可拒绝、可恢复和可渲染的结构化状态。

原 v2 的问题不是这个前提错误，而是 Proposer 同时承担语义判断和持久化协议生成：LLM 必须理解真实 itemId、Patch op、evidenceKind、quote、Profile 分类和证据门禁。2.01 将两类职责分开：

- LLM 只判断“应形成什么领域变化”；
- ProposerTaskRenderer 只提供可读 Memory、稳定短引用和消息；
- Compiler 用确定性代码解析 ref、展开 raw provenance、校验 source、规范化日期并生成持久化 Patch；
- Reducer 只接受 compiled patch，执行结构、状态、容量、并发和事务约束；
- 主聊天 Renderer 继续实时渲染权威状态。

```text
Memory State + Raw Messages
  → ProposerTaskRenderer
  → Semantic Proposer
  → Deterministic Compiler
  → Validator / Reducer
  → State + Event + Snapshot
```

## 2. 设计目标

1. **语义与存储分离**：LLM 不输出 itemId、op、evidenceKind、quote、contentHash 或数据库字段。
2. **受控写入**：Compiler 不写数据库；Proposer/Semantic 候选只能经 Validator/Reducer 写入。Source-generation reset、privacy purge 与 deterministic system cleanup 是由各自算法约束的受控系统路径。
3. **证据可追溯**：当前 Memory 的每个 item/scene field 可追溯到 raw `messageId + contentHash`。
4. **状态分层**：Scene、Todo、持续约定、近期经历、里程碑、世界事实、两个 Profile 和关系记忆独立维护。
5. **低漂移**：状态只做局部增删改；不把 LLM 的全文摘要作为 authority。
6. **可恢复**：durable task、compiled proposal、event、snapshot、cursor 和 sourceGeneration 支持 crash recovery/rebuild。
7. **可渲染**：主聊天实时读取结构化状态并生成稳定文本。
8. **可观察**：Semantic IR、ref map、Compiler 结果、Reducer decision 和运行失败均可检查。
9. **故障隔离**：错误只 halt 对应 target，保留最后稳定状态，其他 targets 与主聊天继续。
10. **早期规则简单**：不为尚未出现的质量问题预设分类、证据数量门或 suppression 图。

## 3. 明确接受的阶段性风险

- Profile/Relationship 可能出现语义重复但措辞不同的 item；
- 单次 Episode 可能促成长程 Profile/Relationship 归纳；
- old-only raw message 或 support-only Memory 可以触发变化；
- read-only Memory 可以支持 update/correct/forget/cancel 等动作；
- 派生 Memory 可能带来一定语义强化；
- correction/forget 不阻止旧 raw source 在 RAG/Recall 或 rebuild 中再次出现；
- message-level provenance 不证明 change 文本被 source 严格蕴含；
- 当前不引入第二个 Verifier LLM、NLI、高风险事实分类或跨 tick 模式 ledger。

这些风险只有在 fixture、评估或真实运行数据证明需要后，才增加最小规则。

## 4. 权威状态与版本

- PostgreSQL `chat_preset_memory.memory_state` 是唯一当前 Memory authority。
- 协议版本固定为字符串 `"2.01"`；数据库 `schema_version` 使用 `TEXT`。
- `chat_messages` 中有效 User/Assistant 原文是 rebuild authority。
- snapshot 是 crash recovery、retention 和 source mutation 增量 rebuild 的 anchor，不是第二份当前状态。Source mutation 只能复用最早受影响消息之前、且 provenance 经当前 raw source 重新验证的 snapshot。
- Renderer 输出、Semantic IR 和 compiled proposal 都不是当前 Memory authority。
- `sourceGeneration` 是 Memory 与 RAG 共用的 raw-source 世代；普通 append 不增加，编辑/删除/恢复/归属或排序语义变化增加并触发 rebuild。
- 旧 rolling/core memory 与旧 v2 派生数据都不转换为 2.01 state。

正式 section 固定为：

```text
scene
todos
standingAgreements
recentEpisodes
milestones
worldFacts
userProfile
assistantProfile
relationship
```

`current`、`working`、`longTerm`、`meta` 是物理容器，不是 section。`previousScene` 和 Todo overdue 是 Reducer 维护的衍生状态。

## 5. 写入边界

### 5.1 Proposer

继续使用六个 normal Proposer 和一个 compactionProposer：

| targetKey | Proposer | sections |
| --- | --- | --- |
| `scene` | `currentStateProposer` | `scene` |
| `todos` | `todoProposer` | `todos` |
| `standingAgreements` | `agreementProposer` | `standingAgreements` |
| `episodes` | `episodeProposer` | `recentEpisodes`, `milestones` |
| `profileRelationship` | `profileRelationshipProposer` | 两个 Profile、`relationship` |
| `worldFacts` | `worldFactProposer` | `worldFacts` |
| maintenance | `compactionProposer` | 单个 compactable item section |

Proposer 使用 provider 原生 structured output，但只输出小型领域 Semantic IR。`noop` 与 `unable_to_decide` 的差异和联合 target 的原子 cursor 语义继续保留。

### 5.2 Compiler

Compiler 负责 ref 到真实目标、support ref 到 raw source、来源去重/复核、Todo 日期规范化和 action 到 op。无法唯一解析时 fail closed，不做自然语言补全或“最像目标”猜测。

### 5.3 Reducer

Reducer 是纯代码 State Applier，不使用 LLM，不做开放式语义判断、相似度匹配或证据蕴含证明。它负责：

- compiled patch schema；
- section/op/target 作用域；
- source refs 完整性；
- item/path 存在性；
- proposal 内结构冲突；
- exact normalized text duplicate；
- Todo/Scene/Episode 生命周期；
- 容量、compaction、并发前置条件；
- event/snapshot/cursor/task/status 原子提交。

Reducer 不再执行 evidenceKind policy、quote matching、new-batch gate、Profile canonicalKey 或 suppression tombstone。

## 6. Provenance 与 forget/correction

- 当前 state 使用扁平 `sourceRefs: [{messageId, contentHash}]`；不保存 evidenceKind、quote、证据组或 Memory-to-Memory 图。
- support ref 在编译时展开为 raw source refs，最终只持久化 raw provenance。
- item update/correct 保留目标旧 provenance并与本 change sources 合并去重；scene set/correct 使用本 change sources替换 field provenance。
- merge 继承所有 source items 的 provenance。
- `correct` 与 `update` 编译成同一个持久化 op，不保留独立诊断差异。
- 所有 item section 都允许 explicit forget；Scene forget 等价于清空目标 field。
- forget 只改变 active Memory；correction/forget 都不生成 context-suppression tombstone，不过滤 RAG/Recall/raw source/rebuild。
- privacy hard delete 是独立能力，继续物理清理 raw source 及全部派生副本。

## 7. 可靠性机制

以下 v2 机制在 2.01 继续有效：

- per-user/preset 单实例串行 lane；
- per-target cursor 与 lagThreshold；
- immutable task payload；
- Provider retry、schema repair、unable context expansion；
- revision/generation/cursor stale 校验与 successor task；
- durable stage、phase identity、dedupe key 和 commit-outcome recovery；
- 每 revision 完整 snapshot 与 normalized event replay；
- source mutation 从最新安全 snapshot 建立新 generation anchor，只重放受影响后缀；无安全 anchor 时从零重建；
- capacity-blocked、maintenance compaction 和 compiled proposal replay；
- per-target healthy/retry_wait/capacity_blocked/halted/rebuilding；
- GapBridge、RAG projection coverage、diagnostic projection 与恢复通知。

2.01 新增 durable 阶段：base/expanded Renderer artifact、unable/compiler-ready Semantic result 和 compiled proposal 均需在跨越不可重复边界前持久化。Unable result 使用独立阶段且不得进入 Compiler；确定性 compile failure 不推进 cursor；若先发现 state/generation/cursor 已变化，使用既有 stale/successor 语义。

## 8. 上下文边界

- 主聊天 recent window、Memory、GapBridge 和 RAG 继续并列装配；
- RAG 负责具体旧场景、原话和细节，Memory 负责持续状态和长期档案；
- Proposer observed messages 使用 raw User/Assistant content；assistant gist 不进入 Memory Proposer；
- direct source 只能引用本 task 实际渲染的 messageId；
- support source 只能引用实际渲染的 read-only ref，但展开后的 raw message 可以位于 observed window 之外；
- correction/forget 不再改变 RAG/Recall 查询结果；只有 raw source mutation、generation cutoff 和 privacy hard delete影响它们。

## 9. 非目标

- 不做旧 v2 兼容、双读、backfill 或渐进切换；
- 不做完整 late discovery 调度；
- 不做严格历史因果 rebuild；
- 不解决 lagThreshold 以下尾批 durable flush；
- 不引入统一总 context 预算；
- 不引入 Gap Compressor、RAG/GapBridge 去重或容量自动降级；
- 不实现 correction/forget source suppression；
- 不为 Profile/Relationship 恢复 facet/canonicalKey/factBasis；
- 不引入语义去重或第二个 Verifier LLM。

## 10. 顶层决策清单

| 编号 | 决策 | 2.01 结果 |
| --- | --- | --- |
| C1 | 当前 authority | `memory_state` JSONB，version=`"2.01"` |
| C2 | LLM 输出 | Semantic IR，不是持久化 Patch |
| C3 | 写入权 | Compiler 不写库；Proposer/Semantic 候选只能经 Validator/Reducer 写入；generation reset、privacy purge、system cleanup 为受控系统路径 |
| C4 | Provenance | 扁平 raw `messageId + contentHash` |
| C5 | Target/cursor | 六个 normal target；联合 sections 共享 cursor |
| C6 | 来源 | direct message 与 rendered read-only support 均合法；无 new-batch gate |
| C7 | Profile | 只存 text + provenance，无 typed metadata |
| C8 | correction | 编译为 update，不保留独立持久化语义 |
| C9 | forget | 所有 item section 可用；Scene forget=clear；只改变 active state |
| C10 | suppression | 全面延期；无 tombstone/RAG filter/rebuild filter |
| C11 | structured output | 保留 Provider schema、preflight、schema repair |
| C12 | durability | 保留 task/revision/snapshot/event/phase identity |
| C13 | capacity | 保留 section budget、compaction 和 compiled proposal replay |
| C14 | rebuild | 保留 sourceGeneration 与 force-drain；从最新未受影响且 provenance 有效的 snapshot 续建，无安全 anchor 时从零开始；不做 suppression terminal filter |
| C15 | privacy | hard delete 不削弱，并覆盖新增 artifact/IR/compiled payload |

## 11. 成功标准

- LLM 输入不含 storage state JSON、真实 itemId、provenance 或 content hash；
- LLM 输出不含 op、evidenceKind、quote、contentHash 或 typed Profile 字段；
- ref 在 retry/repair/expansion/recovery/replay 中稳定；
- support refs 可确定性展开为历史 raw source；
- old-only/support-only change 可以通过；
- relative Todo 日期具有直接 `anchorMessageId`；
- Compiler 失败可见且不产生猜测性 Patch；
- Reducer 仍保证 state、event、snapshot、cursor、task/status 原子一致；
- correction/forget 不写或消费 context-suppression tombstone；
- crash recovery、capacity replay、source rebuild、privacy hard delete 和主聊天上下文继续通过 Harness。
