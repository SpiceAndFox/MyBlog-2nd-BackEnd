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

## 2026-07-13：Memory Control v2 阶段 5

- 实现容量阻塞原子事务：完整 normal proposal、稳定 patch/item identity 与阻塞维度持久化到 task stage payload；写入 `result_revision=null` 的 deferred 审计 group，并同事务创建带 `parent_task_id` 的 maintenance child task、更新 target 为 `capacity_blocked`，cursor 保持不动。
- 实现 maintenance envelope、稳定 dedupe key、`compactionProposer` prompt 与原生 structured-output schema；维护输入只暴露单个 writable section，不携带 raw messages、evidenceGroups 或 cursor。
- 实现 compaction apply：只接受同 section `mergeItems + memory_compaction`，继承 source evidenceGroups，独立提交 revision/event group/完整 snapshot，且不推进 raw-message cursor。
- 实现 pending proposal item 保护：compaction 与所有未终结容量 proposal 引用的 itemId 相交时以 `item_protected_by_pending_proposal` 拒绝；全部 patch 无法应用时 halt 对应 target。
- 实现原 proposal 确定性 replay：不重新调用 normal Proposer，在执行时最新 revision 上重新校验 generation、cursor、活动 proposal、evidence/source 与容量，复用首次冻结的 patch/item identity，成功后原子推进 cursor 并恢复 target healthy。
- 实现联合 target 多 section 的顺序维护、同 section 有界尝试、`unable_to_compact` / `capacity_still_exceeded` halt、compaction 独立 retry 上限，以及容量类人工 resume 创建递增 `resume_epoch` 的新 child task。
- 重启与重复 delivery 会从 durable stage 恢复 maintenance/replay；已完成 replay 不重复调用 Provider，不重复创建 revision/event/snapshot/cursor。
- 增加阶段 5 recovery fixture，以及 deferred → compaction → replay、pending-item 保护、unable/halt/resume、稳定 identity、Provider schema/prompt 与重复 delivery 测试。
- `npm run test:memory-v2` 与 `npm test` 全部通过。

## 2026-07-13：Memory Control v2 阶段 6

- 实现仅按 Unicode code point 字符阈值门控的跨 session recent window：预算内保留完整历史，超预算从最新消息反向选择完整 raw messages，保留最新单条与 user-boundary 裁剪，不叠加 message count/tokenizer/context 百分比。
- 接入单一 Memory v2 context segment：仅在 `needsMemory=true` 且 authority state 存在、版本受支持、schema 合法时实时调用 Renderer；跳过时返回明确 debug reason，state/schema 异常只降级 Memory、不阻断主聊天。
- 实现 per-target GapBridge：按六个 cursor 计算 gap，跨 target 去重并保留 target keys；独立字符/最近消息数预算只选择完整 raw message，超限持久化 omitted 边界与统计，不调用 LLM、不推进 cursor/revision。
- 实现 target、active diagnostic 与 RAG/Recall projection query coverage 的 `healthy/degraded/rebuilding` 聚合；rebuilding 优先，halted 给出维护提示，所有路径显式保持 `chatBlocked=false`。
- 实现 projection 的 `requiredBoundary/processedBoundary` 查询健康与有效 RAG cutoff；partial coverage 仍允许注入已处理结果并标记范围不完整，projection checkpoint 与 Memory cursor 保持独立。
- 实现持续告警与恢复通知：GapBridge/projection 诊断保持 active 到明确追平；清诊断与创建 notification 同事务；target 从非健康恢复时同事务创建通知；JSON 与 SSE `done` 返回健康/通知，响应完成后 best-effort 标记 delivered。
- Renderer 读取 target status 与 active GapBridge sidecar，为稳定 state 输出“可能滞后/正在重建”标记；请求时 effective view 需要 cleanup 时异步、串行唤醒幂等 housekeeping。
- 增加 `CHAT_MEMORY_V1_CONTEXT_ENABLED` 独立开关；v2 启用时关闭 v1 rolling summary/core memory/legacy GapBridge 注入，但保留阶段 8 前的旧 worker 代码。
- 增加阶段 6 context fixture，以及 recent window、GapBridge、健康优先级、projection lag、恢复通知、housekeeping wake-up、state 跳过原因与单一 segment 测试。
- `npm run test:memory-v2` 与 `npm test` 全部通过。

## 尚未执行

- 尚未开始 roadmap 阶段 7。
