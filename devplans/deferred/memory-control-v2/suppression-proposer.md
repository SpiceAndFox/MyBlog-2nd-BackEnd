# Suppression Proposer（延后）

## 问题

Forget/correction 的 evidence message 可能同时包含多个互不相关的事实。当前确定性方案会把整条 suppressed message 从 RAG projection 排除，因此可能连带丢失其中仍然有效的内容。

## 延后原因

片段级精确 suppression 需要新增：

- 一次 LLM 调用；
- 专用 suppressionProposer；
- 新的 structured output schema；
- 原文片段校验与 RAG sanitized projection；
- Provider 失败、unable 和非法输出的降级路径；
- 对 correction、forget、hard delete 不同语义的测试矩阵。

这些机制显著增加实现和排错复杂度。当前先接受“整条消息排除”的保守副作用。

## 当前替代方案

1. RAG chunk 保存全部 source messageId/contentHash 映射。
2. Forget/correction 写 message-level context-suppression tombstone。
3. 删除与 suppressed message 相交的 chunks。
4. 重新分块时跳过整条 suppressed message。
5. RAG 查询再次过滤 suppressed source。
6. Recall 的候选 refs、raw window 和最终文本应用同一 source 过滤；rebuild 清 dirty 前也做 suppression 终态校验。
7. Raw chat message 不修改。

## 未来候选方案

SuppressionProposer 输入 raw message、被 forget/correction 的 item 和 evidence，输出需要从 RAG projection 删除的连续原文片段，例如：

```json
{
  "removeQuotes": [
    "需要删除的连续原文片段"
  ]
}
```

未来实现仍应满足：

- 只能选择删除原文，不能生成 replacement text；
- removeQuote 必须在 raw message 中匹配；
- 至少一个删除片段覆盖目标 evidence；
- raw message 保持不变，只重建 sanitized RAG projection；
- LLM 失败或校验失败时回退为整条消息排除；
- 精确 suppression 不能削弱 forget 的保守保证。

## 重新评估条件

- 整条消息排除在真实数据中造成明显的 RAG 召回损失；
- message-level suppression 指标表明大量消息包含多个独立事实；
- 主体 Memory/RAG/forget 流程已经稳定，新增 LLM 路径不会妨碍核心排错。
