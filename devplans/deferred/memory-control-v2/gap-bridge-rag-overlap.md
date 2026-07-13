# GapBridge 与 RAG 内容重叠（延后）

## 问题

GapBridge 注入 `C < messageId < R` 区间的完整 raw messages，RAG 也可能召回同一区间的消息片段。两者在 context compiler 层并列注入时会产生内容重叠：同一条消息既以完整原文出现在 GapBridge segment，又以片段召回出现在 RAG segment。

当前文档没有定义是否需要去重，还是接受重复（GapBridge 是完整原文、RAG 是片段召回，语义角色不同）。

## 当前临时方案

接受重叠，不做去重。GapBridge 提供完整原文覆盖，RAG 提供语义相关召回，两者角色不同。

## 延后原因

去重策略需要回答：

- 去重粒度是消息级还是片段级？
- 去重后是否影响 RAG 的语义召回完整性？
- GapBridge 和 RAG 的优先级如何确定？
- 去重逻辑放在 context compiler 还是各 segment 内部？

当前 GapBridge 和 RAG 的重叠在实际使用中影响有限，引入去重会增加 context compiler 复杂度。

## 重新评估条件

- 实际运行中重叠内容显著浪费 context 预算；
- 用户或模型因重叠内容产生混淆；
- 总 context 预算优化（见 [总 Context 预算](total-context-budget.md)）需要消除重叠。
