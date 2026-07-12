# 总 Context 预算与降级顺序（延后）

## 问题

当前各 context 组成部分分别有独立预算（Memory section 容量、GapBridge 逻辑预算、recent window 字符阈值等），但没有基于 provider/model 最大输入的统一最终裁剪优先级。在极端情况下，system prompt + RAG + Memory + GapBridge + recent window 的总和可能突破模型物理 context 上限，导致调用直接失败。

具体表现：

- 最新单条 raw message 即使超过 recent threshold 也完整保留；
- GapBridge 预算独立，但仍计入物理上限；
- RAG、Memory、recent window、system prompt 没有统一的最终裁剪优先级；
- Proposer envelope 明确不设总字符边界。

"由 Adapter 处理"只能把问题转化成调用失败，不能保证聊天可用。

## 当前临时方案

当前部署使用 1M context window 的模型，总 context 突破物理上限的概率极低，暂不实现统一裁剪。

## 延后原因

统一预算分配和降级顺序需要回答：

- 总预算如何基于 provider/model 最大输入动态计算？
- 降级优先级如何确定（哪些部分先砍、哪些保留到最后）？
- 仍无法容纳单条消息时返回什么明确错误？
- 降级是否影响 Memory 正确性（如砍掉 Memory readOnlyContext 是否影响 Proposer 判断）？

当前引入会增加 context compiler 的复杂度，且 1M context 模型下收益极低。

## 未来方向

至少定义基于 provider/model 最大输入的确定性预算分配和降级顺序，例如：

- 保留到最后：system prompt + 最新 user message + Memory 当前 scene；
- 依次缩减：GapBridge 截断部分 → RAG 低相关结果 → Memory readOnlyContext 部分 → recent window 早期消息；
- 仍无法容纳单条消息时返回明确错误，不静默截断。

## 重新评估条件

- 切换到较小 context window 的模型；
- 实际运行中出现总 context 超限导致调用失败；
- 各 context 组成部分的实际大小分布已可估算。
