# Memory v2 生产切换执行手册（Deferred）

## 文档定位

本文只登记尚待定稿的 v2 生产 rebuild、校验与启服操作。v1 runtime 与代码已经移除；一次性 `002-drop-memory-v1.sql` 会删除旧字段和 checkpoint 表，不触碰 `chat_messages`，也不表示 v2 已经可以启服。

当前已经具备真实 Provider preflight、RAG/Recall adapter 与统一 migration CLI；仍不能正式切换的原因：

- 尚未提供隔离的生产历史数据库副本；
- 尚未在隔离历史副本上完成两次全量 rehearsal 并确认调用量、容量和耗时；
- 尚未形成经验证的服务停启入口与失败恢复操作；
- 尚无经过非生产环境验证的停服、失败处置和恢复命令。

迁移算法与验收门以 [Source Rebuild 与 Projection](../memory-control-v2/algorithms/source-rebuild-and-projection.md) §5 和 [Harness 验收契约](../memory-control-v2/harness.md) §3.10 为准。

## 1. 不可破坏的数据边界

- Memory 退役、演练和切换不得修改或删除 `chat_messages` 原文；正式 rebuild 必须从这些原文读取 source。
- v1 清理只处理 rolling/core Memory 字段、相关运行字段与 v1 checkpoint。
- 用户明确发起的隐私删除或消息管理属于独立业务流程，不得借 Memory cutover 名义扩大删除范围。
- v1 已清除只表示旧系统不可回退，不代表 v2 targets 或 projections 已追平。

## 2. 定稿前置条件

1. DeepSeek 完整真实 preflight 持续通过六个 Normal Proposer 与 Compaction；
2. 获得与生产 raw history 等价、与线上写入隔离的 rehearsal 数据库副本；
3. RAG/Recall 均提供 staged rebuild、事务提交和 generation/boundary checkpoint adapter；
4. migration CLI 通过 Memory 模块公共接口完成正式装配；（已完成）
5. rehearsal 报告可稳定落盘并包含规模、section 容量、Provider 调用量、耗时和全部验证结果；
6. 运维侧提供可验证的停服、raw boundary 冻结和重新启服入口；
7. 数据库备份、失败处置责任人与维护窗口已经明确。

## 3. 正式手册必须包含

- 代码版本、schema migration 版本和配置指纹；
- 历史副本的创建、脱敏、访问控制与销毁方式；
- Provider preflight、两次全量 rehearsal 和端到端 smoke 的精确命令；
- scope 清单、报告路径、容量分布、总调用量和维护窗口估算；
- 停服证明与 captured raw boundary；
- `002-drop-memory-v1.sql` 已应用且旧列/表不存在的 schema 校验；
- v2 state 初始化、force drain、RAG/Recall drain 和逐项验证命令；
- `canStartService=false` 时保持停服、保存诊断及选择修复续跑或数据库恢复的步骤；
- 成功启服后的观察窗口与健康指标。

当前已实际装配并验证以下只读/能力检查命令：

```text
npm run probe:memory-v2-provider
npm run migrate:memory-v2-data -- --mode inventory
npm run migrate:memory-v2-data -- --mode cutover
```

后者不带 `--apply` 时只输出计划并返回 `apply_required`，不会写数据库。待隔离历史副本可用后，rehearsal 使用：

```text
npm run migrate:memory-v2-data -- --mode rehearsal --apply --report <new-report-path>
```

正式 cutover 只能在完成停服与 raw boundary 冻结后执行：

```text
npm run migrate:memory-v2-data -- --mode cutover --apply --service-stopped --report <new-report-path>
```

报告文件使用独占创建，已存在时拒绝覆盖。命令返回 `canStartService=false` 或非零退出码时必须保持停服。
失败后修复代码或 Provider 配置，再使用新的报告路径重跑同一 cutover 命令；若 raw boundary 未变化且现有 target generation 仍满足 rebuilding/healthy 边界约束，迁移器续跑该 generation 和未完成 task，不重复初始化已经开始的 rebuild。新报告中的错误明细会包含失败 target、task、内部 outcome 和本轮已完成 task 数。

## 4. 禁止行为

- 不得在没有历史副本 rehearsal 报告时启用 v2；
- 不得以简单 JSON probe 代替完整 Provider preflight；
- 不得以口头确认代替实际停服和 raw boundary 冻结证据；
- 不得在任一 Memory target、RAG 或 Recall checkpoint 未追平时启服；
- 不得把 v1 文本转换成 v2 authority；
- 不得因 v1 已清除而跳过失败门或强行设置 `canStartService=true`；
- 不得增加长期 Flush task/type/table 或双 authority 兼容路径。

## 5. 移出 Deferred 的条件

生产历史副本上至少两次可重复 rehearsal 均通过，容量与耗时进入批准窗口，端到端 smoke 通过，精确 cutover 与失败处置命令也在非生产环境验证后，本文才能移出 `devplans/deferred`。正式切换结果最终写入 `devplans/implemented.md`。
