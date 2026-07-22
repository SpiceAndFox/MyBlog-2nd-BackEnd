# 架构迁移 D 阶段：Chat 垂直切片

状态：进行中  
首批完成日期：2026-07-22

## 1. 首批范围

本批迁移“消息发送、上下文编译和 Provider 调用”闭环。没有改变 HTTP 路径、数据库 schema、Memory Control 2.01 数据契约、Chat/RAG/LLM Provider 协议或业务规则；编辑、删除、恢复与隐私操作，以及 Preset、Session、头像和 Gist 的完整迁移仍属于后续批次。

## 2. Application 边界

- `modules/chat` 新增显式 `createChatModule` 工厂；模块实例由 composition 创建，不维护默认单例。
- `application/sendMessage` 拥有发送 use case：校验请求、解析有效设置、按 `userId + presetId` 串行、写入用户消息、编译上下文、调用 LLM、用既有 turn/source-generation fence 提交 assistant 消息，并触发既有 Memory、RAG 与 Gist 后处理端口。
- `application/contextCompiler` 接收 Memory context、RAG retrieval、recent window、segment builder、time context 与 Gist backfill 端口。原 `services/chat/contextCompiler.js` 已删除，不保留并行 authority。
- `application/settings` 统一承接 Controller 原有的 Preset 解析、日期可编辑性、Provider/model 选择及 schema 设置归一化；Session 创建与消息编辑暂时复用同一个注入实例，避免复制规则。
- LLM、Memory、RAG、Repository、日志和 scope coordinator 均由 `app/composition/chat.js` 注入。Chat application 不导入 Provider SDK、SQL adapter、Memory 内部路径或 composition。

## 3. HTTP 与启动接线

- `routes/chat.js` 改为显式 router 工厂，由 composition 注入 Auth middleware、Chat Controller 与头像上传 middleware；导入 route 不会捕获未装配的 Controller 单例。
- `controllers/chatController.js` 改为工厂。消息发送 handler 只负责 Express 输入、SSE 输出、客户端断连和 application error 到既有 HTTP payload 的映射；旧 `_sendMessageInScope` 实现已删除。
- 其余尚未迁移的 Chat handler 继续留在该 Controller，并通过同一 Chat settings 实例保持行为。待 D 阶段后续批次完成后再继续收薄，避免整体搬运。
- `app/composition/createApplication.js` 在配置、数据库、日志、Auth 和 Memory 安装后创建 Chat module/controller/router；显式传入测试 app 时不会提前加载依赖已装配配置的遗留 adapter。

## 4. 一致性与行为保持

本批保留以下边界：

- 同一 Preset 的多 Session 发送仍进入同一 scope lane，不同 turn 不会交错提交；
- 用户消息仍在 Provider 调用前持久化，assistant 写入仍使用 parent turn identity 和 source generation fence；
- 相同 Idempotency-Key 的已完成 turn 直接重放，不重复调用 Provider；
- 编辑等 source mutation 仍先取消活动/排队生成，再进入同一 lane 执行既有 Memory 隐私事务；
- 非流式与 SSE 均只在 Provider 成功后提交 assistant 消息；SSE 的 final 内容仍优先于累计 delta；
- Memory projection 开启时继续跳过旧 RAG turn indexing；RAG 降级继续暴露健康信息但不阻断主 Chat Provider；
- Memory projection rebuilding/missing checkpoint 的上下文仍 fail closed，不查询超出已证明边界的 RAG 数据。

发送闭环只写 Chat owner 的 Session/Message 数据，沿用 Repository 内既有原子 turn fence；本批没有新增跨模块事务，也没有把原始 `pg` client 暴露给 HTTP 或 application 公共输入。

## 5. 测试与回退点

新增或迁移的测试覆盖：

- 同一 Preset 跨 Session 串行提交；
- 并发幂等重放不重复调用 Provider；
- 编辑取消活动发送并等待 lane 后执行隐私写入；
- RAG 降级不阻断主 Provider；
- SSE delta/final 输出及最终持久化内容；
- legacy recent-window 与 Memory v2 projection rebuilding 两条上下文编译路径；
- composition 显式创建 Chat module/router，且保持全部 Chat HTTP 方法、路径、Auth 与上传 middleware 位置。

首批完成验证：

- `npm run check:architecture`：通过，182 个 JavaScript 文件、396 条本地依赖边、无循环；
- `npm test`：297 项离线测试全部通过。

本批没有持久化变更，不需要数据库回滚。代码回退边界是 Chat application 工厂、composition 接线、Controller/router 工厂和对应测试。

## 6. 后续批次

Phase D 尚未完成，后续按原计划继续：

1. 把编辑、删除、恢复和隐私操作迁入 application use case，并为永久 Session 删除替换临时 transaction characterization test；
2. 迁移 Preset、Session、头像和 Gist 职责闭环；
3. 将剩余 HTTP handler 收薄，删除已替代的 Controller/Model 直连和遗留接线；
4. 每批继续运行相关测试、架构门禁和完整离线测试。
