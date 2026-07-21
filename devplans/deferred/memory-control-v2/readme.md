# Memory Control 2.01 延后设计

本目录存放已经识别、但当前阶段推迟实现的问题。推迟不表示问题不存在，而是当前解决方案带来的实现与运行复杂度高于其即时收益。

当前条目：

- [Correction / Forget Suppression](correction-forget-suppression.md)：未来完整设计 active correction/forget 的防复活、RAG/Recall filtering、rebuild 终态和可选片段级 Suppression Proposer。2.01 当前没有任何 tombstone 或 suppression correctness gate。
- [Gap Compressor](gap-compressor.md)：使用 LLM 压缩超预算 gapBridge，并处理单条 raw message 本身超预算的情况。
- [Overdue Todo 长期容量](expired-scenes-overdue-capacity.md)：长期未完成 overdue todo 的归档、检索和清理策略。
- [容量降级策略](capacity-degradation.md)：compaction 失败后的自动降级方案，当前临时使用 halt + 手动调容量。
- [总 Context 预算](total-context-budget.md)：基于 provider/model 最大输入的统一最终裁剪优先级和降级顺序。
- [GapBridge 与 RAG 内容重叠](gap-bridge-rag-overlap.md)：GapBridge 完整原文与 RAG 片段召回的内容去重策略。
- [Scene Snapshot 与 Recall](scene-snapshot-recall.md)：基于 2.01 扁平 `sourceRefs` 的场景快照投影与精确回溯候选方案。
- [Proposer 独立 Few-shot Golden Messages](proposer-few-shot-golden-messages.md)：把合成 golden 作为独立 user/assistant 消息注入运行时；需先通过跨主题 A/B，并按 provider 原生 structured-output 协议编译。
- [运行时维护与长历史扩展](runtime-retention-and-history-scaling.md)：Retention 未调度/投影门不一致、全历史热路径、单 item 容量死路、context capability 与 migration 工具加固。
- [杂项](杂项.md)：暂时还没有详细分类

延后条目重新进入主设计前，必须重新评估调用成本、失败路径、schema/校验复杂度，以及当前确定性替代方案是否已经足够。
