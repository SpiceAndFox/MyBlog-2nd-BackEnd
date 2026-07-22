# 架构迁移 E 阶段：Chat RAG 与 LLM 端口

状态：已完成
完成日期：2026-07-22

## 1. 完成范围

E 阶段将 Chat RAG 的 projection、retrieval、repository 和 degradation 整体归入 `modules/chat/rag`，明确了 Chat application 对 Memory、RAG 和 LLM 的输入输出端口，并将 Chat 生产模型策略收口到 Chat 模块。本阶段未改变 HTTP 路径、数据库 schema、Memory Control 2.01 数据契约、RAG 检索/降级语义、LLM Provider 协议或业务规则。

1. `services/chat/rag/` 的 8 个文件迁入 `modules/chat/rag/`，新建子模块运行时入口；
2. `services/chat/productionModelPolicy.js` 迁入 `modules/chat/modelPolicy.js`，经 Chat 模块公开入口再导出；
3. 全部生产调用方、运维脚本和测试切换到 Chat 模块公开入口；
4. `services/chat/rag/` 与 `services/chat/productionModelPolicy.js` 旧入口删除，不保留兼容转发层。

## 2. RAG 子模块结构

```text
modules/chat/rag/
  index.js              — 子模块运行时入口（retrieve / requestTurnIndexing / requestDeleteFromMessageId / createChatRagProjectionAdapter）
  templates.js          — RAG prompt 片段模板渲染（纯函数）
  sourceRefs.js         — content hash（纯函数）
  chunker.js            — turn 分块与 embedding 文本构造
  repo.js               — chat_rag_chunks / chat_messages 仓储（pgvector 检索）
  sceneRecall.js        — 检索后场景回忆（调用 LLM chat completion）
  retriever.js          — 检索编排：embed → 向量搜索 → rerank → MMR → 场景回忆 → 上下文装配；degradation 在此闭环
  indexer.js            — turn 索引与 fire-and-forget 请求包装
  projectionAdapters.js — Memory v2 projection drain 适配器（stage/commit，惰性加载依赖）
```

`modules/chat/rag/index.js` 只暴露运行时所需的最小 API；仓储内部函数（`deleteAllChunks`、`countStaleChunks`、`listExistingTurnKeys` 等）由 Chat 模块内部直接引用对应文件，不进入子模块运行时入口。

## 3. Chat 端口契约

Chat application 通过 `createChatModule({ config, adapters })` 的工厂参数接收所有外部依赖，不直接导入 Memory、RAG 或 LLM 的实现。当前端口形状：

### RAG 端口（`adapters.rag`）

```text
rag.retrieve({ userId, presetId, query, beforeMessageId, signal })
  → { enabled, messages, sources, stats }
rag.requestTurnIndexing({ userId, presetId, sessionId, userMessage, assistantMessage, userContent, assistantContent })
rag.requestDeleteFromMessage({ userId, presetId, fromMessageId })
```

- `retrieve` 由 `contextCompiler` 在上下文编译时调用；degradation 返回 `{ enabled, messages: [], sources: [], stats }` 而不阻断主 Chat Provider。
- `requestTurnIndexing` / `requestDeleteFromMessage` 由 `sendMessage` / `editMessage` 在 turn 提交后触发，为 fire-and-forget。

### LLM 端口（`adapters.llm`）

```text
llm.complete({ providerId, model, messages, settings, signal }) → { content }
llm.createStreamResponse({ providerId, model, messages, settings, signal }) → async iterable
llm.streamDeltas({ providerId, response }) → async iterable
```

- `sendMessage` 使用 `complete`（非流式）或 `createStreamResponse` + `streamDeltas`（SSE）；`gist` 使用 `complete`。
- Chat application 只依赖这三个方法签名，不依赖 `services/llm` 的内部结构。

### Memory 端口（`adapters.memory`）

由 `services/chat/memoryRuntime.js` 提供的 Memory v2 runtime facade 注入（Phase C 建立）。Chat application 调用 `memory.assembleContext`、`memory.privacyHardDelete`、`memory.mutateSourceAndRebuild` 等；Memory 不识别 Chat/RAG 表实现，projection drain 通过 `createChatRagProjectionAdapter` 由 composition 注入。

### Provider / 模型目录 / 策略

```text
adapters.providers       — services/llm/providers（provider 定义与配置）
adapters.models          — services/llm/models（模型目录）
adapters.settingsSchema  — services/llm/settingsSchema（设置 schema 校验）
adapters.isModelAllowed  — modules/chat/modelPolicy（生产模型允许列表）
```

## 4. productionModelPolicy 归位

`services/chat/productionModelPolicy.js` 迁入 `modules/chat/modelPolicy.js`（内容不变），四个导出（`configureProductionModelPolicy`、`loadProductionModelPolicy`、`isChatModelAllowed`、`isMemoryModelAllowed`）经 `modules/chat/index.js` 公开入口再导出。

调用方切换：

| 调用方 | 原路径 | 新路径 |
| --- | --- | --- |
| `app/composition/chat.js` | `services/chat/productionModelPolicy` | `modules/chat`（合并到已有 destructure） |
| `app/composition/createApplication.js` | `services/chat/productionModelPolicy` | `modules/chat`（合并到已有 destructure） |
| `app/composition/commandContext.js` | `services/chat/productionModelPolicy` | `modules/chat` |
| `services/serverLifecycle.js` | `./chat/productionModelPolicy` | `../modules/chat` |
| `test/server/lifecycle.test.js` | `services/chat/productionModelPolicy` | `modules/chat` |

`modules/chat/index.js` 对 modelPolicy 采用即时 require（零导入、零副作用）；对 RAG 运行时函数采用惰性 getter，避免不需要 RAG 的调用方在导入时触发 config/db/LLM 加载。

## 5. services/llm 决策

`services/llm` 暂不迁入 `shared/llm`。当前 `services/llm` 的真实消费者只有 Chat（`chatCompletions`、`embeddings`、`reranker`、`providers`、`models`、`settingsSchema`）以及 Chat 运维脚本；Memory v2 拥有独立的 `modules/memory/infrastructure/providers`，不依赖 `services/llm`。

触发 `shared/llm` 评估的条件：当稳定的 transport、SSE 或协议适配能力出现多个真实消费者（非 Chat 模块），且接口已稳定时，再决定是否仅将通用协议适配部分迁入 `shared/llm`。在此之前不创建抽象目录。

## 6. 公开入口与运维入口

- `modules/chat/index.js`：Chat 模块运行时公开入口，导出 `createChatModule`、persistence、avatar storage、memory adapters、model policy 函数，以及 RAG 运行时函数（惰性 getter）。
- `modules/chat/admin.js`：运维次级入口，导出 `createChatGistService`、`createRecentWindowContextBuilder`，以及 RAG 运维操作（`indexChatTurn`、`deleteChunksFromMessageId`、`listExistingTurnKeys`、`createChatRagProjectionAdapter`，惰性 getter）。

`regenerateChatRag.js`、`scripts/rebuild-memory-v2-scope.js`、`scripts/migrate-memory-v2-data.js` 均通过 `modules/chat/admin` 获取 RAG 运维能力，不直接导入 `modules/chat/rag` 内部文件。

## 7. 删除的旧入口

- `services/chat/rag/`（8 个文件，整目录删除）；
- `services/chat/productionModelPolicy.js`；
- `services/chat/context/`、`services/chat/context/segments/`（Phase D 遗留空目录）。

`services/chat/` 目前只保留 `memoryRuntime.js`（Phase C 建立的 Memory facade，由 composition 显式配置）。

## 8. 剩余依赖与过渡状态

以下依赖是本阶段保留的过渡状态，不违反架构检查门禁，记录为后续触发条件：

| 依赖 | 方向 | 说明 |
| --- | --- | --- |
| `modules/chat/rag/*` → 根 `config` | modules → config | RAG 文件读取 `chatRagConfig` / `memoryV2Config` 单例；config 在启动边界加载，不读 `process.env`。后续可改为工厂注入只读配置。 |
| `modules/chat/rag/*` → 根 `logger` | modules → logger | RAG 文件直接使用根 logger；logger 导入无数据库、文件系统或 timer 副作用。 |
| `modules/chat/rag/*` → `services/llm/*` | modules → services | RAG 的 embeddings / reranker / chatCompletions 仍直接引用 `services/llm`；待 `shared/llm` 评估时统一处理。 |
| `modules/chat/rag/repo.js` → 根 `db` | modules → db proxy | `db.js` 是惰性代理，导入时不创建连接池；连接由 composition 在启动时 `configureDatabase` 注入。 |
| `services/chat/memoryRuntime.js` | services → modules/memory | Phase C 建立的 Memory facade；待 Memory 接线最终整理时归位。 |
| `services/serverLifecycle.js` → `modules/chat` | services → modules | 启动门禁读取 Chat 模块的生产模型策略；serverLifecycle 在进程启动路径，加载 Chat 模块无导入副作用。 |

## 9. 一致性与行为保持

本阶段保留以下关键边界：

- RAG degradation 仍可观察但不阻断主 Chat Provider（embedding 429、维度错误、DB 错误、deadline 超时、client abort 各自降级）；
- Memory projection 开启时跳过旧 RAG turn indexing；
- Memory projection rebuilding/missing checkpoint 的上下文继续 fail closed，不查询 stale RAG；
- RAG projection drain 的 stage/commit、generation fence 与 checkpoint 语义不变；
- 生产模型策略对 Chat 和 Memory 独立校验，非生产环境放行；
- 运维脚本的 `--clear`、resume、并发索引、quota 重试语义不变。

## 10. 测试与完成门禁

本阶段未新增测试文件；现有测试覆盖随路径切换保持有效：

- `test/rag/`：degradation、http-degradation、repository-boundary、projection-adapters（11 项）；
- `test/chat/`：controller-concurrency 中 RAG indexer mock 路径切换（27 项 Chat 测试）；
- `test/server/lifecycle.test.js`：生产模型策略测试路径切换（6 项）。

完成验证：

- `npm run test:rag`：11 项通过；
- `npm run test:chat`：27 项通过；
- `npm run check:architecture`：通过，189 个 JavaScript 文件、386 条本地依赖边、无循环；
- `npm test`：305 项离线测试全部通过。

本阶段没有数据库迁移或外部写入，不需要数据回滚。代码回退边界是 `modules/chat/rag/`、`modules/chat/modelPolicy.js`、`modules/chat/index.js`、`modules/chat/admin.js`、composition 接线、运维脚本引用及对应测试。

## 11. 下一阶段

Phase F（Auth 与 Blog 按需迁移）：

- Auth 的配置注入在 B 阶段已完成，完整模块整理在其行为测试完备后进行；
- Blog 仅在持续开发或现有边界明显增加维护成本时迁移，可长期保持现状；
- `services/chat/memoryRuntime.js` 的最终归位待 Memory 接线整理时处理；
- `shared/llm` 的建立待 `services/llm` 出现稳定多消费者时评估。
