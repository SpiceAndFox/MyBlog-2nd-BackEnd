# Memory Proposer 语义化重构计划

## 1. 背景与目标

当前 Memory Proposer 同时承担语义识别和持久化协议生成：LLM 需要理解 `writableState`、真实 itemId、Patch op、`evidenceKind`、quote、Profile 分类字段和证据规则。这使 prompt、Provider Schema、重试修复、Reducer policy 与数据库结构彼此耦合，也让简单的语义判断容易因为存储字段错误而失败。

本轮重构的目标是：

- LLM 只判断“应该形成什么记忆变化”；
- Memory 以人类可读文本和任务内短引用提供给 LLM；
- LLM 输出小型领域级 Semantic IR，不输出持久化 Patch；
- 短引用解析、来源展开、日期规范化和 Patch 组装全部由确定性代码完成；
- Validator / Reducer 继续掌握最终写入权；
- 删除当前阶段没有明确收益的分类和保护规则，优先得到简单、可观察、易迭代的链路。

目标链路：

```text
Memory Renderer
  → Semantic Proposer LLM
  → Domain Semantic IR
  → Deterministic Compiler
  → Validator / Reducer
  → Database
```

当前使用的是可反复重建的开发数据库。本轮不设计旧数据 backfill、双读、兼容 Schema 或渐进迁移；实现完成后直接重建开发数据。

## 2. 设计原则

### 2.1 语义与存储分离

- Proposer 只输出领域动作、目标短引用、结果文本、领域必要属性和来源引用。
- Proposer 不输出真实 itemId、持久化 op、`evidenceKind`、quote、content hash 或数据库字段。
- Compiler 只做确定性转换，不补做开放式语义判断。
- 无法唯一解析目标、来源或领域字段时，Compiler 明确失败，不猜测。

### 2.2 早期阶段保持规则简单

当前不为尚未出现的质量问题提前增加复杂限制。只保留保证引用可解析、来源真实、Patch 可验证和写入可回放所必需的机械约束。

阶段性接受以下风险：

- Profile / Relationship 可能出现措辞不同但语义重复的 item；
- 单次 Episode 也可能促成长期 Profile / Relationship 归纳；
- 旧 readOnly Memory 可以在没有 new-batch 直接证据时触发迟到归纳；
- readOnly Memory 可以支持 correct、forget、cancel 等动作；
- 派生记忆可能产生一定程度的语义强化；
- correction / forget 不再阻止旧 raw source 在后续 rebuild 或检索中重新出现。

这些问题在真实 fixture、评估或运行数据中出现后，再增加最小必要规则。

## 3. Renderer 输入契约

### 3.1 使用可读文本

不再把 `writableState`、`readOnlyContext` 等存储结构直接发送给 LLM。Renderer 按 Proposer 的职责输出：

- 可修改记忆；
- 可作为辅助依据的 readOnly Memory；
- 当前消息窗口；
- 判断所需的最少任务元数据。

示意：

```text
[可修改的最近经历]
E1 | 用户因连续追问感到压力，双方暂停交流后重新和解。

[辅助关系记忆]
R1 | 双方遇到分歧时通常愿意复盘。

[消息]
#1151 user | 我不是讨厌你，我只是需要先安静一会儿。
```

### 3.2 稳定短引用

- writable Memory 和 readOnly Memory 都使用任务内短引用。
- 不向 LLM 暴露真实 itemId。
- 短引用在首次调用、Schema repair、上下文扩展、task retry、进程恢复和 shadow replay 中必须保持不变。
- Renderer 产物必须包含私有引用映射，供 Compiler 使用；恢复时不得按变化后的数组顺序重新编号。
- 修改目标只能引用 writable ref；`supportRefs` 只能引用本次实际渲染的 readOnly ref。

短引用只提供与当前存储模型相同的 item 级或 scene field 级定位精度，不提供 item 内子句级寻址。

### 3.3 消息标识

- 原始消息继续显示稳定 `messageId`。
- Proposer 只选择消息 ID，不生成 quote。
- 系统根据 messageId 读取并校验真实消息、role、content hash 和必要的时间信息。

## 4. Semantic IR

每个 Proposer 使用独立的小型 Schema，但普通 change 共享以下概念：

```json
{
  "action": "update",
  "section": "recentEpisodes",
  "ref": "E1",
  "text": "用户需要暂停并不代表拒绝关系；双方在短暂冷静后恢复了沟通。",
  "evidenceMessageIds": [1151],
  "supportRefs": ["R1"]
}
```

字段原则：

- `action`：领域动作；
- `section`：联合 Proposer 必须明确目标 section，单 section Proposer 可由 Schema 固定；
- `ref`：修改现有 Memory 时必填，新增时省略；
- `text`：新增或改写内容时提供；
- `evidenceMessageIds`：可选的直接原始消息来源；
- `supportRefs`：可选的 readOnly Memory 来源；
- 其他字段只保留 Todo 日期、actor/requester 等无法从动作和目标推导的领域信息。

每个 change 至少提供 `evidenceMessageIds` 或 `supportRefs` 中的一种。除此之外不增加来源策略限制。

通用语义动作：

```text
add
update
correct
forget
```

领域动作继续按需保留，例如：

```text
complete
cancel
expire
set
clear
merge
```

不新增 `evidenceEffect`。`correct` 直接作为 Semantic action；它与 `update` 可以保留不同的诊断语义，但当前编译到相同的持久化更新操作。

多 section Proposer 仍需保留当前 `noop` 与 `unable_to_decide` 的终局差异以及共享 cursor 的原子推进语义。具体外层 IR 可以按 Proposer 定义，但不能把无法判断静默写成 noop。

## 5. 来源与 readOnly Memory

### 5.1 两种来源

Semantic IR 支持：

- `evidenceMessageIds`：直接引用原始消息；
- `supportRefs`：引用本 task Renderer 已展示的 readOnly Memory。

两者可以单独使用，也可以混合使用。

### 5.2 不要求 new-batch 来源

- 不要求任一直接消息属于当前 new batch；
- 不要求被引用 Memory 的底层来源属于当前 new batch；
- 删除现有 `overlap_only_evidence` 拒绝规则；
- correction、forget、cancel 与普通 add/update 使用相同的来源规则；
- 不要求 observed pattern 来自固定数量的消息、Episode 或互动片段。

普通 task 仍由消息推进机制触发，但某个 change 可以完全依据此前已存在的 readOnly Memory。

### 5.3 不增加第二套白名单

现有每个 Proposer 的 readOnly 可见范围已经限制了它能看到哪些 section。本轮不再维护 `section A → section B` 的额外 evidence policy matrix。

任意本次实际渲染的 readOnly ref 都可以作为 `supportRefs`。

### 5.4 Compiler 展开来源

Compiler 将 `supportRefs` 确定性展开为对应 Memory item 的原始 provenance：

```text
supportRef
  → task-local ref map
  → authoritative Memory item / field
  → persisted source refs
  → messageId + contentHash
```

随后：

- 与直接 `evidenceMessageIds` 合并；
- 按 `messageId + contentHash` 去重；
- 从数据库校验消息存在性与 content hash；
- 将解析后的原始来源交给 Validator / Reducer；
- 最终不持久化 Memory-to-Memory 引用图。

来源消息可能位于普通 observed window 之外，因此 task payload、Compiler source bundle 和 Validator 接口必须允许携带并校验由 `supportRefs` 展开的历史 source。

## 6. Profile / Relationship 简化

当前 `userProfile`、`assistantProfile`、`relationship` 的 `facet`、`canonicalKey`、`factBasis` 全部删除。

新 item 的语义数据只需要：

```text
text + provenance
```

新 Semantic IR 不再输出：

```text
facet
canonicalKey
factBasis
```

同时删除或改造以下行为：

- Profile facet / canonicalKey 枚举校验；
- 非 multi-value canonicalKey 唯一约束；
- `duplicate_profile_key` 拒绝；
- compaction 对 facet / canonicalKey 相等的依赖；
- `observedPattern` 的固定消息数量和互动片段要求；
- 因缺少上述元数据而产生的 Provider Schema 失败。

仍保留 Profile / Relationship 的基本准入语义：内容应当跨场景仍有价值，并可能影响未来回应；但该判断只由 Proposer prompt 表达，不再包装成额外的持久化分类协议。

## 7. Episode 设计

### 7.1 保持互动弧粒度

`recentEpisodes` 继续以一个连贯互动弧为一个 item，不拆成消息级动作或子事实数组。Milestone 继续作为独立长期转折 section。

### 7.2 删除固定文本模板

删除：

```text
主题: 关键起因/互动 > 结果或重要未决问题 | 后续意义
```

改为语义要求：

- 使用一到两句自然语言概括一个连贯互动弧；
- 保留理解后续对话所需的关键起因、稳定结果或重要未决问题；
- 只有证据明确时才写后续意义；
- 不写逐消息时间线、动作流水账或为满足模板而补造字段；
- 同一互动弧出现新发展时 update 原 item。

### 7.3 容量与渲染暂不改结构

- 保持扁平 Episode item；
- 暂不增加 episode group、claims 或子事件表；
- 当前主 Renderer 渲染有效状态中的全部 recentEpisodes；
- 当前 `maxItems`、`maxRenderedChars` 与淘汰策略先保持不变，真实使用中出现问题后再调参。

### 7.4 Episode correction

- Semantic IR 可以使用 `correct`；
- Compiler 将 Episode 的 `correct` 编译为现有 `updateItem`；
- 不增加 `correctItem`；
- Reducer 更新当前可见文本并保留来源；
- 不为旧来源创建 correction tombstone。

## 8. Persistent Patch 与 evidence 简化

### 8.1 action 到现有 op 的映射

本轮不增加 `correctItem` 或 `correctField`：

```text
item add                → addItem
item update / correct   → updateItem
scene set / correct     → setField
scene clear             → clearField
forget                  → forgetItem
todo complete           → completeTodo
todo cancel             → cancelTodo
todo expire             → expireTodo
agreement cancel        → cancelAgreement
compaction merge        → mergeItems
```

### 8.2 删除 evidenceKind 协议负担

Proposer 不再输出 `evidenceKind`，Compiler 也不再根据 role 生成 `user_correction` / `assistant_correction` 等分类。

在后续实现中，应以 `section + op + 领域字段` 表达行为，并同步简化：

- Provider output schema；
- Patch contract；
- policy gate；
- evidence group；
- semantic event / replay；
- 数据库中的 `evidence_kind` 依赖；
- prompt 与测试中的 evidenceKind 矩阵。

Todo 的 actor/requester、具体生命周期 op 和目标 section 已能表达当前需要的领域差异，不再为同一含义额外保存原因枚举。

### 8.3 不再由 LLM 生成 quote

- Proposer 只选择 messageId 或 Memory support ref；
- Compiler / Validator 从真实消息获得 source metadata；
- 持久化 provenance 至少保留 messageId 与 contentHash；
- quote 是否继续作为系统生成的可选诊断数据，由实现阶段按实际消费者决定，不再属于 LLM 输出契约。

## 9. 全面推迟 Context-suppression Tombstone

本轮停止所有 correction / forget 引发的 context-suppression tombstone 行为，不区分 section：

- `updateItem` / `setField` 不 suppress 被替换值的旧 source；
- `forgetItem` 只移除当前 active Memory item，不 suppress 其历史 raw source；
- Episode、Profile、Relationship、WorldFact、Milestone、Scene 等使用相同原则；
- 不维护 correction 的 user / assistant tombstone 差异；
- 不要求 RAG、Recall、rebuild 或 projection worker 消费 correction / forget tombstone。

明确接受的结果：

- rebuild 可能根据仍存在的 raw source 重新生成曾被 correct 或 forget 的内容；
- RAG / Recall 仍可能召回对应 raw source；
- 当前 Memory state 的可见更新或删除不等同于对历史 source 的永久抑制。

Privacy hard delete 是独立能力：用户明确删除 raw source 或整个数据范围时，仍必须执行真实的物理删除和相应派生数据清理，不能因为推迟 context-suppression tombstone 而削弱隐私删除。

后续应在 `devplans/deferred/memory-control-v2` 中新增或重构现有 suppression 计划，使其覆盖完整的 correction / forget tombstone、RAG / Recall filtering、rebuild 终态过滤和可选片段级 Suppression Proposer。本轮只在本文件记录该延期，不修改其他文档。

## 10. Deterministic Compiler 职责

Compiler 负责：

- 将 writable short ref 映射为真实 itemId 或 scene path；
- 将 Semantic action 映射为现有持久化 op；
- 将 readOnly `supportRefs` 展开为原始 source refs；
- 合并、去重并校验直接与间接来源；
- 根据数据库消息补全 role、createdAt、contentHash 等真实 metadata；
- 规范化 Todo 相对日期和其他确定性领域字段；
- 生成 Validator / Reducer 所需的完整 Patch；
- 输出可诊断的编译错误，不产生猜测性 Patch。

Compiler 不负责：

- 判断一段对话是否值得记忆；
- 判断两个自然语言 item 是否语义重复；
- 决定某条信息属于哪个 Profile 类别；
- 推断一次 update 是否实际是 correction；
- 为缺失目标自动选择“最像”的 item；
- 生成新的事实或补全未表达的语义。

## 11. 写入、失败与诊断边界

- LLM 不直接访问或修改数据库；
- Compiler 不直接写数据库；
- Validator / Reducer 仍是唯一合法写入入口；
- Schema、引用、来源展开或 Compiler 转换失败必须形成可见失败，不能伪装成成功 Patch；
- Semantic IR、Renderer ref map、Compiler 结果与 Reducer decision 应具备可检查性；完整诊断界面的扩建可以后续实施。

## 12. 实施顺序

### 阶段 A：公共契约

1. 定义 Renderer artifact、稳定 ref map、Semantic IR 公共字段和 Compiler 接口。
2. 定义 `evidenceMessageIds + supportRefs` 的来源展开协议。
3. 简化持久化 Patch、provenance 和 evidenceKind 依赖。
4. 停用 correction / forget context-suppression tombstone 写入和读取路径。

### 阶段 B：Episode 垂直切片

1. 为 `episodeProposer` 建立可读 Renderer。
2. 建立 Episode / Milestone Semantic IR。
3. 删除固定 Episode 文本模板。
4. 实现 add/update/correct 到 addItem/updateItem 的 Compiler。
5. 验证共享 cursor、retry、恢复、容量淘汰和无 tombstone 行为。

### 阶段 C：Profile / Relationship

1. 迁移 `profileRelationshipProposer`。
2. 删除 facet、canonicalKey、factBasis 及相关校验。
3. 支持从 rendered readOnly Memory 通过 `supportRefs` 形成长期记忆。
4. 删除 observedPattern 固定证据数量要求。

### 阶段 D：其余普通 Proposer

依次迁移：

1. `worldFactProposer`；
2. `agreementProposer`；
3. `todoProposer`；
4. `currentStateProposer`。

每个 Proposer 都建立自己的最小领域 IR，避免重新形成一个全局大型 Semantic Schema。

### 阶段 E：Compaction 与清理

1. 最后迁移 `compactionProposer`；
2. 删除所有 Proposer 对旧持久化 Patch Schema 的直接依赖；
3. 删除失去消费者的 evidenceKind、typed Profile 和 tombstone 代码；
4. 重建开发数据库和 Memory 数据；
5. 同步重构正式设计文档、prompt、harness、测试和 CLI 诊断输出；
6. 在 deferred 目录建立完整 tombstone / suppression 后续计划。

## 13. 验收标准

### Renderer

- LLM 输入不再包含 `writableState`、真实 itemId 或 evidenceGroups 存储结构；
- writable/readOnly refs 清晰区分且任务内稳定；
- retry、repair、恢复和 replay 使用同一 ref map；
- 消息保留 messageId。

### Semantic IR

- 不包含持久化 op、evidenceKind、quote、contentHash；
- Profile / Relationship 不包含 facet、canonicalKey、factBasis；
- 每个 change 至少存在直接或间接来源；
- old-only supportRefs、support-only correction/forget/cancel 均可通过 Semantic Schema。

### Compiler

- ref 到 itemId/path 的映射完全确定；
- `correct` 只编译为 updateItem/setField，不生成新 op；
- supportRefs 能展开并去重为真实 raw source；
- 历史 source 不因位于 cursorBefore 之前而被 `overlap_only_evidence` 拒绝；
- 无法解析时返回明确错误，不输出猜测结果。

### Reducer / Persistence

- 不再依赖 user/assistant correction evidenceKind；
- 任意 section 的 correction / forget 都不写 context-suppression tombstone；
- update/set 保留当前 itemId 或 scene path；
- forget 只改变 active Memory；
- Validator / Reducer 之外没有数据库写入路径；
- event replay 与开发数据库重建适配新的简化契约。

### Episode

- 保持互动弧粒度；
- 不要求固定 `主题 > 结果 | 意义` 格式；
- 日常动作流水账仍应 noop；
- 同一互动弧的新发展优先 update 原 ref；
- correction 更新文本但不 suppress 旧 source。

### Profile / Relationship

- 新 item 只需要 text 与 provenance；
- 不再因 facet/canonicalKey/factBasis 缺失而失败；
- 不再执行 canonicalKey 唯一检查或 observedPattern 数量门；
- 能完全依据一个或多个 readOnly supportRefs 形成、更新、纠正或遗忘 Memory。

## 14. 本轮不顺带解决的问题

除本计划明确要求删除或调整的机制外，下列流程问题继续保持独立，不在本次职责分离中扩张实现范围：

- late discovery 的完整调度与重放策略；
- rebuild 的严格历史因果顺序；
- lagThreshold 以下尾批的 durable flush；
- target 健康状态的全面收紧；
- 总 context 预算与跨来源裁剪；
- 完整诊断界面；
- 生产级 retention 与历史规模优化；
- 新的 tombstone、suppression、RAG/Recall source 过滤与防复活机制。

上述能力只有在实际需求和失败案例明确后，才从 deferred 计划重新进入主设计。
