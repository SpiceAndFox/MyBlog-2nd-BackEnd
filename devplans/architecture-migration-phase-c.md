# 架构迁移 C 阶段：Memory 接线收紧

完成日期：2026-07-22

## 1. 本批范围

本批只调整 Memory 的公开入口、owner adapter 接线和 Compiler 分层，不改变 Memory Control 2.01 数据契约、数据库 schema、HTTP 路由、Provider 协议、任务调度策略或业务规则。

## 2. 公开入口与实例生命周期

- `modules/memory/index.js` 仅公开 `loadMemoryV2Config` 与 `createMemoryModule`；运行调用方不能再取得 migration、Provider probe、prompt、domain 或 repository 内部能力。
- migration、inspect、provider probe、shadow replay 与只读 GUI 改用显式次级入口 `modules/memory/admin.js`。
- 删除 Memory 顶层的 `defaultMemoryRuntime` 缓存以及 `createDefault*` 工厂。每个 runtime、context assembly 和 projection drain 都绑定到 composition 显式创建的 Memory 模块实例。
- A 阶段冻结的 5 条 Memory 内部路径导入已全部删除，架构门禁的历史债务清单归零；`admin.js` 被识别为显式次级公开入口。

## 3. 数据 owner adapter 注入

- Chat raw source reader 移至 `modules/chat`，由 Chat 持有 `chat_messages`、`chat_sessions` 的读取 SQL，并向 Memory 提供受约束端口。
- User time-zone reader 移至 `modules/auth`，由 Auth 持有 `users` 查询，并支持沿用传入的事务 client。
- RAG projection adapter、RAG/Gist/头像隐私 store、raw source reader 和 scope executor 由 Chat adapter 工厂创建，再由 `app/composition` 注入 Memory。
- Memory repository 集合不再包含 Chat source repository 或 User repository；migration 的 raw source scope inventory 也改走 Chat source reader。
- `app/composition/memory.js` 为命令行运维流程提供同样的显式 owner adapter 装配，不让 admin 入口反向依赖 Chat 或 Auth 实现。

## 4. Compiler 分层

- `domain/semanticCompiler.js` 只接收已加载的 source rows，负责引用解析、来源校验、日期解析和持久化 patch 编译；其中不存在异步函数或 Repository 调用。
- `application/semanticCompiler.js` 负责计算所需 source ids、调用注入的 Chat source reader，并将查询失败映射为既有的 fail-closed compile error。
- normal pipeline、capacity replay/compaction 和 task shadow replay 均通过 application Compiler 编排，原有 source hash、scope、metadata 与 generation/revision 检查保持不变。

## 5. 行为与门禁

本批继续保留以下关键语义：

- normal/maintenance 原子 revision 写入与未知 COMMIT 结果协调；
- task 幂等与 generation/cursor/revision fence；
- privacy raw mutation、derived purge、外部 store residue 验证和启动恢复；
- 严格启动恢复完成后才开放 readiness 与 polling；
- RAG projection staging 失败不推进 checkpoint，过期完成不能提交。

新增 wiring 测试锁定 Memory 最小入口、无默认 runtime、无 Chat/Auth SQL，以及 domain Compiler 无 Repository I/O。完整离线门禁仍为 `npm test`，不包含数据库连接、Provider probe、迁移或任何带 `--apply` 的命令。

完成验证：

- `npm run check:architecture`：通过，177 个 JavaScript 文件、388 条本地依赖边、无循环、无冻结内部导入债务；
- `npm test`：293 项离线测试全部通过。

## 6. 回退点与下一阶段

本批没有持久化变更，不需要数据库回滚。代码回退边界是 Memory runtime/admin 入口、Chat/Auth owner adapter、composition 接线、Compiler application/domain 分层及对应测试。

D 阶段可在此基础上按职责闭环迁移 Chat：Controller 仍通过现有显式配置的 Chat runtime facade 调用 Memory；后续移动 use case 时应把该 facade 的调用逐步改为构造参数注入，不重新引入 Memory 默认实例或内部路径导入。
