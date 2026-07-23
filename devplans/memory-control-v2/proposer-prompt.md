# Memory Control 2.01 Proposer Prompt 契约

本文定义 Semantic Proposer 的职责、输入边界和语义行为。字段 shape 以 [Semantic 写入契约](semantic-write-contract.md) 为权威。

## 1. Prompt 管理

实际发送给模型的 prompt 位于 `modules/memory/prompts/*.md`，由统一 index 按 Proposer 加载：

| Proposer | 文件 | target sections |
| --- | --- | --- |
| `currentStateProposer` | `current-state-proposer.md` | `scene` |
| `todoProposer` | `todo-proposer.md` | `todos` |
| `agreementProposer` | `agreement-proposer.md` | `standingAgreements` |
| `episodeProposer` | `episode-proposer.md` | `recentEpisodes`, `milestones` |
| `userProfileProposer` | `user-profile-proposer.md` | `userProfile`（task 内专家） |
| `assistantProfileProposer` | `assistant-profile-proposer.md` | `assistantProfile`（task 内专家） |
| `relationshipProposer` | `relationship-proposer.md` | `relationship`（task 内专家） |
| `worldFactProposer` | `world-fact-proposer.md` | `worldFacts` |
| `compactionProposer` | `compaction-proposer.md` | 单个 maintenance section |

`profileRelationshipProposer` 只作为持久化 task、cursor、联合 schema 与提交身份存在，不注册或加载联合 prompt。Provider Adapter 将该 task 展开为表中的三个专用专家调用。

Prompt 不写死在 service、Compiler 或 provider adapter 中。Prompt、Semantic Schema 和 Harness fixture 必须同步变化。

## 2. Structured Output

每个 Proposer 使用 provider 原生 JSON Schema/tool/function structured output。职责分离：

- Schema：字段、action、source selector、目标 section 和必填项；
- Prompt：长期性、显著性、领域归属、事件粒度等语义判断；
- Provider Adapter：协议方言、transport schema、错误归一化；
- Compiler：ref/source/date/op 的确定性转换；
- Reducer：compiled patch 与 state/容量/事务约束。

Provider schema 校验通过不等于 change 可以写入。输出仍必须经过本地 Semantic Schema、Compiler 和 Reducer。

## 3. 通用决策规则

- 输出复制当前 `tickId/proposer`，`sectionResults` 恰好覆盖 target sections；
- normal status 为 `changes | noop | unable_to_decide`；
- compaction status 为 `changes | unable_to_compact`；
- `noop` 表示已理解且无需改变；`unable_to_decide` 只用于信息不足、指代冲突或无法唯一定位；
- 联合 Proposer 任一 section unable 时整个结果都会被原子扩窗重提或在二次 unable后整体丢弃；不要假设同一结果中其他 section 的 changes会被部分应用；
- writable ref 只用于目标；support ref 只用于辅助来源；不得编造 ref；
- normal change 至少引用 direct message 或 support Memory；二者均不要求属于 new batch；
- 同一 section 已存在同义内容时优先 update/noop，不重复 add；
- 对已经能确定的变化完整输出，不因猜测长度而省略；
- `correct` 是语义动作，但持久化后与 update 不区分；
- explicit forget 对所有 item sections 合法，scene forget 等价于 clear；
- 完成、取消、到期、忘记不能伪装成 text update；
- text 保留主体、对象、条件、范围、否定和例外，不写流水账或 source 未表达的推断；
- read-only support 可以独立支持 add/update/correct/forget/cancel；
- 敏感或成人内容只做客观、高密度概括。

Proposer 不得输出：

```text
真实 itemId
持久化 op
evidenceKind
quote
contentHash
facet/canonicalKey/factBasis
数据库字段名或 provenance 结构
```

## 4. currentStateProposer

- scene 只保存下一轮仍有用的当前 `location/time/mood/note`；
- 新值使用 `set`；明确修正使用 `correct`；明确失效无替代值使用 `clear/forget`；
- 未再次提到不能 clear；计划、疑问、假设不是已发生状态；
- 每个 field 独立 change；目标使用 writable field ref；
- support-only set/correct/clear/forget 均可表达；
- Scene text 不写人物档案或事件日志。

## 5. todoProposer

- 只记录明确、一次性、可完成/取消/过期的请求、承诺或共同计划；
- 愿望、普通问答、反复适用规则应 noop；
- add 提供 text/actor/requester，可选 dueAt；
- update/correct 提供 writable ref、dueChange 及必要领域字段；
- complete/cancel/expire/forget 使用专用 action；
- overdue 可 complete/cancel/forget；未来改期使用 update/correct + set；
- Wall-clock 到期不输出 expire，由 lifecycle 管理；
- relative dueAt 必须提供属于本 change `evidenceMessageIds` 的 `anchorMessageId`；
- 只有日号、没有明确年月时输出 `{mode:"dayOfMonth",day:1..31}`，并同样提供 direct `anchorMessageId`；Compiler 选择消息本地日期当天或之后最近一次有效的目标日号；
- support-only change 不得生成 relative/dayOfMonth date；已有 absolute deadline 可以直接表达或 keep；
- 不用 task.now、worker/Provider 时间补全日期；其他无法结构化的模糊日期保留在 text 并省略 dueAt。

## 6. agreementProposer

- 只记录未来反复适用的互动规则、边界或长期承诺；
- 一次性事项、单方偏好、关系描述和抒情应 noop；
- add/update/correct/forget 均可用；明确取消使用 `cancel`；
- 当消息明确结束关系、角色、角色扮演或互动模式时，cancel 明显依赖该上层情境的可修改约定；不取消仍可独立成立的规则；
- update/correct/cancel/forget 必须引用 writable agreement ref。

## 7. episodeProposer

- recentEpisode 是一到两句自然语言概括的连贯互动弧；
- 不使用固定“主题 > 结果 | 意义”模板；
- 保留理解后续所需的关键起因、稳定结果或重要未决问题；
- 只有 source 明确时才写后续意义；
- 不写逐消息时间线、动作流水账或进行中占位；
- 同一互动弧新发展优先 update 既有 ref；
- 每 task 通常 0–2 个 episode change，硬上限 3；
- milestones 只记录改变长期关系/剧情基线的转折，不默认和 recentEpisode 双写；
- recentEpisodes 与 milestones 都允许 add/update/correct/forget；
- correct 只改当前可见文本，不要求 suppress 旧 source。

## 8. profileRelationshipProposer

`profileRelationshipProposer` 是调度、cursor 与提交身份，不再用一次模型调用同时裁决三个 section。Provider Adapter 对同一 immutable artifact 展开三个专用调用；每个 prompt 与 structured schema 只拥有一个 section，三个结果通过本地 ref/source 契约后合并为原 proposer 的联合结果，再进入 Compiler/Reducer。三个专家均看到完整 observed window，不切块、不只看候选附近消息；模型覆盖配置默认继承 `profileRelationshipProposer`，也允许显式单独覆盖。

- 两个 Profile 与 relationship 保存跨场景可复用、会改善未来回应或维持角色/关系连续的内容；不以条目数量为目标，也不把“遗忘后必须造成严重错误”作为准入门槛；
- 每个专家以候选准入条件和动作选择规则约束生成，只输出 Schema 约束的终局，不输出分析过程；
- 覆盖维度是识别用 ontology，不是持久化字段：User 包括身份背景、项目能力、目标价值、兴趣偏好、边界、沟通方式和可观察互动倾向；Assistant 包括双方建立的身份、人格、价值、限制和稳定行为；Relationship 包括当前关系、称呼、信任亲密度、角色/权力结构、互动模式和共享边界；
- item 只输出 text 与 sources，不持久化 facet/key/factBasis；移除 typed metadata 不等于移除语义扫描维度；
- 明确且未来可复用的事实不要求出现“永远/以后/记住”；当前偏好或自我描述使用保守范围表达；多个独立片段才可归纳为可观察模式，且不得推断心理动机、诊断或敏感属性；
- 单次消息可以直接表达长期事实；单次普通动作、即时情绪、当前话题、事件流水和本轮测试步骤本身不进入 Profile；
- 用户希望怎样被回应通常进入 userProfile 或 standingAgreements，不固化为 Assistant 人格；section 由事实主体和语义决定，不由消息 role 决定；
- 新信息明确结束身份、关系、角色扮演或互动模式时，以 update/correct 刷新当前含义并处理依赖条目；同一维度的过去阶段、真相揭示或关系转变若能解释当前状态、维持共同经历连续性或避免误读，可以明确标注过去与当前后作为演化事实保留，整条无长期价值时才 forget；
- 每个 text 保持原子性；三个 sections 都允许 add/update/correct/forget；来源可以是 direct、support 或混合且不要求属于 new batch。
- Provider schema 根据 immutable artifact 动态枚举当前 section 可写 ref、辅助 ref 与可见 message id；模型不能把 Memory 整行、其他 section ref 或虚构消息 id 当成 selector。

## 9. worldFactProposer

- 只保存对话世界中持续成立、后续必须一致的客观设定；
- 普通常识、临时场景、观点、猜测、传闻、梦境、比喻、玩笑和互动约定应 noop；
- Assistant 装饰性扩写不能自动成为 canon；
- 与已有设定冲突但无法判断时使用 unable，而不是并列 add；
- 允许 add/update/correct/forget，来源可以是 direct、support 或混合。

## 10. compactionProposer

Compaction 只看一个 section 的可写短 refs，不读取 raw messages、read-only Memory 或 provenance。

- 输出 `{action:"merge", refs:[...], text}` 或 `unable_to_compact`；
- refs 至少两个且来自 writable list，同一输出的多个 merge 不复用 ref；
- merge text 必须短于 source texts 总字符数；
- 只能无损合并语义重复项，不能调和冲突、增加推断或丢失主体/条件/否定/范围；
- Todo 只合并 actor/requester/dueAt 相同的 active items；
- Profile/Relationship 不再有 facet/canonicalKey 相等要求；
- milestones 不跨阶段合并；
- recentEpisodes 不参与 compaction；
- 不输出 sources，Reducer 从 source items 继承。

## 11. User Payload

调用保持 `system prompt + Renderer artifact.publicInput`。不拼入存储 state JSON，不发送 private ref map。

Schema repair 只附加有界 validation feedback；不回传非法输出原文。Context expansion 扩大早期 messages，但继续使用首次 artifact 的 Memory 文本和 ref map。
