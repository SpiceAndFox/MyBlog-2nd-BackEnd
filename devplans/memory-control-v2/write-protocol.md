# Memory Control v2.1 写入协议

本文只定义组件职责和编排顺序。数据 shape、枚举与 DDL 以 [状态契约](state-contract.md) 为准；确定性状态机以 [算法契约索引](algorithms/README.md) 为准。当前为开发期直接替换，不保留 version 2 lag/cursor/new-batch pipeline。

## 1. 组件与职责

### 1.1 SourceScanCoordinator（纯代码）

`SourceScanCoordinator` 负责机械工作：

1. 确定稳定 source boundary；
2. 追加 singleton semantic-boundary plan、capture/promote durable pending tail，并在 deadline 到达后创建、恢复和去重 immutable source-scan task；
3. 组装 singleton scan delta、supporting context、open observation/arc/occasion catalogs；
4. 调用 `semanticSignalObserver`；
5. 校验逐消息 assessment、raw evidence、scope/hash/boundary 和 observation/arc/occasion 引用；
6. 在一个事务内持久化 scan assessment、arc、occasion、observation、evidence、per-target 行并推进 scan checkpoint；
7. 运行 pre-cycle lifecycle；只有存在 runnable candidate 时才为本 boundary 创建 `boundary cycle` 并调度专业 Proposer，无候选时持久 ledger终局。

它不做自然语言语义判断，不按关键词直接决定最终 Memory，也不把 scan cursor 当作候选已消费的证明。

### 1.2 semanticSignalObserver（LLM）

`semanticSignalObserver` 对每条稳定 raw message 做信号检查，输出 observation/arc/occasion actions 与逐消息 assessment。它是唯一的通用语义路由调用，但不是最终 Memory writer：

- 可以识别候选事实、承诺、接受/拒绝、完成、纠正、遗忘、scene 变化、episode arc 和模式证据；
- 可以把新证据 append 到输入 catalog 中的 observation/arc/occasion；
- 不能输出 section patch、itemId、最终 profile/relationship 结论或 Renderer 文本；
- false negative 不能由架构绝对消除，因此 detector 必须有版本、golden/metamorphic 验收和全量重建能力。

`semanticSignalObserver` 的输出 shape 见状态契约 §3，算法见 [Source Scan 与 Observation](algorithms/source-scan-and-observation.md)。

### 1.3 专业 Proposer（LLM）

正式 target 与 Proposer 固定映射：

| targetKey | Proposer | writable sections |
| --- | --- | --- |
| `scene` | `currentStateProposer` | `scene` |
| `todos` | `todoProposer` | `todos` |
| `standingAgreements` | `agreementProposer` | `standingAgreements` |
| `episodes` | `episodeProposer` | `recentEpisodes`, `milestones` |
| `profileRelationship` | `profileRelationshipProposer` | `userProfile`, `assistantProfile`, `relationship` |
| `worldFacts` | `worldFactProposer` | `worldFacts` |

专业 Proposer 只由 observation-target `ready` 或到期的 `retryable` 行触发。输入必须使用 boundary cycle 的共同 as-of snapshot，并包含候选引用的全部 raw evidence、必要支持上下文、相关 writable items 和只读背景。它必须：

- 输出完整 target sections；
- 用 `candidateDecisions` 精确覆盖输入 observations；
- 让每个 proposed candidate 被至少一个带 `observationIds` 的 patch 引用；
- 区分 waiting、excluded、already-reflected，不得用无理由 noop 丢弃候选；
- 只把 observation 当定位/累计账本，最终 evidence 仍引用 raw message。

专业 Proposer 彼此没有调用依赖。episode 输出不是 profile/relationship 的前置事实源；同 cycle 后运行的 target 也看不到前一个 target 刚生成的派生 state。

### 1.4 Reducer（纯代码）

Reducer 是最终写入权威，只负责：

- schema、target/section/op/changeKind/policy；
- observation ID、version、target assignment 与 candidate decision 完整性；
- message ID、scope、generation、source boundary、content hash、role 与 quote；
- item identity、todo/scene/episode 生命周期、结构化 duplicate gate；
- pattern 的 distinct occasion/arc 门槛；
- 容量、revision、cycle/as-of/rebase、task phase 与事务边界；
- event/snapshot、candidate decision、observation-target、tombstone 的原子提交。

Reducer 不做开放式 NLU、语义相似度匹配或 evidence 蕴含证明。`semanticKey` 相同不能由 Reducer 自动合并事实。

### 1.5 Renderer（纯代码）

Renderer 只读取结构化 `memory_state.version=3` 的 effective view。它不读取 scan task、observation claim、candidate status、cursor 或 prompt 文本。自然语言组织、标题、字段标签和基于同一 `projectionIdentity` 的安全去重由 Renderer 完成。

## 2. 在线写入顺序

每个 `(userId,presetId)` 的 source append、scan、boundary cycle、Reducer、housekeeping、source mutation 共用同一串行 scope lane。Provider 调用可以在 cycle 内有限并发，但所有持久状态转移受 durable task/cycle identity 和数据库事务约束。

一次稳定 boundary 的顺序固定为：

```text
raw source 稳定提交
  → durable pending tail + singleton semantic-boundary plan
  → deadline/trigger 到达后冻结下一 durable immutable source-scan task
  → semanticSignalObserver
  → 持久 scan assessment / arc / observation / target rows
  → 若有 runnable candidate：固化 boundary cycle + asOfRevision
  → 为相关 targets 同时冻结 envelope
  → 收集并持久化所有 proposal
  → 固定 target 顺序执行 Reducer
  → candidate lifecycle + event/snapshot/tombstone 原子提交
  → cycle completed（无 candidate 则在 ledger commit 后结束）
  → 才允许下一 boundary cycle
```

scan commit 与 pre-cycle lifecycle 后若没有任何 ready/retryable candidate，不创建空 boundary cycle或专业 Proposer task；逐消息 assessment/ledger 已是该 boundary 的 durable no-candidate 证明。世界事实等模块为空是正常结果。

## 3. 稳定 boundary、批处理与尾部

稳定 source 是已经完整提交的 raw message，不含流式半条 assistant 内容。scan status 的 stable max 与 pending endpoint 可以一次跨越多条消息，但 canonical `single_source_message_v1` plan 固定每条完整有效 source 一个 immutable semantic boundary/Observer task。导入、重建、user-only 与完整 user/assistant 对话都使用同一规则。

Coordinator 可以为等待正常 assistant 回复延迟 user boundary 的实际执行，但不得晚于 `provisionalUserMaxDelayMs`；assistant 到达只提升 pending endpoint并共享 wake/raw prefetch，两条消息仍逐 boundary处理。assistant 失败/断开或显式 flush 时应提前 deadline。`turnId/parent_user_message_id` 仅用于确认回复归属、去重和排障，不进入 boundary或记忆语义。

`batchMaxMessages/debounceMs` 只合并 wake/raw I/O 预取；canonical plan 固定每条完整有效 source 一个 semantic boundary。尾部先写 durable pending row，`tailMaxDelayMs` 是不可无限延后的 freeze deadline 上界：pending endpoint 只能提升、deadline 只能提前；到期后才为最早 boundary 冻结 immutable task。不能只靠进程内 timer或预建一个可扩张的 not-before task，服务重启必须从 pending row、boundary plan和已冻结 task分别恢复。

普通 trigger：

- pending freeze reason：`debounce | batch_target | provisional_user_deadline | tail_deadline | assistant_complete | flush | drain | recovery | rebuild`；历史复查另使用 `scanMode=late_discovery` 并逐既有 boundary 建 task；
- target normal：`candidateReady | candidateRetry`；
- maintenance：`lengthBudget | hygiene`。

version 3 没有 `lagThreshold` 语义门，也没有 per-target raw cursor。

## 4. Observation 路由与成立条件

默认路由：

| 语义 | target |
| --- | --- |
| 当前地点/活动/参与者/氛围变化 | `scene` |
| 一次性请求、承诺、完成、取消 | `todos` |
| 反复适用规则、边界、习惯性承诺 | `standingAgreements` |
| 有长期回忆价值的共同经历/转折 | `episodes` |
| 稳定显式档案或跨场合模式 | `profileRelationship` |
| 持久虚构 canon/世界规则 | `worldFacts` |

一个 observation 可以分配多个 target，但每个 target 拥有独立 consumption 行。每个投影必须增加该 section 独有语义；Renderer 只按共享 `projectionIdentity` 去掉重复表达，不阻止合法的多投影。

成立条件按类型区分，不能统一要求双方接受：

- 明确 user request、用户自我承诺、明确个人边界可以由单条直接证据成立；
- assistant 提议或共同计划可先 waiting，后续接受/拒绝 append 到同一 observation；
- 明确单方长期承诺可成立，另一方接受用于加强或消歧，不是机械必填；
- 从行为推断的 profile/relationship 模式至少需要 3 个独立 occasion，且跨至少 2 个 semantic arc；
- 所有 open episode arc 留在 observation 层；只有明确关闭后才交 episode Proposer 判断是否值得写入；
- 无 canon 的现实/临时场景不能为了填充 worldFacts 而写入。

## 5. 证据与自然演化

所有最终 patch evidence 必须回到 raw message。候选旧证据只在以下条件全部满足时合法：

1. message 已持久登记在 patch 所列 observation 的 evidence 行；
2. observation version 与 task 冻结版本一致；
3. observation-target 属于当前 target；
4. message 未超过 cycle source boundary，且未被 suppression/privacy gate 移除；
5. quote/hash/role/scope 校验通过。

未登记 observation 的 overlap、readOnlyContext、已有 episode/profile summary 不能证明新事实。late discovery 必须创建独立、可审计 observation。

长期状态变化使用 `changeKind`：

- `establish`：首次建立；
- `reaffirm`：追加支持证据，不强制改 text；
- `refine`：增加限定或提高准确性；
- `supersede`：真实的新稳定状态替代旧投影；
- `correct`：旧投影源自错误事实；只有此类更新 suppress 被替换来源；
- `forget`：明确遗忘/撤销；
- `lifecycle`：todo/scene/episode 的确定性状态变化。

自然演化不能伪装成 correction，否则会错误删除 RAG/Recall 中当时真实的历史。

## 6. Candidate decision、Reducer rejection 与重试

Proposer decision 只是建议；最终 observation-target 状态由事务结果决定：

| Proposer/Reducer 结果 | target 状态 |
| --- | --- |
| proposed 且所有关联必要 patch accepted | `consumed` |
| already_reflected 且确定性 identity/现状态检查通过 | `consumed` |
| waiting | `waiting`；observation version 增加前不重复调用 |
| excluded | `excluded` |
| capacity deferred | 保持 `processing`，进入 maintenance/replay |
| 可修复 schema/quote/ref/item/state 错误 | `retryable`，受限修复重试 |
| duplicate 与已有 projection 确实等价 | `consumed: already_reflected` |
| policy/target contract 违反 | `retryable`；耗尽后 `dead_letter` |
| retry budget 耗尽 | `dead_letter`，target degraded/halted |

不得把所有 rejected 都永久重试，也不得把所有 rejected 都当语义成功。分类权威见 [Reducer Apply](algorithms/reducer-application.md)。task `succeeded` 只表示该 workflow 已终结；只有 scan 已覆盖、无 processing/retryable/dead-letter、且所有候选都有显式 lifecycle 结果时，系统才可报告语义 healthy。正常 waiting 本身不 degraded，但必须在 inspect 中可见。

## 7. Revision、cycle 与 compaction

同 cycle target proposals 使用同一个 `asOfRevision`。proposal 全部持久化后按固定 target 顺序 apply。由于正式 targets 的 writable sections 不重叠，后提交 target 可以在以下条件全部满足时跨其它 target 的 revision rebase：

- source generation、cycle、observation versions 不变；
- 当前 target sections 与 as-of snapshot 深度相等；
- 没有 housekeeping/source mutation 插入 cycle；
- proposal 未读取未来 raw/source boundary。

任一条件失败时，整个未完成 cycle 进入 retry/halt；不能偷偷用最新 state 重跑某个 target 并让它看到同 cycle 的未来派生结果。

容量 deferred 继续使用 maintenance task 和 original proposal replay，但 replay 还必须复核 observation version/target status/cycle。compaction 只能合并既有同 section items，继承 evidence/projection identity，不产生 observation 或新事实。

## 8. Source rebuild

重建是 boundary-major/event-time 的时间线重放，而不是逐 target 扫完整段历史。开发期切换直接清空 v2 派生表、创建 version 3 generation，从 raw messages 开始：

1. 按 source 时间和稳定 boundary 顺序运行与在线相同的 scan/cycle/Reducer；
2. 每个 cycle 的 `semanticNow` 使用 [Source Rebuild 与 Projection](algorithms/source-rebuild-and-projection.md) §3.3 的单调 `replayNow(boundary)`；相对日期使用包含时间表达的 `timeAnchorMessageId` 和冻结用户时区；
3. 同一 boundary cycle / semantic evaluation 的 targets 共享 as-of snapshot；不能读取未来 state；
4. 到最终 raw boundary 且候选均为 consumed/excluded/waiting 后，单独以当前 wall clock 运行一次确定性 housekeeping，使未完成 todo 正确 overdue、scene 正确到期；
5. scan retryable/dead-letter、candidate retryable/dead-letter、未完成 cycle 或 projection 未追平时不得报告完成。

waiting 候选是明确业务状态，可以随重建完成保留；它不等于静默缺口。算法见 [Source Rebuild 与 Projection](algorithms/source-rebuild-and-projection.md)。

## 9. Source mutation、forget 与隐私

消息编辑、删除、恢复、归属/可见性/排序变化进入同一 scope lane并提升 `sourceGeneration`。普通 append 不提升 generation。generation 变化使旧 scan/cycle/observation-target/task 失效，并从剩余 raw source 重建；旧派生行按 retention/privacy 规则清理。

`correct`/`forget` 的 active-state、event/snapshot、candidate decision 和 suppression tombstone 必须原子提交。Privacy hard delete 必须物理清除 raw source 及 task payload、observation claim/quote/evidence、scan assessment/event、semantic arc/occasion、cycle、candidate decision、Memory history、RAG/Recall 和受控 debug 中的对应内容，再从剩余 source 重建。详细算法见 [Suppression、Hard Delete 与 Retention](algorithms/suppression-and-retention.md)。

## 10. 健康、诊断与指标

用户侧仍聚合为 `healthy | degraded | rebuilding`：

- source scan halted/retry、cycle halted、candidate retryable/dead-letter、capacity blocked、state 无效或 projection lag → degraded/rebuilding；
- `waiting` 候选只在内部/inspect 展示，不单独降级；超过领域配置的最大合理等待年龄时可产生 `candidate_stale_waiting` 诊断，但仍不得自动编造结论；
- 一个 target 故障不删除其它 target 的稳定 state，source scan 全局 halt 则阻止所有新 target 调度；
- 恢复通知只有在对应 scan/target/projection 真正追平并清除失败候选后生成。

必须观测：scan calls/tokens/latency、逐消息 assessment、signals/no-signal、observation create/append、ready/waiting/consumed/excluded/retryable/dead-letter、target calls/tokens/patches、Reducer reject reason、late discovery、跨窗口补全、pattern 晋升、cycle duration、tail age、online/rebuild metamorphic 结果。

## 11. 集中配置

除原有 section 容量、quote、Provider、retry、retention、health 与 projection 配置外，必须显式配置状态契约 §7.2 的 source scan、observation、pattern 和 boundary-cycle 参数。`detectorVersion` 必须等于 observer prompt + output schema + routing config 的内容 hash；`contractVersion` 必须覆盖专业 Proposer/schema、policy、target order 与 lifecycle 的语义版本；不一致时拒绝启服。会改变既有历史 projection 资格的版本变化必须新 source generation rebuild。

任何配置都不能把 batch/session/turn 变成语义资格门。运行费用由 Provider 官方统计评估，不作为跳过尾部或候选的理由。
