# 架构迁移 A 阶段基线

完成日期：2026-07-22

## 1. 本批范围

本批只建立迁移门禁和行为基线，不移动生产代码，不改变数据库 schema、HTTP 响应、Memory Control 2.01 契约或后台任务调度策略。

入口与 owner 基线沿用主计划：

- HTTP 入口为 `app.js -> routes -> controllers`；
- `users` 由 Auth 持有；
- Chat 持有 Session、Message、Preset、Gist 及 `chat_rag_chunks`；
- Memory 持有 Memory authority、task、event、snapshot、checkpoint 和 privacy 数据；
- Blog 持有 Article、Diary 和 Tag 数据。

## 2. 可执行门禁

`npm test` 现在等价于完整离线门禁，依次运行：

1. `npm run check:architecture`；
2. `node --test test/**/*.test.js`。

Provider probe、数据库迁移、真实数据库 smoke 和任何带 `--apply` 的命令仍不属于离线门禁，不会由测试隐式执行。

架构检查扫描测试与归档之外的本地 JavaScript：

- 禁止模块外部新增对 `modules/<owner>` 内部文件的导入；
- 禁止 `shared` 依赖业务模块；
- 禁止业务模块依赖 `app/composition`；
- 禁止本地依赖图出现循环；
- 已存在的内部导入债务采用精确的 caller/target 清单冻结，不能借清单放宽到新调用方或新目标。

## 3. 行为基线

| 行为面 | 锁定内容 | 主要测试 |
| --- | --- | --- |
| HTTP | 38 个既有 API 的 method、path、认证位置、上传中间件与 controller 绑定 | `test/server/http-contract.test.js` |
| Auth | 登录校验、凭据失败、七日 token、Bearer 认证的状态码/响应体/decoded user | `test/tmp/auth-http-baseline.test.js`（B 阶段以新公开入口测试替换） |
| 错误响应 | 未指定错误为 500；已设置的 4xx 状态保留；响应体不泄露内部错误；headers sent 后委托 Express | `test/server/http-errors.test.js` |
| Chat 事务 | 永久删除 Session 自持事务时 BEGIN/COMMIT/ROLLBACK/release；传入 client 时不接管事务 | `test/tmp/chat-model-transaction.test.js`（D 阶段以 application use case 测试替换） |
| Memory 事务 | 原子 revision 写入、故障回滚、未知 COMMIT 结果协调、隐私与 projection generation fence | 既有 `test/memory/application` 与 `test/memory/persistence` |
| 后台任务 | 严格恢复后才开始 polling；shutdown 先排空任务再关闭 DB；垃圾清理立即运行、不重叠、stop 等待 active tick | `test/server/lifecycle.test.js`、`test/chat/trash-cleanup.test.js`、既有 runtime polling tests |
| Chat 主流程 | scope 串行化、幂等重放、编辑取消、RAG 降级不阻塞 Provider | 既有 `test/chat/controller-concurrency.test.js` |

## 4. 冻结的迁移债务

以下 5 条内部导入在 A 阶段只冻结、不改造；由 C 阶段通过 Memory 最小运行时入口和显式 admin 次级入口删除：

- `scripts/smoke-memory-v2-provider.js -> modules/memory/application/envelope.js`
- `services/chat/contextCompiler.js -> modules/memory/contracts/index.js`
- `tools/memory-task-gui/server.js -> modules/memory/infrastructure/providers/memoryProviderAdapter.js`
- `tools/memory-task-gui/server.js -> modules/memory/infrastructure/providers/outputSchema.js`
- `tools/memory-task-gui/server.js -> modules/memory/prompts/index.js`

其他明确未迁移项：

- 配置、数据库、日志和 server lifecycle 尚未集中到 `app/composition`；
- Auth Controller/Middleware 仍直接读取 JWT secret；
- Memory 默认 runtime、具体 projection/source/privacy/user adapter 及 Compiler I/O 分层尚未收紧；
- Chat Controller 仍承担多类业务编排。

这些是后续阶段的输入，不是放宽 A 阶段门禁的理由。

## 5. 回退点与下一触发条件

A 阶段没有生产运行时或持久化变更。若门禁本身需要回退，回退范围仅为新增检查脚本、characterization tests、测试脚本接线和本记录；不需要数据库回滚。

B 阶段开始条件：`npm test` 完整通过，并保持架构检查无新增债务、无循环。B 阶段第一批应建立 `app/composition` 的最小装配骨架和 Auth JWT 配置注入；其改动必须继续通过本阶段的 HTTP/Auth/错误响应与 lifecycle 基线。
