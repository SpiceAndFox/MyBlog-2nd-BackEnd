# Memory Control v2 Proposer Prompt 契约

本文定义 Memory Proposer 的职责、输入边界、决策结果和预期行为。Proposer 只做语义观察并提出候选 patch；输出结构由 strict schema 约束，最终校验与写入由 Reducer 完成。

静态数据结构以 [state-contract.md](state-contract.md) 为权威，执行与失败语义以 [write-protocol.md](write-protocol.md) 和 [算法契约](algorithms/README.md) 为权威；本文是 Proposer 行为契约的顶层入口。

## 1. Prompt 管理

运行时 prompt 位于 [`modules/memory/prompts`](../../modules/memory/prompts)，由 [`index.js`](../../modules/memory/prompts/index.js) 按 Proposer 名称加载，不能写死在 service 或 provider adapter 中。

| Proposer                      | 文件                               | target sections                                   |
| ----------------------------- | ---------------------------------- | ------------------------------------------------- |
| `currentStateProposer`        | `current-state-proposer.md`        | `scene`                                           |
| `todoProposer`                | `todo-proposer.md`                 | `todos`                                           |
| `agreementProposer`           | `agreement-proposer.md`            | `standingAgreements`                              |
| `episodeProposer`             | `episode-proposer.md`              | `recentEpisodes`, `milestones`                    |
| `profileRelationshipProposer` | `profile-relationship-proposer.md` | `userProfile`, `assistantProfile`, `relationship` |
| `worldFactProposer`           | `world-fact-proposer.md`           | `worldFacts`                                      |
| `compactionProposer`          | `compaction-proposer.md`           | 单个维护目标 section                              |

运行时 `.md` 文件是具体模型指令的唯一来源，并实现本文规定的行为契约。模型行为发生变化时，本文、对应 prompt 和验收用例必须保持一致。

## 2. Proposer Prompt 设计

### 2.1 Schema-Constrained Output

每个 Proposer 必须通过 provider 原生 JSON Schema、tool 或 function structured output 返回结果；禁止把裸文本加 `JSON.parse` 作为主路径。

职责分离：

- strict output schema：字段、枚举、必填项、目标 section 和 op 范围。
- system prompt：schema 无法表达的语义准入、去重、纠错、日期理解和判定边界。
- Provider Adapter：协议差异、传输 schema 编译和 wire 格式归一化。
- Reducer：本地完整 schema、作用域、证据、policy、容量与并发前置条件的最终校验。

Provider 端通过 schema 不代表业务有效；返回值仍须经过本地完整校验。真实 preflight 必须加载全部 normal Proposer schema 与 compaction schema。

scene 的 Provider wire 使用单个 `evidenceRef`，Adapter 在本地业务校验前归一化为 `evidenceRefs: [ref]`。这是传输兼容细节，不应扩散成第二套业务契约。

### 2.2 输入与决策契约

- 将 `task.tickId` 原样复制到输出；`proposer` 与当前调用一致；`sectionResults` 恰好覆盖目标 sections。
- normal section 的结果是 `patches | noop | unable_to_decide`；`patches` 必须含非空 patch 数组。compaction section 使用 `patches | unable_to_compact`。
- `id <= cursorBefore` 是 overlap；`cursorBefore < id <= targetMessageId` 是 new batch。patch 必须由 new batch 触发，且至少一条 evidence 来自 new batch。
- `writableState` 是可写权威基线；同义内容不重复 add。`readOnlyContext` 与 overlap 只辅助理解，不能单独证明新事实；itemId 只能来自 writableState。
- `noop` 表示已理解并确认无需变更；`unable_to_decide` 只表示信息不足、指代冲突或无法定位 item。证据不足以达到长期模式门槛时是 `noop`，不是 `unable_to_decide`。
- 对 new batch 中所有已经能够确定的目标变更给出 patch，不因猜测输出长度而省略；多个独立变更分别表达。
- 同一 section 同时存在确定与不确定候选时，先输出全部确定 patches；只有没有可确定 patch 且关键候选无法判断时才用 `unable_to_decide`。
- 普通 patch 使用非空 `evidenceRefs`；messageId 来自 `observedMessages`，quote 是直接支持 patch 的最短连续原文，归一化后至少 3 个信息字符，最多 200 Unicode code points。带 role 前缀的 evidenceKind 必须匹配真实 role。
- 忘记、完成、取消、失效必须使用专用 op，不能把 text 改成“已处理/已作废”。
- 排除项只形成当前 target 的 `noop`，不能令 Proposer 输出非目标 section；其他 target 独立观察同一批消息。
- value.text 简洁保留主体、对象、条件、范围、否定与例外；不写事件流水账，不加入 evidence 未表达的推断。
- 敏感或成人内容只客观概括记忆本质；quote 仍保持原文，不做净化改写。

### 2.3 各 Proposer 的语义边界

#### currentStateProposer

- scene 只保存下一轮仍有用的当前 `location/time/mood/note`，不是事件日志或人物档案。
- 明确的新当前值用 `setField`；旧值被明确证明失效且无替代值才用 `clearField`。未再次提到不能 clear。
- 计划、提议、疑问和假设不是已发生状态；`createdAt` 不是剧情时间。
- 多字段变化分别输出 patch；每个 scene patch 只有一个 evidenceRef。

#### todoProposer

- todos 只记录明确、一次性、可完成/取消/失效的请求、承诺或共同计划。愿望、普通问答和反复适用的规则应 noop。
- `actor` 是实际执行者，`requester` 是事项发起方；共同计划的 actor 为 `both`，requester 为实际提出方。add value 必含 `text, actor, requester`；update value 必含 `dueChange`。
- 同一句话若同时形成两个可独立完成的事项（如行动承诺与提醒请求），应分别建立 todo。
- active item 可 complete/cancel/expire；可见 overdue item 只能 complete/cancel，不能再次 expire。`status` 与 `becameOverdueAt` 由 Reducer 管理，Proposer 不得输出或修改。
- overdue 只提供最近 N 条。改期可见 overdue item 使用 `updateItem + dueChange.mode=set`；目标旧 item 不可见时 `unable_to_decide`，不得猜 itemId 或 add 替代。
- `completeTodo` 可由明确完成宣告，也可由行动结果、交付、使用或验收共同证明。Wall-clock 到期不输出 `expireTodo`。
- absolute dueAt 只有在年月日都能从 observedMessages 唯一确定时使用。relative 恰好一个单位：`days >= 0`、`months/years >= 1`；今天为 `days=0`。
- 承接回答继承其明确回应的相邻日期；不得用 `task.now` 或 `createdAt` 补全不完整日期。

#### agreementProposer

- standingAgreements 只记录未来反复适用的互动规则、边界或带明确承诺语义的长期承诺。
- 一次性事项、个人偏好、关系描述和单纯抒情应 noop；明确取消使用 `cancelAgreement`。

#### episodeProposer

- recentEpisodes 是稀疏的高显著度互动弧，不是逐轮摘要、聊天日志或动作时间线。
- 按场景、主题、目标与因果连续性聚合；一个完整互动弧最多一个 item，同一弧的新结果优先 update。
- 只有重要结果/未决问题、重要边界或冲突变化、持续关系动态、独特共同经历才进入 recentEpisodes。每 task 通常 0–2 个 patch，硬上限 3。
- 事件中途且尚无稳定结果或必须延续状态时 noop，不建“进行中”占位。
- milestones 只记录改变长期关系/剧情基线的转折；强烈情绪或单次温馨互动不成立。
- milestone 与 recentEpisode 不默认双写。

#### profileRelationshipProposer

- 三个 section 只保存跨场景仍成立并会改变未来回应的事实；一次行为不能推出技能、人格、动机或关系模式。
- User 与 Assistant 的真实消息都可支持三个 section；section 由事实主体和语义决定，不由消息 role 机械决定。
- `explicit` 必须直接断言长期事实；当下动作或感受不是 explicit 长期事实。
- `observedPattern` 至少 3 个不同 messageId、至少 2 个独立互动片段、主体与 section 一致，并含 new-batch evidence。相邻提议→回应或同一事件的连续动作只算一个片段。
- 模式证据未达门槛时 noop。只描述可观察模式，不做心理诊断或敏感属性推断。
- add/update value 完整包含 `text, facet, canonicalKey, factBasis`。非 multi-value canonicalKey 已存在时只能 update/noop。
- facet 表示事实类别；canonicalKey 使用最具体、会稳定影响未来回应的语义槽，只有没有合适槽位才使用 `open`。个人偏好/边界属于对应 Profile；未来行为约定不写入 relationship。
- 一次模型错误、偶发行为或用户要求修复的坏习惯不能被固化为 assistantProfile 人格。
- relationship 只记录双方共同成立的状态、称呼、边界或稳定互动结构；单方愿望和临时安排不成立。

#### worldFactProposer

- worldFacts 只保存对话世界中持续成立、后续必须一致的客观规则或设定。
- User 与 Assistant 的真实消息都可支持新增、修正或遗忘；带 role 前缀的 evidenceKind 仍按真实发言方选择。
- 普通常识、临时场景、观点、猜测、传闻、梦境、比喻、玩笑、人物属性与互动约定应 noop。
- Assistant 的推测或装饰性扩写不能成为 canon；只有确定建立或得到明确确认的规则才可新增。
- 同义设定不重复 add；与基线冲突但没有明确 correction 时也不能直接 add。

### 2.4 Compaction Proposer

compactionProposer 服务长度预算恢复和 high-water hygiene；两种模式都先执行确定性 exact-text merge，再按同一安全标准处理剩余 source items。它只依据单个目标 section 做无损去重，不读取 raw messages。

- 只能输出 `mergeItems` 或 `unable_to_compact`；evidenceKind 固定为 `memory_compaction`，不输出 evidenceRefs。
- itemIds 至少两个且全部来自目标 writableState；value 只含合并后的 text。
- 同一输出中的多个 merge patch 不得复用 itemId；合并 text 必须短于 source texts 的字符总和。
- “相关/兼容”不等于重复。合并不能新增推断、调和冲突，或丢失否定、主体、时间、条件、范围和例外。
- todos 只合并 actor、requester、dueAt 分别相同的 active items；overdue 不参与。
- typed profile/relationship items 只有 facet 与 canonicalKey 分别相同时才可能合并。
- milestones 不跨阶段合并；standingAgreements/worldFacts 只合并同一规则的重复表达。
- recentEpisodes 不参与 compaction，直接返回 `unable_to_compact`。

### 2.5 User Payload

调用保持 `system prompt + 当前 task envelope user message`。user payload 直接使用 [state-contract.md](state-contract.md) §5 定义的 normal 或 maintenance envelope，不拼入另一份自然语言说明。

默认不注入独立 user/assistant few-shot。输出形状由 schema 保证，语义边界由 Proposer 行为契约、Reducer 与 Harness 共同约束。运行时 few-shot 仍属于[延后设计](../deferred/memory-control-v2/proposer-few-shot-golden-messages.md)，没有 A/B 证据前不预留额外传输接口。

## 3. op、evidenceKind 与特殊字段

下表定义各 Proposer 的输出权限；[state-contract.md](state-contract.md) §3–§5 是字段级完整权威。

| Proposer / section     | op                       | 合法 evidenceKind                                                              |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| scene                  | `setField`, `clearField` | `scene_change`, `user_correction`, `assistant_correction`                      |
| todos                  | `addItem`                | `user_request`, `user_commitment`, `assistant_request`, `assistant_commitment` |
| todos                  | `updateItem`             | 上述四种 + `user_correction`, `assistant_correction`                           |
| todos                  | `completeTodo`           | `todo_completion`                                                              |
| todos                  | `cancelTodo`             | `todo_cancel`, `user_correction`, `assistant_correction`                       |
| todos                  | `expireTodo`             | `todo_expiration`                                                              |
| standingAgreements     | `addItem`                | `standing_agreement`                                                           |
| standingAgreements     | `updateItem`             | `standing_agreement`, `user_correction`, `assistant_correction`                |
| standingAgreements     | `cancelAgreement`        | `agreement_cancel`, `user_correction`, `assistant_correction`                  |
| recentEpisodes         | `addItem`                | `recent_episode`                                                               |
| recentEpisodes         | `updateItem`             | `recent_episode`, `user_correction`, `assistant_correction`                    |
| milestones             | `addItem`                | `relationship_milestone`                                                       |
| milestones             | `updateItem`             | `user_correction`, `assistant_correction`                                      |
| profile / relationship | `addItem`                | `long_term_fact`                                                               |
| profile / relationship | `updateItem`             | `user_correction`, `assistant_correction`                                      |
| profile / relationship | `forgetItem`             | `user_forget`, `assistant_forget`                                              |
| worldFacts             | `addItem`                | `long_term_fact`                                                               |
| worldFacts             | `updateItem`             | `user_correction`, `assistant_correction`                                      |
| worldFacts             | `forgetItem`             | `user_forget`, `assistant_forget`                                              |
| compaction             | `mergeItems`             | `memory_compaction`                                                            |

结构上的特殊约束：

- scene Provider wire 使用 `evidenceRef`，其他普通 patch 使用 `evidenceRefs`。
- terminal op、`forgetItem`、`clearField` 不输出 value。
- todos add value 必含 actor/requester；todos update value 必含 dueChange。
- profile/relationship add/update value 必须完整包含 typed metadata。
- mergeItems 使用 itemIds，不输出 evidenceRefs。

---
