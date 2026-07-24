# Memory Control 2.01 Semantic Write Contract

本文是 Memory Control 2.01 的 Proposer 输入、Semantic IR、确定性 Compiler、持久化 Patch 与来源校验的单一权威来源。状态持久化见 [state-contract.md](state-contract.md)，运行编排见 [write-protocol.md](write-protocol.md)，失败恢复见 [Task 执行、Cursor 与幂等算法](algorithms/task-execution-and-idempotency.md)。

## 1. 版本与边界

- 协议版本固定为字符串 `"2.01"`。`memory_state.version`、task/snapshot/event group 的 `schema_version` 均使用该字符串；数据库列使用 `TEXT`，不把版本号存成浮点数。
- 2.01 不读取、迁移或 replay 旧 2.0 state、task、proposal、event 或 snapshot。当前开发数据库可重建，切换时清空旧 v2 派生数据后从 raw messages rebuild。
- LLM 只产生 Semantic IR。真实 itemId、持久化 op、content hash、数据库字段和写入事务只存在于确定性代码边界内。
- Compiler 不写数据库；Validator/Reducer 是唯一合法的语义状态写入入口。

## 2. 权威链路

```text
Observer
  → ProposerTaskRenderer
  → Semantic Proposer LLM
  → Semantic IR Validator
  → Deterministic Compiler
  → Compiled Patch Validator / Reducer
  → memory_state + events + snapshot
```

主聊天使用的 Memory Renderer 与 `ProposerTaskRenderer` 是两个不同组件：前者把权威状态注入主聊天，后者只为一次 Memory task 生成可读输入、稳定短引用与私有 ref map。

## 3. Renderer Artifact

### 3.1 持久化形态

Normal task 创建时必须一次性生成并持久化以下 artifact：

```js
{
  publicInput: {
    task: {
      taskId,
      tickId,
      proposer,
      targetKey,
      targetSections,
      cursorBefore,
      targetMessageId,
      now,
      userTimeZone
    },
    memoryText: "...",
    messages: [
      { id: 1151, role: "user", createdAt: "...", content: "..." }
    ]
  },
  refMap: {
    writable: {
      E1: { section: "recentEpisodes", itemId: "episode:..." }
    },
    readOnly: {
      R1: {
        section: "relationship",
        itemId: "relationship:...",
        sourceRefs: [{ messageId: 901, contentHash: "sha256:..." }]
      }
    }
  },
  messageMeta: {
    "1151": {
      role: "user",
      createdAt: "...",
      contentHash: "sha256:..."
    }
  }
}
```

Provider user payload 从 effective `publicInput` 显式投影：保留 `tickId/proposer/targetKey/targetSections/cursorBefore/targetMessageId/userTimeZone`、`memoryText` 和完整 public messages，不发送 `taskId` 与 `task.now`。完整 `publicInput` 仍作为 durable artifact 保存。`refMap`、`messageMeta`、真实 itemId 和 provenance 只保存在受控 durable payload 中，供 Compiler 与 Validator 使用。首次调用使用 `task_payload` 中的 base artifact；若发生 context expansion，则使用 §3.3 定义的 durable expanded artifact。最终 Semantic result 必须同时固化其 `semanticInputVariant=base|expanded`，Compiler 只能读取对应 variant 的 public input 与 message metadata。

### 3.2 可读渲染

Renderer 按 Proposer 的固定可见范围输出：

- 可修改 Memory：带 writable ref；
- 辅助 Memory：带 read-only ref；
- 当前 observed messages：保留稳定 messageId；
- 最少任务元数据。

示例：

```text
[可修改最近经历（仅作 ref 目标，不得放入 supportRefs）]
E1 | 用户因连续追问感到压力，双方暂停交流后重新和解。

[辅助关系记忆（仅作 supportRefs 来源，不得作为 ref 目标）]
R1 | 双方遇到分歧时通常愿意复盘。

[消息]
#1151 user | 我不是讨厌你，我只是需要先安静一会儿。
```

不向 LLM 发送 `writableState`、`readOnlyContext`、真实 itemId、evidence/provenance 存储结构或未分区的 `memory_state` JSON。

### 3.3 稳定短引用

- writable 和 read-only ref 使用不同命名空间；建议按 section 使用稳定前缀，如 `E1`、`M1`、`T1`、`A1`、`W1`、`UP1`、`AP1`、`R1`、`S-location`。
- ref 在同一 task 的首次调用、schema repair、context expansion、Provider retry、进程恢复、capacity replay 和 shadow replay 中保持不变。
- ref 由首次 artifact 固化，后续不得按数组新顺序重新编号。
- update/correct/forget/terminal action 的目标只能引用 writable ref。
- `supportRefs` 只能引用本次实际渲染的 read-only ref。
- item 使用 item 级 ref；scene 使用 field 级 ref，不提供 item 内子句级定位。
- successor task 读取新 revision 并生成新 artifact；新 task 不承诺沿用 predecessor 的 ref 编号。

Context expansion 只扩展早期 observed messages；Memory 文本和 ref map 沿用首次 artifact。扩窗前必须生成并持久化：

```js
expandedArtifact: {
  publicInput: { /* Memory 文本不变，messages 增加更早 raw messages */ },
  messageMeta: { /* 覆盖 expanded publicInput 中全部 messages */ }
}
```

`expandedArtifact.messageMeta` 是 base metadata 与新增早期消息 metadata 的完整合并结果，必须和 expanded public input 在同一短事务中固化；不得只保存消息文本。新增消息继续使用真实 messageId，Memory ref map 仍只读取 immutable base artifact，不重新编号。一次 task 最多生成一个 expanded artifact，retry/restart 复用同一份，不从变化后的数据库窗口重新构造。

### 3.4 可见范围

各 Proposer 沿用既有 section 可见范围，但范围只决定 Renderer 可展示什么，不再形成第二套 evidence policy matrix：

| Proposer | Writable | Read-only |
| --- | --- | --- |
| `currentStateProposer` | `scene` | `recentEpisodes` |
| `todoProposer` | `todos` | `scene`、`standingAgreements`、`recentEpisodes`、两个 Profile |
| `agreementProposer` | `standingAgreements` | `scene`、active todos、`recentEpisodes`、`relationship`、两个 Profile |
| `episodeProposer` | `recentEpisodes`、`milestones` | `scene`、active todos、`standingAgreements`、`relationship`、两个 Profile |
| `profileRelationshipProposer` | 两个 Profile、`relationship` | `scene`、`recentEpisodes`、`standingAgreements`、`milestones`、`worldFacts` |
| `worldFactProposer` | `worldFacts` | `scene`、`recentEpisodes`、`standingAgreements`、`milestones`、两个 Profile、`relationship` |
| `compactionProposer` | 单个 compactable section | 无 |

`profileRelationshipProposer` 的表项描述持久化 task 的联合可见范围。实际 Provider 阶段由 `userProfileProposer`、`assistantProfileProposer`、`relationshipProposer` 三个内部专家分别输出单 section Semantic 结果；它们不是新增 target，不拥有独立 cursor，也不产生独立提交。合并后的 `proposer` 仍为 `profileRelationshipProposer`。

一旦 section 进入本 task 的可见范围，Renderer 渲染其当前完整有效子集；Todo overdue 的可见窗口仍使用集中配置。

## 4. Semantic IR

### 4.1 外层结果

Normal Proposer 保留 per-section 终局：

```json
{
  "tickId": 12345,
  "proposer": "episodeProposer",
  "sectionResults": {
    "recentEpisodes": {
      "status": "changes",
      "changes": [
        {
          "action": "update",
          "ref": "E1",
          "text": "用户需要暂停并不代表拒绝关系；双方冷静后恢复了沟通。",
          "evidenceMessageIds": [1151]
        }
      ]
    },
    "milestones": {
      "status": "noop"
    }
  }
}
```

- normal status：`changes | noop | unable_to_decide`；
- compaction status：`changes | unable_to_compact`；
- `sectionResults` 必须恰好覆盖 task 的 target sections；
- `changes` 必须是非空数组；
- section 由 `sectionResults` key 确定，change 内不重复保存 section；
- `unable_to_decide` 不能伪装成 `noop`；
- 联合 Proposer 任一 section 为 `unable_to_decide` 时，整个 Semantic result 都不是 compiler-ready；同一结果中其他 section 的 `changes/noop` 不得部分 compile 或 apply。首次 unable 对整个 task 扩窗重提，二次 unable 原子丢弃该次全部候选并提交 cursor-only revision。

### 4.2 普通 change 公共字段

```json
{
  "action": "update",
  "ref": "E1",
  "text": "用户需要暂停并不代表拒绝关系；双方冷静后恢复了沟通。",
  "evidenceMessageIds": [1151],
  "supportRefs": ["R1"]
}
```

规则：

- `action` 是领域动作，不是持久化 op；
- 修改或终结现有对象时 `ref` 必填；新增时禁止提供 `ref`；
- 新增或改写内容时 `text` 必填；terminal action 通常不含 `text`；
- `evidenceMessageIds` 只能引用生成本次 Semantic result 的 effective `publicInput.messages` 中实际出现的 messageId；
- `supportRefs` 只能引用 `refMap.readOnly`；
- 每个 normal change 至少提供非空 `evidenceMessageIds` 或非空 `supportRefs`；两者可以混用；
- 不要求任一来源属于 new batch，也不要求某个 support ref 的底层来源属于 new batch；
- Proposer 不输出 quote、contentHash、真实 itemId、持久化 op 或 evidenceKind。

### 4.3 Action 权限

所有 item section 都允许通用 `add | update | correct | forget`：

| Section | 通用 action | 领域 action |
| --- | --- | --- |
| `scene` | `set | correct | clear | forget` | 无；`forget` 与 `clear` 都令当前字段为空 |
| `todos` | `add | update | correct | forget` | `complete | cancel | expire` |
| `standingAgreements` | `add | update | correct | forget` | `cancel` |
| `recentEpisodes` | `add | update | correct | forget` | 无 |
| `milestones` | `add | update | correct | forget` | 无 |
| `worldFacts` | `add | update | correct | forget` | 无 |
| `userProfile` | `add | update | correct | forget` | 无 |
| `assistantProfile` | `add | update | correct | forget` | 无 |
| `relationship` | `add | update | correct | forget` | 无 |

`correct` 在持久化前与 `update` 合并，不保留独立 event/diagnostic 语义。`clear` 与 scene `forget` 同样编译为 `clearField`。领域 terminal action 与通用 forget 不得通过改写 text 伪装。

### 4.4 领域字段

- Todo add：`text`、`actor`、`requester`，可选 `dueAt`；
- Todo update/correct：允许 `text`、`actor`、`requester` 和必填 `dueChange`；
- Todo `dueAt`/`dueChange.set` 使用 `absolute | relative | dayOfMonth` 判别 union；
- standing agreement、episode、milestone、world fact、Profile、relationship 的 add/update/correct 只需要 `text`；
- Profile/Relationship 不包含 `facet`、`canonicalKey` 或 `factBasis`；
- scene set/correct 提供目标 field ref 和 `text`；clear/forget 只提供目标 field ref；
- compaction change 为 `{ action:"merge", refs:[...], text }`，不提供 evidence/support；来源由 Reducer 从 source items 继承。

### 4.5 Todo 消息锚定日期

`relative` 与 `dayOfMonth` Todo 日期必须额外提供 `anchorMessageId`：

- 必须属于同 change 的 `evidenceMessageIds`；
- Compiler 使用该消息的数据库 `createdAt` 和 task 固化的用户时区做日历运算；`dayOfMonth` 选择 anchor 本地日期当天或之后最近一次有效的目标日号；
- 禁止用 task/worker 当前时间；
- support-only change 不得产生消息锚定日期，只能使用已经规范化的 absolute date，或不改变期限；
- absolute date 不需要 anchor。

## 5. Deterministic Compiler

### 5.1 职责

Compiler 必须：

1. 校验 Semantic IR 与本 Proposer 的领域 schema，并根据持久化的 `semanticInputVariant` 选择 base 或 expanded artifact；
2. 用 writable ref 映射真实 itemId 或 scene path；
3. 用 read-only ref 展开对应权威 Memory 对象的 `sourceRefs`；
4. 合并直接消息来源与 support 来源，按 `messageId + contentHash` 去重；
5. 从数据库重新校验消息存在、scope、有效 User/Assistant role 与 contentHash；direct source 还必须将 role/createdAt 与 effective artifact `messageMeta` 对照，support source 的 createdAt 以当前权威数据库行为准；
6. 规范化 Todo 日期和其他确定性字段；
7. 将 Semantic action 映射为持久化 op；
8. 生成完整 compiled proposal；
9. 返回结构化 compile error，不猜测目标、来源或缺失语义。

Compiler 不得判断内容是否值得记忆、两个文本是否语义重复、事实属于哪个 Profile 类别，或缺失 ref 最像哪个 item。

### 5.2 Action 到 op

```text
scene set/correct      → setField
scene clear/forget     → clearField
item add               → addItem
item update/correct    → updateItem
item forget            → forgetItem
todo complete          → completeTodo
todo cancel            → cancelTodo
todo expire            → expireTodo
agreement cancel       → cancelAgreement
compaction merge       → mergeItems
```

所有 item section 均允许 `forgetItem`。Persistent Patch 不增加 `correctItem`、`correctField` 或通用 `removeItem`。

### 5.3 Source 展开

```text
evidenceMessageId
  → semanticInputVariant 对应的 effective artifact messageMeta
  → authoritative chat_messages row

supportRef
  → task-local read-only ref map
  → authoritative item/field at task base revision
  → persisted sourceRefs
  → authoritative chat_messages rows
```

支持来源可位于 observed window 之外。Compiler 的 source bundle 与 Validator 查询接口必须接受这些历史 messageIds，不能把 `observedMessageIds` 当成数据库查询白名单。

若 ref 不存在、命名空间错误、item/field 与 task base revision 不一致、sourceRefs 缺失、消息不存在、scope/hash 不一致或 relative anchor 非法，Compiler 返回失败，不生成猜测性 Patch。

### 5.4 Compiled Patch

普通 compiled patch 形态：

```js
{
  op: "updateItem",
  itemId: "episode:uuid",
  value: { text: "..." },
  sourceRefs: [
    { messageId: 901, contentHash: "sha256:..." },
    { messageId: 1151, contentHash: "sha256:..." }
  ]
}
```

- scene patch 使用 `path`；
- add/update 使用领域 value；
- terminal/forget patch 不含 value，但必须含 `sourceRefs`；
- `mergeItems` 使用真实 `itemIds + value`，不接受 Proposer source refs，Reducer 从 source items 继承；
- Persistent Patch 不包含 evidenceKind、quote、Semantic `correct` 标记或 Memory-to-Memory 引用。

## 6. Compile 失败与持久化

### 6.1 失败分类

- `semantic_schema_invalid`：Semantic IR 不符合领域 schema；属于 Provider 输出边界错误，可使用 schema repair（次数由 `CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX` 配置）。
- `ref_resolution_failed`：目标或 support ref 无法解析；确定性失败，不盲重试。
- `source_validation_failed`：source 不存在、scope/hash/metadata 不一致；确定性失败。
- `date_anchor_invalid`：relative/dayOfMonth date 缺少合法直接 anchor，或日期无法确定性解析；确定性失败。
- `compile_invariant_failed`：Compiler 内部不变量错误。

确定性 compile 失败不推进 cursor、不产生 revision/snapshot/event；task failed、对应 target halted并写 ops log。若失败前发现 generation/revision/cursor 已变化，则优先走既有 stale/successor 规则，不记录为 compile failure。

### 6.2 Durable stage

Normal task 只有不含 unable 的 Semantic result 才能进入 Compiler：

```text
pending
→ proposing
├→ compiler-ready semantic result
│   → semantic_result_persisted
│   → compiling
│   → compiled_proposal_persisted
│   → reducing
│   → status=succeeded,stage=committed | status=running,stage=capacity_blocked | status=failed
└→ contains unable_to_decide
    → unable_result_persisted
    ├→ first unable
    │   → context_expanding
    │   → context_expanded
    │   → proposing（使用 expandedArtifact）
    └→ second unable
        → status=succeeded,stage=unable_cursor_committed
```

- `task_payload` 固化 Renderer artifact；
- `stage_payload.semanticResult` 只保存通过 schema 且不含 unable 的 compiler-ready Semantic IR，并同时保存 `semanticInputVariant`；
- `stage_payload.unableResult` 保存最近一次通过 schema但含 `unable_to_decide` 或 `unable_to_compact` 的结果；它绝不能被 Compiler 消费；
- `stage_payload.expandedArtifact` 保存 expanded public input及其完整 messageMeta；
- `stage_payload.compiledProposal` 保存 Compiler 结果；
- Provider retry/recovery 按 input variant复用同一 base/expanded artifact；
- Compiler 或 commit crash 后恢复时复用已持久化阶段产物，不重复调用 LLM；
- 恢复看到 `unable_result_persisted` 时不得转入 Compiler：normal task 只继续 expansion或 cursor-only分支，maintenance task只进入 lengthBudget/hygiene终局；
- successor task 不复用 predecessor 的 Semantic IR 或 compiled proposal。

Capacity-blocked replay 使用已持久化 compiled proposal，不重新调用 Proposer 或 Compiler；replay 前仍重新校验 generation、cursor、引用 item 和 source hashes。

## 7. 不变量

- LLM 永远看不到真实 itemId、contentHash 或持久化 op。
- LLM 不能直接写数据库。
- Compiler 不做开放式语义判断，也不写数据库。
- Proposer/Semantic 候选引发的 state 变化不得绕过 Validator/Reducer；source-generation reset、privacy purge 与 deterministic system cleanup 是由各自算法约束的受控系统写入，不属于 Proposer 写入路径。
- 当前 state 只保存 raw source provenance，不保存 Memory-to-Memory 图。
- old-only direct evidence、support-only、direct+support 混合来源都合法。
- correction/forget 不产生 context-suppression tombstone，不影响 raw source、RAG/Recall 或后续 rebuild。
- Privacy hard delete 继续物理删除 raw source 及所有派生副本。
