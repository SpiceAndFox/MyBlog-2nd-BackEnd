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

## 尚未执行

- 尚未开始 roadmap 阶段 2。
