# 子任务 01：写入动作与防线

## 状态与优先级

- 优先级：P0
- 状态：本地实现与验收完成，见 [08-implementation.md](./08-implementation.md)
- 目标：用简单、明确、可机械执行的操作语义阻止 item 被任意全量重写或无界扩张

## 核心原则

确定性层不判断“是否属于同一语义维度”“是否为真正的 WorldFact”或“证据是否在语义上充分”。这些属于模型任务和 eval。

确定性层只保证：

- action 是该 section 明确允许的；
- target 存在且被授权；
- `append` 只携带增量文本；
- `revise | correct` 携带完整结果文本；
- 最终长度、容量、ref、revision 和事务状态有效。

## 动作语义

### `add`

创建新的独立 item。模型提供完整文本和本次 evidence。

### `append`

表达同一有界演进记录的新进展：

- 模型只输出新增片段，不重复旧文本；
- reducer 读取权威旧文本并按 section policy 拼接；
- 模型不能修改或删除旧片段；
- 拼接后的完整 item 仍受 `maxItemChars` 限制。

### `revise`

旧内容过去成立，但当前状态自然变化。模型输出完整的新当前表示，reducer 替换旧文本。

### `correct`

旧内容从一开始就不准确。模型输出完整纠正结果，reducer 替换旧文本。

`revise` 和 `correct` 都是替换操作，但必须保留不同的审计原因。它们不再与 `append` 共用含糊的 `updateItem` 语义。

### 生命周期动作

`forget | cancel | complete | expire | clear` 保留各自已有的领域含义，不通过字符串操作模拟状态迁移。

## Section policy

| Section | Item 形态 | 允许的自然变化 | 不采用的行为 |
| --- | --- | --- | --- |
| `scene` | 当前字段快照 | `set/revise`、`correct`、`clear` | 不 append 历史状态 |
| `todos` | 结构化任务状态 | 字段 revise/correct、complete/cancel/expire | 不拼接责任人、日期或状态 |
| `standingAgreements` | 当前有效规则及生命周期 | `add/revise/correct/cancel/forget` | 不把互相冲突的新旧条款拼在一起 |
| `recentEpisodes` | 有界互动弧 | `add/append/correct/forget` | 不允许模型全量 update 覆盖旧进展 |
| `milestones` | 原子长期转折 | `add/revise/correct/forget` | 不用 append 堆积多个普通事件 |
| `worldFacts` | 当前 canon 快照 | `add/revise/correct/forget` | 不 append 事件流水或独立规则 |
| `userProfile` | 原子 Profile 维度 | `add/revise/correct/forget` | 不用逗号把不同维度塞入同一 item |
| `assistantProfile` | 原子 Profile 维度 | `add/revise/correct/forget` | 不用逗号把不同维度塞入同一 item |
| `relationship` | 当前关系模式快照 | `add/revise/correct/forget` | 暂不建立无限关系时间线 |

如果未来确实需要关系演进历史，应设计独立、有界的时间线表示，而不是直接开放 `relationship.append`。

## Append 格式

P0 只为 `recentEpisodes` 开放 `append`：

```text
旧互动弧 + " → " + 新增片段
```

` → ` 是已定义的数据呈现规则，不用于推断语义。模型负责判断新片段是否属于该互动弧；系统只负责按规则拼接和限制结果。

不为 Profile 使用逗号 append。Profile 已经是 item 列表，新维度应 `add`，原维度自然变化应 `revise`。

## 硬限制

- 每个自然语言 section 配置 `maxItemChars`；
- `append` 同时限制增量长度和拼接后的总长度；
- `revise | correct | add` 限制完整结果长度；
- section 不允许的 action 直接拒绝；
- 不自动截断、自动拆分、自动改变 action 或自动寻找其他 target；
- schema 或硬不变量失败时，整个 semantic result 走现有受限 repair；repair 耗尽后不提交任何变化，保持任务原子性。

阈值按 section 的表达目标和正常样本分布确定。字符数是硬限制；句子数、主题数、词汇重合度等不作为确定性拒绝条件。

## WorldFact 处理

WorldFact 的准入和分类继续由 proposer 负责：

- 稳定外部世界设定才进入 WorldFact；
- 人物偏好、关系、承诺、共同经历和具体事件应进入其他 section 或保持 noop；
- 新 canon 维度用 `add`；
- 现实自然变化用 `revise`；
- 旧记录原本错误用 `correct`。

P0 不增加第二个语义分类器或所谓确定性 WorldFact post-check。质量通过 prompt、真实样本 eval 和后续 Librarian 纠偏控制。

## 可观测性

至少记录：

- action 和 section；
- `append` 增量字符数与最终字符数；
- `add/revise/correct` 结果字符数；
- 当前 `sourceRefs` 数量；
- action 不允许、target 无效、长度超限等机械拒绝 reason；
- inspect 中各 section 的最大 item 长度和来源数量。

## 验收标准

- `update` 不再作为普通文本 item 的通用动作；
- `append` 不能覆盖或修改旧文本；
- 只有 `recentEpisodes` 可以 append，且 reducer 固定使用 ` → ` 拼接；
- Profile、WorldFact、Relationship 的自然变化使用 `revise`，纠错使用 `correct`；
- 超过 `maxItemChars` 的结果无法提交；
- 系统不包含伪装成确定性保证的语义身份检查；
- 非法结果失败后 state 保持不变；
- noop、正常 action、非法 action、边界长度和 repair 耗尽均有测试；
- 不改写受保护 prompt JSON 示例，除非 schema 变化使示例失效并已获得明确同意。

## 非目标

- 不自动判断同一语义维度；
- 不自动拆分复合 item；
- 不用额外模型调用执行语义 post-check；
- 不清理已有测试数据；
- 不设计旧 schema 兼容或数据库迁移路径。
