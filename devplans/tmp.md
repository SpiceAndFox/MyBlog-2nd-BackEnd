# Memory Control 重构最终共识清单

本文汇总截至 2026-07-11 已达成的设计共识，作为后续正式修订 Memory Control 文档和实现的基线。讨论中已被推翻的早期方案不再具有约束力。

## 1. 设计方法与总体原则

1. 本次重构采用偏瀑布式设计：设计阶段一次性覆盖 deferred、compaction、snapshot、replay、overdue、expired scene、gapBridge、用户告警、forget/RAG suppression 等完整能力，不以“首版先删除、以后再补”为默认策略。
2. 实现仍按依赖顺序分层推进和验收，但这是工程实施顺序，不代表把已确定功能延期到不明确的未来。
3. 设计在完整性和可落地性之间取平衡：只为明确的故障路径引入机制；能用简单确定性规则解决的问题，不堆叠多套预算、风险分类或 LLM 判断。
4. LLM 负责语义判断和提出候选变更；Reducer 负责纯代码可验证的结构、作用域、权限、证据、容量、并发和事务约束。
5. 接受 LLM 语义判断存在一定偏差。Reducer 不宣称能够证明自然语言 text 一定被 evidence 语义蕴含，也不要求 LLM 判断“高风险事实”。
6. 可恢复性的目标包括：避免静默丢失/重复应用、支持崩溃恢复、追踪错误记忆来源、保证 forget 后不会被自动重建，以及区分模型错误、Reducer 错误和事务错误。

### 1.1 原设计继承原则

1. 本文是对原 Memory Control v2 设计的变更共识，不是通过省略内容重新定义全部契约。
2. 未在本文中明确修改、替换或延后的原设计契约继续有效；本文省略不代表删除。
3. item/evidenceGroups/evidenceKind/op/policy table、Proposer envelope/readOnlyContext、Prompt、Renderer、Scene Snapshot/Recall 等未在本文完整重述的契约，默认继承原正式文档。
4. 未经明确确认的实现细节不得因为出现在讨论稿中就被视为已定规范；这类内容统一列入 §25。

## 2. 权威状态与作用域

1. PostgreSQL 中的结构化 `memory_state` 是新系统唯一的当前 Memory authority。
2. 旧 rolling summary/core memory 不转换为新系统 authority，也不与新 Memory 同时注入。
3. 最终迁移时停止旧 worker/注入并物理删除旧 Memory 数据；新系统从 raw messages 重建。
4. 如果运维层保留数据库级离线备份，备份不得进入应用上下文或提供给 Agent；是否强制生成该备份尚未确认。
5. user/preset 下的对话跨 session 语义连续。session 只是按天或 UI 划分的存储单元，不是 Memory 或 scene 的语义边界。
6. sessionId 仍保存在消息、evidence、event 和 Recall provenance 中，但不用于 key 当前 scene，也不自动触发 scene reset。

## 3. State 结构

目标 state 至少包含以下语义 section：

```js
{
  version: 2,
  current: {
    scene: {/* 固定字段 */}
  },
  working: {
    todos: [],
    overdue: [],
    standingAgreements: [],
    recentEpisodes: [],
    expiredScenes: []
  },
  longTerm: {
    milestones: [],
    worldFacts: [],
    userProfile: [],
    assistantProfile: [],
    relationship: []
  },
  meta: {
    revision,
    sourceGeneration,
    targetCursors: {}
  }
}
```

具体命名可在 canonical schema 中调整，但以下语义不可改变：

- current.scene 与 session 完全解耦。
- working.expiredScenes 是与 current.scene 分开的正式 section。
- overdue 与 todos 同级并拥有独立容量。
- recentEpisodes 与 milestones 联合处理但分别存储。
- userProfile 与 assistantProfile 都允许 User 和 Assistant 双方全权 add/update/forget。
- worldFacts 与 relationship 同样允许双方 add/update/forget。
- evidence role 仍按数据库真实消息校验，但不再用 role 限制 User/Assistant 对两个 Profile 的操作权。
- `memory_state.meta` 不再保存旧 `recovery: {}`；Recovery 能力没有删除，而是迁移到 durable task、per-target status 和 ops log，详见 §16。

## 4. Target、Proposer 与 Cursor

一个 Proposer 联合处理的多个 section 必须共享一个 target cursor，禁止“共享 Proposer + 独立 section cursor”。

| targetKey    | Proposer             | 可写 section                                            | cursor       |
| ------------ | -------------------- | ------------------------------------------------------- | ------------ |
| `scene`      | currentStateProposer | current.scene                                           | `scene`      |
| `todos`      | todoProposer         | working.todos；overdue 为 Reducer 维护的同族状态    | `todos`      |
| `agreements` | agreementProposer    | working.standingAgreements                              | `agreements` |
| `episodes`   | episodeProposer      | working.recentEpisodes、longTerm.milestones            | `episodes`   |
| core sections | coreProposer        | longTerm 下除 milestones 外的原 core sections    | 见下文       |

约束：

1. 一个 normal task 只有一个 cursorBefore、newBatch、targetMessageId 和 proposal。
2. episodeProposer 联合判断普通 episode 和 milestone，可以一次输出两类 patch。
3. todoProposer 和 agreementProposer 保持独立，不共享 Proposer 或 cursor。
4. overdue 由 Reducer 根据 todo 的 dueAt 确定性迁移，不新增 commitmentProposer。
5. cursor 只在该 task 的 proposal 全部形成终局后推进。
6. Compaction task 不拥有独立 raw-message cursor；它是被 capacity-blocked normal task 派生出的维护任务。
7. coreProposer 及其各 core section cursor 保留原设计；“一次联合处理全部 core paths”与“各 path 独立 cursor”的最终协调方案尚未确认，不擅自改成共享 core cursor。

## 5. Proposal 持久化与 Compaction 状态机

保留 deferred、LLM compaction 和 compaction 后确定性重放，但禁止 accepted + deferred 的非原子混合提交。

状态机：

```text
pending
→ proposing
→ proposal_persisted
→ capacity_blocked
→ compacting
→ compaction_applied
→ replaying_original_proposal
→ succeeded
```

Compaction 无法完成时进入 halt，而不是推进 cursor：

```text
compacting
→ compaction_failed/halted
```

完整规则：

1. Proposer 输出经结构校验后，为每个 patch 分配稳定 patchId。
2. 在 apply 任何 patch 前，完整持久化原 proposal、source hashes、generation、cursorBefore、targetMessageId、prompt/model/schema 版本。
3. Reducer 先预检整个 proposal bundle。
4. 如果任一 patch 因 section 条数或可渲染字符容量需要 compaction，本轮不 apply proposal 中的其他 patch，避免 partial commit。
5. 创建 durable compaction task，并暂停同一 target 的后续 normal task。
6. Compaction 成功后，从数据库读取原 proposal，在当前 state 上重新做纯代码校验并确定性 replay；不得重新调用原 Proposer。
7. Source generation 在此期间变化时，旧 proposal/compaction task stale，由 rebuild 处理，不能 apply 到新 generation。
8. CompactionProposer 不得 merge/remove 原 proposal 正在引用的 itemId。
9. Compaction 失败时 cursor 不推进，原 proposal 保留，并必须显式告警。
10. Halt 是否只限对应 Memory target，还是同时阻断主聊天，对话中出现过两种表述，精确范围列入 §25，不再把“仅 target halt”写成已确定共识。
11. 人工清理容量、调整配置、更换模型或修复问题后，可 resume 相关 Memory 处理；resume 先重试 compaction，再 replay 原 proposal。

## 6. CompactionProposer 权限

1. 只有 compactionProposer 可以输出 `mergeItems`。
2. normal Proposer 永远不能输出 mergeItems。
3. compactionProposer 只能输出 mergeItems，不能输出 add/update/forget/complete/cancel。
4. mergeItems 不能跨 section。
5. compaction 是 system maintenance operation，不伪装成普通 message evidenceKind。
6. Merge 后的新 item ID 由 Reducer 生成 UUID/ULID，禁止使用 `itemIds.join(",")`。
7. Merge event 必须记录 `mergedFromItemIds`、resultItemId 和 replay 所需完整 normalized value。
8. 被合并旧 items 从 active state 移除，但历史通过 event chain 保留。
9. Merge 后 evidence 从输入 items 继承，compactionProposer 不能伪造 raw-message evidence。
10. compactionProposer 继承原设计的可维护范围：todos、standingAgreements、milestones 和 core sections；recentEpisodes 仍由 Reducer 的滑动窗口处理。
11. expiredScenes 和 overdue 是本次新增 section，compactionProposer 是否可以合并它们尚未确认，在确认前不扩大权限。
12. Todo merge 至少满足：同 section、actor 相同、requester 相同、dueAt 相同，并且相关 item 不受原 deferred proposal 保护。

## 7. Snapshot、Event 与恢复

1. State snapshot/checkpoint 是同一个概念：某个 revision 的完整权威 state，不再为每个 section 设计互不一致的恢复 checkpoint。
2. 每个成功提交的 state revision 都在同一事务写一份完整 post-state snapshot。
3. 一个 task bundle 即使包含多个 patch，也只产生一个 revision 和一份 snapshot。
4. 因为 revision N 已有 post-state snapshot N，所以 revision N+1 修改前天然已有“修改前 snapshot”，不需要额外复制一份 pre-state snapshot。
5. Compaction apply 和原 proposal replay 各自形成明确 revision，并各自同步 snapshot。
6. Source generation seed 必须同步写完整 snapshot。
7. State、events、snapshot、cursor、task 终态和 target health 必须在同一事务提交。
8. Snapshot 包含全部语义 section、全部 target cursors、revision 和 sourceGeneration；不包含 task retry/错误计数等运行恢复状态。这些状态必须在专用表中持久化，并非只保存在进程内。
9. Event replay 不重新调用 LLM，只使用 event 中的 normalized applied operation、result item ID 和确定性字段。
10. Add event 的 result item ID 不能为 null。
11. 为解决 eventId/itemId/provenance 的循环依赖，Reducer 在事务中预留 event IDs、生成 item IDs、构造最终 state，再插入完整 events。
12. 自动 overdue 转移、scene expiry、recentEpisodes 滑动窗口滚出、archive 等持久化变化必须记录 system cleanup event，禁止 silent delete。
13. Event/snapshot replay 必须校验 revision 连续性、cursor 连续性和 group task/target 一致性。是否额外引入 state hash 列入 §25。

## 8. Evidence 与 Quote

Reducer 对 evidence 做以下纯代码校验：

1. messageId 必须属于 task observed messages。
2. 数据库中的 user、preset、session、role、createdAt、content hash 必须与 proposal 时一致。
3. 普通 patch 的 evidence 可来自 task 的 observed messages（包括 newBatch 和 overlap）；不增加“至少一条必须来自 newBatch”的硬校验。
4. quote 必须非空，不能只有空白或纯标点。
5. quote 和 raw content 继承原设计的同一套确定性归一化：转小写并去除空白和配置中明确列出的标点差异。正式 schema 必须固定具体函数和标点集，不得由各 Provider 或调用点自行实现。
6. 归一化 quote 必须至少包含 3 个非空白、非标点/符号的信息字符，否则拒绝对应 patch，reason=`quote_too_short`。
7. 所有长度的 quote 统一使用模糊匹配，不再设置短文本精确、长文本模糊的双路径。
8. Reducer 在归一化 raw content 中寻找 quote 的最佳等长匹配窗口，继承原设计的 Levenshtein normalized similarity 算法；默认接受阈值为 0.75，具体值进入集中配置。
9. 低于阈值时拒绝对应 patch，reason=`quote_not_found`。
10. 每个 quote 最大为 200 个 Unicode code points；Reducer 按 code point 计数，超出时拒绝对应 patch，reason=`quote_too_long`，不自动裁剪。
11. Prompt 明确要求复制“能够支持 patch 的最短连续原文，最多 200 个 Unicode 字符”，但必须接受 LLM 可能无法精确复制；Reducer 的模糊匹配是最终接收规则。
12. 通用模糊匹配不能修复否定词删除、数字/姓名替换等低编辑距离但高语义影响的问题；系统明确接受这一剩余风险，不得在文档中宣称已解决否定翻转。
13. 不引入否定词专项规则、高风险事实识别或自然语言蕴含验证。

## 9. Memory 容量与长度预算

每个会进入主聊天上下文的 Memory section 只使用两个容量维度：

```js
{
  (maxItems, maxRenderedChars);
}
```

规则：

1. `maxRenderedChars` 只计算可能被 Renderer 输出的语义文本，例如 item.text 和 scene value。
2. quote、evidence、hash、ID、provenance、event、task proposal、compaction audit 等不渲染内容不计入 Memory 容量。
3. 除 recentEpisodes 外，超过 section 的 maxItems 或 maxRenderedChars 时，proposal 进入 deferred/compaction 状态机。recentEpisodes 保持 Reducer 确定性滑动窗口，超限时滚出最旧 item 并记录 system cleanup event，不调用 compactionProposer。
4. 不设置 Memory 业务层的 Proposer proposal/envelope 总字符上限。
5. 不要求 LLM 自己准确控制 proposal 总字符数。
6. Provider context/output 的物理硬上限仍然存在，但它属于 Adapter/Provider 能力边界，不是 Memory 容量策略。
7. Observer 在请求超过 Provider 能力时缩小 batch；单条消息仍无法处理时进入 degraded 并显式提醒，不能静默丢弃。
8. 各 section 的 maxItems/maxRenderedChars、scene TTL、overdue/archive 时间、lagThreshold、gapBridge 预算等都从集中配置读取，禁止散落硬编码。
9. 除 quote 最大 200 已确定外，其余具体默认数值需结合真实历史分布确定并写入配置文档。

## 10. Scene 生命周期

1. current.scene 是 user/preset 级状态，与 session 完全解耦。
2. current.scene 使用固定字段 shape；clearField 将对应 value 设为 null 并保留清除 event/provenance，不删除字段。
3. current.scene 有配置化过期时间，不得硬编码在业务代码中。
4. Scene 到期后不直接删除，而是作为完整 item 移入 expiredScenes。
5. 移动时保留 scene 值和 provenance，写 `system_cleanup: scene_expired` event，并清空 current.scene 固定字段。
6. expiredScenes 有独立 maxItems/maxRenderedChars；超限时的精确处理策略尚未确认，不默认授权 compactionProposer。
7. Renderer 将 expiredScenes 明确标为“已过期场景/上次已知场景”，不得称为当前状态。
8. Renderer 在后台 housekeeping 尚未持久化时先构造 effective view，避免本次请求继续把已到期 scene 标成 current。

## 11. Todo、Overdue 与时间

1. Todo 必须保存结构化 actor 和 requester，而不只保存 text。
2. actor 合法值为 user/assistant/both；requester 表示提出请求或承诺的一方。
3. 相对时间以 evidence message 的 createdAt 为 anchor，不使用 worker/task 执行时间。
4. `dueAt` 表示 deadline，不表示直接删除时间。
5. 当 `now >= dueAt` 时，由纯代码将 todo 从 todos 移入同级 overdue section，保留 itemId、actor、requester、dueAt 和 provenance。
6. 迁移写 `system_cleanup: todo_became_overdue` event。
7. Renderer 在持久化迁移尚未执行时先按 overdue 渲染 effective view。
8. Overdue 可以 complete/cancel，也可以在配置化保留期后 archive。
9. Todos 与 overdue 各自拥有独立 maxItems/maxRenderedChars，不互相占用容量。
10. `updateTodo` 必须显式输出 dueChange union：keep、clear 或 set；字段省略不能同时表示“不修改”和“清空”。

## 12. needsMemory 与 Recent Window

1. 主聊天 recent window 继续保留 user-boundary 裁剪，避免上下文从孤立的 Assistant 回复开始。
2. Memory Observer 不使用 user-boundary 裁剪，必须按 target cursor 读取完整 source。
3. `needsMemory` 采用简单的 Unicode 字符阈值作为主要判断，不同时堆叠 message count、tokenizer 预估和 context 百分比。
4. session 之间语义连续，因此 recent window 可以跨 session；消息保留 sessionId provenance，但不向 Proposer 注入会改变语义处理的 session boundary 控制标记。

## 13. LagThreshold 与尾批

1. 普通聊天中，尾部不足 lagThreshold 不视为 correctness bug。
2. 后续新消息到达后可与旧尾批一起处理；在此之前 recent window 仍提供原文覆盖。
3. 不引入普通 idle flush 或按 session rollover flush。
4. 极长新消息把未处理尾批挤出 recent window 时，由 per-target gapBridge 补齐。
5. Source rebuild 必须忽略 lagThreshold，force drain 到 captured boundary 后才能清 dirty。
6. 一次性迁移/cutover 和管理员排查也可调用相同内部 force-drain 能力。

## 14. GapBridge

1. GapBridge 按每个 target cursor 查询有效 gap，不再依赖 legacy summarizedUntilMessageId。
2. 对 recent window 起点 R 和 target cursor C，gap 是 target scope 中满足 `C < messageId < R` 的有效消息集合。
3. GapBridge 拥有独立逻辑字符预算，不与 Memory Renderer 的 section 容量竞争。
4. Gap 未超预算时直接注入 raw messages。
5. Gap 超预算时不调用 LLM 压缩，而是按 messageId 倒序选择最近 N 条完整 raw messages，再恢复为升序注入；N 和字符预算进入集中配置。
6. 截断结果必须持久化记录“已截断”、省略规模和保留边界，不能伪装成完整 gap；精确字段 schema 尚未确认。
7. 发生截断时继续主聊天，但进入 degraded，并向用户明确告警“部分早期对话未在上下文中”；旧 target state 必须标记为可能滞后，不能无提示声称是当前状态。
8. 不允许为了填满预算而截断单条 raw message 后仍声称其是完整原文；单条消息本身超预算时的取舍列入 §25，实现前需另行确认。
9. GapBridge 的逻辑预算独立，但其最终文本仍计入主模型不可突破的物理 context 上限。
10. 使用 LLM 压缩超预算 gap 的方案推迟到 [Gap Compressor 延后设计](memory-control-v2-deferred/gap-compressor.md)。

## 15. Memory 健康状态与用户告警

用户侧只需要统一的三档状态：

- `healthy`
- `degraded`
- `rebuilding`

下表是 per-target status（§16.1）到用户侧状态的概念映射，用于说明语义，不锁定最终数据库枚举或 schema：

| per-target status | 用户侧状态 | 说明 |
| --- | --- | --- |
| `healthy` | `healthy` | 该 target 正常运行 |
| `retry_wait` | `degraded` | 瞬时错误退避重试中，记忆可能滞后 |
| `halted` | `degraded` | compaction 无法完成等原因导致该 target 暂停，需人工 resume |
| `rebuilding` | `rebuilding` | source rebuild 进行中 |

任一 target 非 healthy 即整体显示对应 degraded/rebuilding 告警；所有 target 恢复 healthy 后整体回到 healthy。

共识：

1. 任何可能影响对话质量的问题都必须显式告知用户，包括 Provider/网络失败、target 积压、compaction halt、schema/state 异常、dirty rebuild、gap 超预算截断导致的上下文覆盖不完整、RAG/Recall 未追平等。
2. 内部仍保存精确 reason、taskId、target、generation、attempt 等诊断信息，但不要求用户理解大量错误枚举。
3. 告警应持续到恢复完成，而不是只弹一次短暂提示。
4. 恢复后应明确提示 Memory 已追平到相应 boundary。
5. Compaction 无法完成时必须 halt，但 halt 对主聊天的精确影响范围尚待确认（§25）。
6. 无论最终选择哪种 halt 范围，用户都必须知道对应记忆类别已暂停且可能滞后。
7. resume/rebuild 等恢复入口不能因 target halt 而不可访问；同一 target 的普通 proposal 仍按顺序等待，不能绕过 halt。管理员直接修改语义 state 的权限和路径尚未确认。

## 16. 自动恢复

### 16.1 Recovery 状态归属

旧设计中的 `memory_state.meta.recovery` 不再作为语义 state 字段，但其中能力必须完整迁移，不能静默丢弃。

字段归属：

| 旧 recovery 字段/语义 | 新持久化位置 |
| --- | --- |
| `consecutiveErrors` | per-target status |
| `awaitingContextExpansion` | 当前 durable task/proposal 的 `contextExpansionAttempt` |
| `lastErrorReason` | per-target status，同时写 ops log |
| `lastErrorTickId` | ops log 的 taskId/attempt；per-target status 保存 lastTaskId |
| halt 状态与原因 | per-target status |
| retry attempt/notBefore | durable task |
| 完整错误历史 | ops log |

建议的 per-target status 概念结构：

```js
{
  userId,
  presetId,
  sourceGeneration,
  targetKey,
  status: "healthy" | "retry_wait" | "halted" | "rebuilding",
  consecutiveErrors,
  lastErrorReason,
  lastTaskId,
  nextRetryAt,
  updatedAt
}
```

持久化规则：

1. Recovery 状态必须保存在数据库，进程内计数器不能成为 authority。
2. Provider/schema 等未产生语义 patch 的失败，只原子更新 task、per-target status 和 ops log；不增加 memory revision，也不写完整 state snapshot。
3. 成功提交语义 patch 时，state/event/snapshot/cursor/task 终态和对应 target status 的错误计数重置必须在同一事务完成。
4. `unable_to_decide` 首次扩窗口的状态属于该 proposal/window，不属于长期 target state，因此记录在 durable task 的 `contextExpansionAttempt` 中。
5. Compaction halt、deferred proposal 和 replay 阶段属于 durable task/target status，不写进语义 memory_state。
6. Renderer 和用户告警同时读取语义 memory_state 与 per-target status；删除 recovery 字段不能导致 degraded/rebuilding/halted 状态不可见。
7. Crash recovery 分两条：语义 state 从 snapshot/events 恢复，运行恢复状态从 durable task/per-target status/ops log 恢复。

### 16.2 旧 `meta.recovery` 迁移

默认 cutover 路径物理删除旧 Memory 并从 raw messages 重建新 state，不继承旧错误计数、halt 或 context-expansion flag；新 generation 的 target status 从 healthy/0 初始化。

如果开发期间存在已运行的 v2 state 且需要 in-place 移除 `meta.recovery`（而非清空重建），必须先在同一事务内将其恢复语义写入 durable task/per-target status/ops log，再删除 JSON 字段；迁移失败必须整体回滚。可确定定位的状态按 §4 的 target 映射（scene family → `scene`，todos → `todos`，standingAgreements → `agreements`，recentEpisodes/milestones → `episodes`）迁移；core 各 section 的映射随 §4 待确认的 cursor 方案一并定稿。无法定位 target 的旧全局错误/halt 应如何保守迁移列入 §25，不在本文中擅自规定为“halt 全部 target”。

至少包含以下恢复路径：

1. Provider/网络临时错误：有限指数退避重试。
2. 进程重启：单实例 worker 从数据库重读非终态 durable task，按已持久化阶段继续；不为此引入多实例 lease 协议。
3. Revision/cursor stale：丢弃旧执行结果，按 durable task/proposal 和当前 state 重新校验。
4. Source dirty/generation 变化：启动 source rebuild。
5. State/schema 损坏：优先从 snapshot 恢复；必要时从 raw messages rebuild。
6. Compaction 失败：halt 对应 target，保留原 proposal，显式告警，等待 resume。
7. RAG/Recall projection 落后：保持 degraded/rebuilding，追平当前 generation 后恢复。

## 17. Source Generation 与 Rebuild

自动 source rebuild 只在已被 Memory 观察的 source 发生变化时触发：

- 编辑历史消息；
- regenerate 导致截断/删除后续消息；
- 删除历史消息；
- session trash/restore/permanent delete；
- 消息 preset 归属或可见性变化；
- raw source 排序语义变化。

普通追加 User/Assistant message 不增加 sourceGeneration，只唤醒 normal worker。

管理员可因以下原因显式 rebuild：

- state/schema 损坏；
- 更换关键 Proposer prompt/model 后希望全量重新推导；
- Memory schema/compaction 语义发生不兼容变化；
- 人工判断当前 state 无法局部修复；
- v2 初次从 raw history 建立 state。

Rebuild 流程：

```text
sourceGeneration + 1
→ 设置 dirty
→ 取消旧 generation tasks
→ 初始化新 generation state + snapshot
→ 从当前有效 raw messages 重放
→ force drain 所有 target 到 captured boundary
→ 校验 state/snapshot/events/cursors
→ 清 dirty
→ 用户状态 rebuilding → healthy
```

Raw source mutation、generation increment、dirty boundary、旧 task 取消和 Memory/RAG/Recall invalidation intent 必须原子持久化，禁止 controller 在 source 已提交后 best-effort 标 dirty。是否以 outbox 表实现列入 §25。

## 18. Flush 与 Cutover

1. 不引入独立 Flush 子系统、Flush task type、Flush 状态机或专用持久化表。
2. 只保留 worker 内部的 `forceDrainTo(boundaryMessageId)` 能力，继续使用普通 durable tasks。
3. force drain 仅用于 source rebuild、管理员排查和一次性迁移/cutover。
4. Cutover 不是长期运行时子系统，只是一次性迁移流程。
5. Cutover 必须覆盖：停止旧 worker/注入、物理删除旧 Memory、从 raw messages rebuild/force drain 到捕获边界、校验并在 ready 后才注入 v2。具体部署/删除顺序需结合可回滚的迁移步骤另行确认。
6. Cutover 未追平或校验失败时保持 rebuilding/degraded，不能把 v2 标为 ready。

## 19. Forget、Correction 与物理删除

1. Correction：用新 revision 更新错误 item，active state 只渲染新值，event history 保留旧 revision。
2. Forget：从 active state 移除 item，并写 context-suppression tombstone，阻止相同 source 在 rebuild/RAG/Recall 中重新进入上下文。
3. Privacy hard delete：跨 raw/event/snapshot/RAG/Recall/debug 派生存储执行物理清除。
4. “把 text 改成已作废”不是 forget，Renderer 不应继续注入被忘记内容。
5. Forget transaction 必须收集足以阻止被忘记内容通过 rebuild/RAG/Recall 回流的全部相关 source provenance，不能只看当前 revision；具体 event-chain 数据结构列入 §25。

## 20. RAG Suppression

当前阶段不引入 suppressionProposer，不尝试用新的 LLM 调用从一条多事实消息中精确识别应删除的语义片段。

当前确定性方案：

1. RAG chunk 必须能追踪其 source messageId/contentHash。
2. Forget/correction transaction 从被移除或被替换 item 的全部相关 provenance 收集 evidence messageId/hash，并写 context-suppression tombstone；具体追踪结构尚未锁定。
3. 与 suppressed message 相交的现有 RAG chunks 全部失效/删除。
4. RAG 重新分块和 embedding 时跳过 suppressed message；raw chat message 本身不修改。
5. RAG 查询再做一次 source suppression 过滤，命中 suppressed message 的 chunk 不返回。
6. Correction 的新消息正常进入 RAG，旧 evidence message 按上述规则排除。
7. 该方案会保守地排除同一消息中的其他无关事实；这是当前明确接受的副作用。
8. 使用 LLM 做片段级精确 suppression 的方案推迟到 [Suppression Proposer 延后设计](memory-control-v2-deferred/suppression-proposer.md)。

## 21. Provider Adapter

1. Memory worker 使用独立 structured-output Adapter，不复用裸文本解析路径。
2. Adapter 使用 Provider 原生 schema/tool/function 能力，并在返回后做本地结构校验。
3. 不支持 structured output 的 Provider/model 不能配置为 Memory Proposer。
4. Adapter 必须区分正常输出、网络失败、refusal/safety block、max-output truncation 和 schema invalid。
5. Prompt 约束用于提高成功率，Reducer/Adapter 代码校验用于保证结构边界；必须接受 LLM 偶尔不遵守 Prompt。
6. Provider 的物理 context/output 上限由 Adapter 处理，不转化为 Memory section 容量规则。

## 22. 单实例串行与幂等

1. 继承原设计的部署假设：当前只支持单实例，由进程内 per-user/preset 队列保证 Memory 写入串行；不引入 lease、多实例 claim 或数据库 CAS 协议。
2. Durable task 使用稳定 task identity/dedupe key，重复 wake-up 不创建重复任务。
3. Reducer 提交前校验 generation、cursorBefore 和当前 revision，禁止 cursor 回退、跳过 gap 或把旧 state 上的 itemId 决策 apply 到新 revision。这是进程重启和 stale result 防护，不代表多实例并发支持。
4. 相同 task/patchId 的重复恢复或 delivery 只能产生一组 events 和一个 state revision。
5. Compaction、proposal replay、snapshot 和 cursor 更新都必须满足同一幂等原则。
6. 未来如改为多实例部署，需单独设计数据库锁/lease/fencing 协议，不属于当前共识。

## 23. 运营与指标

需要记录但不直接阻断聊天的指标包括：

- calls/message；
- input/output tokens；
- Provider/model latency 与费用；
- schema failure；
- safety/refusal；
- unable rate；
- quote similarity 分布、quote-too-short/quote-not-found/quote-too-long rate；
- compaction success/failure/halt rate；
- deferred proposal age；
- queue age/backlog；
- revision/cursor stale；
- gapBridge raw/truncated/omitted；
- rebuild duration；
- RAG/Recall projection lag；
- Memory degraded/rebuilding 持续时间。

低价 LLM API 使多次调用成本可以接受，但不能因此忽略延迟、限流、失败率和错误累积。

## 24. 配置原则

下列变量必须进入集中配置并在文档中说明，不得散落硬编码：

- 每个 section 的 maxItems；
- 每个 section 的 maxRenderedChars；
- current.scene 过期时间；
- expiredScenes 保留/容量；
- overdue archive 时间；
- 每个 target 的 lagThreshold；
- gapBridge raw 字符预算；
- gapBridge 截断后保留的最近消息数；
- quote 模糊匹配算法与接受阈值；
- Provider retry/backoff；
- Compaction retry 次数与 target halt 条件；
- Snapshot/event/debug retention；
- 用户 degraded/rebuilding 告警防抖和恢复条件。

Evidence quote 最大 200 Unicode code points 已确定；模糊匹配继承原设计的默认阈值 0.75，可通过集中配置调整。其余具体默认值尚未最终固定，应根据真实历史分布和 Provider 能力选择。

## 25. 尚未确认的实现决策

以下内容不是当前共识，不得在实现时默认采用：

1. expiredScenes 和 overdue 超出容量时是否授权 compactionProposer 合并，以及它们的确定性 archive 细则。
2. per-target status 的最终数据库 schema、精确状态枚举和告警防抖时序。本文 §15–§16 只规定必须持久化恢复能力并向用户显式告警的语义。
3. state hash/canonical JSON、outbox 的具体表结构、snapshot/event/debug retention 的默认值。需保证已确认的原子性、可恢复性和 dirty rebuild，但实现形式尚未锁定。
4. 旧 `meta.recovery` 无法定位 target 时的精确保守迁移策略；默认 cutover 从 raw messages 重建时不需要迁移旧运行错误状态。
5. GapBridge 对“单条 raw message 本身已超预算”的精确取舍，以及 omitted 诊断字段的最终 schema。
6. Forget/correction 沿 merge/duplicate event chain 追踪 source 的具体数据结构。要求仍是被忘记/纠正的内容不得通过 rebuild、RAG 或 Recall 重新注入。
7. 管理员直接维护的精确绕行权限、物理删除前是否强制生成离线备份，以及 cutover 各阶段的最终顺序。
8. Compaction 失败后的 halt 只停止对应 Memory target，还是阻断该 user/preset 的主聊天。已确认的是“必须 halt 且必须显式告警”，两种范围中的最终选择需再确认。
9. coreProposer 联合处理多个 core path 时的 cursor 粒度；需在保留原 coreProposer 责任的前提下，解决共享调用与独立 cursor 不一致。

---

本文是讨论共识清单，不替代最终拆分后的状态契约、写入协议、Prompt、Renderer、Harness 和迁移文档。正式文档修订时必须逐项映射，并删除与本清单冲突的旧设计。
