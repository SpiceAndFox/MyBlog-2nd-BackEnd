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

- 任务概览优先展示 stage、输入变体、消息窗口、cursor、重试、revision 与执行时间；
- 详情分为“概览 / Provider I/O / 持久化 / 诊断”，大块数据可折叠，便于对照 Semantic IR 与 compiled proposal；
- 当前 Prompt、按当前代码重建的实际 Provider user payload、完整持久化 task envelope 与响应 JSON Schema；
- 分支持久化的 `stage_payload.semanticResult` / `stage_payload.unableResult` 与 `stage_payload.compiledProposal`；
- 由 immutable base artifact 和 `stage_payload.expandedArtifact` 重建的 effective 输入及其 Provider 投影；
- task 状态、重试、context expansion、ops 与 Schema 错误。

服务只监听 `127.0.0.1`，API 只执行参数化 `SELECT`。Prompt 未随 task 保存，因此界面展示的是当前工作区版本。无效的 Provider 原始输出按现有隐私设计不会落库，界面只能显示已持久化的校验错误。
