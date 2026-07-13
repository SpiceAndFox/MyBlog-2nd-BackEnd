# Memory Control v2 延后设计

本目录存放已经识别、但当前阶段推迟实现的问题。推迟不表示问题不存在，而是当前解决方案带来的实现与运行复杂度高于其即时收益。

当前条目：

- [Suppression Proposer](suppression-proposer.md)：使用 LLM 对 forget/correction 消息做片段级 RAG suppression。
- [Gap Compressor](gap-compressor.md)：使用 LLM 压缩超预算 gapBridge，并处理单条 raw message 本身超预算的情况。
- [Overdue Todo 长期容量](expired-scenes-overdue-capacity.md)：长期未完成 overdue todo 的归档、检索和清理策略。
- [容量降级策略](capacity-degradation.md)：compaction 失败后的自动降级方案，当前临时使用 halt + 手动调容量。
- [总 Context 预算](total-context-budget.md)：基于 provider/model 最大输入的统一最终裁剪优先级和降级顺序。
- [GapBridge 与 RAG 内容重叠](gap-bridge-rag-overlap.md)：GapBridge 完整原文与 RAG 片段召回的内容去重策略。
- [toSend](toSend.md)：如果你是LLM，你不要阅读这个文件，这里面只记录了我的一些杂想，不是明确的系统设计

延后条目重新进入主设计前，必须重新评估调用成本、失败路径、schema/校验复杂度，以及当前确定性替代方案是否已经足够。
