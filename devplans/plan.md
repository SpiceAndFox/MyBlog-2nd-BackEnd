# Memory Control v2 顶层设计

## 文档定位

本文不是实施排期，也不是任务拆解清单。它定义的是情感类 AI Chat 的 memory control 顶层设计：系统为什么要重构、什么状态应被记住、谁有权改写记忆、哪些约束不可破坏，以及未来具体实现应服从哪些设计原则。

后续可以另写实施计划，但实施计划必须服务于本文，而不是反过来用局部工程便利牵引整体设计。

## 核心判断

当前 memory 系统的根本问题不是 prompt 不够强，而是把 memory 当成可反复重写的文本摘要。`rolling summary` 和 `core memory` 在多轮压缩、复述、再解释后，必然出现语义漂移、状态混杂、旧事实污染新上下文、短期剧情侵入长期档案等问题。

Memory Control v2 的设计前提是：memory 不是一段文本，而是一组可审计、可更新、可拒绝、可渲染的状态。LLM 可以帮助观察和提出修改，但不能直接成为最终状态的写入者。

## 设计目标

1. **受控**：所有 memory 变更必须经过结构化 patch、确定性校验和 reducer。
2. **有证据**：重要记忆必须能追溯到原始 message id 或明确事件来源。
3. **分层**：短期状态、近期剧情、待办、里程碑、长期核心档案分别维护，不混在同一段摘要里。
4. **低漂移**：旧 memory 不应被模型反复自由改写；允许局部增删改，不允许无边界全文重写。
5. **可恢复**：系统应能从事件日志、快照和原始对话重建状态，而不是依赖某一次 LLM 输出。
6. **可渲染**：底层是结构化状态，但注入主聊天模型时必须渲染成稳定、清晰、紧凑的上下文文本。
7. **可审计**：长上下文模型用于复核和提出修复建议，而不是绕过控制层直接覆盖 memory。

## 非目标

- 不追求兼容旧 rolling/core pipeline 的内部设计。
- 不把旧 checkpoint 机制视为新系统的核心能力。
- 不让模型输出的整段 summary 成为权威状态。
- 不把所有历史都塞入长期记忆。
- 不用缓存或兼容层掩盖状态模型错误。

## 旧系统取舍

旧系统中值得保留的是少量工程思想，而不是具体实现。

- 保留“同一 user/preset 的 memory 写入需要串行化”的思想。
- 保留“消息编辑、删除、会话恢复会导致 memory 失效”的思想。
- 保留“状态需要可恢复”的思想。
- 废弃“checkpoint 保存旧文本摘要”的中心地位。
- 废弃“旧文本 + 新对话 -> 新全文”的更新范式。
- 废弃 core memory 依赖 rolling summary checkpoint 的严格同步思路。

在 v2 中，checkpoint 应被重新理解为 **state snapshot**；恢复依据应是 **原始消息 + patch event log + snapshot**，而不是某个历史时刻的非结构化 summary 文本。

## 记忆分层

Memory v2 将记忆拆成不同生命周期的 section。每个 section 有自己的更新条件、删除规则和证据强度。

| Section | 作用 | 生命周期 | 更新原则 |
| --- | --- | --- | --- |
| `scene` | 当前场景锚点，如地点、时间、氛围 | 高频、覆盖式 | 存完整当前状态；无变化则不改 |
| `participants` | 当前人物状态，如情绪、动作、意图 | 高频、覆盖式 | 只记录当前状态，不承载长期人格 |
| `todos` | 未完成承诺、约定、澄清项 | 中频、事件型 | 支持创建、完成、取消、过期；删除必须有证据 |
| `recentEpisodes` | 最近几次有意义互动 | 高频、滑动窗口 | 允许追加和合并，不允许反复改写旧含义 |
| `milestones` | 关系或剧情关键里程碑 | 低频、近似归档 | 默认 append/merge；普通日常不得进入 |
| `core` | 长期事实、偏好、人格、关系模式 | 低频、晋升制 | 必须有稳定证据；不接受单次临时事件污染 |

这套分层的重点不是“标题变多”，而是每个 section 的写入权、删除权、更新频率和证据要求不同。

## 状态模型

权威 memory 应是结构化 state，而不是文本。

概念形态：

```js
{
  v: 2,
  rolling: {
    scene: {},
    participants: {},
    todos: [],
    recentEpisodes: [],
    milestones: []
  },
  core: {
    worldFacts: [],
    userProfile: [],
    assistantProfile: [],
    relationship: []
  },
  meta: {
    coveredUntilMessageId: 0,
    sections: {}
  }
}
```

每个可追踪 item 应包含：

```js
{
  id,
  text,
  evidenceMessageIds,
  confidence,
  createdAtMessageId,
  updatedAtMessageId,
  expiresAtMessageId,
  tags
}
```

`scene` 和 `participants` 这类当前状态可以更轻量，但仍应记录最后更新时间和证据来源。`core`、`milestones`、`todos` 必须具备更强证据约束。

## 写入控制模型

Memory v2 的写入链路分为四个职责层：

1. **Observer**：读取近期对话、当前 state 和 section meta。
2. **Proposer**：LLM 根据输入提出结构化 patch proposal。
3. **Reducer**：纯代码校验 patch，并按 section 规则决定 accept/reject/noop。
4. **Renderer**：把被接受后的 state 渲染成主聊天模型可读的 memory 文本。

LLM 的职责是“提出候选变更”，不是“保存最终记忆”。最终写入必须由 reducer 决定。

典型 patch 概念：

```json
{
  "op": "setField",
  "section": "scene",
  "path": "location",
  "value": "教室室内",
  "evidenceMessageIds": [123, 124],
  "confidence": 0.86
}
```

Reducer 至少应处理：

- schema 校验
- message id 证据校验
- confidence 阈值
- section-specific 规则
- 重复与冲突
- 删除保护
- 长度预算
- 过期策略

## 删除与遗忘原则

遗忘不是让模型随手“压缩掉”。不同 section 的遗忘规则不同：

- `scene` 和 `participants` 可以被新状态覆盖。
- `recentEpisodes` 按窗口和重要性自然滚动。
- `todos` 的删除需要完成、取消、失效或澄清结果。
- `milestones` 默认不删除，只允许合并、纠错或去重。
- `core` 删除和修改应最保守，必须有明确冲突证据或用户修正。

这使“遗忘”成为确定性策略，而不是摘要模型的副作用。

## 长上下文模型的角色

DeepSeek 官方文档显示，`deepseek-v4-flash` 已提供 1M context、384K max output，并支持 JSON Output 和 Tool Calls；DeepSeek 官方发布说明也将它定位为快速、经济的 V4 选择。参考：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[V4 Preview Release](https://api-docs.deepseek.com/news/news260424)。

这类长上下文低成本模型让 memory v2 可以更大胆，但不能回到“全量重写文本”的旧路。

它适合承担：

- 大窗口审计：检查当前 state 是否缺证据、过期或冲突。
- 候选晋升：从长历史中发现可能进入 `core` 的稳定模式。
- 迁移辅助：把 legacy summary 转成候选 patch，而不是直接信任。
- 重建辅助：在原始消息和 patch log 上提出修复建议。

它不应承担：

- 直接覆盖最终 memory state。
- 无证据删除旧记忆。
- 把全历史重新总结成一段新的权威文本。

## 上下文注入原则

主聊天模型不应该感知内部 patch log、event log 或 reducer 细节。它只需要收到清晰的 memory 渲染结果。

渲染输出应满足：

- 区分长期核心记忆与近期状态。
- 明确哪些是当前状态，哪些是历史背景。
- 避免把旧场景强行延续到当前回复。
- 遇到与用户当前陈述冲突的内容，应提示模型优先澄清。
- 文本稳定，避免每次渲染都换表达。

底层 state 可以复杂，但注入给主模型的文本必须克制、可读、低噪声。

## 与 RAG 的边界

Memory v2 和 RAG 不是互相替代。

- Memory 保存当前可用状态、长期偏好、关系模式和关键里程碑。
- RAG 负责从历史对话中召回具体场景、原话和细节。
- Memory 应高精度、低容量、可控。
- RAG 可高召回、按查询动态取用。

一个事实如果只在某次旧对话中重要，但不应持续影响当前关系状态，它更适合留在 RAG，而不是进入 core memory。

## Prompt 管理原则

Memory worker prompt 应从 `prompts/` 读取，不能继续散落或写死在 service 文件中。Prompt 是 memory policy 的一部分，必须能被版本化、审阅和替换。

所有 worker 输出必须结构化。解析失败、schema 失败、证据失败时，系统应记录失败原因，但不得改写权威 state。

## 成功标准

Memory Control v2 成功，不是因为摘要更漂亮，而是因为它在长线聊天里表现出以下性质：

- 场景不变时不会被反复润色和漂移。
- 当前人物状态能及时更新，但不会污染长期人格。
- 待办能创建、完成、取消和过期，不会变成永久幽灵项。
- 里程碑只记录真正重要的关系或剧情转折。
- core memory 不被临时剧情、一次性互动或错误 summary 污染。
- 修改、删除、重建后，memory 能解释“为什么现在是这个状态”。
- 主聊天模型拿到的是稳定上下文，而不是越来越混乱的历史压缩文本。

## 设计一句话

Memory Control v2 的本质是：用 LLM 观察历史，用结构化 patch 表达变化，用确定性 reducer 控制写入，用 renderer 给主模型提供稳定上下文。
