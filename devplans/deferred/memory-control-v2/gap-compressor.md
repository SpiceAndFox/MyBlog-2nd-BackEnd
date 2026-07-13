# Gap Compressor（延后）

## 问题

当 target cursor 落后 recent window 起点时，gapBridge 需要补充 Memory 尚未覆盖、同时已离开 recent window 的 raw messages。Gap 可能超过独立字符预算，无法完整注入主模型上下文。

## 延后原因

LLM gapCompressor 需要新增：

- 一条新的 LLM 调用路径；
- 专用 Prompt/schema/Adapter 处理；
- generation、target、cursor、boundary、source hashes、model/prompt version 维度的缓存；
- 压缩失败、缓存失效和 Provider 错误处理；
- 压缩文本与正式 Memory 权威边界的 Renderer 规则；
- 新的 degraded 指标和 Harness。

当前收益不足以抵消这些复杂度。

## 当前替代方案

1. Gap 未超独立预算时，完整注入 raw messages。
2. Gap 超预算时，按 messageId 倒序选择最近 N 条可完整容纳的 raw messages，再按升序注入。
3. 不截断单条消息后伪装完整；无法容纳的消息（包括单条本身已超整个 gap 预算的消息）计入 omitted。
4. 输出记录 `gapTruncated=true`、omitted message count 和最早保留 messageId。
5. 用户看到 degraded 告警：“部分早期对话未在上下文中”。
6. 相关 target state 标记为可能滞后，不能无提示称为当前状态。

## 未来候选方案

对超预算 gap 调用 gapCompressor，生成明确标注为“尚未写入正式 Memory 的过渡历史”的有界摘要，并按 source hashes 和处理边界缓存。

未来实现需解决：

- 压缩结果不是正式 Memory authority；
- source edit/generation 变化时缓存必须失效；
- 同一 gap 不应在每轮请求重复调用；
- 压缩失败必须回退到当前最近 N 条方案并告警；
- 单条 raw message 本身超预算时，如何在不伪装完整原文的前提下做有界压缩、缓存和 source invalidation；
- 最终文本仍受主模型物理 context 上限约束。

## 重新评估条件

- 真实运行中 gap 截断频繁发生；
- 被省略的早期 gap 明显影响对话连续性；
- 主体 cursor/gapBridge/告警流程已经稳定；
- 新增调用延迟和成本可以接受。
