# 已完成开发

## 2026-07-12：Memory Control v2 阶段 1

- 建立严格的 v2 state、patch、task envelope、Proposer output、枚举与 revision 0 校验契约。
- 增加集中配置入口；v2 默认关闭，启用后未确定默认值的容量、恢复与 retention 配置必须显式提供并校验。
- 增加全部 v2 DDL、迁移脚本，以及 state/audit/runtime/sidecar repositories。
- 实现事务化 revision 0 初始化：authority state、完整 snapshot 和六个 healthy target status 原子创建。
- 建立 Harness runner、revision 0 fixture，以及 contracts/config/repository 测试。
- 增加 `npm test`、`npm run test:memory-v2`、`npm run migrate:memory-v2`；测试全部通过。
- 执行npm run migrate:memory-v2

## 架构决策与迁移

- 项目目标架构确定为渐进式模块化单体；Memory v2 立即采用新架构，旧 Blog/Chat/RAG 按需迁移，不进行一次性重构。
- 架构约束已写入 `devplans/roadmap.md`；旧架构迁移计划写入 `devplans/deferred/architecture-migration.md`。
- Memory v2 已迁至 `modules/memory`：contracts、config、harness、infrastructure/repositories 和模块公共入口分别归位。
- DDL 迁至 `migrations/memory/001-memory-v2.sql`，测试迁至 `test/memory`；旧 `services/chat/memory-v2`、`test/memory-v2` 路径及引用已清除。

## 2026-07-12：Memory Control v2 阶段 2

- 实现统一 Evidence quote matcher：固定归一化、Unicode code point 长度、信息字符门槛、等长窗口 Levenshtein 与 evidence source/role 复核。
- 实现静态 Policy Gate，覆盖九个正式 section 的 section + op + evidenceKind 权限矩阵。
- 实现纯代码生命周期与日历运算：任意用户时区 absolute/relative dueAt、月末截断、scene TTL、Todo overdue/revive、recentEpisodes 确定性滚出及请求时 effective view。
- 实现纯代码 Reducer：schema/evidence/policy/冲突校验、accepted/rejected/noop/deferred 决策、局部 apply、provenance、correction/forget tombstone 候选、容量门、cleanup events、revision/cursor 候选 state 与完整 snapshot。
- 实现稳定 Renderer 模板、active/overdue Todo 分组与独立预算，以及 per-target stale/rebuilding/GapBridge health 标记。
- 增加阶段 2 reducer fixture、Renderer 完整 golden，以及 evidence、policy、lifecycle、calendar、Reducer、compaction、effective view 和 Renderer 测试。
- `npm run test:memory-v2` 与 `npm test` 全部通过。

## 尚未执行

- 尚未开始 roadmap 阶段 3。
