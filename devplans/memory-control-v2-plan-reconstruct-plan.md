# Memory Control v2 文档重构方案（共识定稿）

## 0. 文档目的与执行原则

本文不是 Memory v2 的最终状态契约，而是对现有文档集的重构实施方案。它汇总围绕“八个核心问题”和“十一个关联问题”达成的全部共识，规定每份文档要删除、改写和新增的内容，供后续 AI Agent 按同一产品前提重建最终设计。

目标文档：

- `devplans/memory-control-v2-overview.md`
- `devplans/memory-control-v2/state-contract.md`
- `devplans/memory-control-v2/write-protocol.md`
- `devplans/memory-control-v2/rendering-and-context.md`
- `devplans/memory-control-v2/proposer-prompt.md`
- `devplans/memory-control-v2/harness.md`
- `devplans/scene-snapshot-recall.md`

执行原则：

1. 本次重构采用瀑布式设计：设计阶段一次覆盖 deferred、compaction、snapshot、replay、overdue、expired scene、gapBridge、用户告警、forget/correction 与 RAG suppression，不以“首版先删除、以后再补”为默认答案。
2. 实现仍可按依赖顺序分层落地和验收，但不得用实现切片改变最终 schema 或推迟关键状态机设计。
3. 可行性优先：只为明确故障路径增加机制；一个总量约束可以解决的问题，不拆成多套细粒度预算或 LLM 风险分类。
4. Reducer 只承担纯代码能稳定完成的结构校验。无法证明的自然语言真实性、语义蕴含和 compaction“不新增事实”只能依靠 prompt、权限隔离和评测降低风险，不得伪装成代码保证。
5. 最终文档之间不得复制出互相漂移的第二套静态契约。状态 shape、op、reason code、数据表和配置键以 `state-contract.md` 为唯一权威；其它文档引用它并补充时序或使用方式。

---

## 1. 必须写在文档开头的个性化项目说明

### 1.1 放置位置

在 `memory-control-v2-overview.md` 的“文档定位”之后、核心判断之前，新增“项目个性化前提”章节。其它六份文档在开头链接该章节，不再自行假设通用聊天产品语义。

### 1.2 必须明确写入的内容

1. **项目类型**：这是个人维护的情感类 AI Chat。对话连续性和记忆质量高于无提示的可用性降级，但 Memory 故障不应默认封锁主聊天；任何可能影响对话质量的故障必须显式告知用户。
2. **跨 Session 语义连续**：session 主要是按天划分的存储/UI 单元，不是语义边界。新 session 不重置 shared memory、target cursor 或 scene；recent window 和 Memory Observer 均按 user/preset 连续消息流工作。
3. **Scene 与 Session 解耦**：scene 是 user/preset 级当前状态。sessionId 只作为 raw source 与 provenance 字段，不参与 scene key、scene 生命周期或自动 reset。
4. **User/Assistant 对 Profile 的对等权限**：User 与 Assistant 都可对 `userProfile`、`assistantProfile` 执行 add/update/forget。Reducer 仍校验 evidence 的真实消息 role，但不得用 role 限制这两个 path 的操作权。
5. **错误透明原则**：Memory 网络失败、Provider 拦截、target 积压、compaction halt、dirty rebuild、gapBridge 压缩失败、RAG/Recall 未追平等只要可能影响回复质量，都必须进入用户可见的 degraded/rebuilding 状态；不得只写后台日志。
6. **目标级 Halt**：普通 Memory 故障由自动恢复与显式告警处理；只有 compaction 无法完成、原 proposal 无法安全 replay 时 halt 对应 Memory target。主聊天和其它 target 继续运行，但必须持续提示受影响的记忆类型。
7. **完整设计而非功能阉割**：本次重构直接设计 compaction、deferred 和恢复状态机。后续 Agent 不得以“先做简单首版”为由删除已达成共识的能力。
8. **旧系统不构成兼容约束**：旧 rolling/core Memory 策略质量不可接受，不做 shadow 对比或文本迁移；上线 v2 时从 raw messages rebuild，并物理删除旧 Memory 数据/runtime path。离线数据库备份可以保留，但不得进入 Agent context 或形成双 authority。
9. **成本假设**：低价 LLM API 的调用成本可以接受，可以使用 compactionProposer、gapCompressor 和 suppressionProposer；但仍记录调用量、token、延迟、失败率和积压，防止质量与可靠性问题被低价格掩盖。
10. **成人内容边界**：成年、consensual 的情感/成人互动是合法 source。Memory 以客观、紧凑文本记录事件与关系变化；Provider safety block 必须被识别、告警和恢复，不能伪装成 noop。
11. **单实例当前事实不等于可丢失状态**：当前部署可以是单应用实例，正常调度按 user/preset 串行；但 proposal、compaction、cursor、snapshot、dirty 和恢复状态必须落数据库，不能依赖进程内对象。

### 1.3 后续 Agent 禁止自行改写的产品决策

- 禁止把“新 session”解释为场景或关系重置。
- 禁止恢复 userProfile 只能由 User 修改、assistantProfile 只能由 Assistant 修改的单方权限模型。
- 禁止把“用户可见告警”降级成仅日志/指标。
- 禁止因为实现复杂而删除 deferred、compactionProposer 或 deterministic replay。
- 禁止重新引入 v1 summary 作为 fallback authority。
- 禁止将 Memory target halt 写成主聊天全局 halt。

---

## 2. 目标状态模型与写入单元

### 2.1 目标 State 形态

`state-contract.md` 应以如下概念形态重写；最终字段名和机器 schema 以该文档为准：

```js
{
  version,
  revision,
  sourceGeneration,
  current: {
    scene: {
      location,
      time,
      mood,
      note,
      updatedAt,
      expiresAt
    }
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
    targetCursors: {},
    targetHealth: {},
    memoryStatus
  }
}
```

关键语义：

- `current.scene` 是 preset-scoped 单对象，不以 sessionId 建 map。
- `expiredScenes` 是与 todos/overdue 同级的可管理 section，不是假装 current 的旧字段。
- `overdue` 是独立 section，不占用 active todos 的条数或长度容量。
- snapshot 覆盖上述完整 state 和全部 target cursor。
- task/proposal/lease/attempt 等运营状态放专用表，不混入语义 state snapshot。

### 2.2 写入单元与唯一 Cursor

删除 `meta.perSectionCursor` 和“一个共享 Proposer 对多个独立 section cursor”设计，改为 per-target cursor：

| targetKey | Normal Proposer | 可写 section | cursor |
| --- | --- | --- | --- |
| `scene` | `currentStateProposer` | `current.scene` | `scene` |
| `commitments` | `commitmentProposer` | `todos`, `overdue`, `standingAgreements` | `commitments` |
| `episodes` | `episodeProposer` | `recentEpisodes`, `milestones` | `episodes` |
| `core` | `coreProposer` | `worldFacts`, `userProfile`, `assistantProfile`, `relationship` | `core` |

规则：

- 一个 normal task 只持有一个 targetKey、一个 cursorBefore、一个 observed window、一个 targetMessageId 和一个原 proposal。
- `episodeProposer` 联合判断 episode/milestone，两个 section 不再分叉进度。
- `commitmentProposer` 联合判断 todo/overdue/agreement，避免同一意图被两个独立 Proposer 重复分类。
- `compactionProposer` 是维护 Proposer，不拥有 normal source cursor。
- `gapCompressor` 与 `suppressionProposer` 是 context/派生数据工具，不得修改 authoritative memory_state。

### 2.3 Proposer 清单

最终文档只保留以下 LLM 能力：

1. `currentStateProposer`
2. `commitmentProposer`
3. `episodeProposer`
4. `coreProposer`
5. `compactionProposer`
6. `gapCompressor`
7. `suppressionProposer`

删除独立 `todoProposer`、`agreementProposer`。Normal Proposer 禁止输出 `mergeItems`；只有 `compactionProposer` 可以输出该 op。

---

## 3. Proposal、Deferred、Compaction 与确定性 Replay

### 3.1 必须替换旧 accepted + deferred 混合模型

现有文档允许同一窗口部分 patch accepted、部分 deferred，然后 compaction 后重新调用原 Proposer。这会造成：

- 已 accepted patch 在重跑时重复或改变；
- 进程崩溃后 deferred proposal 丢失；
- compaction 改变 itemId/state 后无法判断原输出如何继续；
- cursor 是否可推进缺少可恢复的单一判断。

重构后，只要一个 proposal 中任一 patch 因 section 容量触发 compaction，就先持久化**完整 proposal**，该 proposal 的任何 normal patch 都不在本轮提前 apply。

### 3.2 Durable Proposal 必备字段

`state-contract.md` 应新增 durable proposal/task 表或等价 JSONB 字段，至少保存：

- proposalId/taskId；
- userId/presetId/sourceGeneration/targetKey；
- cursorBefore/targetMessageId；
- proposer/promptVersion/schemaVersion/provider/model；
- observedMessageIds、role、createdAt、contentHash 摘要；
- 完整 normalized original proposal；
- 每个 patch 的稳定 patchId；
- protectedItemIds（原 proposal 正在 update/complete/cancel/forget 的 item）；
- expectedRevision；
- state machine status；
- compactionTaskId/attempt/error；
- lease token/expiry；
- createdAt/updatedAt。

原 proposal 一旦进入 `proposal_persisted`，compaction 后不得重新调用原 Normal Proposer。

### 3.3 状态机

`write-protocol.md` 应定义并图示以下状态机：

```text
pending
→ proposing
→ proposal_persisted
→ reducer_preflight
   ├─ no capacity block → applying → succeeded
   └─ capacity block → compaction_pending
      → compacting
      → compaction_applied
      → replaying_original_proposal
      → succeeded
```

异常分支：

```text
provider/schema/source/revision error → retry_wait/rebuild
unable_to_compact / compacted but still over cap → halted_compaction
sourceGeneration changed → cancel old proposal and enter source rebuild
```

### 3.4 Compaction 权限和 Reducer 约束

`compactionProposer`：

- 只能输出 `mergeItems` 或 `unable_to_compact`；
- 不能 add/update/forget/complete/cancel；
- 不能输出新的 raw evidenceRefs；
- 不能跨 section 或跨 core path 合并；
- 不能合并 `protectedItemIds`；
- 可处理 todos、overdue、standingAgreements、expiredScenes、milestones 和各 core path；
- recentEpisodes 按“近期滑动窗口”定义确定性滚出最旧项并写 event，不进入 compaction；current scene 是固定字段对象，也不进入 compaction；
- merge 文本可能存在语义偏差，这是接受的 LLM 风险，Prompt 约束“不新增事实”，Harness 用真实 eval 评估，但 Reducer 不宣称能证明。

Reducer：

- 校验所有 source item 存在且属于同 section/path；
- 为 merged item 生成新 UUID/ULID，禁止 `itemIds.join(",")`；
- event 保存 `mergedFromItemIds`、resultItemId 和继承后的 evidence；
- compaction evidence 由 source items 继承，`memory_compaction` 是 operation reason，不是新事实证据；
- todos/overdue 仅在 actor、requester、dueAt 和生命周期 section 相同时允许 merge；
- todos 与 overdue 不能互相 merge；
- current scene 不通过 mergeItems 压缩；expiredScenes 可以 merge。

### 3.5 Halt 语义

compactionProposer 返回 `unable_to_compact`、技术重试耗尽，或 merge 后仍无法容纳原 proposal 时：

- 原 proposal 保持 durable；
- 对应 target 进入 `halted_compaction`；
- target cursor 不推进；
- 后续同 target normal task 不执行；
- 其它 target 和主聊天继续；
- 用户持续看到受影响 target 的 degraded 提示；
- 管理员调整容量、模型、Prompt 或人工清理后执行 resume；
- resume 从 compaction/replay 状态继续，不重新调用原 Normal Proposer。

必须删除“compaction 失败后只提醒并推进 cursor”的方案，也不得把 target halt 扩大成主聊天全局 halt。

---

## 4. Snapshot、Event、ID、Dirty 与可恢复性

### 4.1 每 Revision 完整 Post-State Snapshot

每次成功改变 state/cursor 的事务都同步写一份完整 post-state snapshot：

```text
锁 state/task
→ 校验 proposal
→ 预留 event IDs / 生成 result item IDs
→ apply 完整 bundle
→ revision + 1
→ canonical state hash
→ 写 events + memory_state + full snapshot + cursor/task status
→ COMMIT
```

一个 task 有多个 patch 时，它们属于一个原子 revision，只写一份 snapshot。因为 revision N 已保存 post-state snapshot N，revision N+1 修改前天然已有完整 pre-state，不再额外写“修改前 snapshot”。

Snapshot 必须包含所有 section、revision、generation 和 target cursors；不包含 lease/retry/Provider 等运营态。

统一术语：本设计中的 `state checkpoint` 与 `state snapshot` 指同一个东西，只保留一套完整 state snapshot 表和恢复语义；`scene snapshot` 是 Recall 派生 projection，不能与恢复 checkpoint 混为一谈。

### 4.2 Event 可重放字段

必须修正：

- add event 的 result item ID 不得为 null；
- Reducer 可先预留 event sequence ID、生成 item ID，再构造 state/hash 并插入完整 event；
- merge event 保存新 resultItemId 和 `mergedFromItemIds`，不能把多个 ID 拼成字符串；
- normalized event 保存重放所需的完整 applied patch，而不是只有摘要；
- 每个 revision 的 events 共享 revisionBefore/After、cursorBefore/After 和 stateHashAfter；
- replay 按 revision 分组，组内规范顺序 apply，组末校验 hash；
- noop/rejected/deferred/compaction operational history 与真正改变 state 的 applied events 在 schema 中明确区分，不能让恢复逻辑猜测。

### 4.3 自动生命周期必须写 Event

以下纯代码变化不得 silent delete：

- todo 到期移入 overdue：`todo_became_overdue`；
- overdue 长期未处理归档：`overdue_archived`；
- current scene 到期移入 expiredScenes：`scene_expired`；
- expiredScenes 容量维护/归档；
- recentEpisodes 确定性滚出；
- system reset/clear；
- correction/forget/suppression。

### 4.4 Source Dirty 与原子 Invalidation

消息编辑/删除不得先提交 raw mutation、再 best-effort 标 dirty。相关 repository 必须接受 transaction client，在同一数据库事务中完成：

- 修改/删除/恢复 raw source；
- sourceGeneration + 1；
- 设置 dirty boundary；
- 取消旧 generation pending/running task；
- 写 Memory rebuild outbox；
- 写 RAG/Recall invalidation outbox。

Renderer 在 dirty/rebuilding 时不把旧 state 当作已追平状态，并向用户显示 rebuilding。

### 4.5 Source Rebuild 触发条件

自动触发：

- 编辑历史消息；
- truncate/regenerate 删除后续消息；
- 删除历史消息；
- session trash/restore/permanent delete；
- raw source 可见性、preset 归属或排序语义改变。

管理员显式触发：

- state/schema/hash 损坏；
- Prompt/模型/schema/compaction 语义变化后要求重新派生；
- 初次从 raw history 建立 v2；
- 人工判断 state 不可局部修复。

普通 append 不触发 source rebuild，只唤醒 normal task。

### 4.6 Force Drain，而非独立 Flush 子系统

不要新增 flush 表、flush task type 或独立状态机。只在 worker 内定义：

```js
forceDrainTo(boundaryMessageId)
```

它忽略 normal lagThreshold，把现有 durable normal/rebuild tasks 处理到固定 boundary，用于：

- source rebuild 完成前；
- 一次性迁移/cutover；
- 管理员排查时立即处理尾批。

普通聊天不需要 idle flush。跨 session 语义连续、recent window 和 gapBridge 能覆盖不足 lagThreshold 的尾部消息；下一批消息到来后继续处理即可。

### 4.7 Cutover 只是一段迁移流程

删除把 cutover 描述成通用运行时子系统的设计。迁移章节只保留一次性步骤：

1. 停旧 worker/injection；
2. 可选做不进入 Agent context 的离线 DB 备份；
3. 物理删除 v1 Memory 数据和 runtime path；
4. 部署 v2 schema；
5. 捕获 raw boundary；
6. 从 raw rebuild v2 并 force drain 到 boundary；
7. 校验 state/snapshot/events/cursors；
8. 标记 ready 并启用 v2 context。

不做 v1/v2 shadow 对比，不把旧 summary 转成 v2 item。

---

## 5. Todo、Overdue、Scene 与时间语义

### 5.1 Todo 结构

Todo 必须存：

- text；
- actor：`user | assistant | both`；
- requester：`user | assistant`；
- dueAt/dueTimeZone；
- created/updated message IDs 与 provenance。

相对日期使用 evidence message `createdAt` + 配置时区计算，不使用 task 执行时间。

`updateTodo` 必须显式输出：

```js
dueChange: { mode: "keep" }
// 或 { mode: "clear" }
// 或 { mode: "set", expression: ... }
```

禁止用字段省略同时表达 keep/clear。

### 5.2 Overdue 独立 Section

`dueAt` 是 deadline，不是删除时间。`now >= dueAt` 时由纯代码把 item 从 todos 移到 overdue：

- 保持同一个 itemId、actor、requester、due 和 provenance；
- 写 `todo_became_overdue` event；
- overdue 可以 complete/cancel；
- overdue 有独立 `maxItems/maxRenderedChars`；
- 长期未处理按配置归档并写 event；
- Renderer 在持久化 housekeeping 尚未完成时先构造 effective view，确保当前请求已按 overdue 渲染。

移除把 wall-clock 到期解释成 silent `expireTodo` 删除的旧规则。用户明确“不再需要”走 cancel；系统长期归档走 system event。

### 5.3 Current Scene 与 Expired Scenes

- current scene 与 session 完全解耦；
- `setField/clearField` 保持固定字段 shape，clear 后 `value=null` 并保留 clear provenance；
- 到 `sceneExpireAfterMs` 时，把完整 scene 转成 expiredScenes item并写 `scene_expired` event；
- current scene 全字段清 null；
- expiredScenes 在 Renderer 中使用“已过期场景/上次已知场景”标题，绝不称为当前状态；
- expiredScenes 有独立条数和可渲染字符容量，可由 compactionProposer 合并；
- TTL、归档时长和容量均来自集中配置，不得散落硬编码。

---

## 6. Evidence、Quote、权限、Correction 与 Forget

### 6.1 Quote 规则

删除当前 Levenshtein 0.75、去标点后的模糊匹配，改为可解释的纯代码规则：

- quote 非空；
- quote 不能只有 whitespace/punctuation；
- quote 必须是 observed raw message 的连续精确子串；
- messageId、userId、presetId、role、createdAt、contentHash 必须重新从 DB 校验；
- 普通 semantic patch 至少一条 evidence ref 来自 newBatch；
- 每个 quote 最多 **200 Unicode code points**；超出时只拒绝对应 patch，reason=`quote_too_long`；
- Prompt 明确要求复制“最短但足够的连续原文，最多 200 个 Unicode 字符”；
- Provider schema 支持时声明 `maxLength=200`，Reducer 仍以 code point 计数作最终权威；
- 不自动裁剪超长 quote；
- 不增加否定词专项、高风险事实分类或语义蕴含 Verifier。剩余语义偏差是明确接受的 LLM 风险。

### 6.2 Profile 与 Core 权限

Policy table 必须明确：

- User/Assistant 都可 add/update/forget `userProfile`；
- User/Assistant 都可 add/update/forget `assistantProfile`；
- User/Assistant 都可 correction/forget worldFacts/relationship；
- Reducer 校验 evidence 的实际 speaker role，但不把 speaker role 变成 profile path 权限限制；
- 不引入 authorityRole、多视角并存或“Assistant 不得改 User 档案”的规则。

### 6.3 Correction、Forget 与 Hard Delete

- correction：更新已有 item revision，active state 只渲染新值；
- forget：从 active state 移除并写 context suppression，防止 Memory/RAG/Recall 从旧 evidence 重新带回；
- hard delete：额外清 raw/event/snapshot/RAG/Recall/debug 派生数据；
- 禁止把 forget 写成“该信息已作废”后继续渲染；
- 普通 Proposer 使用窄 op，不恢复通用 `removeItem`。

### 6.4 RAG 精确 Suppression

为避免一条 message 含多个事实时整条删除，引入 `suppressionProposer`，但限制其能力：

输入：raw message、被 correction/forget 的 item、旧 evidence quote、新 correction evidence（如有）。

输出只允许：

```json
{
  "removeQuotes": ["必须从 raw message 精确复制的相关片段"]
}
```

Reducer/派生数据 worker：

- 每个 removeQuote 必须是 raw message 的连续精确子串；
- 至少一个 removeQuote 覆盖旧 item evidence quote；
- 不接受 replacement text；
- 从 RAG projection 删除这些片段，用剩余原文重新 chunk/embedding；
- raw chat history 不修改；
- correction message 正常进入 RAG；
- suppressionProposer 失败、unable、输出非法或未覆盖 evidence 时，保守地把整条 message 排除出 RAG，并显示 degraded 告警。

数据设计需增加 chunk→source message 映射和 context suppression 记录，使查询和 reindex 都能确定性排除被 suppression 的 source。

---

## 7. 容量、配置与 Provider 物理边界

### 7.1 Memory 业务容量只看可渲染内容

每个 section 只配置：

```js
{
  maxItems,
  maxRenderedChars
}
```

`maxRenderedChars` 只统计可能进入主聊天 context 的语义文本，如 item.text、scene value。明确不统计：

- quote/evidence；
- provenance/hash/ID；
- event/task/proposal；
- snapshot 元数据；
- compaction audit；
- 任何不被 Renderer 输出的字段。

条数或可渲染字符超限时触发 deferred + compaction。文档可列默认建议值，但配置模块是运行时单一来源，Reducer/Renderer/Prompt 不得各自硬编码。

例外：recentEpisodes 按定义确定性滚出最旧项并写审计 event，不因滑动窗口触发 compaction；current scene 是固定字段对象。其它允许 compaction 的 section 才进入 durable deferred 状态机。

### 7.2 不设 Proposal/Envelope 业务字符预算

删除“完整 proposal/envelope 必须小于某个人工字符数”的业务规则，也不因为 quote 不渲染就把它计入 Memory section 容量。

Provider context/output 上限是不可消除的物理边界，Adapter 只做以下处理：

- 调用前读取 provider/model capability；
- Observer 自动缩小 observed batch 直到请求可发送；
- 不要求 LLM 自己精确计算整体输出长度；
- 单条 raw message 仍超过 Provider 能力时不静默截断，进入 degraded 并明确告警/等待人工处理；
- max-token truncation 归类为 Provider/structured-output error，不把半截 JSON 交 Reducer。

### 7.3 集中配置项

最终文档至少列出以下集中配置，不要求本方案现在确定全部默认数值：

- `recentWindowMaxChars`（needsMemory 的唯一主要阈值）；
- 各 target `lagThreshold`；
- 各 section `maxItems/maxRenderedChars`；
- `quoteMaxCodePoints`，默认 200；
- `sceneExpireAfterMs`；
- `expiredSceneArchiveAfterMs`；
- `overdueArchiveAfterMs`；
- `gapBridgeRawMaxChars`；
- `gapBridgeCompressedMaxChars`；
- Provider retry/backoff/lease；
- compaction attempt/resume 策略；
- snapshot/event/debug retention；
- user-visible degraded/rebuilding 状态刷新策略。

所有 TTL 和阈值都必须从配置读取，不能写死在 Reducer、Renderer 或 Prompt 文件。

---

## 8. Recent Window、Lag、GapBridge 与用户可见状态

### 8.1 needsMemory 与 User-Boundary

- v2 不受旧 `CHAT_RECENT_WINDOW_MAX_MESSAGES` 语义约束；
- `needsMemory` 只使用 Unicode 字符预算这一主要近似阈值；
- 保留 user-boundary 裁剪，使 recent window 尽量从 User message 开始；
- User-boundary 只用于主聊天 recent context，不用于 Memory Observer；
- recent window 按 user/preset 跨 session 连续。

### 8.2 LagThreshold 尾批

- normal worker 只有达到 lagThreshold 才创建批处理任务；
- 不增加 idle timer/idle flush；
- 当下一条跨 session 消息到来时，尾部消息与新消息一起处理是预期行为；
- 在此之前 recent window 仍向主模型提供这些 raw messages；
- 如果旧尾部被字符窗口挤出，则由 gapBridge 补齐；
- source rebuild、迁移和管理员强制排查必须使用 `forceDrainTo(boundary)`，不能带未处理尾批清 dirty/ready。

### 8.3 Per-Target GapBridge

移除对全局 `summarizedUntilMessageId` 的依赖。对每个 target cursor `C` 和 recent window 起点 `R` 查询有效 gap：

```text
C < messageId < R
```

规则：

- gap 为空：不注入 bridge；
- raw gap 在独立预算内：直接注入；
- raw gap 超独立预算：调用 gapCompressor；
- 压缩结果标注为“尚未进入正式 Memory 的过渡历史”，并按 source hashes 缓存；
- 压缩失败：相关 target 标记 stale/degraded，用户显式告警；旧 state 不得无标记宣称为当前状态；
- gapBridge 使用独立逻辑预算，不与 Memory section 的 `maxRenderedChars` 竞争；最终物理上仍计入主模型 context。

### 8.4 用户可见 Memory Health

用户侧只暴露三个稳定状态：

- `healthy`
- `degraded`
- `rebuilding`

内部 reason 可以细分，但 UI 必须统一显示：

- affected target/能力；
- 首次发生时间；
- 自动恢复是否进行中；
- 当前回复可能使用滞后 Memory；
- 是否需要管理员介入；
- 恢复后追平到哪个 boundary。

任何影响质量的错误都不能只记录日志。告警是持久状态，恢复后显式清除；不是一次性 toast。

自动恢复至少覆盖 Provider backoff、lease reclaim、revision retry、dirty rebuild、snapshot/event restore 和 RAG/Recall reindex。Compaction 无法完成则保持 target halt，等待 resume。

---

## 9. 逐文档更新方案

### 9.1 `memory-control-v2-overview.md`

建议整体重写，而非在旧决策表上局部修补。

新增：

- 文档开头的“项目个性化前提”（§1）；
- per-target cursor 与联合 Proposer；
- persisted proposal + compaction + deterministic replay；
- 每 revision snapshot；
- target halt 与用户可见 health；
- currentScene/expiredScenes、todos/overdue；
- correction/forget/RAG suppression；
- force drain 和物理删除 v1 的迁移原则；
- 瀑布式完整设计说明。

删除/改写：

- “每 section 独立 cursor”；
- todoProposer/agreementProposer；
- normal Proposer 主动 merge；
- 主聊天全局 halt；
- 模糊 quote matcher；
- 旧 v1 运行后再清理/对比；
- session 暗含 scene 边界；
- “首版删除复杂功能”的措辞。

顶层决策表应按本方案重新编号，不继承当前 C1-C17 的冲突结论。

### 9.2 `state-contract.md`

这是改动最大、必须先完成的权威文档。重写：

- 完整 state schema（含 overdue、expiredScenes、per-target cursor）；
- Todo actor/requester/dueChange；
- current/expired scene shape；
- section `maxItems/maxRenderedChars` 语义；
- Proposer/target/op 矩阵；
- compaction-only mergeItems policy；
- 双方对 userProfile/assistantProfile 的全权 policy；
- exact quote + 200 code point；
- durable task/proposal/compaction/replay 表；
- event result IDs、mergedFrom、revision/hash/cursor 字段；
- 每 revision full snapshot 表；
- dirty/source generation/outbox；
- target health 与用户 health；
- correction/forget/suppression 与 RAG source mapping；
- 稳定 reason codes。

必须删除：

- `perSectionCursor`；
- sectionResults 对多个独立 cursor 的暗示；
- Levenshtein/0.75 fuzzy quote；
- `itemIds.join(",")`；
- add event item_id null；
- 只限制 item 数量；
- profile 单方权限或 authorityRole；
- wall-clock todo silent expiry；
- Proposal/envelope 人工字符预算。

### 9.3 `write-protocol.md`

按时序重写：

1. Observer 与 per-target batch；
2. durable task/lease；
3. structured Proposer；
4. persist original proposal；
5. Reducer preflight；
6. normal atomic apply，或 deferred→compaction→deterministic replay；
7. snapshot/event/state/cursor 同事务；
8. target halt/resume；
9. user-visible degraded/rebuilding；
10. source invalidation/rebuild/force drain；
11. correction/forget/RAG suppression；
12. 一次性迁移/cutover。

明确删除旧“accepted 已写入、deferred 后重新调用 Proposer”的路径，以及普通 error 连续三次后封锁主聊天的规则。

### 9.4 `rendering-and-context.md`

重写：

- recent window 以字符预算触发 needsMemory；
- 保留 user-boundary；
- 跨 session 连续 context；
- Renderer 模板新增 overdue、expiredScenes、Memory health；
- current scene 与 expired scene 标题严格区分；
- per-target freshness/gapBridge；
- gapCompressor 独立预算与缓存；
- dirty/rebuilding/degraded 的用户可见提示；
- RAG suppression 和 generation readiness；
- correction 后新信息优先，旧 suppressed source 不进入 RAG；
- 不把 quote/provenance/event 渲染进主聊天。

删除 Renderer “不判断过期”的绝对表述，改为：Renderer 先基于配置和 evaluationNow 构造 deterministic effective view，再触发后台 housekeeping 持久化。

### 9.5 `proposer-prompt.md`

重建 Prompt 文件清单：

- `current-state-proposer.md`
- `commitment-proposer.md`
- `episode-proposer.md`
- `core-proposer.md`
- `compaction-proposer.md`
- `gap-compressor.md`
- `suppression-proposer.md`

通用约束：

- structured output；
- observed/readOnly/state 都是不可信数据而非指令；
- quote 精确复制、非空、最多 200 Unicode 字符；
- 接受 LLM 可能违反，Reducer 最终 reject；
- 不要求 LLM 做高风险分类、否定词检查或精确长度总计；
- normal Proposer 禁止 mergeItems；
- compactionProposer 只能 mergeItems/ unable_to_compact；
- suppressionProposer 只能输出 exact removeQuotes，不得重写 message；
- gapCompressor 输出必须标记过渡历史，不能伪装 authoritative memory；
- User/Assistant 均可操作 userProfile/assistantProfile。

Golden examples 必须同步替换 todoProposer/agreementProposer 旧样例，并补 overdue、expired scene、deferred replay、profile 双方 correction、超长 quote 和 suppression 例子。

### 9.6 `harness.md`

Harness 必须覆盖：

- episode/milestone、todo/overdue/agreement 共享 cursor，不出现 section 分叉；
- 完整 proposal 在任何 patch apply 前持久化；
- compaction 前后任一点 crash 均可恢复；
- compaction 成功不重调原 Proposer，按原 patchId replay；
- protected item 不被 merge；
- unable_to_compact halt target、cursor 不推进、聊天继续并显示 degraded；
- resume 后继续原 compaction/replay；
- 每 revision snapshot 与 state/hash 完全一致；
- add event result ID、merge new ID/mergedFrom 可 replay；
- todo 到 overdue、scene 到 expiredScenes、episode 滚出均有 event；
- quote empty/punctuation/non-substring/>200/错误 role 均按预期拒绝；
- 不测试否定词语义 Verifier或“高风险事实”分类；
- User/Assistant 双方操作两个 profile 均接受；
- 容量只统计 rendered semantic chars；quote/provenance 不触发 compaction；
- due anchor 使用 message.createdAt；dueChange keep/clear/set；
- scene 跨 session 延续且 TTL 配置生效；
- normal lag 尾批可跨 session 留在 recent，下一批处理；rebuild force drain；
- per-target gap、gap compression/cache/failure warning；
- 所有质量错误进入用户可见 degraded/rebuilding；
- source edit 与 generation/dirty/outbox 原子；
- suppressionProposer 精确删除片段，失败时整条 message 退出 RAG；
- v1 数据物理删除、v2 raw rebuild、无双 authority。
- 运营指标包含 calls/message、input/output token、Provider latency/error、schema invalid、unable、compaction 成功率、target halt 时长、queue age、rebuild 时长和用户可见 degraded 持续时间。

### 9.7 `scene-snapshot-recall.md`

现文档将 scene snapshot 与 session 强耦合，必须重构：

- snapshot scope 改为 user/preset scene timeline；
- 行中保留 sourceSessionId 作 provenance，但 session 变化不关闭 scene；
- 删除“不做跨会话 recall”的限制；同 user/preset 可跨 session 精确回溯；
- snapshot/区间边界基于实际下一 scene event，不使用 `nextMessageId - 1` 假设全局 ID 连续；
- scene_expired 也生成历史 scene snapshot/projection；
- currentScene、expiredScenes 与 Recall projection 的职责分开；
- snapshot writer 必须 durable/retry，不使用不可恢复的 post-commit best-effort；
- source edit/delete 通过 generation invalidation 重建 projection，不保留证据已失效却仍宣称有效的 snapshot；
- Recall 和 RAG 都服从 correction/forget suppression；
- Recall 独立预算保留，但最终仍遵守主模型物理 context 上限；
- 移除“首版/未来扩展”式功能延期措辞，改成完整目标和明确非目标。

---

## 10. 旧契约替换矩阵

| 现有说法 | 更新后说法 |
| --- | --- |
| 每 section 独立 cursor | 每 target 一个 cursor；联合 Proposer 共享 cursor |
| todoProposer + agreementProposer | commitmentProposer 联合处理 |
| normal Proposer 可以主动 merge | 只有 compactionProposer 可以 mergeItems |
| accepted 先 apply，deferred 后重调 Proposer | 完整 proposal 先持久化；compaction 后确定性 replay |
| compaction 失败全局 halt chat | halt 对应 target；聊天继续并告警 |
| 连续 Provider 错误封锁聊天 | 自动恢复 + degraded/rebuilding 用户提示 |
| 每 section 只有 item count | 每 section maxItems + maxRenderedChars |
| quote ≤80 且 fuzzy 0.75 | quote 精确连续原文、≤200 code points |
| proposal/envelope 人工总字符预算 | 无业务总字符预算；只处理 Provider 物理上限 |
| todo expiresAt 到期删除 | dueAt 到期移入 overdue |
| scene 属于 session/current.scene | preset-scoped currentScene + expiredScenes |
| 新 session 隐含场景边界 | session 仅是按天存储/UI 单元，语义连续 |
| add event item_id=null | event 保存 Reducer 生成的 resultItemId |
| merge item ID 为 join 字符串 | Reducer 新 UUID + mergedFromItemIds |
| 自动过期/滚出不写 event | 所有 state 生命周期变化写 system event |
| userProfile/assistantProfile 有单方 authority | User/Assistant 对两者均有完整操作权 |
| forget 写成“作废”文本 | active 删除 + suppression；hard delete 独立 |
| RAG 整条保守删除 | suppressionProposer 选 exact spans；失败才整条排除 |
| summarizedUntilMessageId 驱动 RAG/gap | per-target cursor 查询实际 gap |
| idle flush 修尾批 | normal 不 idle flush；rebuild/cutover 内部 force drain |
| cutover 是运行时子系统 | cutover 仅是一次性迁移步骤 |
| v1 保留并 shadow 对比 | 物理删除 v1，从 raw rebuild v2 |

---

## 11. 文档重构执行顺序

1. **先重写 overview**：固定个性化前提、顶层决策和术语。
2. **重写 state-contract**：确定 state、task/proposal/event/snapshot/suppression schema、op、policy、reason 和配置键。
3. **重写 write-protocol**：把静态契约串成可恢复状态机，重点验证 compaction/replay、snapshot transaction 和 source rebuild。
4. **重写 rendering-and-context**：确定 recent、health、overdue/expired scene、gapBridge 和 RAG suppression 的注入语义。
5. **重写 proposer-prompt**：只引用已稳定的 schema/op，不提前发明字段。
6. **重写 scene-snapshot-recall**：按 preset-scoped scene timeline 和 suppression/generation 契约修订。
7. **最后重写 harness**：将所有共识变成 fixture、crash injection、golden output 和 migration assertions。
8. **全局一致性扫描**：删除旧标识、旧 reason、旧 cursor、旧 halt 和旧预算描述。

任一步发现需要改变已冻结产品决策时，先修订 overview 的决策表和本方案，再同步其它文档；不得只在某份子文档中偷偷改变语义。

---

## 12. 文档完成定义（Definition of Done）

### 12.1 结构一致性

- 七份目标文档都引用同一个项目个性化前提。
- state section、targetKey、Proposer 名称、op 和 cursor 映射完全一致。
- 所有配置项只在 state-contract 定义，其它文档只引用。
- 所有 reason code 在 state-contract、write protocol 和 Harness 一致。
- 所有事件都能说明是否改变 state、是否推进 cursor、如何 replay。

### 12.2 必须能回答的故障问题

最终文档必须不依赖口头补充即可回答：

1. Proposer 输出后、持久化前崩溃怎么办？
2. Proposal 已持久化、compaction 前崩溃怎么办？
3. Compaction 已提交、原 proposal replay 前崩溃怎么办？
4. Replay 提交返回前连接断开怎么办？
5. Compaction 永远无法释放容量怎么办？
6. Source 在 deferred 期间被编辑怎么办？
7. Snapshot/event/state 任一缺失或 hash 不一致怎么办？
8. Memory degraded/rebuilding 如何向用户展示和恢复？
9. correction/forget 后 Memory、RAG、Recall 如何同时失效旧事实？
10. 跨 session 的尾批、scene、recent 和 gap 如何连续？

### 12.3 必须消失的旧关键词/旧语义

完成后全局搜索并人工确认以下内容只出现在“禁止/迁移说明”中，而非 active contract：

- `todoProposer`
- `agreementProposer`
- `perSectionCursor`
- normal proposer `mergeItems`
- accepted + deferred 后重新调用原 Proposer
- `itemIds.join(",")`
- add event `item_id = null`
- quote fuzzy/Levenshtein/0.75
- 主聊天全局 halt
- session-scoped current scene
- `summarizedUntilMessageId` 作为 gap/RAG 权威边界
- todo wall-clock silent delete
- v1 shadow/双 authority
- 独立 flush 子系统

### 12.4 验证方式

- Markdown 相对链接全部存在。
- 代码围栏配对。
- 表格、枚举和示例字段与权威 schema 一致。
- 使用脚本扫描旧关键词和冲突 reason。
- Harness 文档包含 compaction 状态机每个 crash point。
- Renderer golden 明确区分 current scene、expired scene、todo、overdue 和 degraded/rebuilding。
- 迁移章节明确物理删除 v1、raw rebuild、force drain 和 ready gate。

---

## 13. 本方案明确不解决的事项

为防止后续 Agent 再次扩大范围，以下内容不属于本轮文档重构：

- 多实例主动写入的完整分布式调度；当前只要求数据库持久化和幂等足以覆盖单实例崩溃/管理操作。
- 用第二个 LLM 证明普通 memory text 或 compaction text 的语义真实性。
- 自动判断“高风险事实”或复杂否定词语义。
- 把旧 v1 summary 转换成 v2 item。
- 将 session 改造成语义隔离单元。
- 让 suppressionProposer重写 raw message；它只能选择要从派生 RAG projection 删除的精确原文片段。
- 建立独立 flush/cutover 运行时平台。

这些非目标不得被误解为延期功能；它们是基于项目特性和可行性主动排除的设计范围。
