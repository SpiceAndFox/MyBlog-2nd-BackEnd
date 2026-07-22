# 架构迁移 E 阶段：Chat RAG 与 LLM 端口

状态：已完成；2026-07-22 完成审计后已补齐显式注入边界

## 1. 完成范围

E 阶段将 Chat RAG 的 projection、retrieval、repository 和 degradation 归入 `modules/chat/rag`，并明确 Chat application 所需的 RAG、Memory 与 LLM 端口。完成审计进一步消除了 RAG 对根配置、数据库、日志和 `services/llm` 的直接依赖。本阶段未改变 HTTP、数据库 schema、Memory Control 2.01 数据契约、RAG 检索/降级语义或 Provider 协议。

- `services/chat/rag/` 的实现迁入 `modules/chat/rag/`，旧入口删除；
- `services/chat/productionModelPolicy.js` 迁入 `modules/chat/modelPolicy.js`；
- RAG 所有组件改为显式工厂，配置、database、logger 和 LLM 函数均由调用方提供；
- `app/composition/chatRag.js` 接收显式 Chat LLM runtime；RAG embedding/reranker 由 Chat RAG 子模块内部的实例工厂创建；
- 运维脚本通过同一 composition 工厂取得 RAG admin/projection 能力，不再从 Chat admin 入口穿透内部实现。

## 2. 当前结构与装配

```text
app/composition/chatRag.js
  └─ createChatRagModule({ config, database, logger, llm })
       ├─ createChatRagRepository
       ├─ createChatRagChunker
       ├─ createChatRagSceneRecall
       ├─ createChatRagRetriever
       ├─ createChatRagIndexer
       └─ createChatRagProjectionAdapter
```

`modules/chat/rag/index.js` 只组合已注入依赖，不读取全局配置、不创建数据库连接，也不加载 `services/llm`。`modules/chat/index.js` 仅公开 `createChatRagModule` 工厂；`modules/chat/admin.js` 只保留 Gist 与 recent-window 的显式运维工厂，不暴露 RAG Repository 内部函数。

RAG runtime 公开形状：

```text
retrieve({ userId, presetId, query, beforeMessageId, signal })
requestTurnIndexing({ userId, presetId, sessionId, userMessage, assistantMessage, ... })
requestDeleteFromMessage({ userId, presetId, fromMessageId })
projectionAdapter
privacyStore
admin.indexChatTurn / deleteChunksFromMessageId / listExistingTurnKeys
```

生产 Chat 只接收前三个运行时端口；Memory composition 只接收 `projectionAdapter` 和 `privacyStore`；脚本才使用 `admin`。

## 3. Chat application 端口

Chat application 通过 `createChatModule({ config, adapters })` 接收外部能力，不导入 RAG、Memory 或 LLM 实现。

### RAG

- `retrieve` 由 context compiler 调用；degradation 返回空结果与可观察状态，不阻断主 Chat Provider；
- `requestTurnIndexing` 与 `requestDeleteFromMessage` 在事务提交后触发 fire-and-forget 工作。

### LLM

```text
llm.complete({ providerId, model, messages, settings, signal })
llm.createStreamResponse({ providerId, model, messages, settings, signal })
llm.streamDeltas({ providerId, response })
```

### Memory source-write guard

```text
memory.lockSourceWriteGuard(userId, presetId, { client })
  → { sourceGeneration, privacyPending }
```

Chat `sendMessage` application use case 拥有 user/assistant 两个写入事务。在每个事务内，它先取得 Memory scope transaction lock 并读取 generation/privacy fence，再把同一个 `client` 与 generation 交给 Chat Repository。Chat Repository 只查询 Chat-owned 表，不直接读取 `chat_preset_memory` 或 `chat_memory_privacy_operations`。

## 4. 数据一致性

同一 scope 的以下操作共享由 Memory owner 提供的 PostgreSQL advisory transaction lock：

- Chat user message 插入；
- Chat assistant message generation fence 提交；
- Memory source mutation 与 rebuild generation 初始化；
- Memory privacy delete/reset。

锁、fence 读取和 Chat/Memory 写入均在同一 transaction client 上完成，因此不会把原本的原子检查拆成有竞态的独立查询。锁 key 只包含 scope 标识，不包含原始用户数据。

## 5. Chat LLM 最终归属

2026-07-23 的补充批次确认 RAG 是 Chat 子模块，而 Memory 使用独立 strict structured-output Provider，因此不存在三个独立 owner 共同消费一个高层 LLM service 的事实。`services/llm` 的受版本控制实现已删除：completion/provider/model/settings/SSE 归入 `modules/chat/infrastructure/llm`，embedding/reranker 归入 `modules/chat/rag/infrastructure`。

暂不建立 `shared/llm`。只有 transport、SSE 或协议能力出现跨 owner 的稳定复用时，才提取对应纯基础部分。

## 6. 完成审计修正

原阶段记录曾把下列项目列为“允许的过渡状态”：

- `modules/chat/rag/*` 直接依赖根 `config`、`logger`、`db` 和 `services/llm`；
- `services/chat/memoryRuntime.js` 保存可变的进程级 runtime facade；
- Chat Repository 直接读取 Memory-owned generation/privacy 表。

这个判断不合理，因为它们分别违反主计划的固定依赖方向、数据 owner、跨模块事务和无隐式单例规则。完成审计已将其全部删除，不再作为可重新引入的技术债基线。

## 7. 行为保持与验证

- RAG degradation 继续可观察且不阻断主 Chat Provider；
- Memory projection 开启时继续跳过旧 RAG turn indexing；
- rebuilding/missing checkpoint 继续 fail closed；
- projection stage/commit、generation fence、隐私清理与 checkpoint 语义不变；
- 非流式与 SSE 的 Chat LLM 端口不变。

最终验证（完成审计后）：

- `npm run check:architecture`：190 个 JavaScript 文件、337 条本地依赖边、无循环；
- `npm test`：334 项离线测试全部通过；
- 架构测试覆盖业务模块根依赖、跨模块内部导入、SQL data owner 和已删除 runtime facade；
- Memory persistence 测试覆盖 advisory lock、同一 transaction client、generation/privacy fence。

本阶段没有数据库 migration 或外部写入；回退边界是 RAG 工厂、Chat/Memory transaction guard、composition 接线、架构门禁和对应测试。
