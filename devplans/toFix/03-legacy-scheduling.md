# 子任务 03：Turn-less 历史数据的 Librarian 调度

## 状态与优先级

- 优先级：P1
- 状态：本地实现与验收完成，见 [08-implementation.md](./08-implementation.md)
- 目标：长时间 turn-less rebuild 中可以周期运行 Librarian，同时保持 checkpoint、恢复与去重简单确定

## 当前失效机制

周期 Librarian 以完整对话 turn ordinal 为水位。旧测试消息缺少 `turn_id` 和 `parent_user_message_id` 时，`listCompleteTurnBoundaries` 返回 0 个完整 turn，因此周期任务永远不触发。

最终 `runFinal` 仍可能执行，但整个 rebuild 期间产生的错误只能在末尾一次性处理。

## 选定方案

不回填历史 turn metadata，也不尝试从 user/assistant 交替推断真实 turn。

调度器使用两种明确水位：

- 正常数据：`complete_turn`，值为完整 turn ordinal；
- turn-less rebuild：`message_batch`，值为已经完整处理的确定性批次 ordinal，并保存对应 `boundaryMessageId`。

`message_batch` 只控制 Librarian 的运行频率，不声称恢复了真实对话 turn 语义。

## 确定性要求

- 批次划分只依赖固定配置、source generation 和有序消息边界；
- 相同输入必须产生相同批次 ordinal 和 `boundaryMessageId`；
- task 保存 `watermarkKind`、ordinal 和 boundary；
- checkpoint 使用相同三元组去重；
- retry、进程恢复和 rehearsal 重用已持久化边界，不重新猜测；
- source generation 改变后不沿用旧 checkpoint；
- final Librarian 继续按最终消息边界运行。

## Barrier 与一致性

- Librarian 只能在相关普通 target 到达同一 `boundaryMessageId` 后运行；
- `complete_turn` 和 `message_batch` 共用同一 barrier，不建立两套执行器；
- revision 变化时旧 refMap 失效；
- rebuild 恢复后不得重复提交已经完成的周期任务。

## 简化取舍

- 不做 turn metadata backfill；
- 不处理旧 schema 兼容或 migration；
- 不创建“legacy complete turn”这种容易与真实 turn 混淆的伪概念；
- 不为极端历史消息形态设计复杂配对启发式；
- 测试数据库可以重建，目标实现只支持最终水位模型。

## 验收标准

- turn-less rebuild 不再导致周期 Librarian 永久为 0 次；
- 相同输入、source generation 和配置生成相同批次边界；
- retry 和进程恢复不改变既定边界；
- checkpoint 和 final Librarian 均可去重；
- 正常 complete-turn 数据不受后备水位影响；
- 缺失回复、非交替消息和删除消息不会影响 `message_batch` 的确定性。
