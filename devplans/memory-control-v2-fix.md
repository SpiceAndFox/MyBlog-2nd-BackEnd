# Memory Control v2 当前修复计划

> 文档性质：近期实施与验收计划
>
> 目标：先修复已经由 Alice 数据证明的问题，再决定是否继续扩展架构
>
> 延后方向见 [Memory Control v2.1 延后项](deferred/memory-control-v2.1/readme.md)

## 1. 当前判断

当前记忆效果差的主要原因不在 Renderer，而在以下环节：

1. Proposer 对明确内容输出了错误的 `noop` 或错误 patch。
2. Reducer 拒绝 patch 后，任务仍可能推进 cursor 并被标记为 `succeeded` / `healthy`。
3. 重建按 target 扫完整段历史，可能读取 source boundary 之后产生的状态。
4. 历史 scene 在重建时使用当前执行时间计算生命周期，导致刚写入就过期。
5. 当前测试能验证 schema 和确定性流程，但不能衡量真实模型的语义召回与误写。

因此，本轮不再引入新的通用语义处理平台。先建立可复现评测，修复确定性丢失，再针对真实失败调整模型和 prompt。

本文是实施计划，不替代 [Memory Control v2 顶层设计](memory-control-v2/memory-control-v2-overview.md)。实现若改变既有契约，必须同步修改对应的状态、算法和 Harness 文档，不能让本文与权威契约长期并存冲突。

## 2. 已确认的 Alice 证据

当前 generation 的最终结果表现为：长期档案、关系、里程碑和持续约定为空，仅保留两条逾期 todo、两条 episode，最新 previousScene 仍停留在较早的早餐场景。

任务记录进一步表明：

- 当前 generation 共执行 90 个 task，最终全部为 `succeeded`，六个 target 也全部为 `healthy`。
- 实际存在 15 个 `rejected` patch，但这些 rejection 没有阻止对应 cursor 推进。
- `729/730` 的“以后每天早上做早餐”完整位于 agreement task 的 new batch，proposal 仍为 `noop`。
- `1078–1080` 的两个“明天”事项被输出为 `days: 0`，最终立即成为 overdue。
- 部分 todo 和 episode 在后续窗口才被模型发现，随后因 `overlap_only_evidence` 被拒并永久跳过。
- 三明治完成 patch 使用了真实短回复“好吃”，但因 quote 信息字符过短被拒。
- schema repair 后可能从“存在候选 patch”退化成全 `noop`，任务仍继续推进。

另外，当前 generation 完成后，episode/profile prompt 又发生过修改。因此现有 `inspect` 结果不能直接代表当前 HEAD 的实际效果。

## 3. 本轮范围

本轮只做以下事情：

1. 建立 Alice 语义评测和 task shadow replay。
2. 阻止 rejection、schema repair 等路径静默丢失候选。
3. 修复短 quote、todo 相对日期、既有 item 引用等确定性问题。
4. 修复 rebuild 的时间顺序和 scene 事件时间。
5. 在固定评测集上比较当前模型、较强模型和精简 prompt。
6. 补齐尾批处理和语义诊断。

本轮不建设全局语义扫描器、通用候选账本、跨 tick profile 模式累计或通用 open-arc 状态。它们统一放入延后目录。

## 4. 实施顺序

### 4.1 先建立可复现评测

新增只读的 task shadow replay 能力，能够读取已持久化 `task_payload`，使用当前 prompt/model 重新生成 proposal，但不写入 memory state、cursor、event 或 task 状态。真实 rebuild 不属于 shadow replay，仍需单独执行和确认。

评测至少记录：

- task、target、source boundary 和 observed message IDs；
- model、provider adapter、prompt hash、输出 schema hash 和窗口配置；
- proposal 的 patch / noop / unable 数量；
- 本地 schema 与 Reducer 预检结果；
- accepted / rejected 数量和 reject reason；
- Alice 行为断言的通过情况。

先用同一批输入比较当前 HEAD、当前模型与较强模型。不得再根据一次 `inspect` 结果直接继续堆叠 prompt 规则。

### 4.2 阻止 silent loss

调整普通 proposal 的终局语义：

- 明确的语义 `noop` 和确定无副作用的重复项可以推进。
- schema、quote、evidence、非法操作、错误 itemId 等可修复问题不能被当作语义成功。
- 可修复问题应携带原因做一次受限重试；仍失败时保留 task 和输入，target 保持 degraded/halted，不推进会丢失该内容的 cursor。
- proposal 中存在可修复 rejection 时，不得只因事务成功提交就把 target 标为 `healthy`。
- schema repair 后从 patch 退化成全 `noop` 的情况必须可见，不能与普通 noop 混在一起。

`inspect:memory-v2` 或配套诊断报告必须展示 proposal、Reducer decision 和 rejection，而不是只展示最终 memory state。

### 4.3 修复 Evidence 与 Todo 的确定性问题

- 完整、精确匹配原消息的短回复可以作为证据；短中文回复不能仅因少于三个信息字符而被一律拒绝。
- update/complete/cancel 等操作只能引用当前 writable state 中真实存在的 item。
- force-drain 重建中出现合法 late discovery 时，不得仅因证据已经位于 overlap 就静默丢失；至少要形成可处理或明确失败的结果。
- “今天 / 明天 / 后天 / N 天后”等明确相对日期必须以原始时间表达所在消息和用户时区为准，并由确定性逻辑校验，不能完全相信模型给出的数字。
- 同一 todo 的建立、修订和完成必须落到同一 item，不能留下语义重复或已经完成却仍 overdue 的副本。

### 4.4 修复 Rebuild 语义

重建应沿原始消息时间线推进 source boundary，而不是先让一个 target 看完整段未来，再处理下一个 target。

每个重建 task 只能读取其 source boundary 当时可见的原始消息和 memory 状态。历史 scene 与相对日期使用消息事件时间计算；重放追到边界后，再以当前现实时间统一执行 housekeeping。

session 继续只作为存储/UI 元数据，不作为 scene、episode 或长期模式的语义边界。

### 4.5 再调整 Proposer

在上述确定性问题修复后，使用固定 Alice 评测比较：

- 当前模型与更强模型；
- 当前长 prompt 与精简 prompt；
- 不同的 batch/context/overlap 配置。

Prompt 只保留目标边界、必要语义规则和少量合成校准。Alice 的真实或高度同构案例进入评测集，不继续复制到生产 prompt。

本轮重点校准：

- agreement 不漏掉明确建立并得到接受的 recurring commitment；
- todo 正确处理建立、完成和相对日期；
- scene 能识别明确地点、时间、活动结束和回家；
- episode 按完整互动弧总结，不生成动作流水账；
- profile/relationship 保持保守，没有充分证据时允许为空；
- worldFacts 没有合格设定时保持为空。

### 4.6 处理尾批与健康状态

`lagThreshold` 只用于合并吞吐。生成结束、显式 flush 或达到最大等待时间后，不足阈值的尾批也必须进入现有 durable task 流程。

Target 报告为 `healthy` 至少要求：

- cursor 已覆盖要求的 source boundary；
- 没有未解决的可修复 rejection、schema failure 或 retry task；
- rebuild/force-drain 已真正完成；
- 没有 active 的相关质量诊断。

## 5. Alice 行为验收

以下断言只要求语义正确，不要求最终文案逐字一致：

| 原始消息                                              | 预期结果                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `528/529` 经常做草莓大福及接受                        | 建立或更新 recurring agreement，不得 noop                                        |
| `684/687/696` 的三明治承诺与 `724/727/728` 的完成过程 | 形成同一个 todo 生命周期并最终完成，不得继续 overdue                             |
| `729/730` 每天早上做早餐及接受                        | 建立 daily-breakfast agreement                                                   |
| `975–1077` 夜间外出、取回饼干并送回家                 | 作为完整互动弧评估；达到当前 episode 标准时形成一条完整 episode                  |
| `1078–1080` 明天的三明治和草莓大福                    | 形成两个一次性 todo，日期按 `days: 1` 解释                                       |
| 最后已超过 TTL 的 scene                               | currentScene 可以为空，但 previousScene 必须来自最近一次真实场景，而不是较早早餐 |
| 当前没有明确虚构 canon                                | worldFacts 保持为空                                                              |

同时必须满足：

- 上述内容若未写入，报告能明确区分 proposer noop、schema failure、Reducer rejection、生命周期清理和渲染过滤。
- 不得存在未解决的可修复 rejection 却仍显示 target healthy。
- 同一事实不得因重试、overlap 或 rebuild 重复创建。

## 6. 测试与验证

离线测试至少覆盖：

- 可修复 rejection 不推进 cursor；
- 一次修复重试成功与失败；
- 短消息精确 quote；
- 非法 itemId；
- schema repair 后全 noop 的诊断；
- 相对日期锚定；
- force-drain late discovery；
- rebuild 不读取未来状态；
- scene 使用事件时间并在末尾 housekeeping；
- 不足 lagThreshold 的尾批 flush。

真实模型评测与普通单元测试分开：单元测试保证确定性状态机，shadow replay 评估语义效果。正式重建前先在隔离 rehearsal 中生成报告并人工核对 Alice 断言。

## 7. 文档同步

实现本计划时，需要同步修订现有契约中与以下行为冲突的条款：

- 普通 rejected 是否推进 cursor；
- quote 的最小信息量；
- rebuild 的 target-major 调度与 task 时间；
- target healthy 的判断；
- 尾批等待规则。

对应 Harness 必须同时更新，不能只改代码或只改本文。

## 8. 完成定义

本轮修复完成需要同时满足：

1. Alice 行为断言通过当前选定模型的固定 shadow/rehearsal 评测。
2. 所有最终记忆都能追溯到原始消息和 accepted event。
3. 可修复 rejection、schema repair 和 retry 不再静默推进并伪装为 healthy。
4. rebuild 按 source 时间线运行，不读取未来状态，scene/日期使用正确事件时间。
5. 在线尾批能在有限时间内被处理。
6. `inspect` 能解释关键内容为什么写入、没有写入或被拒绝。

延后目录中的能力不属于本轮完成条件。
