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

## 2026-07-12：Memory Control v2 阶段 3

- 实现 Normal Observer：按六个 target 独立 lag/status 门控，跨 session 读取有效 user/assistant raw source，并按 `newBatch + overlap` 组装观察窗口。
- 实现严格的 Normal task envelope：writable/read-only state 按 Proposer 固定范围裁剪，移除 evidenceGroups，并限制 read-only item ID 暴露。
- 增加六个独立 Proposer prompt、per-Proposer 原生 JSON Schema，以及本地 output/envelope 二次契约校验。
- 实现 Memory Provider Adapter、mock Adapter 与 OpenAI-compatible native structured-output transport，区分调用失败、安全拒绝、最大输出截断和 schema invalid。
- 实现 durable normal task 的稳定 dedupe key，以及 state/event group/events/snapshot/cursor/task/target status/tombstone 的单事务成功提交；重复 phase delivery 返回既有 revision。
- 增加阶段 3 pipeline fixture，以及 Observer/envelope、prompt、Adapter、原子提交和重复 delivery 测试。
- 本机 `deepseek-v4-flash` smoke 已尝试；当前端点明确返回 `This response_format type is unavailable now`，不支持设计要求的原生 `json_schema`，因此未降级为裸 JSON 解析，真实 API golden 延后到可用 structured-output 端点。

## 2026-07-13：Memory Control v2 阶段 4

- 实现 Provider 可重试错误的有限指数退避：task attempt/notBefore 与 target consecutiveErrors/nextRetryAt 分别持久化，连续错误达到阈值时只 halt 对应 target。
- 实现 `output_schema_invalid` 直接 halt、首次 `unable_to_decide` 扩展尝试，以及二次 unable 的零 semantic event cursor-only revision。
- 实现 generation/cursor stale 的持久化丢弃，以及 revision mismatch 时旧 task 取消、新 baseRevision successor task 原子创建并重新调用 Proposer。
- 为 normal/cursor-only/system-cleanup phase 建立稳定 identity；重复 delivery 与 COMMIT outcome unknown 均先查询既有 event group，避免重复 revision、event、snapshot 或 cursor 推进。
- 区分并记录 `reducer_failed`、`transaction_failed`、`commit_outcome_unknown`；明确回滚后保留可恢复 task，未知提交结果先 reconcile。
- 实现启动恢复扫描：从 queued/running/到期 retry_wait durable task 的 immutable task payload 恢复，可接入 per-user/preset 串行队列。
- 实现 target 级手动 resume use case：retry_wait 复用原 task；Provider/schema halt 保留旧 task 并原子创建新的 normal task。容量类 resume 等待阶段 5 maintenance/compaction 链路，不伪造不可执行 child task。
- 实现后台 housekeeping use case：scene/todos/recentEpisodes 分 target 幂等执行，与 effective view 共用 lifecycle 规则，变化时原子写 system-cleanup task、event group/events、完整 snapshot；无变化不创建空 revision。
- 增加阶段 4 recovery fixture，以及 retry/halt、unable、successor、重启恢复、COMMIT outcome unknown、resume、逐写入点事务故障和 housekeeping 幂等测试。
- `npm run test:memory-v2` 与 `npm test` 全部通过。

## 尚未执行

- 尚未开始 roadmap 阶段 5。
