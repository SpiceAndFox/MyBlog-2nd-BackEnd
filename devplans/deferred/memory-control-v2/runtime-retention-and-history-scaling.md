# Memory Control 2.01 运行时维护与长历史扩展（延后）

## 定位

本文记录 2026-07-14 上线审计中确认存在、但在当前个人单用户和现有历史规模下不直接阻塞首日 cutover 的问题。延后以本文列出的上线约束成立为前提；达到升级条件时必须转成 blocker，不能无限期搁置。

## 1. Retention 已实现但没有生产调度，且投影门永远无法通过

### 当前行为

- `modules/memory/application/runtime.js:101,336-339` 构造并暴露 `runRetentionScope`；
- 全仓除定义和测试外没有调用该入口；`app.js:59-73` 只启动 task/projection polling；
- 因此 `.env.example:120-124` 声明的 snapshot/event/task/ops retention 实际不会运行；
- `modules/memory/application/retention.js:48-57` 又硬编码 `checkpoints.length === 2`，而当前只注册和推进 `rag`，见 `services/chat/memoryRuntime.js:7-9` 与 `sidecarRepository.js:98-106`。即使接上 scheduler，也不会允许清理 old generations。

### 为什么可暂缓

默认最短 retention 是 30 天，fresh cutover 首日没有 eligible v2 rows；用户 privacy hard delete 是独立即时路径。暂缓必须同时满足：

1. rehearsal/生产库没有已超过 retention window 的 2.01 rows；
2. 数据库容量足以覆盖至少一个确定交付周期，且有表增长告警；
3. 在第一批数据到期前同时交付 scheduler 和投影集合修复；
4. 对外没有已经生效的更短数据保留承诺。

任一条件不满足时，本项升级为上线阻塞。

### 验收

- 定时遍历 initialized scopes，使用有界 batch 和 overlap guard；
- required projection keys 来源于实际注册集合，当前只有 `rag`；legacy/未知 row 不得误判健康；
- fresh 单-rag current 时允许清理 old generations，missing/unhealthy rag 时禁止；
- 用真实 PostgreSQL fixture 验证过期 rows 被删、authority anchor 和 replay chain 仍成立。

## 2. 每次聊天请求全量读取、哈希并遍历整个 preset 历史

### 当前行为

- 当前热路径每次请求读取并哈希该 preset 的大范围 raw history；2.01 不再读取 correction/forget tombstone；
- `sourceRepository.js:39-46` 的 SQL 没有 LIMIT/下界，且对每条 content 做 SHA-256；
- recent window、GapBridge、诊断恢复和 time candidates 随后多次遍历同一全量数组；实际 time context 只需要末两条候选。

当前已知历史规模较小，尚无性能证据证明它会阻塞首日请求，因此暂缓；但复杂度随长期情感对话线性增长，不能当作最终架构。

### 验收

- SQL 分别按 recent 字符窗、各 target gap 范围、scene anchor 和末两条 time candidates 做有界查询；
- 若未来启用完整 suppression 设计，其过滤记录按相关 message ids/range 查询，不能恢复全量热路径；
- 10 万消息 scope benchmark 中，DB 返回行数与进程驻留对象有显式上界，已完全被 cursor 覆盖的旧历史不再线性增加单请求延迟/RSS。

### 升级条件

- rehearsal 的最大 scope 已使 context compile p95 超过产品预算；
- 单请求读取/哈希量足以造成明显 event-loop stall 或 RSS 峰值；
- 上线前即导入大规模历史。

## 3. 单条超预算 item 会进入无法完成的 compaction

### 当前行为

- normal output 的 `value.text` 只有 `minLength`，没有 maxLength，见 `modules/memory/infrastructure/providers/outputSchema.js:3-4,33-37`；
- item section 超预算统一 deferred 到 compaction；
- compaction 唯一写操作 `mergeItems` 要求至少两个 item，见 `modules/memory/infrastructure/providers/outputSchema.js:42-50`；空 section 或单 item 没有合法压缩动作，`unable_to_compact` 会 halt target；
- 当前 [容量降级策略](capacity-degradation.md) 依赖运维调高容量后 resume。

Prompt 要求高密度短文本，且 target halt 不阻断主聊天并会显示 degraded，因此本轮不新增自动降级状态机。但应补一个确定性局部拒绝：空/单 item 的超长 add/update 不应创建必败 maintenance chain。

### 验收

- 空/单 item 超预算时局部 `capacity_exceeded`，cursor/health 语义明确；或提供可验证的单 item 压缩 op；
- manual resume 不重复创建同一种必败 child；
- schema-valid 2001-char item 对 2000-char section limit 的回归测试覆盖完整 pipeline。

## 4. Context capability 和统一总预算仍依赖部署自律

[总 Context 预算](total-context-budget.md) 的延期前提是主聊天与 Memory 都使用已验证的约 1M 模型。当前实现只相信 Memory 环境变量中的 `MAX_INPUT_TOKENS`，structured-output preflight 不验证真实 context capability；主聊天模型 metadata 也没有统一 `maxInputTokens`。

首发必须用 allowlist 锁定已经独立验证的模型。若开放小 context 模型选择或无法证明上限，本项立即升级为 blocker；否则统一裁剪算法仍按原文档延期。

## 5. Migration/schema 工具的长期加固

当前 runner 每次按文件名重跑全部 SQL，没有 migration ledger/advisory lock；schema checker 主要检查对象名称，不能证明 index 定义、constraint 和 legacy data 均正确；migration report 也缺少完整代码/schema/config 指纹。

本次 production cutover 的具体缺口属于主审计的 GATE-01~03，不能延期。完成首次安全 cutover 后，通用工具加固可继续在本文跟踪：

- migration ledger、checksum 和 advisory lock；
- 对关键 index predicate/columns、constraint 和 enum/check 的精确 schema 验证；
- report 内置 git SHA、migration SHA-256、脱敏配置指纹和真实 Provider metrics；
- recovery scan、retention 和 projection reconcile 的全局 batch/背压。

## 6. 重新评审节奏

首次 cutover 后一周复核 DB 增长、context compile p95/RSS、Provider calls/cost 和 capacity halt；第一批 30 天 retention 到期前必须完成第 1 节。任何升级条件命中时，从 Deferred 移回 active devplan 并按上线事故风险排序。
