# Memory Control v2.1 顶层设计

## 文档定位

本文定义情感类 AI Chat 的 Memory Control v2.1 顶层判断、组件边界与不可破坏的不变量。静态 shape/枚举/DDL 以 [状态契约](state-contract.md) 为单一权威，运行编排以 [写入协议](write-protocol.md) 为权威，确定性状态机从 [算法契约索引](algorithms/README.md) 进入。

配套文档：

- [Source Scan 与 Observation](algorithms/source-scan-and-observation.md)：逐消息语义扫描、observation/arc/occasion ledger；
- [Task、Boundary Cycle 与幂等](algorithms/task-execution-and-idempotency.md)：durable task、冻结 snapshot、candidate lifecycle、commit/recovery；
- [Source Rebuild 与 Projection](algorithms/source-rebuild-and-projection.md)：boundary-major/event-time 重建；
- [Proposer Prompt](proposer-prompt.md)：observer 与专业 Proposer 的 structured output 约束；
- [渲染与上下文](rendering-and-context.md)：主聊天注入与可见边界；
- [Harness](harness.md)：golden、metamorphic、在线/重建等价性验收；
- [修复行为定义](../memory-control-v2-fix.md)：本次问题分析与行为需求来源，不重复定义静态 schema。

若文档冲突，优先级为：本文的顶层不变量 → 状态契约的静态定义 → 算法文档的状态机 → Prompt/Renderer/Harness 的消费约束。修订时必须同步受影响文档，不能靠实现猜测。

## 1. 核心判断

当前Memory总结结果差并不只是某一句 prompt 写得不好。旧链路同时存在四个结构性问题：

1. **按 target 独立扫 raw source**：不同 target 在不同窗口、不同 revision 看同一段对话，产生未来信息泄漏和批大小敏感；
2. **cursor 把“看过”误当“理解并处理”**：noop、Reducer rejection 或窗口遗漏后仍可推进，语义信号永久丢失；
3. **没有跨消息候选账本**：提议、接受、履约、纠正、重复模式散落在多批消息中，Proposer 无法稳定拼成一个事实；
4. **历史重建使用执行时钟且按 target-major 运行**：相对日期、scene TTL、episode/profile 读取顺序与在线时间线不同。

因此，v2.1 的核心前提是：

> Memory 不是一段反复改写的摘要，也不是若干 target cursor；它是 raw source 经一次可审计语义扫描形成 observation ledger，再由同一 boundary snapshot 上的专业 Proposer 投影出的结构化状态。

LLM 负责两个受限语义阶段：通用 observer 识别候选信号，专业 Proposer 判断候选是否达到某一 memory section 的写入标准。纯代码负责 source 完整性、schema、证据注册、版本、权限、生命周期、容量、并发前置条件和事务提交。LLM 不直接覆盖最终 state，Reducer 不假装能做开放式语义理解。

## 2. 目标

1. 每一条稳定 raw message 都有 `signals` 或 `no_relevant_signal` 的 durable assessment；
2. 跨消息的 propose/accept/reject/complete/correct/forget/pattern evidence 可以累积，不因批边界丢失；
3. 所有专业 Proposer 在同一 boundary cycle / semantic evaluation 上读取同一 `asOfRevision`，避免跨 target 未来泄漏；
4. scan 进度、candidate 消费和 current memory 分成三个 authority，任何一个都不能冒充另一个；
5. 每条最终 memory 能追溯到 observation、occasion/arc 与原始 message/hash/quote；
6. waiting、excluded、already-reflected、retryable、dead-letter 都有显式终态或可恢复状态，不允许无理由 noop；
7. 在线处理与全量重建使用同一 `single_source_message_v1` boundary plan；不同 batch/debounce 只改变 wake/prefetch，不改变 Observer task/cycle 切分；
8. relative due date 以真实表达时间的消息为 anchor，scene 以事件时间维护 epoch 与字段 TTL；
9. correction/forget 能阻止错误或被遗忘 source 重新进入 active memory、RAG/Recall；自然演化保留历史；
10. 主聊天始终使用最后一次稳定 state，并准确暴露 degraded/rebuilding，而不是回退到旧全文摘要。

## 3. 非目标与部署假设

非目标：

- 不兼容 version 2 的 state/task/event/snapshot/target cursor；
- 不迁移旧 rolling/core 文本或旧 v2 proposal；
- 不把所有聊天历史都晋升为 memory；
- 不引入第二个通用 Verifier LLM；
- 不让 Reducer 用 embedding、NLI 或关键词规则做最终语义判断；
- 不声称 scanner 可以从架构上消灭所有 false negative；
- 首版不解决多实例并发，仍以单实例 per-scope lane + durable identity/transaction guard 为部署前提；
- 不把 session、turn、批大小、固定频率或消息间隔当作 memory 语义资格。

部署前提：

- 同一 `(userId,presetId)` 的 raw append、source mutation、scan、cycle reduce 与 housekeeping 串行；
- Provider/model 必须通过真实 structured-output schema preflight；
- batch/debounce 只优化 pending wake/raw prefetch；durable pending deadline 保证尾部不会无限等待且只能提前；
- section 容量、retry、retention 与 context 预算全部集中配置并由 harness 验证。

## 4. 总体架构

```text
chat_messages（raw authority）
        │ stable source boundary
        ▼
SourceScanCoordinator（纯代码）
        │ one semantic scan per singleton boundary
        ▼
semanticSignalObserver（LLM）
        │ assessment + arc/occasion + observations
        ▼
Observation Ledger（durable control plane）
        │ per-target ready/retryable candidates
        ▼
Boundary Cycle（同一 asOfRevision）
        │ relevant specialized Proposers only
        ▼
candidate decisions + patches
        │
        ▼
Reducer（纯代码）── event/snapshot/tombstone/decision 原子提交
        │
        ▼
memory_state.version=3 ── Renderer ── 主聊天 memory segment
```

### 4.1 SourceScanCoordinator

纯代码 coordinator 追加 singleton boundary plan、capture/promote durable pending，在 deadline 到达后为下一 boundary冻结 immutable scan task，组装 singleton delta + supporting context、调用 observer、校验 output，并在一个事务内落 assessment/arc/occasion/observation/target 行及 scan checkpoint。它不按关键词决定 memory，也不创建 patch。

完整提交的 user message 本身就是稳定 source；Coordinator 可以为让正常 assistant child共享一次 wake/raw prefetch而有界等待，但两条消息仍是两个 semantic boundaries。user-only 消息不得晚于 provisional 最大等待，失败/断开/flush 时提前处理。流式半条 assistant 不是稳定 source；导入历史按冻结边界处理。turn/session 元数据只证明 source 完整性或回复归属，不进入记忆语义。

### 4.2 semanticSignalObserver

Observer 是一次通用语义扫描，负责发现：scene 变化、一次性/持续承诺、接受/拒绝、完成/取消、episode arc、长期事实、模式证据、纠正与遗忘。它可以显式 append 到输入 catalog 中的 observation，但不能输出最终 item/section patch。

每条 new source message 必须有 assessment。相同 `semanticKey` 不是同一事实；只有显式 `relatedObservationId` 才能 append/supersede/invalidate。detector prompt/schema/routing config 形成 `detectorVersion`；版本变化必须新建 source generation 全量重建。

### 4.3 Observation Ledger

Observation 保存候选 claim、raw evidence、relation、occasion/arc、版本和 per-target lifecycle。它解决的不是“先把消息总结一下”，而是让多条证据跨 boundary 可累计、可重判、可解释。

一个 observation 可路由多个 target，但每个 target 独立处理：

```text
ready → processing → consumed
                   ↘ waiting
                   ↘ excluded
                   ↘ retryable → processing | dead_letter
```

新 evidence 使 observation version 增长时，relation×target 路由决定是否重新 `ready`。accept/reject/complete/cancel/correct/forget/contradict/arc-progress/arc-close 等 material change 必须重开受影响 target；完全重复的 support 可以保持原状态。

### 4.4 专业 Proposer

专业 Proposer 按记忆族分工，但不存在固定串行调用链。只有目标存在 ready/retryable candidate 时调用；episode 不是 profile/relationship 的中间摘要，worldFacts 也不会因“每批都必须跑”而填充临时内容。

每次 output 必须逐 observation 给出：

- `proposed`：达到写入阈值，并指向具体 patch；
- `waiting`：证据不足、等待接受/结果或模式门槛；
- `excluded`：目标不匹配、瞬时内容、错误推断、非 canon 等；
- `already_reflected`：当前 state 已由同一 projection identity/确定性 identity 表达。

Proposer 不能直接声称 `consumed`，也不能用 section noop 代替候选决定。

### 4.5 Reducer 与 Renderer

Reducer 只做可确定性验证与 apply。候选旧 evidence 必须已经登记在 observation registry，版本、target、boundary、hash、quote、role 与 suppression gate 全部有效；任意 overlap/read-only 历史不能直接触发写入。

Renderer 只读取 `memory_state.version=3` 的 effective view，不读取 observation claim、task/cursor 或 prompt。跨 section 去重只允许基于同一 `projectionIdentity`，不能靠文本相似或相同 semantic key 擅自删信息。

## 5. Boundary Cycle 与批不变量

每个 source boundary 先完成 scan commit，再创建一个 boundary cycle：

1. 执行 boundary 前的确定性 lifecycle；
2. 冻结 `asOfRevision`、`semanticNow` 和各 target observation version；
3. 为所有相关 target 从同一 snapshot 组装 envelope；
4. 可有限并发调用 Proposer，但必须先持久化全部 proposal；
5. 再按固定 target 顺序运行 Reducer。

同一 cycle 中，后运行 target 看不到前一个 target 刚生成的 state。跨其他 target revision 的 safe rebase 只有在本 target writable sections 与 as-of snapshot 完全相同、generation/cycle/observation version 不变时成立。

cycle immutable。同一 evaluation 的技术 retry 以同一 `cycleLineageId/reviewEpoch` 的 `retryEpoch+1` 新建 cycle，并继承 retry 0 的 visibility snapshot/as-of、source cutoff、semanticNow 与 candidate versions；否则 recovery target 会看到同-boundary已提交的其他 target state。后来 waiting stale、operator/dead-letter recheck 使用最新已封存 boundary 的新 cycle lineage/review epoch，冻结最新 as-of/current versions，不能冒充技术 retry。observation version变化由其 current boundary/review接管；无法对原 visibility snapshot safe rebase时 halt/rebuild。下一 boundary/evaluation 必须等待更早工作到达 completed/明确 halt。

批处理只影响调用次数，不影响语义结果。以下三种运行必须满足 metamorphic equivalence：

- 同 160 条消息分成 1 批；
- 分成多个在线 stable boundary；
- 从 raw source 全量重建。

允许 event/task ID 与调用次数不同；最终 active state、observation terminal state、suppression 终态和相对日期必须等价。

## 6. 记忆分层与写入标准

| section              | 用途                           | 主要成立条件                                                   |
| -------------------- | ------------------------------ | -------------------------------------------------------------- |
| `scene`              | 当前地点、时间、氛围、活动锚点 | 明确当前状态；epoch start/end；字段独立 TTL                    |
| `todos`              | 可完成、取消或过期的一次性事项 | 明确 request/commitment；完成/取消可跨消息关联                 |
| `standingAgreements` | 持续规则、边界、反复适用承诺   | 明确长期承诺或双方形成的互动规则；不能伪装成 todo              |
| `recentEpisodes`     | 最近有回忆价值的共同经历       | 已关闭且达到记忆价值门槛的 semantic arc                        |
| `milestones`         | 关系/剧情关键转折              | 明确重要性，不接收普通日常                                     |
| profile/relationship | 稳定显式档案或跨场合模式       | explicit 长期事实，或 3 occasions / 2 arcs 的 observed pattern |
| `worldFacts`         | 持久虚构 canon/世界规则        | 明确 canon；现实常识、临时场景和角色即兴动作不得填入           |

所有 open episode arc 都只留在 observation 层；即使已有高显著性中间结果，也必须等到 arc 明确关闭后才可投影。session 边界、单轮结束或固定时间间隔不能自动关闭 arc。

## 7. Evidence、身份与自然演化

最终 memory 的证据始终回到 raw message，不以 observation claim、episode summary 或 read-only memory 代替。每个 state evidence group 记录 observation IDs、occasion IDs、message/hash/quote、`evidenceKind` 与 `changeKind`。

`semanticKey` 只帮助检索；相同 key 不自动合并。item 更新依赖显式 item ID 与 observation root/projection identity。跨 section 合法多投影只有在每个 section 增加自己的语义时成立。

变化语义固定为：

- `establish`：首次建立；
- `reaffirm`：新证据重申，旧历史保留；
- `refine`：增加限定或提高准确性，旧历史保留；
- `supersede`：真实的新状态替代旧投影，旧历史仍可召回；
- `correct`：旧事实当时就是错误的，旧 source 被 suppress；
- `forget`：明确要求忘记，active state 与召回 source 被 suppress；
- `lifecycle`：真实完成、取消、过期、scene epoch/TTL 等确定性变化。

短回复证据按关系链解释。`好`、`好吃`、`OK` 可以作为某个已登记提议的接受/支持证据，但不能脱离实质提议独自建立长期事实。

## 8. 时间与重建

Todo relative date 以真正包含“明天/下周”等表达的 `timeAnchorMessageId.createdAt` 为 anchor，并使用 task 冻结的用户时区；不能以 worker 执行时间或更晚的接受消息为 anchor。

Scene 使用 epoch + 字段级 TTL。新 epoch start 会归档旧 epoch；显式 end 会归档并清空；单字段更新不延长其他字段。`previousScene` 每个 epoch 只保存一次完整 last-known snapshot。

重建按 **boundary-major + event-time** 运行：按 raw 时间线依次 scan/cycle/reduce，cycle 的 `semanticNow` 使用单调 `replayNow(boundary)`，即上一 boundary 时钟与本 boundary 新纳入消息最大有效 `createdAt` 的较大者。到最终 raw boundary 后，再以当前 wall clock 运行一次 housekeeping，使历史 todo 正确 overdue、scene 正确过期。

重建完成条件不是“所有 task status 都 succeeded”，而是：scan 到 captured boundary、cycle 全部完成、candidate 无 processing/retryable/dead-letter、state/snapshot 连续、projection 追平。正常 waiting 可保留并完成重建，但必须在 inspect 中可见。

## 9. 失败、健康与诊断

用户侧聚合为 `healthy | degraded | rebuilding`：

- waiting 不降级；它表示事实尚未成立；
- source scan retry/halt、cycle halt、candidate retryable/dead-letter、capacity blocked、state invalid、projection lag 导致 degraded/rebuilding；
- 某 target 故障保留其他 target 与最后稳定 state；source scan 全局 halt 阻止新候选调度；
- Provider/schema 错误、Reducer business reject、Reducer exception、transaction failure、unknown commit outcome 分开记录；
- 恢复通知只有在对应 scan/target/projection 真正追平后产生。

`inspect:memory-v2` 至少展示：scan cursor/boundary/detector version、逐消息 assessment、observation 版本与 raw evidence、arc/occasion、per-target status/reason、candidate decision、patch/reject、cycle/as-of/epoch、task worker/target/stage、state provenance 与健康诊断。

## 10. 开发期直接替换

切换 version 3 时：

1. 停止所有 Memory worker，并验证没有 running task；
2. 保留 raw `chat_messages`；
3. 删除旧 v2 current state、snapshot/event/task/status/ops、suppression、projection checkpoint、diagnostic，以及新旧 observation 控制面中的派生行；
4. 以 [状态契约](state-contract.md) 的 fresh schema 创建空 version 3 authority；
5. 从 raw source 全量 rebuild 到 captured boundary，运行 final wall-clock housekeeping 与 projection drain；
6. 只有验收通过后启用在线 writer/Renderer。

没有旧 schema reader、backfill、双写、shadow compatibility 或旧 proposal replay。rehearsal 可以在隔离数据库执行，但它验证的是 version 3 从 raw 重建，不是旧派生状态迁移。

## 11. 顶层决策表

| 决策                | 结果                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| current authority   | `memory_state.version=3`                                                                 |
| raw scan            | 每个完整有效 source message 的 immutable semantic boundary 一次 `semanticSignalObserver` |
| candidate authority | durable observation + per-target lifecycle                                               |
| target 调用         | 只调用有 ready/retryable candidate 的专业 Proposer                                       |
| snapshot 可见性     | 同一 boundary cycle 共享 `asOfRevision`                                                  |
| raw scan 进度       | global source scan checkpoint；无 per-target raw cursor                                  |
| evidence 新鲜度     | observation registry + version/boundary/hash；不要求 task new-batch evidence             |
| 模式晋升            | 3 distinct occasions、2 distinct arcs                                                    |
| scene               | epoch + 字段级 TTL + 每 epoch 一次完整 previous snapshot                                 |
| rebuild             | boundary-major、event-time；末尾 wall-clock housekeeping                                 |
| 兼容                | 开发期 destructive replace，无 version 2 兼容                                            |

## 12. 成功标准

- Alice 对话中的早餐/点心承诺能区分一次性 todo 与持续 agreement，并在接受、履约或取消后正确演化；
- `好吃` 等短回复不再因固定三字符规则丢掉接受链，但不能独立制造事实；
- `明天` 使用原消息时间，不因几个月后重建而立即生成错误期限；
- scene 不因历史重建使用当前时钟而在写入瞬间消失，也不因更新 mood 给 location 续期；
- 同一原始消息在不同 batch/debounce 下产生相同 boundary rows、Observer envelopes与逐 boundary顺序，不会产生根本不同的 profile/relationship/worldFacts；
- Reducer reject 不会与 cursor 推进一起静默丢失候选；
- 每条记忆可以从 item → evidenceGroup → observation/occasion/arc → raw message 完整解释；
- correction/forget 后，active memory、rebuild、RAG/Recall 都不会重新暴露被 suppress 的旧 source；
- inspect 能明确回答“没扫描、没识别、在等待、被排除、提案失败、Reducer 拒绝还是事务失败”。
