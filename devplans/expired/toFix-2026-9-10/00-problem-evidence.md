# 子任务 00：问题证据与根因

## 状态

已确认问题；本文作为其他子任务的事实基线，不直接定义最终实现。

## 调查背景

2026-07-27 对测试服务器 `user_id=1`、`preset_id=Lina-Weil` 的 Memory v2 数据进行了只读检查。检查时该 scope 仍处于 rebuild 中：

- 源消息边界为 `8195`；
- 各 target 仅处理到约 `4550`；
- 观察对象是重建过程中的中间状态，不是最终 Memory。

即便如此，现有数据已经暴露出结构性问题：

- `worldFacts` 收录大量人物互动、关系规则和具体事件；
- 单个 item 不断吸收彼此独立的事件，形成超长复合条目；
- `sourceRefs` 随 update 做历史并集，逐渐失去“当前文本直接证据”的含义；
- 多个 section 存在重复、近重复、复合断言和 provenance 膨胀；
- Librarian 的周期调度在这批历史数据上没有运行。

## WorldFact 异常样本

检查时最大的 `worldFacts` item：

- 当前长度：923 个 Unicode 字符；
- 当前 `sourceRefs`：112 条；
- 初始写入：66 字、4 条 `sourceRefs`；
- 此后由 `worldFactProposer` 多次以 `updateItem` 扩张；
- 历史上最长达到 1078 字；
- 内容主要由人物亲密互动、关系约定、场景事件和角色反应组成，不符合 WorldFact 的存续测试。

该 item 不是由 Librarian 或 compaction 创建的，而是普通 `worldFactProposer` 对同一 target 连续 update 造成的。

## Librarian 实际尚未运行

检查时：

- `chat_memory_tasks` 中不存在 `target_key=librarian` 的 task；
- `chat_memory_librarian_checkpoints` 中不存在该 scope 的 checkpoint；
- 5126 条源消息的 `turn_id` 和 `parent_user_message_id` 全部为空；
- `listCompleteTurnBoundaries` 因此返回 0 个完整 turn；
- 当前 rebuild 尚未完成，最终的 `runFinal` 也尚未发生。

所以当前问题不能简单归因于“Librarian 判断错误”。更准确的结论是：

1. 上游 proposer 正在持续制造错误和膨胀；
2. 周期 Librarian 在 turn-less 历史数据上没有获得执行机会；
3. 即使最终 Librarian 被调用，现有操作语义也不足以完整、准确地修复这些数据。

## 根因

### 1. `update | correct` 缺少可执行的存储语义区分

当前 section 只有总 item 数和总渲染字符预算，没有普遍适用的单 item 字符上限。只要 section 尚未超过总预算，单条 WorldFact 即使接近 1000 字仍可被接受。

Prompt 区分自然发展 `update` 与事实纠错 `correct`，但两者最终都编译为同一个全量 `updateItem`。Reducer 无法从操作本身判断模型是在追加进展、自然修订还是纠正错误，只能接受完整新文本并合并来源。

“是否仍属于同一 canon 维度”是开放式语义判断，不能通过确定性 post-check 可靠解决。修复方向应是把存储动作改为机械可执行的 `append / revise / correct`，由 section 明确允许哪些动作，并用长度、权限、revision 等硬不变量限制写入。

后续任务：[01-write-path-guards.md](./01-write-path-guards.md)。

### 2. `sourceRefs` 同时承担直接证据与历史 lineage

`updateItem` 会把旧 item 的全部 `sourceRefs` 与本次 patch 的 `sourceRefs` 做并集。长期运行后：

- item 的来源数量只增不减；
- 一个短文本可能挂载数百条历史消息；
- 无法判断哪条消息直接支持当前文本中的哪个断言；
- split、merge、dedupe 会进一步传播膨胀的来源集合。

完整历史已经存在于 event log，不应继续复制到当前 item 的直接支持字段中。

后续任务：[02-provenance.md](./02-provenance.md)。

### 3. Librarian 的操作能力不足

现有 Librarian 首期只维护：

- `standingAgreements`
- `worldFacts`
- `userProfile`
- `assistantProfile`
- `relationship`

存在以下缺口：

- 无法把误写入长期 section 的事件移动到 `recentEpisodes` 或 `milestones`；
- `splitMove` 要求至少一个 part 改变 section，不能对分类正确但包含多个独立断言的 item 做纯同 section 拆分；
- `splitMove` 会把原 item 的全部 `sourceRefs` 复制给每一个 part；
- 缺少明确的原子化重写操作；
- 缺少对“不属于任何长期 section、也不应恢复为近期事件”的错误内容进行可审计淘汰的操作；
- 只读 Memory 文本不足以让模型为拆分后的每个断言准确选择证据子集。

后续任务：[04-librarian-operations.md](./04-librarian-operations.md)。

### 4. turn-less 历史数据使周期调度失效

Librarian 周期调度以完整对话 turn ordinal 为水位。旧数据没有 `turn_id` 和 `parent_user_message_id`，导致完整 turn 数恒为 0。

重建完成后仍会执行一次 final Librarian，但整个长 rebuild 过程中没有周期清理，错误 item 可以持续膨胀到最后才被一次性处理。

后续任务：[03-legacy-scheduling.md](./03-legacy-scheduling.md)。

## 调查操作边界

此次检查没有：

- 修改服务器文件；
- 修改共享测试数据库；
- 运行 Librarian；
- 中断正在执行的 rebuild；
- 执行任何 migration 或 `--apply` 操作。
