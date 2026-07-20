# Memory Proposer 职责分离计划

## 目标

让 LLM 只负责识别记忆语义，不再理解数据库存储结构或生成持久化 Patch。格式转换、字段补全和写入继续由确定性代码负责。

## 新链路

```text
Memory Renderer
  → Semantic Proposer LLM
  → 简单的领域级 Semantic IR
  → Deterministic Compiler
  → Validator / Reducer
  → Database
```

## 1. 渲染 Proposer 输入

- 将 Memory 和消息渲染成人类可读文本，不发送 `writableState` 等存储结构。
- 可修改的旧记忆使用任务内稳定短引用，如 `M1`、`M2`，不暴露真实 itemId。
- 消息保留 `messageId`，用于精确标记证据。
- 只提供当前 Proposer 需要的可写记忆、辅助上下文和消息窗口。

示意：

```text
[可更新记忆]
M1 | 用户偏好：喜欢吃番茄

[本批消息]
#1151 user：我现在已经很讨厌番茄了
```

## 2. 简化 Proposer 输出

- 每个 Proposer 使用自己的小型领域 IR，不再输出 `addItem`、`updateItem`、`evidenceKind` 等持久化协议。
- 输出只表达语义动作、目标引用、记忆内容、证据消息和必要的领域属性。
- 继续使用结构化 JSON，但 Schema 只约束简单 IR。

示意：

```json
{
  "changes": [
    {
      "action": "revise",
      "ref": "M1",
      "text": "用户讨厌吃番茄",
      "evidenceMessageIds": [1151]
    }
  ]
}
```

## 3. 增加 Deterministic Compiler

Compiler 负责将 Semantic IR 转换成现有持久化 Patch：

- 将短引用映射为真实 itemId；
- 将领域动作映射为具体 op；
- 根据 Proposer、section、消息 role 补充 evidenceKind；
- 规范化 todo 日期等领域属性；
- 生成 Validator 和 Reducer 所需的完整结构。

Compiler 不做新的语义判断。无法确定映射时拒绝转换，不猜测目标。

## 4. 简化证据

- Proposer 只选择精确的 `evidenceMessageIds`，不生成 quote。
- 系统根据 messageId 保存并校验来源信息和 content hash。
- window start/end 继续作为 task 级范围，不替代单条 Memory 的证据消息。

## 5. 保持写入边界

- LLM 不直接访问或修改数据库。
- Validator 和 Reducer 仍是唯一合法写入入口。

## 迁移顺序

1. 先为 `episodeProposer` 建立 Renderer、Semantic IR 和 Compiler。
2. 依次迁移 `profileRelationshipProposer`、`worldFactProposer`、`agreementProposer`、`todoProposer` 和 `currentStateProposer`。
3. 最后迁移 `compactionProposer`，并删除所有 Proposer 对持久化 Patch Schema 的直接依赖。
