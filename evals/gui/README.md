# Memory Proposer Task Viewer

只读查看 `chat_memory_tasks` 与 `chat_memory_ops_log` 中持久化的 proposer task。

```bash
npm run gui:memory-v2
```

然后打开 <http://127.0.0.1:4317>。自定义端口：

```bash
npm run gui:memory-v2 -- --port 4318
```

界面按 scope 和 generation 展示：

- 当前 Prompt、持久化 task envelope 与响应 JSON Schema；
- 成功持久化的 `stage_payload.persistedProposal`；
- task 状态、重试、context expansion、ops 与 Schema 错误。

服务只监听 `127.0.0.1`，API 只执行参数化 `SELECT`。Prompt 未随 task 保存，因此界面展示的是当前工作区版本。无效的 Provider 原始输出按现有隐私设计不会落库，界面只能显示已持久化的校验错误。
