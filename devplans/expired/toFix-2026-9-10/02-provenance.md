# 子任务 02：Provenance 分层

## 状态与优先级

- 优先级：P1
- 状态：本地实现与验收完成，见 [08-implementation.md](./08-implementation.md)
- 前置：[01-write-path-guards.md](./01-write-path-guards.md) 的 `append / revise / correct` 动作语义

## 问题

当前 `sourceRefs` 同时表达：

1. 支持 item 当前文本的直接 evidence；
2. item 经历 add/update/correct/merge/split 的完整历史 lineage。

因为所有文本更新都进入同一个 `updateItem` 并合并旧、新来源，当前 evidence 只增不减，最终无法回答哪些消息仍直接支持当前文本。

## 目标语义

- **当前直接支持**：权威 item 上的 `sourceRefs`，只表达当前文本所声明的支持来源；
- **历史 lineage**：event group、event 和 snapshot 中保存的完整演变记录。

系统不尝试确定性证明 evidence 在语义上充分，只验证 ref 是否真实、可见、被授权，并按 action 执行明确的来源规则。

## 各操作的来源规则

### `add`

当前 evidence 等于本次 change 声明并通过授权校验的 evidence。

### `append`

旧文本仍保留，因此当前 evidence 为：

```text
旧 item 当前 evidence ∪ 新增片段 evidence
```

此处并集是有明确含义的：结果文本确实同时包含旧内容和新片段。

### `revise | correct`

旧文本被完整替换，因此当前 evidence 直接替换为结果文本声明的 evidence，不再自动继承全部历史来源。

如果新完整文本保留了旧事实，模型可以通过已授权的旧 item ref 继续选择对应来源；Compiler 只负责展开和校验这些选择，不判断语义充分性。

### `split`

每个 part 分别选择授权 evidence 子集，不复制源 item 的全部来源。

### `merge`

结果选择支持合并后文本的授权 evidence，不无条件合并所有历史来源。

### `remove | forget | cancel`

当前 item 被移除或进入终态，操作原因和当次 evidence 写入 event；历史版本由 event log 保留。

## 时间字段语义

- `createdAtMessageId`：item 初次创建时的消息边界；不要求永远存在于当前直接 evidence 中；
- `updatedAtMessageId`：最近一次成功改变该 item 的消息边界；不再从当前 `sourceRefs` 的最大值反推；
- event 记录每次 action 的 boundary、直接 evidence 和结果状态。

这样时间字段描述生命周期，`sourceRefs` 描述当前支持，两者不再互相冒充。

## 简化取舍

- P1 继续使用平面 `text + sourceRefs`，不引入 segment 数组；
- `append` 的片段级历史由 event log 恢复，不在权威 item 中建立第二套嵌套结构；
- 不静默截断来源；
- 不设计旧 schema 兼容或数据迁移，测试数据库直接按目标 schema 重建；
- replay、snapshot 和 rebuild 只需要支持目标语义。

## 验收标准

- `append` 保留旧 evidence 并加入新片段 evidence；
- `revise | correct` 替换当前 evidence，不继承无关历史来源；
- split/merge 只接受已授权 evidence 子集；
- `createdAtMessageId`、`updatedAtMessageId` 与 evidence 各自表达单一概念；
- event replay 从 snapshot 和 events 恢复完全相同的目标 state；
- 一个反复 revise/correct 的短 item 不再积累所有历史 `sourceRefs`；
- 测试覆盖 add、append、revise、correct、split、merge 和终态操作。
