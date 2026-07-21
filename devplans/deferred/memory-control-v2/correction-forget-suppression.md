# Correction / Forget Suppression（延后）

## 当前 2.01 行为

Memory Control 2.01 的 correction/update 只改变 active value，forget 只移除 active item/scene field：

- 不写 context-suppression tombstone；
- 不过滤 raw source；
- 不过滤 RAG/Recall；
- rebuild 不做 suppression terminal filter；
- 旧 source 可以在后续任务或 rebuild 中再次促成 Memory；
- privacy hard delete 仍执行真实物理删除，不属于本计划。

本延后项重新进入主设计前，禁止在某个 section 或某条查询路径局部恢复半套 suppression。

## 需要解决的问题

未来若产品需要“纠正/忘记后旧内容不再从任何上下文复活”，必须同时覆盖：

1. active Memory state；
2. persisted raw provenance；
3. RAG chunk 构建和查询末端；
4. Recall/Scene Recall候选、raw window与最终文本；
5. source rebuild终态；
6. capacity replay与stale proposal；
7. correction链和后续未suppressed source；
8. message-level与片段级精度；
9. retention、privacy hard delete与审计。

## 候选基础设计

- durable tombstone key至少为 `userId/presetId/messageId/contentHash`；
- correction/forget state revision与tombstone必须原子提交；
- projection physical cleanup只用于收敛，查询末端filter才是correctness gate；
- rebuild必须允许历史顺序重放，但在target恢复healthy前做确定性终态filter；
- compiled proposal replay必须重新应用source suppression gate；
- tombstone跨sourceGeneration保留，privacy hard delete时物理清除；
- sourceRefs仍只保存raw provenance，不建立Memory-to-Memory图。

## 可选片段级 Suppression Proposer

Message-level suppression 会连带隐藏同一消息中的无关事实。若真实数据证明召回损失明显，可增加独立 Suppression Proposer：

```json
{
  "removeSpans": [
    { "messageId": 121, "start": 8, "end": 24 }
  ]
}
```

未来方案必须使用稳定offset/内容hash校验，只允许选择原文片段，不能生成replacement事实。Provider失败时的保守降级、片段重叠合并、embedding重建和查询filter需作为同一完整设计。

## 重新评估条件

- correction/forget 后旧内容复活造成真实用户伤害；
- RAG/Recall召回旧source成为稳定失败模式；
- message-level suppression的召回损失有量化证据；
- 2.01 Semantic/Compiler/Reducer链已稳定，有能力承担额外correctness状态机。
