# 子任务 06：Episode 与 Milestone 识别分离

## 状态

- 定位：Future / 独立演进
- 当前不阻塞 WorldFact、provenance 和 legacy Librarian 修复
- 依赖：可靠的完整 turn boundary、目标 provenance 语义和普通 target barrier

## 问题

当前 `episodeProposer` 同时维护 `recentEpisodes` 和 `milestones`，要求模型在同一个短消息窗口中既识别近期互动弧，又判断其是否改变长期关系或剧情基线。

两种判断时间尺度不同，容易把强烈情绪、普通和解、单次温馨互动或尚未稳定的事件过早升级为 milestone。

这是模型职责拆分方案，不试图用确定性规则判断什么事件“真正重要”。正确性通过输入范围、结构约束和 eval 控制。

## 职责与动作

### `episodeProposer`

高频运行，只维护 `recentEpisodes`：

- 新的独立互动弧使用 `add`；
- 同一互动弧的新进展使用 `append`，模型只输出新增片段；
- 旧互动弧描述从一开始就不准确时使用 `correct`；
- 明确不应保留时使用 `forget`。

Reducer 使用 ` → ` 拼接 append 片段，并执行增量长度与最终总长度限制。它不判断新片段是否真的属于同一互动弧。

### `milestoneProposer`

低频运行，只维护 `milestones`：

- 新的长期转折使用 `add`；
- 转折的当前长期意义自然变化时使用 `revise`；
- 旧记录从一开始就不准确时使用 `correct`；
- 明确失去长期意义时使用 `forget`。

Milestone 是原子长期转折快照，不开放 append，也不复制完整 episode 过程。

## Milestone 输入范围

Writable Memory 只包含全部现有 `milestones`。只读输入限定为：

- 最近 N 个完整 turn 范围内形成或发生实质变化的 `recentEpisodes`；
- `userProfile`；
- `assistantProfile`；
- `relationship`；
- `standingAgreements`。

默认不提供 `scene`、`todos` 和 `worldFacts`，避免扩大输入和误判来源。

N 是显式配置，并以完整 turn boundary 定义窗口。task 保存窗口起止 boundary，retry、恢复和 rehearsal 重用相同输入。

Profile、relationship 和 agreements 只作为比较背景，不能在结构上独立授权 milestone change。每个 milestone change 至少选择一个本轮授权的 `recentEpisodes` ref；Compiler 只验证这个结构条件，不声称验证该 episode 是否真的构成长程转折。

## 调度与一致性

```text
普通消息处理
  -> episode / profileRelationship / agreement 推进
  -> 建立一致 boundary barrier
  -> milestoneProposer 读取已提交结果
  -> 提交 milestone
```

`profileRelationshipProposer` 会读取 milestones，因此不要求同一 boundary 内双向反复运行直至收敛。新 milestone 从下一处理周期起供它使用，接受一个周期的确定性延迟，避免依赖环和 revision churn。

原 `recentEpisodes` item 继续按滑动窗口淘汰；milestone 只表达长期基线变化，不把 episode 移入长期 section。

## Evidence 规则

- episode append：旧 evidence 与新增片段 evidence 做并集；
- episode correct：当前 evidence 替换为完整纠正结果声明的 evidence；
- milestone add/revise/correct：只使用本轮授权 evidence；
- 不无条件并入 episode、Profile、relationship 或 agreement 的全部历史 lineage；
- 语义支持是否充分由模型与 eval 评估，Compiler 只检查授权关系。

## 验收标准

- `episodeProposer` 不再产生或修改 `milestones`；
- recent episode 的进展通过 `append` 产生，模型不能全量重写旧文本；
- milestone 不开放 append；
- `milestoneProposer` 不直接读取未沉淀为 episode 的短期原始事件；
- 静态 Profile、relationship 或 agreement 不能单独授权 milestone change；
- 每个 milestone change 至少引用一个本轮窗口内授权的 episode；
- barrier、retry、rebuild 和恢复使用相同窗口与 revision；
- 两个 proposer 之间不存在同 boundary 循环调度；
- 明确转折、边界争议和强情绪但 noop 的样本进入 eval，而不是被描述为确定性可证明条件。
