# 架构迁移 H 阶段：Chat LLM owner 归位

状态：已完成
完成日期：2026-07-23

## 1. 决策

RAG 是 Chat 子模块；Memory 使用自己的 strict structured-output Provider、schema compiler、preflight 和恢复语义，并未消费原 `services/llm`。因此不建立 Chat/RAG/Memory 共用的高层 `shared/llm`，而是把原 `services/llm` 按真实 owner 归入 Chat。

## 2. 当前结构

```text
modules/chat/infrastructure/llm/
  index.js                    — catalog/runtime 实例工厂
  providerRegistry.js         — 实例级环境与 Provider registry
  providerDefinitions/        — Chat Provider/model/settings metadata
  chatCompletionGateway.js    — adapter 路由
  adapters/                   — OpenAI-compatible / Anthropic / Google GenAI
  models.js / settingsSchema.js / sse.js

modules/chat/rag/infrastructure/
  embeddings.js
  reranker.js

modules/memory/infrastructure/providers/
  ...                         — 保持独立，不与 Chat completion 合并
```

## 3. 单例清理

- `createChatLlmCatalog({ environment })` 为每个进程上下文创建独立 Provider registry、model catalog、settings schema 与 OpenRouter attribution；
- `createChatLlmRuntime({ catalog, config })` 创建 completion gateway；
- embedding/reranker 接收显式 RAG config、fetch 与 attribution；
- production model policy 改为绑定环境的实例，不再使用 `configuredEnvironment`；
- 根 `config.loadApplicationConfig` 接收 Chat LLM catalog 和 Memory config loader，不再导入 LLM 或业务模块实现。

## 4. 接线与退役

`createApplicationComposition` 与 `createCommandContext` 创建 Chat LLM catalog/runtime，并将同一实例注入 Chat、RAG 和相关脚本。`services/llm` 的全部受版本控制 JavaScript 文件已删除，未保留 forwarding facade；未受版本控制的本地环境文件不由迁移修改。

架构测试锁定以下约束：

- `services/llm` 不得重新出现 JavaScript 实现；
- Chat LLM/RAG infrastructure 不得读取根 config；
- Provider environment、OpenRouter attribution 与 production model policy 必须保持实例隔离。

## 5. 行为边界

Chat completion、SSE、Provider/model/settings、RAG embedding/reranker/degradation 行为保持不变。Memory 的 structured-output schema、严格 tool call、Provider preflight、重试和恢复语义未改动。没有 database migration 或外部写入。

最终验证：

- `npm run check:architecture`：190 个 JavaScript 文件、337 条本地依赖边、无循环；
- `npm test`：334 项离线测试全部通过；
- `git diff --check`：通过。
