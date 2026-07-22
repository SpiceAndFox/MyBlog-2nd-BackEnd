# 架构迁移 B 阶段：启动装配层

完成日期：2026-07-22

## 1. 本批范围

本批建立 `app/composition`，集中负责环境加载、配置校验、数据库、日志、Auth、HTTP 应用、Memory 运行时、后台任务和 Server lifecycle 的进程级装配。没有改变数据库 schema、HTTP 路径与响应契约、Memory Control 2.01 数据契约或 Chat 业务规则。

## 2. 装配与生命周期

- `app.js` 仅保留进程入口、信号处理安装和启动失败收口；导入它不会启动 Server。
- `createApplicationComposition` 显式创建并接线配置、DB Pool、logger、Auth、Memory runtime、HTTP app、后台服务和 lifecycle。
- `db.js` 与 `logger.js` 改为工厂和已装配适配器入口；单纯导入不再创建 Pool、日志目录或清理文件。
- 命令行工具通过 `commandDatabase` 或 `commandContext` 建立自己的显式装配，不依赖 Server 入口，也不在共享模块中回退读取环境变量。
- Chat 垃圾清理与 Article 临时图片清理由统一后台服务组启动并按逆序排空；Article Controller 被导入时不再创建目录或 timer。
- Article 临时图片清理归入 `modules/blog/articles/infrastructure`，composition 只通过 `modules/blog` 公开入口装配；这不展开 Auth/Blog 的其余完整目录迁移。

Memory 运行时实例现在由 composition 发起创建，但 Memory 内部的默认 runtime、具体 repository/projection/privacy/source/user 接线仍按计划留给 C 阶段收紧。

## 3. 配置与 Auth

- `loadApplicationConfig(env)` 接收显式环境快照，校验 Server、Database、Auth 以及既有 Chat/RAG/LLM/Memory 配置，并递归冻结结果。
- 非测试运行代码的 `process.env` 访问被限制在配置/启动/CLI 边界；架构检查会拒绝 Service、Controller、Middleware 或业务模块新增直接读取。
- Provider 发现、OpenRouter attribution 和生产模型 allowlist 通过 composition 注入环境快照，不再在调用路径读取全局环境。
- `modules/auth` 提供最小公开工厂；JWT secret 同时注入签发 Controller 和验证 Middleware。七日 token、认证状态码、错误体和 decoded user 行为保持不变。

Auth 其余代码仍暂时位于既有 Controller、Middleware 和 Model；完整目录迁移留到 F 阶段。

## 4. 行为与门禁

本批保留 A 阶段全部 38 个 HTTP 路由与既有错误、事务、Memory 恢复、隐私、RAG 降级和 shutdown 行为。新增基线覆盖：

- composition 在显式 `start` 前不会启动后台 interval；
- 多个后台服务按声明顺序启动、按逆序停止和排空；
- 配置对象为只读；
- 架构门禁拒绝业务运行路径直接读取 `process.env`；
- Auth 基线通过 `modules/auth` 公开入口验证，不再通过测试修改全局 JWT 环境变量；
- logger 的遗留 raw log 清理由显式创建触发，而不是由模块导入触发。

完整离线门禁仍为 `npm test`，不包含数据库连接、Provider probe、迁移或带 `--apply` 的命令。

## 5. 回退点与下一阶段

本批没有持久化变更，不需要数据库回滚。代码回退边界是 `app/composition`、显式 DB/logger/Auth/后台工厂、入口接线及相应测试。

C 阶段继续处理：缩小 Memory 公开入口、删除默认 runtime、把 projection/privacy/raw source/User time-zone adapter 从外部注入、移出 Compiler 的 Repository I/O，并清除 A 阶段冻结的 5 条 Memory 内部导入债务。
