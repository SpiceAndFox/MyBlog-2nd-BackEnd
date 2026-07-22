# 架构迁移 D 阶段：Chat 垂直切片

状态：已完成
完成日期：2026-07-22

## 1. 完成范围

D 阶段按职责闭环完成了以下四批迁移，未改变 HTTP 路径、数据库 schema、Memory Control 2.01 数据契约、Chat/RAG/LLM Provider 协议或业务规则：

1. 消息发送、上下文编译和 Provider 调用；
2. 消息编辑、截断、Session 删除/恢复和永久隐私删除；
3. Preset、Session、头像、Gist 和过期回收；
4. HTTP 入站适配器、Chat Repository 与进程级实例接线收口。

Phase E 将继续处理 `services/chat/rag` 与 Chat 所需的 LLM 端口；本阶段没有提前改变 RAG 检索、projection、degradation 或 Provider transport 的归属。

## 2. Application 边界

- `modules/chat/application/sendMessage.js` 拥有发送 use case：请求校验、设置解析、scope 串行、用户消息写入、上下文编译、Provider 调用、assistant turn/source-generation fence 提交，以及 Memory/RAG/Gist 后处理。
- `editMessage.js` 拥有编辑、截断与 regeneration handoff。它先取消同 scope 的活动/排队生成，再把 raw source 修改与 source generation 初始化交给一次 `privacyHardDelete` 事务回调；HTTP 不接触事务 client。
- `sessions.js` 拥有 Session 创建、列表、回收站、删除、恢复、永久删除和消息列表。删除/恢复继续通过 `mutateSourceAndRebuild` 原子修改 raw source，永久删除继续通过 Memory privacy transaction 执行。
- `presets.js` 拥有 Preset 校验、CRUD、Memory rebuild、永久删除和头像替换。永久删除把头像 URL 写入 durable privacy operation payload；头像替换失败仍恢复旧 URL并清理新文件。
- `contextCompiler.js` 及 `application/context` 拥有上下文编译、recent-window、Gist cache/backfill、time context 与 segment 顺序；配置由 Chat module 工厂注入，不再由这些实现读取全局配置。
- `gist.js` 是显式创建的 Gist application service，Repository、LLM、配置、日志和队列均在实例创建时确定，不再存在导入即创建的全局 worker queue。
- `trashCleanup.js` 暴露显式 `start`/drain，并由 application composition 纳入后台服务生命周期；导入模块不会启动 timer。
- `scopeCoordinator.js` 改为显式实例。Chat 发送、source mutation、Memory scope executor 与 Server shutdown 共用 composition 创建的同一个实例。

## 3. Infrastructure 与数据 owner

- Chat SQL 已从 `models/chatModel.js`、`chatPresetModel.js` 和 `chatMessageGistModel.js` 移至 `modules/chat/infrastructure/repositories`，并改为接收 database adapter 的工厂；旧 Model 入口已删除，没有双 authority 或兼容转发层。
- Session 永久删除的内部事务仍只在未传入 transaction client 时自行 `BEGIN/COMMIT/ROLLBACK/release`；由 Memory privacy 流程传入 client 时不会擅自提交、回滚或释放。
- `infrastructure/avatarStorage.js` 是头像文件适配器，负责受管路径解析、压缩、删除和存在性检查；application use case 不直接导入 `fs`、`path` 或 `sharp`。
- Chat 的 raw source reader、RAG/Gist/头像 privacy store 仍由 Chat owner adapter 提供给 Memory。Gist privacy store 已切换到注入 database 的 Chat Repository。
- 运维脚本 `regenerateGists.js` 使用 `modules/chat/admin.js` 的显式次级入口创建 Gist service；生产运行入口不公开运维执行函数。

## 4. HTTP 与启动装配

- `controllers/chatController.js` 仅负责 Express 输入输出、SSE framing、客户端断连、HTTP 状态/payload 映射和 request-context 日志；它不再导入 Model、配置、Memory runtime、scope coordinator、RAG indexer、文件系统或图片 SDK。
- `routes/chat.js` 继续作为显式 router 工厂，所有方法、路径、Auth 和头像上传 middleware 位置保持不变。
- `app/composition/chat.js` 创建 Chat persistence、头像 storage、module/controller/router，并注入 Memory、RAG、LLM、配置、日志和唯一 scope coordinator。
- `app/composition/createApplication.js` 创建进程级 scope coordinator，把同一实例同时交给 Chat 与 Memory，并用 Chat module 的 `trashCleanup.start` 管理后台生命周期和 drain。
- `app/composition/memory.js` 的独立命令上下文也显式创建 scope coordinator，不恢复模块级默认单例。

## 5. 一致性与行为保持

本阶段保留以下关键边界：

- 同一 Preset 的多 Session 发送进入同一 scope lane，不同 turn 不会交错提交；
- 相同 Idempotency-Key 的已完成 turn 直接重放，不重复调用 Provider；
- 用户消息仍在 Provider 调用前持久化，assistant 写入仍校验 parent turn identity 与 source generation fence；
- 编辑先取消活动/排队生成，再在 privacy transaction 内完成截断、内容更新和 generation 初始化；
- Session 删除/恢复与 Memory rebuild 保持一次 source mutation 边界；永久 Session/Preset 删除保留 raw source、derived store、头像 residue 验证和恢复语义；
- 非流式与 SSE 都只在 Provider 成功后提交 assistant 消息，SSE final 内容仍优先于累计 delta；
- Memory projection 开启时继续跳过旧 RAG turn indexing，RAG 降级仍可观察但不阻断主 Chat Provider；
- Memory projection rebuilding/missing checkpoint 的上下文继续 fail closed；
- Gist 去重、worker 并发上限、recent-window backfill 上限和缺表降级语义保持不变；
- 垃圾清理立即执行首个 tick、不重叠执行，并在 stop 时等待活动 tick 排空。

## 6. 删除的旧入口

本阶段删除了以下已替代实现：

- `models/chatModel.js`、`models/chatPresetModel.js`、`models/chatMessageGistModel.js`；
- `services/chat/context/*`、`gistPipeline.js`、`avatarStorage.js`、`trashCleanup.js`；
- `services/chat/scopeCoordinator.js`、`taskQueue.js`、`textUtils.js`；
- Controller 内的业务编排、SQL/Model 直连、文件处理和默认 runtime 接线；
- 临时的 `test/tmp/chat-model-transaction.test.js`，其事务门禁已迁入正式 Chat 测试目录。

`services/chat` 目前只保留 Phase E 范围内的 RAG、Provider model policy，以及 Phase C 已建立并由 composition 显式配置的 Memory facade。

## 7. 测试与完成门禁

新增或固化的测试覆盖：

- scope 内并发发送、幂等重放、编辑取消与异步 privacy handoff；
- Session/Preset 永久删除的 transaction client 归属与 durable avatar payload；
- Session 设置归一化、上下文 segment 顺序与配置注入；
- Gist 内容去重、归一化和 backfill admission 上限；
- 头像受管路径和隐私清理；
- 垃圾清理分组、非重叠 tick 和 stop drain；
- Repository 自有事务与外部事务两条路径；
- Controller 无持久化、配置、文件系统和 runtime authority 的架构门禁；
- composition 显式创建完整 Chat module、router 和后台服务。

完成验证：

- `npm run test:chat`：27 项 Chat 测试全部通过；
- `npm run check:architecture`：通过，188 个 JavaScript 文件、383 条本地依赖边、无循环；
- `npm test`：305 项离线测试全部通过。

本阶段没有数据库迁移或外部写入，不需要数据回滚。代码回退边界是 Chat application/infrastructure、composition 接线、薄 Controller、显式 admin 入口及对应测试。

## 8. 下一阶段

Phase E 从当前公开端口继续：

1. 将 RAG retrieval、projection、repository 和 degradation 迁入 `modules/chat/rag`；
2. 明确 Chat application 对 RAG 与 LLM 的最小输入输出；
3. 删除 `services/chat/rag` 的旧入口；
4. 只在出现稳定、多消费者的 transport/SSE 协议复用后，评估是否建立 `shared/llm`。
