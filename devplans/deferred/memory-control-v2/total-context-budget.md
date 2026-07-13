# 总 Context 预算与降级顺序（延后）

## 问题

当前各 context 组成部分分别有独立预算（Memory section 容量、GapBridge 逻辑预算、recent window 字符阈值等），但没有基于 provider/model 最大输入的统一最终裁剪优先级。在极端情况下，system prompt + RAG + Memory + GapBridge + recent window 的总和可能突破模型物理 context 上限，导致调用直接失败。

**两条独立调用链**，需要分别考虑：

1. **主聊天 context**：system prompt + RAG + Memory render text + GapBridge + recent window。这是当前问题主要关注的链，因为各 component 并列注入同一请求。
2. **Proposer context**：system prompt + writableState + readOnlyContext + observedMessages。Memory 业务层当前明确不设 Proposer envelope 总字符上限，只通过 Observer 缩小 batch 来处理；Provider 物理上限由 Adapter 处理。

两条链的预算算法应独立设计：主聊天的优先保证可用性（降级），Proposer 的优先保证正确性（缩小窗口而非砍内容）。

## 当前临时方案

当前部署使用 1M context window 的模型，主聊天 context 突破物理上限的概率极低，暂不实现统一裁剪。详见 [../memory-control-v2-overview.md](../memory-control-v2-overview.md) §3 部署假设。

## 延后原因

统一预算分配和降级顺序需要回答：

- 总预算如何基于 provider/model 最大输入动态计算？
- 降级优先级如何确定（哪些部分先砍、哪些保留到最后）？
- 仍无法容纳单条消息时返回什么明确错误？
- 降级是否影响 Memory 正确性（如砍掉 Memory readOnlyContext 是否影响 Proposer 判断）？

当前引入会增加 context compiler 的复杂度，且 1M context 模型下收益极低。

## 未来方向

至少定义基于 provider/model 最大输入的确定性预算分配和降级顺序：

**主聊天 context 降级**（保证可用性）：
- 保留到最后：system prompt + 最新 user message + Memory 当前 scene；
- 依次缩减：GapBridge 截断部分 → RAG 低相关结果 → Memory 非当前 scene 的 section → recent window 早期消息；
- 仍无法容纳单条消息时返回明确错误，不静默截断。

**Proposer context 预算**（保证正确性）：
- 不砍 writableState 或 readOnlyContext（砍掉会直接影响 Proposer 判断正确性）；
- 通过 Observer 缩小 batch 而非在 envelope 内做字符级裁剪；
- 单条消息仍无法处理时进入 degraded 并显式提醒。

## 重新评估条件

- 切换到较小 context window 的模型；
- 实际运行中出现总 context 超限导致调用失败；
- 各 context 组成部分的实际大小分布已可估算。
