# Memory Control v2.1 Proposer Prompt 契约

本文定义产品 Memory v2.1（持久状态 `schemaVersion=3`）的 `semanticSignalObserver` 与各专业 Proposer 的 schema-constrained structured output 约束和 prompt 要点。Observer 只登记可追溯的语义候选；Proposer 只能对候选作决定并提出 patch，二者都不能直接写入最终 memory。最终校验与写入由 [write-protocol.md](write-protocol.md) 中的 Reducer 完成。开发期不保留 v2 envelope、output 或 fixture 兼容层：非 v3 task/state 或不符合 v3 output schema 的结果必须显式拒绝，旧派生状态清空后只从 raw messages 重建。

## 1. Prompt 管理

Memory worker prompt 必须从仓库真实目录 `modules/memory/prompts/*` 读取，不能写死在 service 文件中。现有专业 Proposer/Compaction prompt 已位于该目录；Observer 的目标文件为 `modules/memory/prompts/semantic-signal-observer.md`，当前尚需新增，接入前不得回退到 service 内联 prompt 或虚构另一套路径。

v2.1 至少拆出以下 prompt：

- `semantic-signal-observer.md`（目标路径，待新增）
- `current-state-proposer.md`
- `todo-proposer.md`
- `agreement-proposer.md`
- `episode-proposer.md`
- `profile-relationship-proposer.md`
- `world-fact-proposer.md`
- `compaction-proposer.md`

## 2. Proposer Prompt 设计

### 2.1 Schema-Constrained Output

`semanticSignalObserver` 和每个专用 Proposer 的输出都必须通过 provider 支持的 schema-constrained structured output 强制（实现可以是 function/tool calling 或 JSON schema response format，由 provider adapter 决定；禁止裸 prompt + `JSON.parse` 作为主路径）。专业 Proposer 保留 `sectionResults` 作为 patch 容器，同时必须输出覆盖输入候选的 `candidateDecisions`；Observer 使用独立 observation schema，不能复用 patch schema。

Provider adapter 可以针对受限 JSON Schema 方言编译等价的传输 schema，但不得改变业务输出契约；Provider 未强制的约束仍须由本地完整 schema 校验。DeepSeek strict-tools 的 Memory 调用默认关闭 thinking，并强制调用唯一输出 tool；其传输 schema 必须为 enum/const 补显式 primitive `type`，并保证 `anyOf` 的直接分支带 `type` 或 `$ref`，详细编译约束见 [state-contract.md](state-contract.md) §8。真实 preflight 必须加载 Observer、全部专业 Proposer 与 Compaction schema，不能用简单 `{ok:true}` 代替。

schema 作者注意：

- `semanticSignalObserver` 的 schema 只允许输出 observation 的新增、补证、冲突或关闭建议，以及本次扫描覆盖结论；不得出现 memory section value、patch op、itemId 或最终展示摘要。最小业务字段见 §2.6。
- 输出中的 `proposer` 字段必须等于当前调用的 Proposer 名称。
- 专业 Proposer 的每个普通 patch 及 scene `epochTransition` lifecycle operation 都必须有本 output 内唯一 `patchId`，并用 `observationIds` 关联至少一个输入 observation；每个输入 observation 对当前 target 都必须有且仅有一条 `candidateDecisions` 记录，decision 的 `patchIds` 与全部 operations 必须双向一致。`outcome/reasonCode` 条件规则见 §2.7；Proposer 不得自行宣称 observation 已 consumed，只有 Reducer 的最终结果能推进候选生命周期。
- `currentStateProposer.sectionResults.scene` 可选携带 `epochTransition: { patchId, action: "start" | "end", evidenceKind: "scene_change", changeKind: "lifecycle", evidenceRef, observationIds }`。它是与普通 patch 同级参与 candidate atomic unit 的 lifecycle operation；evidence/observation 使用普通 raw evidence 规则且不可省略，不得增加 session/turn 字段或用 session 元数据证明 transition。
- `path`、`itemId`、`itemIds` 的必填规则（[state-contract.md](state-contract.md) §4）需要用 `oneOf` 或条件 required 表达：只有 `scene.setField`/`scene.clearField` 要求 `path`；`updateItem`/`retractItem`/`forgetItem`/`completeTodo`/`cancelTodo`/`expireTodo`/`cancelAgreement` 要求 `itemId`；`mergeItems` 要求 `itemIds`（数组）。所有 item section 由 `sectionResults` key 直接寻址，不使用 `path`。
- `todos.addItem.value` 必须含 `text/actor/requester`，期限放在 patch 顶层 `dueChange` 而非预渲染 text；add 只允许省略 dueChange 或使用 `set + dueAt`，不接受 keep/clear。`todos.updateItem` 同样使用顶层 `dueChange`，并以 `oneOf` 严格表达 `keep`、`clear`、`set + dueAt`。relative set 还必须带真正承载时间表达的非空 `timeAnchorMessageId`，absolute set 固定为 null；relative anchor message 必须属于 patch observation evidence。字段规则见 [state-contract.md](state-contract.md) §4.3。
- `compactionProposer` 的 schema 必须额外限制：只能输出 `mergeItems`，`evidenceKind=memory_compaction`、`changeKind=lifecycle`，不得输出 `observationIds/evidenceRefs/candidateDecisions`。
- canonical 普通 patch 的 `evidenceRefs[].quote` schema 设置 `maxLength: 200`；Reducer 仍按 Unicode code points 复核长度、信息量和匹配，不把 Provider schema 当作最终证据校验。Provider wire 可以按 [state-contract.md](state-contract.md) §8 使用可逆的更窄表示；当前 scene wire 使用单个 `evidenceRef`，Adapter 必须在业务校验前归一化为 `evidenceRefs: [ref]`。

### 2.2 Prompt 设计原则

每个 `modules/memory/prompts/*.md` 是独立、自包含且有长度预算的 system prompt，只保留本 Proposer 的任务边界、schema 无法表达的语义规则、evidenceKind 子集和必要的判定校准。输出字段与枚举由 strict schema 负责，prompt 不复制完整 JSON 输出样例。校准例必须是合成、领域中性且最小化的边界对照；不得复制真实用户、preset 或当前调试会话中的人物、地点、物品和事件。大量正反例应留在 Harness 评测集，而不是塞进生产 prompt。

以下原则按主题分组。各 prompt 文件按 §2.3 的组成表提取相关条目。

#### 通用原则

1. 只对本次 `task.targetKey` 在 [state-contract.md](state-contract.md) §1.4 固定映射出的 writable sections 输出结果。canonical task 不携带 `targetSections`；非映射 section 不要输出。
2. 普通成功 output 的每个 target section 必须明确输出 patches / noop 之一；同时用 `candidateDecisions` 逐项说明输入候选的处理结果。section 级状态不能替代候选生命周期。无法组成合法 decision 时改用独立 task-level `unable_to_decide` union，不能混入 sectionResults。
3. noop 与 unable_to_decide 的区别：
   - noop：已理解输入 candidates，当前没有 patch；每个 candidate 仍必须以 `waiting/excluded/already_reflected + reasonCode` 解释。
   - unable_to_decide：输入 envelope 本身不足以执行判断，task-level reason 只能是 `missing_context | ambiguous_reference`，并给出 `requestedContext`。“证据尚未达到晋升门槛”属于带原因的 noop，不属于执行失败。
   - 不要把"看不懂"伪装成"没变化"。
4. patch 必须附 evidenceKind；除 mergeItems 外，patch 必须附 evidenceRefs。quote 应复制专业 envelope `observedMessages`（即与 observations 相关的最小充分 raw messages）中能够支持该 patch 的最短连续原文，不要改写，最多 200 个 Unicode code points；不要依赖自己精确计数，Reducer 以 [Evidence 校验与 Quote 匹配算法](algorithms/evidence-validation.md)的统一长度与模糊匹配规则作最终裁决。
5. 普通写入 patch 的 evidenceRefs 必须来自本次输入的 `observedMessages`，并存在于 `observationIds` 对应的 durable evidence 版本。证据可以早于当前扫描增量或支持窗口；只要原始消息存在、属于同一 user/preset 与 source generation、未超过 task source boundary、未被 suppression，且 quote/hash 复核通过，就是合法证据。不得再要求“至少一条 evidence 位于 new batch”。`readOnlyContext` 只能用于理解背景，不能作为证据，也不能被当作完整世界状态来推断缺失事实。
6. readOnlyContext 中的 item 不含 id 字段。itemId/itemIds 必须来自 writableState 中对应 section 的 item。
7. 如果现有背景不足以判断，输出 unable_to_decide，不要把背景猜成事实。
8. 删除/完成/取消必须用对应 op（retractItem/forgetItem/completeTodo/cancelTodo/expireTodo/cancelAgreement），不要用通用 removeItem。forgetItem 只用于 worldFacts/userProfile/assistantProfile/relationship 的明确 forget 指令；retractItem 只用于 recentEpisodes/milestones/四个长期 section 的明确事实纠正，表示当前 item 本不应成立且没有替代值。二者都不能用“把 text 改成已作废”代替，也不能互换。
9. 输出结构为 `sectionResults + candidateDecisions`，`sectionResults` 必须恰好覆盖 `task.targetKey` 的固定 writable-section 集合，`candidateDecisions` 必须恰好覆盖本次输入中路由到当前 target 的 observations：
   ```json
   {
     "tickId": "<task.tickId>",
     "proposer": "<本 Proposer 名称>",
     "candidateDecisions": [ ... ],
     "sectionResults": {
       "<section>": {
         "status": "patches | noop",
         "patches": [ ... ]
       }
     }
   }
   ```
   Task-level unable 使用 `{tickId, proposer, status:"unable_to_decide", reasonCode, requestedContext:{beforeMessageId,afterMessageId}}`，不携带 `candidateDecisions/sectionResults`，不关闭任何 observation。
10. Memory 业务层没有 proposal/envelope 总字符预算；不要为了猜测总字符上限而丢弃必要 patch。每个 `value.text` 应遵守本节“语义文本与展示文本”规则，最终 section 容量由 Reducer 按 `maxItems + maxRenderedChars` 校验。
11. 专用 prompt 描述排除项时，只给出当前 target section 的决定，例如“不属于 todos → todos noop”。不要写“应归另一个 section”或“由另一个 Proposer 处理”，避免把不可输出的 section 暗示为本次调用的候选结果；其他 target 会独立判断。

#### 语义文本与展示文本

Proposer 负责输出准确、简洁的语义内容，不负责设计聊天展示格式。`value.text` 应使用自然、可直接理解的短语或短句；不得为了压缩而强制拼接 `+`、`→`、`>`、`|`，也不得预先加入 Renderer 的 section 标题、角色标签或项目符号。能由结构化字段表达的关系必须放入字段，Renderer 再按 [rendering-and-context.md](rendering-and-context.md) 组织自然、简洁且去重的最终文本。

- ❌ `"被忽视感 > 愤怒 | 侧头回避 | 拒绝交流"`
- ✅ `"因感到被忽视而生气，并暂时回避交流"`

#### 成人内容

value.text 客观记录事件本质、双方意愿、关系变化，不写感官描写。quote 可以摘录原话片段（含感官描写），因为 quote 仅用于审计溯源，不渲染给主聊天模型。

#### actor、requester 与 dueAt（仅 todoProposer）

每个新增 todo 都要明确：

- `actor`：实际执行者，值为 `user`、`assistant` 或 `both`。
- `requester`：提出请求或承诺的一方，值为 `user` 或 `assistant`。

如有明确 deadline，在 patch 顶层 `dueChange.mode=set` 中设置：

- 听到明确日期 → `dueAt={ "mode": "absolute", "date": "YYYY-MM-DD" }`
- 听到相对日期 → 只选择一个单位输出 `dueAt={ "mode": "relative", "days": N }` / `{ "mode": "relative", "months": N }` / `{ "mode": "relative", "years": N }`。`days >= 0`，`months/years >= 1`；今天固定为 `days=0`，明天固定为 `days=1`，不得同时输出多个单位或未使用的零值字段。
- 只提取你听到的，不要按 worker 当前时间做日期计算。Relative dueChange 同时输出非空 `timeAnchorMessageId`，指向真正出现“明天/两周后”等表达的 observation evidence；absolute dueChange 的 `timeAnchorMessageId` 固定为 `null`。Reducer 用 relative anchor raw message 的 `createdAt` 与冻结用户时区计算，不得默认取最新接受/完成消息。
- 更新 todo 时始终显式输出 `dueChange`：不改期限用 `keep`，删除期限用 `clear`，设置/替换期限用 `set`。字段省略不表示清空。

#### evidenceKind 判断指南

以下为完整 evidenceKind 列表。各 prompt 文件只包含本 Proposer 合法的子集（[state-contract.md](state-contract.md) §2.3/§5.1）。

- user_request: 用户明确请求系统/角色稍后做某事（assistant 是行动者）
- user_commitment: 用户明确承诺稍后做某事（user 是行动者，user 发起）
- assistant_request: assistant 明确请求用户稍后做某事（user 是行动者，assistant 发起）
- assistant_commitment: assistant 明确承诺稍后做某事（assistant 是行动者）
- todo_completion: 待办已完成
- todo_cancel: 待办被取消
- todo_expiration: 短期待办自然失效或被澄清为不再需要
- scene_change: 地点/时间/环境/氛围明确变化
- standing_agreement: 持续互动约定、相处规则或长期承诺形成或修订
- agreement_cancel: 持续互动约定被明确取消或作废
- recent_episode: 最近发生的有意义互动
- relationship_milestone: 关系或剧情关键转折
- user_correction: 用户明确修正旧记忆或设定
- assistant_correction: assistant 明确修正已有记忆。与 user_correction 权限相同
- user_forget: 用户明确要求忘记已有长期事实或档案 item
- assistant_forget: assistant 明确撤回并要求忘记已有长期事实或档案 item
- long_term_fact: 长期事实，包括明确表达的（"我叫小明"）和从行为推断的（多次回避冲突→倾向回避冲突）。evidenceRefs 的 quote 始终是 raw message 短片段——对陈述是原话，对推断是体现该行为的原话（如"我冲过去把门踹开了"）；推断理由写在 value.text 中，不放在 quote
- memory_compaction: 基于已有 memory item 的预算维护与去重合并，不代表新事实

### 2.3 各 Proposer 专属原则

以下原则按 Proposer 分组，每个 `modules/memory/prompts/*.md` 在 §2.2 通用原则基础上追加本组原则。

#### currentStateProposer（scene）

- scene 是当前叙事 epoch 的字段状态，用 setField/clearField 字段级覆盖；无变化时输出 noop。epoch 由活动、地点、参与者或因果连续性决定，session、turn、固定消息数和单纯时间间隔都不能独立开始/结束 epoch。
- 有明确新场景/新活动开始且与当前 epoch 不连续时，scene section 输出 `epochTransition.action=start`：Reducer 先把旧 epoch 归档为 latest previous scene、创建新 epoch，再按顺序应用本 section 的字段 patches。start 证据必须直接支持边界变化，不能只支持某个字段值；transition 自身必须带唯一 `patchId`、`evidenceKind=scene_change`、`changeKind=lifecycle`、`observationIds/evidenceRef`。
- 有明确离开、返回、活动结束且尚未开始新场景时输出 `epochTransition.action=end`：Reducer 归档当前 epoch 并清空 current scene；end 不与设置新字段的 patch 混用。只有 transition 也属于 `status=patches` 的语义写入，即使 `patches=[]`；对应 proposed decision 的 `patchIds` 指向 transition 自身的 `patchId`。
- 没有 epochTransition 时只独立更新/清除有原文支持的字段；一个字段的新 evidence 不刷新其他字段的 TTL。字段 TTL 到期也由 Reducer/effective view 独立处理，不由 Proposer伪造 end transition。
- scene 多字段变化时输出多个 setField patch，每个 patch 恰好 1 条 evidenceRef。
- clearField 表示“此字段已失效”；patch 不携带 `value:null`，Reducer 会把固定字段的 value 设为 null，并保留清除 event/provenance。

#### todoProposer（todos）

- todos 只记录明确、可完成、可取消或可过期的请求/承诺。模糊愿望和持续互动约定不要写入 todos。
- 新增时必须设置 actor/requester；有明确期限时使用 patch 顶层 dueChange，relative 给出非空 timeAnchorMessageId，absolute 给出 null（见 §2.2）。更新时必须显式设置 dueChange。
- `status` 与 `becameOverdueAt` 由 Reducer 管理，Proposer 不得输出或修改；todoProposer 的 writableState 可包含 active/overdue items，以便两者都能 complete/cancel。
- overdue todo 可通过 `updateItem` 设置 `dueChange.mode=set` 且新 dueAt 在未来时变回 active；Proposer 看到用户重新安排已过期待办的时间时应输出此类 updateItem。
- todoProposer 的 writableState 包含全部 active、所有当前 observations 直接关联的 overdue todo，再补最近 N 条 overdue（N=`proposerContext.todosRecentOverdueItems`）；直接关联项永不因该 N 或普通 state 预算被截断。若必需 item 超 Provider 物理上限则显式 missing_context/capacity failure，不得带残缺 writableState 调用。

#### agreementProposer（standingAgreements）

- standingAgreements 只记录持续互动约定、相处规则和具有明确承诺语义的长期承诺；单纯抒情或夸张不算约定。取消使用 cancelAgreement。

#### episodeProposer（recentEpisodes, milestones）

- `recentEpisodes` 是少量高显著度且已经结束的“事件簇”，不是逐轮摘要、聊天日志或动作时间线。先按同一活动/目标/参与者/地点/因果连续性判断 semantic arc，再为一个完整弧最多写一条；不得为每个新动作另建 item。
- open semantic arc 只保存在 observation/candidate 层，可随跨 batch、跨窗口、跨 session 的关键进展补证。只要弧仍为 open，专业 Proposer 就输出 section `noop`，候选决定为 `waiting`（通常 `reasonCode=awaiting_outcome` 或 `insufficient_evidence`），即使已经出现高显著性中间结果也不得写入最终 `recentEpisodes`。只有弧关闭后才可一次性 add；已经落地的 episode 只在后续原文确实 refine/correct 该已完成事件时 update。
- 单个 task 的 recentEpisodes 通常为 0–2 个 patch，最多 3 个；普通日常弧即使关闭也可 `not_memory_worthy`。
- `value.text` 只保留事件、结果/未决问题及关系意义，省略不改变结果的过渡动作、表情和感官细节。重复日常互动与临时安排本身不构成 episode。
- milestones 位于长期区，只记录明确改变关系身份、信任/边界基线或主剧情状态的关键转折。一次温馨互动或普通日常承诺即使情绪强烈也不是 milestone。
- milestone 与 recentEpisode 不默认双写；只有同一证据同时产生独立的近期延续价值和长期基线变化时才分别记录。

#### profileRelationshipProposer（userProfile, assistantProfile, relationship）

- `userProfile`、`assistantProfile`、`relationship` 接受长期事实（含 assistant 设定人格和行为推断的人格特征），临时剧情、一次性情绪不要写入。
- 每个 add/update value 必须包含 `text + facet + canonicalKey + factBasis`。facet/canonicalKey 使用 [状态契约](state-contract.md) §1.3 的 section 专属枚举；同 section 的非 multi-value canonicalKey 已存在时只能 update/noop，不能再次 add。
- evidenceRefs 可以引用 observation 持有的旧原文，不要求位于当前扫描增量。`factBasis=observedPattern` 默认至少引用 3 个相互独立的有效行为场合并跨至少两个 semantic arc；不同 messageId、turn 或 session 本身不等于独立场合。直接稳定陈述使用 `explicit`。
- User 与 Assistant 的真实消息都可以用 `long_term_fact` 支持三个 section 的新增；不要按 role 把任一方限制为只能维护 userProfile 或 assistantProfile。
- 三个正式 section 分别输出自己的 `sectionResults`，patch 不使用 `path`。
- 已有 item 的事实错误可由 user_correction 或 assistant_correction 修正，两者权限相同；重申、细化或自然取代使用与新原文语义相符的 evidenceKind，并分别标记 `changeKind=reaffirm/refine/supersede`，不得伪装成 correction。
- 明确要求忘记已有 item 时输出 `forgetItem`，并按真实发言方使用 `user_forget` 或 `assistant_forget`；只引用 writableState 中的 itemId，不复述被忘记内容到 value。
- `factBasis=explicit` 只用于消息直接断言身份、稳定偏好/边界、长期能力或关系状态；“明确说出一次当下动作/感受”仍是一次性事件，不能借 explicit 绕过长期性门槛。
- 行为推断使用 long_term_fact，只在持久 observation 累计出清晰、显著且跨独立 semantic arc 复现的行为模式时才输出，一次性动作不构成 trait。相邻的提议与回应、问题与回答或同一语义弧的多个动作只算一个行为场合。证据尚未达到模式门槛时应输出 section `noop` 与候选决定 `waiting + pattern_threshold_not_met`，而不是丢弃候选或伪装成 `unable_to_decide`。
- 已有长期结论的自然变化必须用 §2.7 的 `changeKind` 区分 `reaffirm`、`refine`、`supersede` 与事实错误导致的 `correct`；关系加深、偏好具体化或新证据重申不得一律标成 correction。
- assistantProfile 只记录被明确赋予或稳定形成的身份、人格、价值、能力和行为特征；一次活动或即时情绪反应不能推出技能或人格，也不能把一次模型错误或用户要求修复的坏习惯固化为 Assistant 人格。
- relationship 只记录明确关系身份/称呼/共同边界，或跨独立片段重复成立的互动结构；单次照顾、临时安排或亲昵回应不是持续关系模式。

#### worldFactProposer（worldFacts）

- worldFacts 只记录世界设定事实（如"这个世界有魔法"），临时剧情、一次性情绪不要写入。
- User 与 Assistant 的真实消息都可以用 `long_term_fact` 新增 worldFacts。
- `worldFacts` 是独立正式 section，patch 不使用 `path`。
- 已有 worldFacts item 的事实错误可由 user_correction 或 assistant_correction 修正，两者权限相同；canon 的重申、细化或自然取代使用对应 `changeKind`，不得一律伪装成 correction。
- 明确要求忘记已有 worldFacts item 时输出 `forgetItem`，并按真实发言方使用 `user_forget` 或 `assistant_forget`；不输出 value。

### 2.4 Compaction Proposer 要点

`compactionProposer` 使用独立 prompt，处理长度预算恢复和 high-water hygiene 两种模式下的安全合并。两种模式在调用 LLM 前都先执行确定性 exact-text merge；`mergeItems` 的 v3 字段/policy 见 [state-contract.md](state-contract.md) §4.3/§5.1。

```
你是 memory 维护合并器。你的任务是在给定单个 section 的 source items 中寻找重复或高度重叠项，并提出 mergeItems patch。你不能新增事实、不能删除长期记忆、不能跨 section 合并。

### 核心原则
1. 只处理输入 target 指定的单个 section。
2. 只能输出 mergeItems 或 unable_to_compact。
3. 没有明显重叠时输出 unable_to_compact。
4. mergeItems 的 itemIds 必须全部来自 writableState 中的目标 source items，且至少 2 个。
5. evidenceKind 只能使用 `memory_compaction`。不得输出 `user_correction` 或 `assistant_correction`。
6. changeKind 固定为 `lifecycle`；不输出 observationIds/evidenceRefs，Reducer 会根据 itemIds 从 source items 继承 evidenceGroups。
7. value.text 必须是 writableState source items 的自然、简洁合并，不得引入 source items 未表达的新事实或展示层符号模板。
8. todos 只能合并重复/同一事项且 actor、requester、dueAt 分别相同的 active 待办；overdue todo 不参与 compaction，不能改写这些字段或把未完成待办删除成"已处理"。
9. standingAgreements 只能合并重复/高度重叠的约定；不能把有效约定删除成"已处理"。
10. milestones/worldFacts/userProfile/assistantProfile/relationship 只能在各自 section 内合并高度重叠项；不能因为容量压力遗忘长期事实。
```

### 2.5 User Prompt

将当前 schema 版本对应的 envelope JSON 直接作为 user message 传入（或序列化为可读文本，取决于 provider 的 structured output 实现）。v2.1 普通专业 Proposer 使用 §2.7 的 observation-first envelope；不得继续把一个任意 `newBatch + overlap` 窗口当作候选范围或证据新鲜度边界。Compaction 仍使用维护模式 envelope。

默认调用保持 `system instructions + 当前 task envelope user message`，不注入独立 user/assistant few-shot 对。few-shot 不是结构化输出的必需条件：输出形状由 strict schema/tool 约束，语义边界优先由短规则、Reducer 和 Harness 固化。独立 golden messages 的候选结构、A/B 指标和移出延期条件统一记录在 [Proposer 独立 Few-shot Golden Messages（延后）](../deferred/memory-control-v2/proposer-few-shot-golden-messages.md)，当前主设计不预实现传输接口。

### 2.6 semanticSignalObserver prompt/schema 边界

`semanticSignalObserver` 在每个 immutable `single_source_message_v1` boundary 扫描唯一一条尚未可靠评估的 source message。它负责发现信号、把后续接受/拒绝/完成/纠正与已有 observation 关联，并给出候选 target；它不判断最终 memory 文案，不输出 patch，也不因没有信号而制造内容。`batchMaxMessages/debounceMs` 只能合并 pending wake/raw prefetch；durable pending `tailMaxDelay`、显式 drain 或 rebuild 收尾必须处理不足批量的 tail。它们不能合并 Observer boundaries，也不能减少 canonical Observer task/envelope/call 数。

Observer input 采用 [state-contract.md](state-contract.md) §3.1 的 source-scan envelope：`task` 固化 `schemaVersion=3/sourceGeneration/scanMode/contractVersion/semanticBoundaryId/boundaryOrdinal/boundaryPlanVersion/scanCursorBefore/sourceBoundaryMessageId/detectorVersion/semanticNow/userTimeZone`；`newMessageIds` 恰好包含 boundary 的唯一 source message；`observedMessages` 包含该 singleton delta 与有界支持原文；`openObservationCatalog` 提供可关联 observation，`mutableArcCatalog/mutableOccasionCatalog` 提供全部 open 与本次 correction dependency直接相关的 closed 对象。`sessionId`/session 名称不属于语义输入，turn/reply 元数据只可用于确认源完整性和回复归属。

下例中 729 已经作为 catalog 中 observation/occasion 的 registered evidence 提供，仅 730 是本次 singleton delta/newMessageId；因此 output 只 assessment 730，并用 exact ID/version append 既有对象。Observer strict output 必须使用以下三组 canonical 字段：

```json
{
  "tickId": 12345,
  "proposer": "semanticSignalObserver",
  "sourceBoundaryMessageId": 730,
  "messageAssessments": [
    { "messageId": 730, "outcome": "signals", "signalIndexes": [0], "arcActionIndexes": [], "occasionActionIndexes": [0] }
  ],
  "arcActions": [],
  "occasionActions": [
    {
      "action": "append",
      "occasionId": "occasion-uuid-from-input-catalog",
      "expectedVersion": 1,
      "arcId": null,
      "arcActionIndex": null,
      "semanticKey": "breakfast-promise",
      "evidenceRefs": [
        { "messageId": 730, "quote": "好呀" }
      ]
    }
  ],
  "signals": [
    {
      "action": "append",
      "relatedObservationId": "uuid-from-input-catalog",
      "affectedObservationIds": [],
      "expectedVersion": 1,
      "kind": "recurring_commitment",
      "relation": "accepts",
      "semanticKey": "care:daily-breakfast",
      "subjectRole": "both",
      "factBasisHint": "explicit | observedPattern | not_applicable",
      "claim": "Assistant 提议以后每天早上做早餐，User 接受",
      "candidateTargets": ["standingAgreements"],
      "occasionId": "occasion-uuid-from-input-catalog",
      "occasionActionIndex": null,
      "arcId": null,
      "arcActionIndex": null,
      "evidenceRefs": [
        { "messageId": 729, "quote": "以后每天早上都给你做" },
        { "messageId": 730, "quote": "好呀" }
      ]
    }
  ]
}
```

Prompt/schema 边界：

1. `messageAssessments` 必须逐一且只逐一覆盖 `newMessageIds`；`signals` outcome 的三个 index 数组并集必须非空，`no_relevant_signal` 时三者都为空。这只证明 source 已扫描，不等价于任意专业 target 的 noop。
2. 每个 signal/arc/occasion action 至少引用本次 singleton boundary raw message，所有 refs 都不得超过 source boundary。create/open 的对象 ID 与 `expectedVersion` 必须为 null；append/close/supersede/invalidate 必须显式携带输入 catalog 中同 scope/generation 对象的精确 ID 与 `expectedVersion`，Coordinator 仅在 compare-and-set 命中时提交。这里的 boundary 要求只保证 Observer 连续扫描，不得被专业 Proposer 复用为最终 patch 的证据新鲜度规则。
3. `kind/relation/action/candidateTargets` 必须来自 [state-contract.md](state-contract.md) §2–§3 的封闭枚举。`semanticKey/claim/factBasisHint` 只是候选分类，不是最终事实；相同 semanticKey 不会自动合并 observation。
4. `arcActions/occasionActions` 只按活动/目标/参与者/地点/因果连续性维护 semantic arc 与独立行为场合；session、turn、固定消息数和单纯时间间隔不能独立产生 action。每个 arc open 必须同时 create 唯一 `episode_arc` observation；arc append/close/invalidate 必须对它分别输出 `arc_progress/arc_closes/contradicts` mutation。occasion 支持 create/append/close/invalidate；arc 终结时同 output 终结其全部 open occasions。open arc 只持久化在 observation/arc ledger。
5. 同一 output 引用尚未持久化的对象时必须使用 action index：occasion action 的 `arcId/arcActionIndex` 二选一；signal 的 `arcId/arcActionIndex` 二选一、`occasionId/occasionActionIndex` 二选一（两组均可为空）。index 只能指向本 output 中 evidence/scope 兼容的 `open/create` action，不能同时自报对象 ID。
6. Observer 不输出 durable UUID、candidate consumption、memory patch/itemId、最终 dueAt、profile 晋升结论、episode 展示文案或 Renderer text。SourceScanCoordinator 复核 raw evidence 后从 task/index 确定性生成/更新 identity。
7. 普通信号的 `affectedObservationIds=[]`。只有新建 `memory_correction|memory_forget` observation时可列出 catalog 中 exact IDs；若旧 observation/arc/occasion 已有 consumed/current projection或仍参与有效 pattern，禁止直接 supersede/invalidate，必须先创建此 correction/forget candidate并覆盖全部受影响 targets，由 Reducer完成 update/retract/forget 后再终结旧依赖。
8. Observation 不是最终 memory、episode 草稿或聊天摘要，禁止进入 Renderer。

### 2.7 专业 Proposer observation-first envelope 与 candidateDecisions

每次专业 Proposer 被触发时，必须收到：

- `task`：`schemaVersion=3`、`sourceGeneration`、`semanticBoundaryId/boundaryCycleId/cycleLineageId`、`cycleKind/reviewEpoch/reviewTrigger/retryEpoch`、仅 late discovery review 使用的 `lateDiscoverySourceBoundaryId`、`workerKey/targetKey`、`contractVersion`、`sourceBoundaryMessageId`、`asOfRevision`、`semanticNow/userTimeZone` 与 `observationVersions[{observationId,version}]`；
- `observations`：本 target 待判断或因新证据需要重判的候选，id/version 集合必须精确覆盖 `task.observationVersions`，并含 durable identity、kind、状态、candidate target、semantic arc/模式独立性元数据及 raw evidence 索引；
- `observedMessages`：覆盖这些 observations 的最小充分相关原文，包括较早候选证据、当前补充证据及必要消歧消息；它不是旧式任意 recent window；
- 与候选直接相关的完整 writable items，以及 source boundary 时点的必要 `readOnlyContext`；
- 涉及相对时间时的 anchor message 和用户时区。

`contextWindow` 只是检索支持上下文的预算，不是证据资格范围。同一 `boundaryCycleId/cycleLineageId/reviewEpoch` 的多个 Proposer 必须读取同一个 as-of 状态；不得让先提交的 episode、profile 或其他投影成为后运行 Proposer 才能获得的事实，也不得要求 profile/relationship 等待 episode。同一 source boundary 后来可以承载新的 semantic review epoch；它以新 lineage 明确冻结新的 as-of，不能回写或扩张旧 cycle。

Canonical output 在 `sectionResults` 之外必须包含：

```json
{
  "candidateDecisions": [
    {
      "observationId": "<uuid>",
      "outcome": "proposed",
      "reasonCode": "meets_write_threshold",
      "patchIds": ["patch-1"]
    }
  ]
}
```

条件规则：

- `outcome=proposed` 的 `reasonCode` 只能是 `meets_write_threshold` 且 `patchIds` 非空。每个 ID 必须指向本 output 的真实普通 patch 或 scene `epochTransition` operation，operation 的 `observationIds` 也必须反向包含该 observation；一个 observation 产生多个 scene field patch/transition 时可列多个 patchId。每个 operation 引用的 observation 也必须在对应 decision.patchIds 中反向列出。Proposer 只表示“建议写入”，不能宣称候选已消费；只有 Reducer 的 accepted/deferred/rejected 结果能推进 lifecycle。
- `outcome=waiting` 的 `reasonCode` 必须是 `insufficient_evidence | awaiting_acceptance | awaiting_outcome | ambiguous_reference | pattern_threshold_not_met` 之一，且 `patchIds=[]`。它保留候选等待后续补证，不是失败或丢弃。
- `outcome=excluded` 的 `reasonCode` 必须是 `target_mismatch | not_memory_worthy | transient_only | invalid_inference | not_canon | contradicted` 之一，且 `patchIds=[]`。`target_mismatch` 只排除当前 target，仍允许 Observer 路由到其他 target；其余 reason 必须有当前原文和模块门槛支持。
- `outcome=already_reflected` 的 `reasonCode` 只能是 `duplicate_or_existing_state`，且 `patchIds=[]`，表示当前有效投影已经表达同一语义且无新的 reaffirm provenance 需要提交。
- section `status=noop` 时，所有输入 observations 仍必须分别得到 `waiting/excluded/already_reflected + reasonCode`；这就是 noop 的可审计原因。只要存在 `proposed` decision，对应 section 就必须有至少一个引用该 observation 的普通 patch 或 scene transition operation。
- task-level `unable_to_decide` 只保留给缺少上下文或无法消歧、以至于不能可靠产生逐候选 decision 的执行层问题；它必须输出合法 `reasonCode/requestedContext`，该 attempt 不改变 observation 状态并进入受限扩窗/重试。模式门槛不足使用 `waiting + pattern_threshold_not_met`。
- 每个普通 patch 必须携带自然变化 `changeKind: establish | reaffirm | refine | supersede | correct | forget | lifecycle`。底层 `op` 仍按 section policy 使用 `addItem/updateItem/forgetItem/completeTodo/...`，不能用 `correct` 冒充所有自然演化；完成、取消、过期与 scene 生命周期使用 `lifecycle`。`projectionIdentity` 由 Reducer 从被接受 patch 的 observation root 确定性派生，Proposer 不得自由生成。
- 每个输入 observation/version 对当前 target 恰好一条 decision；section `status=noop` 时也不能省略。没有输入 candidate 的 target 不应创建 normal task。
- 一个 observation 可以合法投影到多个 section，但每个 projection 必须增加独有语义；patch 的 `observationIds` 让 Reducer 派生共享/独立的 `projectionIdentity`，Renderer 再据此归并，不能把同一自然句原样复制到多个长期 section。

## 3. Per-Proposer op→field 必填速查表

[state-contract.md](state-contract.md) §4 的字段必填规则是 Reducer 校验视角的 master 规则。本节按 Proposer 拆分，供 schema 作者和 prompt 编写者速查。每个 Proposer 的 output schema 只包含自己合法的 op（适用 Proposer 列见 [state-contract.md](state-contract.md) §4）。

下表省略 v3 patch 的共同必填字段 `patchId/changeKind`；所有非 compaction patch 还必须携带 `observationIds`，compaction 的 changeKind 固定为 lifecycle。`projectionIdentity` 由 Reducer 派生，不属于 Proposer output。

### currentStateProposer（scene）

| op           | path         | itemId | itemIds | value  | evidenceRefs |
| ------------ | ------------ | ------ | ------- | ------ | ------------ |
| `setField`   | 必填(字段名) | 不需要 | 不需要  | 必填   | 必填         |
| `clearField` | 必填(字段名) | 不需要 | 不需要  | 不需要 | 必填         |

scene section result 可另带 `epochTransition:{patchId,action:start|end,evidenceKind:scene_change,changeKind:lifecycle,evidenceRef,observationIds}`。它与普通 patches 共享 output 级 patchId namespace并参与 candidate decision 双向覆盖；`start` 可与新 epoch 的 set/clear patches 同组，`end` 可作为唯一 operation 且不与字段设置混用。transition 不使用 `path/itemId`。

### todoProposer（todos）

| op             | path   | itemId | itemIds | value  | evidenceRefs |
| -------------- | ------ | ------ | ------- | ------ | ------------ |
| `addItem`      | 不需要 | 不需要 | 不需要  | 必填   | 必填         |
| `updateItem`   | 不需要 | 必填   | 不需要  | 可选*  | 必填         |
| `completeTodo` | 不需要 | 必填   | 不需要  | 不需要 | 必填         |
| `cancelTodo`   | 不需要 | 必填   | 不需要  | 不需要 | 必填         |
| `expireTodo`   | 不需要 | 必填   | 不需要  | 不需要 | 必填         |

> `expireTodo` 是 Proposer 观察到用户澄清“不再需要”时输出的终止 patch（evidenceKind: `todo_expiration`），需要 evidenceRefs。Wall-clock 到达 `dueAt` 不调用 `expireTodo`、也不删除 item；Reducer 原位设置 `status=overdue` 并写 `system_cleanup: todo_became_overdue`。

`todos.updateItem` 的 `dueChange` 始终必填。只改 deadline/revive 时可以省略 value；`dueChange=keep` 时 value 必须非空且产生实际字段变化；`dueChange=clear|set` 可省略 value。空 value/省略 value 与 keep 的组合、或归一化后没有任何实际变化的 patch 均拒绝。

### agreementProposer（standingAgreements）

| op                | path   | itemId | itemIds | value  | evidenceRefs |
| ----------------- | ------ | ------ | ------- | ------ | ------------ |
| `addItem`         | 不需要 | 不需要 | 不需要  | 必填   | 必填         |
| `updateItem`      | 不需要 | 必填   | 不需要  | 必填   | 必填         |
| `cancelAgreement` | 不需要 | 必填   | 不需要  | 不需要 | 必填         |

### episodeProposer（recentEpisodes, milestones）

| op           | path   | itemId | itemIds | value | evidenceRefs |
| ------------ | ------ | ------ | ------- | ----- | ------------ |
| `addItem`    | 不需要 | 不需要 | 不需要  | 必填  | 必填         |
| `updateItem` | 不需要 | 必填   | 不需要  | 必填  | 必填         |
| `retractItem`| 不需要 | 必填   | 不需要  | 不输出| 必填         |

### profileRelationshipProposer（userProfile, assistantProfile, relationship）

| op           | path   | itemId | itemIds | value  | evidenceRefs |
| ------------ | ------ | ------ | ------- | ------ | ------------ |
| `addItem`    | 不需要 | 不需要 | 不需要  | 必填   | 必填         |
| `updateItem` | 不需要 | 必填   | 不需要  | 必填   | 必填         |
| `retractItem`| 不需要 | 必填   | 不需要  | 不输出 | 必填         |
| `forgetItem` | 不需要 | 必填   | 不需要  | 不输出 | 必填         |

patch 所属 section 由 `sectionResults.userProfile` / `assistantProfile` / `relationship` 确定。

三个 section 的 `addItem + long_term_fact` 都可由 User 或 Assistant 的真实消息支持；`updateItem` 使用与真实发言方一致的 `user_correction` / `assistant_correction`，`forgetItem` 使用与真实发言方一致的 `user_forget` / `assistant_forget`。

`addItem`/`updateItem` 的 value 固定为 `{ text, facet, canonicalKey, factBasis }`；这四个字段都必填，禁止退回仅含 text 的 legacy 输出。

### worldFactProposer（worldFacts）

| op           | path   | itemId | itemIds | value  | evidenceRefs |
| ------------ | ------ | ------ | ------- | ------ | ------------ |
| `addItem`    | 不需要 | 不需要 | 不需要  | 必填   | 必填         |
| `updateItem` | 不需要 | 必填   | 不需要  | 必填   | 必填         |
| `retractItem`| 不需要 | 必填   | 不需要  | 不输出 | 必填         |
| `forgetItem` | 不需要 | 必填   | 不需要  | 不输出 | 必填         |

`worldFacts.addItem + long_term_fact` 可由 User 或 Assistant 的真实消息支持；`updateItem` 使用与真实发言方一致的 `user_correction` / `assistant_correction`，`forgetItem` 使用与真实发言方一致的 `user_forget` / `assistant_forget`。

### compactionProposer（维护模式）

| op           | path   | itemId | itemIds | value      | evidenceRefs |
| ------------ | ------ | ------ | ------- | ---------- | ------------ |
| `mergeItems` | 不需要 | 不需要 | 必填    | 必填(text) | 不输出       |

`evidenceKind` 只能是 `memory_compaction`，`changeKind` 只能是 `lifecycle`。compactionProposer 输出状态为 `patches | unable_to_compact`。Reducer 根据 itemIds 从 source items 继承 evidenceGroups。

## 4. Harness Evaluation Examples

本节样例用于 Harness 与人工评审，约束 schema 无法表达的 text/value 质量、quote 选取、op 边界和 evidenceKind 判定。它们不是必须逐条复制进生产 system prompt；生产 prompt 只保留少量合成、领域中性的边界校准。为突出 section 专属字段，下面的 patch 片段省略 v3 共同字段 `observationIds/changeKind`；可执行 Harness fixture 必须补齐这些字段，并提供对应 `candidateDecisions`。`projectionIdentity` 由 Reducer 派生，不能补入 Proposer fixture output。

### 4.1 currentStateProposer

**✅ setField + scene_change（地点变化）**

```json
{
  "op": "setField",
  "path": "location",
  "value": "医院门口",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 121, "quote": "我到了医院门口" }]
}
```

quote 是原话短片段，value 是简洁的语义值；标题和字段标签由 Renderer 组织。

**✅ setField + scene_change（氛围变化）**

```json
{
  "op": "setField",
  "path": "mood",
  "value": "雨后安静",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 122, "quote": "雨停以后好安静" }]
}
```

**✅ clearField + scene_change（场景已失效）**

```json
{
  "op": "clearField",
  "path": "note",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 125, "quote": "我们已经离开那家店了" }]
}
```

`clearField` 表示"此字段已失效"，不是设为 null。

**✅ epochTransition.start（归档旧 epoch 后建立新场景）**

```json
{
  "status": "patches",
  "epochTransition": {
    "patchId": "scene-transition-start-126",
    "action": "start",
    "evidenceKind": "scene_change",
    "changeKind": "lifecycle",
    "evidenceRef": { "messageId": 126, "quote": "我们到家了" },
    "observationIds": ["018f2f5e-7f2a-7b11-9c31-aaaaaaaaaaaa"]
  },
  "patches": [
    {
      "op": "setField",
      "path": "location",
      "value": "家里",
      "evidenceKind": "scene_change",
      "evidenceRefs": [{ "messageId": 126, "quote": "我们到家了" }]
    }
  ]
}
```

Reducer 先把当前 epoch 归档为 latest previous scene，再创建新 epoch 并应用 location patch。session 变化不能代替该证据。

**✅ epochTransition.end（明确结束且没有新场景）**

```json
{
  "status": "patches",
  "epochTransition": {
    "patchId": "scene-transition-end-127",
    "action": "end",
    "evidenceKind": "scene_change",
    "changeKind": "lifecycle",
    "evidenceRef": { "messageId": 127, "quote": "今晚的活动就到这里吧" },
    "observationIds": ["018f2f5e-7f2a-7b11-9c31-bbbbbbbbbbbb"]
  },
  "patches": []
}
```

Reducer 归档并清空 current scene；不得为了通过固定 TTL 或 session 边界而生成 end。

**✅ setField + user_correction（用户修正错误场景记忆）**

```json
{
  "op": "setField",
  "path": "location",
  "value": "家里",
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 128, "quote": "我们其实一直在家没出去过" }]
}
```

之前误记为医院，用户澄清实际在家。correction 区分"场景变了"和"之前记错了"。

**✅ setField + scene_change（场景时间自然推进）**

```json
{
  "op": "setField",
  "path": "time",
  "value": "清晨",
  "evidenceKind": "scene_change",
  "changeKind": "supersede",
  "evidenceRefs": [{ "messageId": 129, "quote": "现在已经是清晨了" }]
}
```

当前 epoch 内时间自然推进到清晨，属于新状态取代旧状态，不表示先前的时间记录有误，因此不得产生 correction tombstone。

**❌ 模糊氛围当 scene_change**

```json
{
  "op": "setField",
  "path": "mood",
  "value": "感觉有点不一样了",
  "evidenceKind": "scene_change",
  "evidenceRefs": [{ "messageId": 121, "quote": "感觉有点不一样了" }]
}
```

"有点不一样"不是明确的场景变化，应输出 noop 或更具体的描述。

### 4.2 todoProposer

**✅ addItem + user_commitment（用户承诺稍后做某事）**

```json
{
  "op": "addItem",
  "value": { "text": "归还橡皮", "actor": "user", "requester": "user" },
  "evidenceKind": "user_commitment",
  "evidenceRefs": [{ "messageId": 121, "quote": "我明天会把橡皮还给她" }]
}
```

用户承诺自己归还橡皮，actor=user，requester=user。quote 是用户原话，明确表达承诺。

**✅ addItem + user_request（用户请求 assistant 稍后做某事）**

```json
{
  "op": "addItem",
  "value": { "text": "提醒归还橡皮", "actor": "assistant", "requester": "user" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 121, "quote": "明天记得提醒我把橡皮还给她" }]
}
```

用户请求 assistant 提醒自己，actor=assistant（assistant 执行提醒），requester=user（用户发起请求），待办内容是"提醒"而非归还本身。一句话同时包含承诺和提醒请求时允许生成两个 todo。

**✅ addItem + user_commitment + dueAt（用户承诺，带 deadline）**

```json
{
  "op": "addItem",
  "value": { "text": "去钓鱼", "actor": "both", "requester": "user" },
  "dueChange": { "mode": "set", "dueAt": { "mode": "relative", "days": 14 }, "timeAnchorMessageId": 130 },
  "evidenceKind": "user_commitment",
  "evidenceRefs": [{ "messageId": 130, "quote": "我们两周后去钓鱼吧" }]
}
```

LLM 只提取“两周”= 14 天，并明确 message 130 是时间 anchor。Reducer 以该 raw message 的数据库 `createdAt` 计算 `dueAt`，不使用 task/worker 执行时间。

**✅ addItem + user_commitment + dueAt（绝对日期）**

```json
{
  "op": "addItem",
  "value": {
    "text": "去玩",
    "actor": "both",
    "requester": "user"
  },
  "dueChange": { "mode": "set", "dueAt": { "mode": "absolute", "date": "2026-07-10" }, "timeAnchorMessageId": null },
  "evidenceKind": "user_commitment",
  "evidenceRefs": [{ "messageId": 133, "quote": "我们2026年7月10号去玩吧" }]
}
```

LLM 提取明确日期；Reducer 将该日期在用户时区下结束后的首个日界线持久化为 `dueAt`。`dueAt` 是 deadline，不是删除时间。

**✅ addItem + assistant_request（assistant 请求用户做某事）**

```json
{
  "op": "addItem",
  "value": { "text": "按时吃饭", "actor": "user", "requester": "assistant" },
  "evidenceKind": "assistant_request",
  "evidenceRefs": [{ "messageId": 131, "quote": "你要记得按时吃饭" }]
}
```

assistant 是发起者，user 是行动者。与 `user_commitment`（user 自发承诺）不同——assistant 应主动追问此类待办。

**✅ completeTodo + todo_completion**

```json
{
  "op": "completeTodo",
  "itemId": "todo:1",
  "evidenceKind": "todo_completion",
  "evidenceRefs": [{ "messageId": 140, "quote": "橡皮我已经还了" }]
}
```

**✅ updateItem + user_commitment（用户细化待办范围）**

```json
{
  "op": "updateItem",
  "itemId": "todo:1",
  "value": { "text": "归还橡皮和笔记本" },
  "dueChange": { "mode": "keep" },
  "evidenceKind": "user_commitment",
  "changeKind": "refine",
  "evidenceRefs": [{ "messageId": 135, "quote": "对了还有笔记本也要还" }]
}
```

新增同一承诺的执行范围是自然细化，不表示原待办“归还橡皮”是错误事实；只有明确说先前记错时才使用 correction。

**✅ addItem + assistant_commitment（assistant 承诺做某事）**

```json
{
  "op": "addItem",
  "value": { "text": "准备生日惊喜", "actor": "assistant", "requester": "assistant" },
  "evidenceKind": "assistant_commitment",
  "evidenceRefs": [{ "messageId": 132, "quote": "我来准备生日惊喜吧" }]
}
```

assistant 是行动者兼发起者。

**✅ cancelTodo + todo_cancel**

```json
{
  "op": "cancelTodo",
  "itemId": "todo:1",
  "evidenceKind": "todo_cancel",
  "evidenceRefs": [{ "messageId": 141, "quote": "橡皮不用还了" }]
}
```

**✅ expireTodo + todo_expiration**

```json
{
  "op": "expireTodo",
  "itemId": "todo:2",
  "evidenceKind": "todo_expiration",
  "evidenceRefs": [{ "messageId": 142, "quote": "那件事已经过了吧，不用管了" }]
}
```

用户澄清待办不再需要。与 `cancelTodo`（明确取消）的区别：expire 侧重"自然失效或被澄清为不再需要"，cancel 侧重"明确取消"。

**❌ 模糊愿望当 user_request**

```json
{
  "op": "addItem",
  "value": { "text": "想变好", "actor": "user", "requester": "user" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 121, "quote": "我希望能变好" }]
}
```

"希望能变好"是模糊愿望，不是明确请求/承诺，不应写入 todos。

**❌ 持续互动约定当 user_request**

```json
{
  "op": "addItem",
  "value": { "text": "沉默时先开口说明状态" },
  "evidenceKind": "user_request",
  "evidenceRefs": [{ "messageId": 123, "quote": "以后沉默的时候先说一声" }]
}
```

"以后沉默时先开口"不是可完成的一次性事项，当前 `todos` 应输出 noop；其他 target 独立判断。

### 4.3 agreementProposer

**✅ addItem + standing_agreement（持续互动约定）**

```json
{
  "op": "addItem",
  "value": { "text": "沉默时先开口说明状态" },
  "evidenceKind": "standing_agreement",
  "evidenceRefs": [{ "messageId": 123, "quote": "以后沉默的时候先说一声" }]
}
```

**✅ updateItem + standing_agreement（约定修订）**

```json
{
  "op": "updateItem",
  "itemId": "agreement:1",
  "value": { "text": "沉默超过几分钟时先开口说明状态" },
  "evidenceKind": "standing_agreement",
  "evidenceRefs": [{ "messageId": 130, "quote": "如果沉默很久就先告诉我一声" }]
}
```

**✅ cancelAgreement + agreement_cancel**

```json
{
  "op": "cancelAgreement",
  "itemId": "agreement:1",
  "evidenceKind": "agreement_cancel",
  "evidenceRefs": [{ "messageId": 140, "quote": "这个约定不用继续了" }]
}
```

**✅ updateItem + user_correction（用户修正约定内容）**

```json
{
  "op": "updateItem",
  "itemId": "agreement:1",
  "value": { "text": "沉默时先说明原因再开口" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 136, "quote": "不是先开口，是先说原因" }]
}
```

**✅ updateItem + assistant_correction（assistant 修正约定）**

```json
{
  "op": "updateItem",
  "itemId": "agreement:1",
  "value": { "text": "沉默超过几分钟时先说明状态" },
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 137, "quote": "其实之前说的是沉默很久才需要" }]
}
```

### 4.4 episodeProposer

**✅ addItem + recent_episode（近期有意义互动）**

```json
{
  "op": "addItem",
  "value": { "text": "两人在屋顶谈开了对离别的担忧并和解" },
  "evidenceKind": "recent_episode",
  "evidenceRefs": [{ "messageId": 121, "quote": "很怕你会走" }]
}
```

text 只描述事件的核心经过与结果；Renderer 决定标题、项目符号和最终措辞。

**✅ addItem + relationship_milestone（关系关键转折）**

```json
{
  "op": "addItem",
  "value": { "text": "双方第一次明确表达彼此信任" },
  "evidenceKind": "relationship_milestone",
  "evidenceRefs": [{ "messageId": 150, "quote": "我愿意相信你" }]
}
```

**✅ updateItem + user_correction（用户修正 episode 描述）**

```json
{
  "op": "updateItem",
  "itemId": "episode:7",
  "value": { "text": "雨夜争执后和解，用户澄清自己表达的是不安而非指责" },
  "evidenceKind": "user_correction",
  "evidenceRefs": [{ "messageId": 160, "quote": "我不是在指责你" }]
}
```

**✅ updateItem + assistant_correction（assistant 修正 episode 描述）**

```json
{
  "op": "updateItem",
  "itemId": "episode:7",
  "value": { "text": "雨夜争执后由 assistant 先打破沉默，双方随后和解" },
  "evidenceKind": "assistant_correction",
  "evidenceRefs": [{ "messageId": 161, "quote": "其实那天是我先开口的" }]
}
```

assistant 角色重新诠释互动经过，与 `user_correction` 权限相同。

**❌ 日常闲聊当 milestone**

```json
{
  "op": "addItem",
  "value": { "text": "一起吃了顿饭" },
  "evidenceKind": "relationship_milestone",
  "evidenceRefs": [{ "messageId": 145, "quote": "一起去吃饭吧" }]
}
```

普通日常不得进入 milestones，应输出 noop 或走 recentEpisodes。

### 4.5 profileRelationshipProposer

**✅ addItem + long_term_fact（明确陈述）**

```json
{
  "op": "addItem",
  "value": { "text": "姓名: 小明", "facet": "identity", "canonicalKey": "identity", "factBasis": "explicit" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我叫小明" }]
}
```

**✅ addItem + long_term_fact（行为推断）**

```json
{
  "op": "addItem",
  "value": { "text": "初识时较内向，熟悉后会更依赖对方", "facet": "interactionPattern", "canonicalKey": "open", "factBasis": "explicit" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我其实挺内向的，但熟了就会很粘人" }]
}
```

quote 是体现该行为的原话，推断理由写在 value.text 中，不放在 quote。

**✅ updateItem + long_term_fact（用户细化自己的档案）**

```json
{
  "op": "updateItem",
  "itemId": "userProfile:1",
  "value": { "text": "不喜欢被连续追问，情绪激动时尤其如此", "facet": "communicationBoundary", "canonicalKey": "followUpQuestions", "factBasis": "explicit" },
  "evidenceKind": "long_term_fact",
  "changeKind": "refine",
  "evidenceRefs": [{ "messageId": 170, "quote": "我情绪激动时尤其不喜欢被连续追问" }]
}
```

新陈述为既有沟通边界增加适用情境，是细化而非宣称旧档案错误。

**✅ forgetItem + user_forget（用户明确要求忘记档案项）**

```json
{
  "op": "forgetItem",
  "itemId": "userProfile:1",
  "evidenceKind": "user_forget",
  "evidenceRefs": [{ "messageId": 171, "quote": "请忘掉这条偏好" }]
}
```

forgetItem 不输出 value，也不把旧内容改写成“已作废”。

**❌ 一次性情绪当 long_term_fact**

```json
{
  "op": "addItem",
  "value": { "text": "情绪: 今天很难过", "facet": "communicationStyle", "canonicalKey": "open", "factBasis": "explicit" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "我今天好难过" }]
}
```

一次性情绪不构成 trait，不应进入 profile section。行为推断只在跨独立 semantic arc 累计出清晰、显著的行为模式时才成立。

### 4.6 worldFactProposer

**✅ addItem + long_term_fact（世界设定）**

```json
{
  "op": "addItem",
  "value": { "text": "世界设定: 存在魔法" },
  "evidenceKind": "long_term_fact",
  "evidenceRefs": [{ "messageId": 121, "quote": "这个世界是有魔法的" }]
}
```

**✅ updateItem + long_term_fact（assistant 细化世界设定）**

```json
{
  "op": "updateItem",
  "itemId": "worldFacts:2",
  "value": { "text": "世界设定: 魔法只在夜间生效" },
  "evidenceKind": "long_term_fact",
  "changeKind": "refine",
  "evidenceRefs": [{ "messageId": 175, "quote": "对了，这个世界的魔法只在晚上才管用" }]
}
```

该消息为既有 canon 增加生效条件，属于自然细化；若要使用 `assistant_correction + correct`，原文必须明确表达“之前说错了/先前设定有误”等事实纠正。

**✅ forgetItem + assistant_forget（assistant 明确撤回世界设定）**

```json
{
  "op": "forgetItem",
  "itemId": "worldFacts:2",
  "evidenceKind": "assistant_forget",
  "evidenceRefs": [{ "messageId": 176, "quote": "请忘记这条世界设定" }]
}
```

### 4.7 compactionProposer

**✅ mergeItems + memory_compaction（合并重叠 userProfile）**

```json
{
  "patchId": "compact-1",
  "op": "mergeItems",
  "itemIds": ["userProfile:1", "userProfile:2"],
  "value": { "text": "更适合在夜间长聊，并且熟悉后会更依赖对方" },
  "evidenceKind": "memory_compaction",
  "changeKind": "lifecycle"
}
```

value.text 是 source items 的自然、简洁合并，不引入新事实。evidenceGroups 由 Reducer 继承。

**❌ compaction 引入 source items 未表达的新事实**

```json
{
  "patchId": "compact-2",
  "op": "mergeItems",
  "itemIds": ["userProfile:1", "userProfile:2"],
  "value": { "text": "偏好: 夜间长聊 | 慢热 | 最近说想养猫" },
  "evidenceKind": "memory_compaction",
  "changeKind": "lifecycle"
}
```

维护模式只合并 source items 已表达的事实。

---
