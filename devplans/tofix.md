# Memory v2 完整性修复总览

2026-09-09：P0/P1/P2 本地实现完成。离线回归 462/462，开启 thinking 的 DeepSeek 合成评估 10/10；数据库实机重建未执行。实施结果、限制和运行说明见 [08-implementation.md](./toFix/08-implementation.md)。

## 目标

修复 Memory v2 在长期运行和历史数据 rebuild 中暴露出的四类完整性问题：

- `worldFacts` 分类错误、复合化和单 item 无界增长；
- 当前直接证据与历史 lineage 混用，导致 `sourceRefs` 无界膨胀；
- turn-less 历史数据无法触发周期 Librarian；
- Librarian 缺少安全拆分、重写、重新归类和移除错误内容的能力。

本文只维护范围、原则、优先级、依赖和完成定义。调查证据、详细设计、未来构想与 rehearsal 样本放在 [`devplans/toFix/`](./toFix/) 的子任务文档中。

## 设计原则

### 只硬校验能够机械证明的事实

确定性层只负责：

- action 是否被 section 允许；
- target/ref 是否存在且被授权；
- `append` 是否只提供增量、`revise | correct` 是否提供完整结果；
- 拼接后的长度、容量和格式是否合规；
- evidence ref、base revision 和事务状态是否有效。

“是否属于同一语义维度”“是否真正重复”“证据在语义上是否充分”等开放式判断属于模型任务和 eval，不伪装成 reducer 能保证的硬规则。

### 用明确的变更操作取代含糊的 `update`

- `append`：只输出新增片段，由 reducer 按 section policy 确定性拼接；
- `revise`：旧内容过去成立，但当前状态自然变化；输出完整新表示；
- `correct`：旧内容从一开始就不准确；输出完整纠正结果。

不是所有 section 都允许 `append`。当前只把 `recentEpisodes` 定义为有界演进记录；Profile、WorldFact、Relationship 等继续保持原子快照语义。

### 优先保持简单和可维护

- 不增加无法证明正确性的语义 post-check；
- 不自动截断、自动拆分或自动推断 target；
- 不预先实现三轮 Librarian 和第二套复杂状态机；
- 当前系统尚未上线，不设计旧 schema 兼容或数据库迁移路径；测试数据库可按目标 schema 重建。

## 已确认结论

2026-07-27 对测试服务器 `user_id=1`、`preset_id=Lina-Weil` 的只读检查表明：

- 异常 WorldFact 是普通 `worldFactProposer` 连续 update 造成的，不是 Librarian 或 compaction 创建的；
- 现有 `update | correct` 最终都编译为 `updateItem`，并对历史和本次 `sourceRefs` 做并集；
- 旧消息缺少 turn metadata，周期 Librarian 没有获得执行机会；
- 现有 Librarian 无法准确修复同 section 复合 item，也无法为 split part 分配独立 evidence。

检查发生在 rebuild 中间状态，不能把当时的 Memory 当作最终输出，但上述机制问题不依赖最终 rebuild 结果。

详细证据与根因见 [00-problem-evidence.md](./toFix/00-problem-evidence.md)。

## 子任务与依赖

| 子任务 | 定位 | 优先级 | 依赖 | 文档 |
| --- | --- | --- | --- | --- |
| 写入动作与防线 | 引入 `append / revise / correct`，定义 section policy 和机械硬限制 | P0 | 无 | [01-write-path-guards.md](./toFix/01-write-path-guards.md) |
| Provenance 分层 | 按变更操作定义当前 evidence 与历史 lineage | P1 | P0 动作语义 | [02-provenance.md](./toFix/02-provenance.md) |
| Legacy 调度 | 使 turn-less rebuild 可周期运行 Librarian | P1 | 现有 barrier/checkpoint | [03-legacy-scheduling.md](./toFix/03-legacy-scheduling.md) |
| Librarian 操作模型 | 支持安全 revise/correct、同 section split、evidence 子集和受限 remove | P2 | Provenance 分层 | [04-librarian-operations.md](./toFix/04-librarian-operations.md) |
| 多轮 Librarian | 保留“审计、复核、执行”作为远期备选 | Future / 需评估 | 单轮基线与 rehearsal eval | [05-multiround-librarian.md](./toFix/05-multiround-librarian.md) |
| Episode/Milestone 分离 | 将近期互动弧识别与长期转折判断解耦 | Future / 独立演进 | turn boundary、provenance、barrier | [06-episode-milestone.md](./toFix/06-episode-milestone.md) |
| Rehearsal 与评估 | 用真实结构样本验证各阶段 | 贯穿所有阶段 | 对应子任务实现 | [07-rollout-rehearsal.md](./toFix/07-rollout-rehearsal.md) |

## 推荐实施顺序

### P0：建立简单、明确的写入语义

- 用 `append / revise / correct` 取代普通 item 的通用 `update`；
- 为每个 section 明确允许的 action 和 item 形态；
- 对 `append` 增量及最终文本、`revise | correct` 完整结果执行字符和容量限制；
- 增加 action、长度、来源数量和拒绝原因的指标与 inspect 输出。

### P1：修复基础一致性

- 让 `append` 保留旧 evidence 并加入新 evidence；
- 让 `revise | correct` 以结果文本声明的 evidence 替换当前直接支持；
- 完整演变历史只进入 event log；
- 为 turn-less rebuild 使用确定、幂等的后备调度水位。

### P2：增强纠偏能力

- Librarian 支持 move、revise、correct、通用 split、merge 和受限 remove；
- split/merge 只允许选择已授权 evidence 子集；
- 编译器只校验权限和结构，不宣称验证开放式语义正确性。

### Future：仅在证据支持时增加复杂度

- 单轮 Librarian 先建立质量、成本和 stale 基线；
- 只有 eval 证明必要时才增加条件式复核或完整三轮对话；
- Episode/Milestone 分离作为独立工作流推进，不阻塞本轮完整性修复。

## 总体验收标准

- 普通 item action 具有明确、可执行的存储语义；
- `append` 不能重写旧文本，且仅在授权 section 使用；
- `revise | correct` 不再自动继承全部历史 evidence；
- 单个 WorldFact 不再通过 `update` 持续吸收新事件；
- turn-less rebuild 能周期运行 Librarian；
- 同 section 复合 item 可以拆分，且每个 part 只选择授权 evidence；
- revision 变化后不会使用旧 ref 提交；
- event replay 可以恢复相同权威 state；
- 所有修改都有可解释的 audit event；
- 所有 section 的最短 noop 和正常 changes 测试均保留。

## 当前开发边界

- 系统尚未上线；直接设计目标 schema 和行为，不维护旧 schema 兼容或数据库迁移方案；
- 测试数据可以重建，不把为测试数据保留兼容性作为架构复杂度来源；
- 真实 `task_payload`、Memory 和消息正文不得提交为测试 fixture，CI 使用脱敏样本；
- 不修改 `modules/memory/prompts/*.md` 中受保护的 JSON 示例，除非 schema 变化使其失效且已获得用户明确同意；
- 本计划本身不授权对共享测试服务器执行写操作或中断正在运行的 rebuild。
