# Memory Control v2 上线阻塞审计

审计日期：2026-07-14  
审计基线：`dc663ce`  
结论：**No-Go，当前不应执行生产 cutover，也不应把现状视为可上线版本。**

## 1. 范围与判定口径

本次审计覆盖 Chat HTTP/SSE 主链路、Provider adapter、RAG、Memory v2 runtime/state/rebuild/privacy/migration、数据库 migration、启动生命周期和生产依赖。与 AI Chat 无关的博客文章业务不在本轮范围内。

沿用当前“个人单用户、单 Node.js 实例”的首发假设。只有会造成以下结果的问题被列为首发阻塞：

- 正常用户操作可造成对话/记忆顺序损坏或不可恢复的错误状态；
- 补充能力或第三方故障会阻断主聊天；
- 隐私永久删除仍留下可访问原文；
- 生产迁移、失败恢复或依赖安全尚无足够证据放行；
- 普通重复操作可无界放大 Provider 调用、成本或进程资源。

长期扩展性和非首日能力单独归档到 [运行时维护与长历史扩展](deferred/memory-control-v2/runtime-retention-and-history-scaling.md)。Devplan 只作为设计意图证据；最终结论以当前代码的实际行为为准。

## 2. 必须修复的代码阻塞项

### BLK-01 同一 Memory scope 的聊天变更没有统一串行或 turn identity

证据：

- `controllers/chatController.js:1249` 先独立写入 user message，耗时 LLM 完成后才在 `:1290` / `:1388` 写 assistant message；
- `models/chatModel.js:402-424` 的消息没有 `turn_id`、parent user message 或 request idempotency key；
- edit/truncate 在 `controllers/chatController.js:988-995` 执行，但不取消或等待正在生成的 send；
- streaming 直到 context 编译完成后才监听 `req.close`，见 `controllers/chatController.js:1089-1091,1329-1331`；Node 的 `IncomingMessage.close` 在请求体完成时已经触发，因而该监听通常既错过事件，也不能取消随后发生的客户端断连；
- Memory lane 只包裹 Memory 工作，见 `modules/memory/application/runtime.js:16-25,260-267`；
- RAG 用一个 `pendingUser` 猜测回合配对，见 `services/chat/rag/projectionAdapters.js:26-41`。

普通双击、客户端重试或 send 与 regenerate 并发时，可以形成 `user1,user2,assistant2,assistant1`。edit 已截断旧消息后，在途请求仍可插入基于已删除内容生成的“幽灵 assistant”。实际对 `U1,U2,A1,A2` 调用当前 `buildTurns` 只得到 `[[U2,A1]]`，证明 RAG 会错配并丢回合。

放行条件：

- 用同一个 per-`userId/presetId` coordinator 包住 append、生成、edit、delete 和 rebuild source mutation；使用 response/socket close 正确取消在途 Provider，并区分正常 response 完成；
- assistant 落库前验证 parent user message 和 source generation 仍有效；
- 持久化 `turn_id` / parent / idempotency key，重试不得重复创建 user message；
- 增加双 send、send+edit/regenerate、跨 session 同 preset 的集成测试。

### BLK-02 edit / 永久删除在 HTTP 请求中同步执行全历史六 target rebuild

证据：

- raw mutation 和 privacy operation 先提交，随后同步 `forceDrainTo`，见 `modules/memory/application/privacyHardDelete.js:70-87`；
- `forceDrainTo` 对六个 target 按历史小批次反复调用 Memory Provider，见 `modules/memory/application/sourceRebuild.js:177-256`；
- controller 在永久删 session 和 edit 中同步等待，见 `controllers/chatController.js:900-915,988-1005`；
- edit 不检查 `mutation.status`，即使 incomplete 仍返回 200 或继续 regenerate。

默认六 target、`lagThreshold=2` 时，一次从零 rebuild 的 normal calls 约为 `3 × scope 消息数`，还不含 schema retry、Provider retry 和 compaction。raw edit/delete 已提交后，drain 失败却会返回 500；重试可能得到 404，客户端无法判断是“未执行”还是“已删除但派生重建失败”。

放行条件：raw mutation 与 durable privacy operation 原子提交后返回 `202 + operationId`；后台续跑 purge/verify/drain；提供幂等状态查询；operation 完成前禁止 regenerate；失败响应必须明确 raw mutation 是否已经提交。

### BLK-03 RAG query 是主聊天的无降级硬依赖

证据：

- query embedding 和向量查询没有 fallback，见 `services/chat/rag/retriever.js:355-371`；
- embedding 的网络、限流、超时、响应维度错误都会抛出，见 `services/llm/embeddings.js:94-153`；
- v2 与 v2-off 的 context compiler 都直接 await RAG，见 `services/chat/contextCompiler.js:44-51,105-110`；
- user message 已在 `controllers/chatController.js:1249` 落库，SSE headers 到 `:1320` 才发送。

Embedding 服务或 RAG DB 短暂故障时，健康的主聊天 Provider 完全不会被调用；请求在最长 30 秒后返回 500，并留下无 assistant 的 user message。RAG 是增强能力，这与主聊天稳定目标冲突。

放行条件：RAG query 采用短的聚合 deadline；基础 embedding/DB retrieval 失败时降级为空 RAG、记录 degraded health 并继续主聊天；rerank/scene recall 保留各自的局部 fallback；传递 client abort；增加 embedding timeout、HTTP 429、维度错误和 DB error 的端到端测试。

### BLK-04 Privacy hard delete 没有覆盖原文日志和头像文件

证据：

- 完整编译后 prompt 写入 `debugFull`，见 `controllers/chatController.js:1030-1040,1269-1279`；
- gist 请求和模型原始输出写入 `debugGist`，见 `services/chat/gistPipeline.js:116-150`；
- 两类原文日志在环境变量缺失时默认开启，见 `logger.js:23-27`，且 custom file 不受 `LOG_LEVEL` 限制，见 `logger.js:156-176`；
- privacy store 只注册 RAG，见 `services/chat/memoryRuntime.js:11-18`，append-only 文件无法按 scope 清理；
- `/uploads` 公开提供文件，见 `app.js:43-44`；头像替换和永久删除 preset 都没有删除旧文件，见 `controllers/chatController.js:714-724,745-773`。

`.env.example` 显式关闭 raw debug 不能修复 fail-open 默认值，也不能清理已经生成的历史文件。头像 URL 在 DB 删除后仍可继续公开访问。

放行条件：删除生产路径的原文日志调用或改为可按 scope 删除的受控存储；代码默认 false，生产开启时拒绝启动；清理历史 raw debug 文件；头像替换/永久删除使用受限目录内的幂等文件清理；用唯一 canary 完成“聊天/头像 → 永久删除 → 搜索 DB、RAG、日志和文件系统”的零残留测试。

### BLK-05 Memory Provider 没有全局 admission control，manual rebuild 也没有去重

证据：

- runtime 只有 per-scope `Map` lane，不限制不同 scope 的总并发，见 `modules/memory/application/runtime.js:16-25`；
- 每个 scope 的 eligible targets 顺序调用 Provider，见 `modules/memory/application/normalWritePipeline.js:492-496`；
- 每次 assistant 落库都 fire-and-forget 唤醒 Memory，见 `controllers/chatController.js:359-362,1293,1396`；
- 任意已认证用户可重复 POST manual rebuild，controller 每次都排入一个完整 rebuild，见 `routes/chat.js:16` 和 `controllers/chatController.js:644-660`；
- 配置中没有 Memory worker concurrency / queue bound；项目已有 gist semaphore，但 Memory 未复用。

多个 preset、重复 rebuild 或恢复任务可同时打满 Provider 连接和配额，形成 retry/halt 风暴，并无界放大成本。per-scope 串行不能提供跨 scope 背压。

放行条件：所有 normal/maintenance/recovery/rebuild Provider calls 共用可配置全局 semaphore 和有界 durable queue；相同 scope 的 active rebuild 返回同一 operation/status 而不是再次排队；增加 50 scopes 并发测试，证明 active calls 不超过 N、异常必释放 permit、scope 顺序不变。

### BLK-06 OpenAI-compatible 与 Anthropic SSE parser 不支持合法 CRLF 和 EOF 尾帧

证据：

- 两个 parser 都只查找字面量 `\n\n`，见 `services/llm/adapters/openaiCompatible/chatCompletions.js:276-312` 和 `services/llm/adapters/anthropicMessages/chatCompletions.js:325-379`；
- stream 结束时都没有 flush `TextDecoder` 或解析剩余 buffer。

同一个 OpenAI delta 帧的本地复现结果为：LF `['ok']`、CRLF `[]`、没有末尾空行的 EOF 帧 `[]`。兼容网关使用 CRLF 时整段响应变成 `Empty model response`；仅尾帧缺空行时则静默保存截断的 assistant。

放行条件：使用合规 SSE parser，覆盖 LF/CRLF/CR、任意 chunk 边界、多 `data:` 行、comment、`[DONE]` 和 EOF 尾帧；OpenAI-compatible 与 Anthropic adapter 都要有协议测试。

### BLK-07 Chat 上传链路锁定了存在可达高危 DoS 的 Multer 2.0.2

`pnpm-lock.yaml:32-34` 锁定 `multer@2.0.2`，聊天头像路由实际使用 disk storage，见 `routes/chat.js:20` 和 `middleware/uploadChatPresetAvatar.js:10-35`。当前只限制单文件大小，没有 field nesting、fields、parts 或 files 数量限制。

2026-07-14 执行 `pnpm audit --prod` 得到 21 项公告（11 high）。逐项检查调用面后，本轮阻塞的是直接可由 multipart 路径触达的 Multer 公告；`jsonwebtoken -> jws` 公告明确说明 `node-jsonwebtoken` 的 verify 用法不受影响，受控 route/glob 等其它传递依赖不据此自动升级为阻塞。Multer 官方修复要求升级到 2.2.0 并配置 `limits.fieldNestingDepth`，参见 [GHSA-72gw-mp4g-v24j](https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j) 和 [Express 2026-06 security release](https://expressjs.com/en/blog/2026/06/30/security-releases/)。

放行条件：升级并锁定已修复版本；为 avatar/article upload 设置最小 `fieldNestingDepth`、`fields`、`parts`、`files` 和 file size；验证 abort/malformed upload 不留 partial file；重新执行 production dependency audit。

### BLK-08 v2-off 不能作为安全运行或回滚模式

`CHAT_MEMORY_V2_ENABLED=false` 时，局部 edit/hard-delete 被转换成 reset authority，见 `modules/memory/application/runtime.js:28-45`；注册的 RAG store 会删除整个 preset chunks，但 disabled runtime 不从剩余 source rebuild，见 `services/chat/memoryRuntime.js:14-18` 和 `modules/memory/application/privacyHardDelete.js:53-67`。同时旧 direct indexer 是无 generation fence 的 fire-and-forget，见 `services/chat/rag/indexer.js:97-112`，在途任务可把已编辑旧内容重新写回。

放行条件二选一：修复 v2-off 的局部删除/rebuild/fence；或在发布配置和启动校验中明确禁止该模式，并声明 `false` 不是可用回滚路径。当前 `.env.example:60` 的默认 false 只能用于 migration 前停用，不能直接作为生产上线配置。

## 3. 必须取得证据的发布门禁

### GATE-01 生产 history rehearsal 与恢复演练尚未完成

现有 runbook 已明确记录：没有隔离生产历史副本、没有两次全量 rehearsal、没有验证过的停启服/失败恢复命令，见 `devplans/deferred/memory-v2-production-migration-runbook.md:7-12,23-31,68-80`。`002-drop-memory-v1.sql` 会删除旧 authority；因此这不是普通文档欠账。

必须在隔离副本上完成两次完整 rehearsal，记录真实 calls/tokens/cost、容量、耗时和失败率；做一次中途失败注入并验证续跑与数据库恢复；正式 cutover 必须有备份恢复证明、服务完全停止和 raw boundary 冻结证据。

### GATE-02 当前 migration report 不足以单独支持放行

CLI 的调用量只是 `ceil(messageCount / lagThreshold)` 估算，见 `scripts/migrate-memory-v2-data.js:72-79`；报告只含 task count、duration 和 section usage，见 `modules/memory/application/migration.js:160-208`。它不含 git/schema/config 指纹，也没有真实 Provider calls/tokens/cost；schema retry、Provider retry 和 compaction 都不会反映在 `normalTaskCount` 中。

放行前应补齐实现，或建立等价的外部审计证据包。迁移结束时还需重新做全局 source inventory，不能只信任 `--service-stopped` 布尔声明。

### GATE-03 上线数据库存在两个未验证的升级条件

当前环境没有 `DATABASE_URL/WINDOWS_DATABASE_URL`，无法读取真实 schema/data；以下只读检查必须在 rehearsal 与生产库执行：

```sql
SELECT user_id,preset_id,subject_kind,subject_key,diagnostic_type,COUNT(*)
FROM chat_context_quality_diagnostics
WHERE resolved=FALSE
GROUP BY 1,2,3,4,5
HAVING COUNT(*) > 1;

SELECT user_id,preset_id,projection_key,processed_generation,status
FROM chat_context_projection_checkpoints
WHERE projection_key='recall';
```

若第一条有结果，migration runner 会先重跑 `001-memory-v2.sql:107` 的 unique index，尚未执行 `005-runtime-correctness.sql:6-21` 的 dedupe 就失败。若第二条有结果，当前 context assembly 会把所有 checkpoint 纳入 health，但 runtime 已不再推进 legacy `recall`，从而永久显示 rebuilding；migration 又只验证 `rag`。两种情况都必须有迁移和回归测试，不能人工直接忽略。

### GATE-04 部署必须证明当前代码依赖的运行约束

- replicas 固定为 1，禁止 autoscaling 和新旧进程重叠；当前 lane 只是进程内 `Map`；
- 完成 pending privacy/rebuild/task/projection recovery 后才对外 ready；当前 `app.listen` 早于后台 `recoverPending`，且没有 readiness endpoint 或 graceful SIGTERM drain，见 `app.js:59-75`；
- `LOG_DEBUG_FULL_ENABLED=false`、`LOG_DEBUG_GIST_ENABLED=false`，并处置历史 raw logs；
- 主聊天与 Memory model 锁定为已独立验证 context capability 的 allowlist。当前 Memory 只相信环境中的 `MAX_INPUT_TOKENS`，preflight 不验证真实上限；
- cutover 后只能以 v2 enabled 启动，不能用 BLK-08 的 disabled path 回滚。

其中单实例可以作为首发部署约束；分布式 DB lease/fencing 继续延期。readiness、graceful shutdown 和致命异常退出仍建议落到代码，而不是依赖人工等待。

## 4. 验证结果与正向结论

- `npm test`：43/43 通过；
- `node --test --experimental-test-coverage test/**/*.test.js`：通过，加载到的文件约 81% line coverage；但 controller、真实 PostgreSQL、SSE adapter、RAG fault path 和并发 send/edit 没有被覆盖；
- 全仓业务 JavaScript `node --check`：通过；
- OpenAI-compatible SSE CRLF / EOF 缺陷已用导出的 parser 本地复现；
- 当前 Node 运行时的最小 HTTP 复现中，`req.end` / `req.close` 同在 14ms 发生，而 response 在 321ms 才结束，证明 controller 后置的 `req.close` 监听不能承担 response 期间断连取消；
- RAG `buildTurns(U1,U2,A1,A2) -> [[U2,A1]]` 已本地复现；
- `pnpm audit --prod`：1 low、9 moderate、11 high；已按实际调用面筛选，BLK-07 是本轮确认可达的直接依赖阻塞；
- `npm run check:memory-schema` 和 live inventory 因当前环境没有数据库/config secrets 未能执行，不能把旧文档中的历史结果当成本次 live 证明。

未发现正常 v2 路径存在跨 user/preset 查询泄漏；Memory authority/event/snapshot/task 的正常提交保持同一事务；generation/boundary fencing、rebuild checkpoint 提交前重校和 Provider structured-output preflight 的主体设计是可靠的。这些正向结论不能抵消上述外围集成阻塞。

## 5. 建议修复顺序

1. 先修 BLK-01、BLK-02、BLK-04：消除数据顺序与隐私不可逆风险；
2. 再修 BLK-03、BLK-05、BLK-06、BLK-07、BLK-08：保证主链路降级、资源边界和协议/依赖安全；
3. 为每个 blocker 增加故障与并发集成测试；
4. 完成 GATE-03 数据库预检和 legacy 数据迁移；
5. 在隔离历史副本完成 GATE-01/02 rehearsal；
6. 最后固化 GATE-04 部署方式并执行 production cutover。

所有 BLK 和 GATE 都有可复验的完成证据后，才将结论改为 Go。
