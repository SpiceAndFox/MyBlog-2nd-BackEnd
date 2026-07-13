# State Contract 审查批次

建议拆成 3 轮、12 个批次。顺序按“基础契约 → 写入语义 → 持久化与恢复 → 跨系统 sidecar”排列，避免下游审查建立在错误 schema 上。

本文保留审查拆分与覆盖清单，不作为合规结论本身。第二轮已经按批次 5–7、12 的交叉边界完成首轮修复；具体实现状态见 `devplans/implemented.md`，最终合规结论仍应以各轮审查报告和测试结果为准。

## 第一轮：静态契约与输入边界

| 批次                             | 审查范围                                                                                                                                 | 主要代码                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 权威状态与基础枚举            | §1–§3：九个 section、六个 target、state 容器、scene/item/evidenceGroups、Todo 字段、schema version、全局唯一 ID、meta 禁止保存运行状态   | `modules/memory/contracts/constants.js`、`modules/memory/contracts/state.js`、初始化逻辑                                                    |
| 2. DDL 与 Repository 映射        | §1、§9.1–§9.10 的所有表、字段、类型、nullable/default、唯一约束、索引；数据库行与 JS 对象映射                                            | `migrations/memory/001-memory-v2.sql`、`migrations/memory/003-add-user-time-zone.sql`、`migrations/memory/004-add-diagnostic-projection-checkpoints.sql`、`infrastructure/repositories/*`、`test/memory/repository.test.js` |
| 3. Patch、Envelope 与输出 Schema | §4–§5：op 字段组合、normal/maintenance 判别、redacted view、readOnlyContext 固定范围、target sections 完整覆盖、unable/noop/patches 结构 | `modules/memory/contracts/proposal.js`、`modules/memory/application/envelope.js`、`modules/memory/infrastructure/providers/outputSchema.js` |
| 4. Provider Adapter              | §10：显式 adapter 选择、原生 structured output、本地二次校验、DeepSeek schema 编译、错误归一化、完整 schema preflight                    | `infrastructure/providers/*`、`modules/memory/config/loadProviderConfig.js`、`test/memory/provider-adapter.test.js`                         |

批次 1、2 是阻断性基础。如果这里发现 state shape 或数据库约束错误，后续结论需要标记为“基于错误基础契约，修复后需复核”。

## 第二轮：Reducer 与语义写入

| 批次                           | 审查范围                                                                                                                                                                 | 主要代码                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5. Evidence、Policy 与拒绝路径 | §3、§4、§6、§7：per-Proposer evidence enum、section/op/evidenceKind 矩阵、真实 role、message/hash/scope 复核、quote 匹配、reject reason、部分 accepted/rejected          | `modules/memory/domain/evidence.js`、`modules/memory/domain/policy.js`、`modules/memory/domain/reducer.js`                                                                            |
| 6. 生命周期与容量              | §1 中 Scene/Todo 生命周期、§8、§9.2 cleanup：dueAt 日历计算、overdue/revive、previousScene、recentEpisodes 滚出、active/overdue 独立容量、集中配置、cleanup operation    | `modules/memory/domain/calendar.js`、`modules/memory/domain/lifecycle.js`、`modules/memory/domain/capacity.js`、`modules/memory/application/housekeeping.js`                          |
| 7. Revision、Event 与成功事务  | §9.1、§9.2、§9.6：revision 连续性、post-state snapshot、event group、event_index、normalized_operation、patch/item ID、联合 target cursor、原子写回、重复 phase delivery | `modules/memory/application/normalWritePipeline.js`、`modules/memory/infrastructure/repositories/stateRepository.js`、`modules/memory/infrastructure/repositories/auditRepository.js` |

批次 5 先验证“能不能接受”，批次 6 再验证“接受后如何变更”，批次 7 最后验证“如何可靠落库”。

## 第三轮：恢复、维护与跨系统状态

| 批次                                     | 审查范围                                                                                                                                                         | 主要代码                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8. Durable Task、失败与恢复              | §9.3–§9.6、§10 orchestrator 部分：task/status/ops log authority、retry/halt/resume、successor、unable 二次处理、stale result、commit outcome unknown、启动恢复   | `modules/memory/application/recovery.js`、`modules/memory/application/runtime.js`、`modules/memory/infrastructure/repositories/runtimeRepository.js`                                              |
| 9. Capacity Maintenance 与 Replay        | §5.2、§5.5、§8、§9.2–§9.4：deferred 审计 group、maintenance child、pending item 保护、compaction revision、冻结 proposal replay、容量类 resume                   | `modules/memory/application/capacityMaintenance.js`、`test/memory/stage5-capacity-maintenance.test.js`                                                                                            |
| 10. Source Generation 与 Projection      | §1 的 sourceGeneration、§9.4 rebuilding、§9.7：source mutation 原子初始化、六 target rebuild boundary、force-drain、RAG/Recall 独立 checkpoint、stale projection | `modules/memory/application/sourceRebuild.js`、`modules/memory/application/projectionDrain.js`                                                                                                    |
| 11. Suppression、Retention 与隐私删除    | §9.8、§9.11、§9.6 日志限制：forget/correction tombstone 原子性、查询/rebuild gate、anchor 提升、引用保护、privacy hard delete、禁止持久日志泄漏正文              | `modules/memory/domain/suppression.js`、`modules/memory/application/retention.js`、`modules/memory/application/privacyHardDelete.js`                                                              |
| 12. Diagnostics 与 Recovery Notification | §9.9–§9.10：诊断归属、omitted boundary、scene capacity event projection/checkpoint、per-field resolved 条件、健康聚合、通知唯一性、事务内创建、响应成功后 best-effort delivered | `modules/memory/application/contextAssembly.js`、`modules/memory/application/diagnosticProjection.js`、`modules/memory/domain/contextCoverage.js`、`modules/memory/domain/health.js`、`modules/memory/infrastructure/repositories/sidecarRepository.js`、`modules/memory/infrastructure/repositories/diagnosticProjectionRepository.js` |
