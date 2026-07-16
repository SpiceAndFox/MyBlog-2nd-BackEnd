# Proposer 独立 Few-shot Golden Messages（延后）

## 定位

本文记录把合成 golden 示例作为独立 `user` / `assistant` 消息注入 Memory Proposer 请求的候选方案。它不同于 Harness golden fixture：

- Harness fixture 是离线评测真值，不发送给线上模型；
- few-shot golden messages 是每次 Provider 调用的运行时输入，会影响 token、延迟和模型行为。

当前不实现运行时 few-shot，正式行为仍以 [Proposer Prompt 与 Schema](../../memory-control-v2/proposer-prompt.md) 为准。

## 当前方案

每次 Proposer 调用只发送：

1. 精简、领域中性的 system prompt；
2. 当前 Memory task envelope 作为 user message；
3. strict JSON Schema 或强制 tool call 约束输出；
4. Reducer 对 evidence、重复项、pattern 门槛和 policy 做确定性复核。

生产 prompt 可以保留少量抽象判定校准，但不得包含真实用户、preset 或调试会话的情节细节。

## 延后原因

1. 目前没有跨主题固定评测证明独立 few-shot 相对精简零样本有稳定净收益。
2. 单一示例容易造成主题、措辞和 patch 数量锚定；多样示例又会持续增加每次调用的输入 token。
3. Provider wire 不同，不能共用一段普通 assistant JSON：
   - OpenAI JSON Schema transport 可使用结构化 assistant 内容；
   - 当前 DeepSeek strict-tools transport 必须使用符合协议的 assistant tool call；若协议要求完成 tool turn，还需对应 tool result，不能伪造为普通文本。
4. 示例必须与 proposer、schema、provider/model snapshot 和 prompt version 一起版本化；schema repair、retry、rebuild 与 preflight 必须复用同一 bundle，不能在同一 durable task 中漂移。
5. 直接从生产对话挑 golden 会造成数据泄漏与过拟合；示例只能来自人工合成的领域中性 fixtures。

## 候选设计

若重新启用评估，Prompt loader 升级为版本化 bundle，而不是只返回字符串：

```js
{
  version,
  systemPrompt,
  fewShotMessages,
}
```

传输层按 provider 协议编译 `fewShotMessages`，逻辑顺序为：

1. system instructions；
2. 一组或多组合成 example user envelope；
3. 对应的 provider-native assistant structured output/tool-call transcript；
4. 当前真实 task envelope。

要求：

- 按 Proposer 和 provider/model 组合单独配置，默认关闭；
- 示例覆盖正例、noop、unable、update 和高风险误提取边界，不能只展示 addItem；
- 示例主题与线上评测集分离，且人物、地点、物品、措辞多样；
- 示例输出必须通过当前 `buildOutputSchema` 和本地业务 validator；
- prompt bundle version/fingerprint 进入可观测 telemetry；不得记录原始生产 payload；
- schema repair 只附加校验反馈，不更换 few-shot 集。

## A/B 评测

至少比较：

- A：当前精简 zero-shot；
- B：独立 few-shot golden messages；
- 必要时 C：只保留 system prompt 内的抽象边界校准。

评测集需覆盖：

- episode 聚合、跨 batch update、普通日常 noop、milestone 过度晋升；
- profile explicit 与一次性动作区分、observedPattern 独立片段门槛、主体归属；
- overlap-only、同义重复、correction、forget、unable_to_decide；
- 不同主题、关系阶段、角色语气和消息长度；
- DeepSeek strict-tools 与其他已支持 transport。

指标至少包括：

- patch 级 precision/recall，且将错误长期记忆的 false positive 设为高权重；
- episode fragmentation、重复 add、milestone/profile 过度晋升率；
- output schema invalid、schema repair 与 Provider retry 率；
- input tokens、端到端延迟和调用成本；
- 不同重复运行和模型 snapshot 下的稳定性。

实验开始前必须预先登记验收阈值，不能看到结果后修改标准。

## 移出 Deferred 的条件

同时满足以下条件后才能进入主设计：

1. 已有不含生产会话数据的跨主题固定评测集和可重复运行脚本；
2. few-shot 相对 zero-shot 在预登记指标上有稳定净收益，尤其降低高成本 false positive，且没有不可接受的漏记回归；
3. token、延迟和费用增量已进入批准预算；
4. 每个支持的 transport 都有 provider-native transcript 编译、preflight、repair/retry 和协议测试；
5. 有按 Proposer/provider/model 开关的灰度与回滚方案。

在这些条件满足前，不修改当前 `system + 当前 task user message` 的生产调用结构。
