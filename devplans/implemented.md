# 已完成开发

## 2026-07-13：State Contract 第三轮审查修复

- 启动与周期任务恢复新增 durable rebuild-boundary reconciliation：即使当前没有 pending task，只要 target 仍处于同 generation rebuilding，就在 scope 串行 lane 中续跑 force drain，并尊重 durable `retry_wait/notBefore`。
- maintenance Provider 退避期间 child task 保持 `retry_wait/notBefore`，target 保持 `capacity_blocked`；parent/replay 尊重 child 到期边界，不提前重试。
- retention anchor 提升改为从旧 anchor 确定性 replay 已吸收的 semantic/system-cleanup events，并与候选 snapshot 深比较；仅 status row 完整、同 generation 且无 rebuild boundary 时才清理旧 generation。
- GapBridge 恢复改为按当前 generation/state 和原省略 source 区间证明；diagnostic 增加 generation 归属、跨 generation 清理及 active partial unique index/原子 upsert。
- projection checkpoint 增加独立 tombstone 水位；即使 generation/source boundary 不变，也会异步删除命中 tombstone 的 RAG 派生数据，同时保留 query-time suppression correctness gate。
- session permanent delete 与自动 trash purge 接入 runtime privacy-hard-delete 编排和同一 scope lane，物理清理 RAG 后验证无残留，再从剩余 raw source rebuild。
- 新增 `005-runtime-correctness.sql`，fresh schema、schema checker、契约说明和回归测试同步覆盖上述行为。

## 2026-07-13：State Contract 第二轮审查修复

- scene 字段写入超过 `scene.maxRenderedChars` 时只拒绝该字段 patch（`capacity_exceeded`），恢复其 pre-patch 值；同 bundle 其他合法 patch 可提交，cursor 正常推进，不创建 maintenance task。
- 新增从已提交 semantic events 派生的独立 `scene_capacity_diagnostics` 投影：持久化 event checkpoint、按字段维护 `detail.rejectedPaths`，投影失败不回滚 normal task，并由 runtime/context assembly 幂等重试。
- active `scene_capacity_exceeded` 在 health 防抖后进入 degraded，Renderer 则立即在当前状态前标记“该类记忆可能滞后”；响应 health alert 说明长度超限未写入，对应字段后续 accepted 后逐项恢复并产生 recovery notification。
- 新增 `004-add-diagnostic-projection-checkpoints.sql`，为 diagnostics 增加通用 `detail`，建立 diagnostic projection checkpoint；schema checker、privacy hard delete 和契约文档同步覆盖。
- Retention 在删除 event 前先同步 diagnostic projection；同步失败则不清理，避免 checkpoint 尚未消费的 rejection event 被提前删除。
- 同轮修复还包括 capacity phase 重入、maintenance 全 rejected 审计、replay suppression gate，以及日历毫秒与 DST gap/overlap 语义。

## 2026-07-13：Memory Control v2 写协议审查修复

- 增加 durable task 持续轮询 worker 与 `CHAT_MEMORY_V2_TASK_POLL_INTERVAL_MS`，启动扫描之后仍会自动消费 queued/running/到期 retry_wait；task、housekeeping、source mutation/rebuild 和 projection 工作共用 runtime 的 user/preset 串行 lane。
- `unable_to_decide` 第二次提交补齐 baseRevision stale 校验并走 successor；Provider 普通重试真正受 `retryMax` 限制；Observer 缺失 target status 时不再按 healthy 放行。
- target resume 在新 task 成功前保持 degraded，新增 `npm run resume:memory-v2` 维护入口。
- 增加 User `time_zone` 字段、认证更新接口与迁移；task 创建时将 IANA 时区固化到 envelope，Reducer 用其做确定性日历运算。
- 增加 authority state 的最新完整快照恢复与无法证明完整时的 raw-source 新 generation rebuild，并从上下文降级路径经统一 lane 自动触发。
- 接入告警防抖/恢复稳定配置和有界内存指标采集（eligible/lag、Provider 调用/延迟/tokens、task outcome、quote similarity/reject reason）。

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
- 本机 `deepseek-v4-flash` smoke 已尝试；当时使用的正式端点明确返回 `This response_format type is unavailable now`，不支持原生 `json_schema`，因此未降级为裸 JSON 解析。该历史限制后续已由官方 Beta `deepseek-strict-tools` adapter 解决，最新结果见本文“Memory Provider adapter 与配置解耦”。

## 2026-07-13：Memory Control v2 阶段 4

- 实现 Provider 可重试错误的有限指数退避：task attempt/notBefore 与 target consecutiveErrors/nextRetryAt 分别持久化，连续错误达到阈值时只 halt 对应 target。
- 实现 `output_schema_invalid` 的边界化恢复：输入契约错误直接 halt；Provider 输出错误持久化后最多立即重试一次，第二次仍非法才 halt。首次 `unable_to_decide` 扩展尝试，二次 unable 以零 semantic event cursor-only revision 终结。
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
- v1 rolling summary/core memory/legacy GapBridge 已正式退役：删除其环境变量，运行时固定禁止旧上下文注入与后台 tick；本阶段暂留的实现代码已在阶段 8 物理清理。
- 增加阶段 6 context fixture，以及 recent window、GapBridge、健康优先级、projection lag、恢复通知、housekeeping wake-up、state 跳过原因与单一 segment 测试。
- `npm run test:memory-v2` 与 `npm test` 全部通过。

## 2026-07-13：Memory Control v2 阶段 7

- 实现 source mutation generation 初始化事务：raw mutation 回调、有效 source boundary、`sourceGeneration + 1`、旧 generation 非终态 task 取消、空 state/cursor、全局 revision 单调递增 snapshot、六 target `rebuilding` 与 RAG/Recall checkpoint invalidation 原子提交。
- 实现授权 `forceDrainTo`：绕过普通 lag/status 门控，复用 normal durable task pipeline 分批追平 captured boundary；中间批次保持 `rebuilding`，仅在 generation、authority state、完整 snapshot、连续 event/revision/cursor 与 suppression 终态校验通过后逐 target 恢复 healthy。
- 实现 RAG/Recall 通用 projection drain：generation 不一致全量 staged rebuild、同 generation 增量 staged append，提交前重校 generation/boundary，并在同事务提交派生结果与独立 checkpoint；stale 结果不推进 checkpoint 或写入派生数据。
- 完成 correction/forget suppression 闭环：既有 Reducer tombstone 原子提交保持不变；normal/rebuild evidence 查询先排除 suppressed source；重建终态过滤支持“更晚且未 suppress 的 correction evidenceGroup”例外。
- RAG chunk metadata 保存全部 source `messageId + contentHash`；建索引前、相似度查询末端和相邻 raw dialogue window 均应用 tombstone gate。generation mismatch 时不注入旧 RAG projection。
- 实现 Recall 三段 suppression 的纯代码 gate：候选 evidence refs、raw window 与最终可注入 evidenceGroups 统一按 source key 过滤，全 refs 被过滤的 group 跳过。
- 实现 retention：校验 schema-valid authority/anchor、revision/event/snapshot 连续链后原子提升 anchor，清理已吸收 event/snapshot；保留 active task、predecessor/parent 和 retained group 引用，并仅在 targets/projections 已脱离旧 generation 后清理旧 generation 审计数据。
- 实现 privacy hard delete 编排：raw source、Memory state/history/task/ops/tombstone/diagnostic/notification/checkpoint 与显式 RAG/Recall/debug store adapter 同一受控流程物理清除；任一 store 仍有残留时保持 rebuilding，不执行 force drain；清除后从剩余 raw source 重建。
- 增加阶段 7 rebuild/suppression fixture，覆盖 correction 例外、RAG/Recall 查询 gate、source generation 初始化、force drain 中间状态、projection stale、retention anchor 与 privacy residue 阻断。
- `npm run test:memory-v2` 与 `npm test` 全部通过。

## 2026-07-13：Memory Provider adapter 与配置解耦

- 保留上层 `MemoryProviderAdapter` 的统一结果语义，新增 structured transport factory；Memory pipeline 不再绑定单一 Provider 请求协议。
- 支持 `openai-json-schema` 与 `deepseek-strict-tools` 两种显式 adapter。DeepSeek adapter 使用 Beta strict function/tool calling、强制指定 tool，并将 tool arguments 归一化为统一 structured output。
- 增加 DeepSeek schema 编译层：将 `oneOf`/`const` 和可选 object properties 转换为 strict-tools 可接受的 schema 子集；不受 Provider 支持的长度、数组约束仍由既有本地契约校验兜底。
- 用 `CHAT_MEMORY_V2_PROVIDER_ADAPTER` 替代不能证明真实能力的 `CHAT_MEMORY_V2_PROVIDER_STRUCTURED_OUTPUT` 布尔声明。
- Provider 配置可独立加载；preflight 只读取 `CHAT_MEMORY_V2_PROVIDER_*`，不再回退到聊天链路的 `DEEPSEEK_*` 配置。官方 DeepSeek strict adapter 会在请求前拒绝非 `/beta` 端点。
- 增加 adapter 选择、配置隔离、schema 转换、strict tool 请求及响应归一化测试；`npm run test:memory-v2` 与 `npm test` 全部通过。
- DeepSeek Memory 请求显式发送独立 `thinking.type=disabled`，不继承主聊天思考设置；配置允许显式启用以便实验，但高频生产默认关闭。
- preflight 从简单布尔 schema 扩展为六个 Normal Proposer 与 Compaction 完整 schema 的顺序 golden 探测，并移除脚本对单一模型 ID 的硬编码。
- Provider 输出边界 `output_schema_invalid` 首次将计数持久化到 durable task 并立即重试一次；输入边界错误不重试，第二次输出错误 halt，恢复扫描不会重新获得次数。
- 独立 `CHAT_MEMORY_V2_PROVIDER_*` 已使用官方 DeepSeek Beta strict-tools 端点与 `deepseek-v4-flash` 完成真实 preflight；六个 Normal Proposer 与 Compaction 的完整 schema 均以强制 tool call 通过。实测修复了 enum 缺少显式 primitive `type` 以及嵌套 `anyOf` 分支缺少直接 `type` 的 DeepSeek schema 兼容问题，并增加编译器回归测试。

## 2026-07-13：Memory Control v2 阶段 8 代码退役与运行时切换

- 物理删除 v1 rolling summary、core memory、checkpoint、worker/tick/rebuild lock、旧 context segments、旧模型和旧 prompts；聊天代码不再导入或分支到 v1。
- 上下文编译器只允许单一 Memory v2 segment；v2 关闭时只提供普通 recent/RAG 上下文，不存在旧 Memory fallback。
- 增加 v2 runtime 装配：normal observer/pipeline、per-scope 串行队列、source mutation rebuild 与进程启动 durable task recovery 已接入聊天运行路径。
- 旧手动 rebuild API 改为触发 v2 source rebuild；消息编辑、会话删除/恢复/永久删除和 trash purge 均改为使 v2 generation 失效并 rebuild。
- 新增 `002-drop-memory-v1.sql`，幂等删除 v1 checkpoint 表及 rolling/core/dirty/rebuild 字段；fresh schema 与 migration runner 均只建立/执行 v2 所需结构，且不修改或删除 `chat_messages`。
- Assistant gist 仍是可选的近期窗口压缩能力，不是 Memory authority；其实现和配置已移出旧 Memory 命名空间。

## 尚未执行

- roadmap 阶段 8 的代码退役已完成；生产历史副本上的正式 rehearsal/cutover 仍未执行。当前已有历史规模与 section 容量/耗时报告、全 target/snapshot/event/projection 校验，以及“校验失败不得启服”的硬门。
- 真实 RAG projection adapter 与 query-time Recall checkpoint adapter 已接入运行时；尚需提供生产历史数据库副本和 migration CLI 装配入口，之后执行全量 rehearsal、容量/耗时记录及端到端业务 smoke。v2 生产切换手册暂存于 [Memory v2 生产切换执行手册（Deferred）](deferred/memory-v2-production-migration-runbook.md)；通过前不开放生产启服门。

## 2026-07-15：Memory v2 上线审计 Stage 6 生命周期修复

- 启动改为先执行完整 Provider preflight 和 strict pending recovery，再启动 task/projection worker 并监听业务端口；privacy/rebuild/task/projection 仍存在 incomplete、retry、pending 或非健康投影时 fail closed，不进入 ready。
- 新增 `/health/live` 与 `/health/ready`；业务中间件在 starting/recovering/draining/failed 状态统一返回 `503`，部署平台可据此控制流量。
- 新增 SIGTERM/SIGINT graceful shutdown：撤销 readiness、停止 polling/cleanup、取消所有在途可取消 chat scope，等待 HTTP、Memory、privacy operation 和 scope lane 收口后关闭数据库；超时强制断开并记录非 graceful 结果。
- Memory runtime、privacy hard delete、trash cleanup 和 scope coordinator 均增加可等待的 idle/shutdown 边界，避免旧进程退出后仍继续调用 Provider 或提交派生结果。
- production 启动强制 `CHAT_MEMORY_V2_ENABLED=true`、`APP_REPLICA_COUNT=1`，要求两个 raw debug 开关显式为 false，并用 `CHAT_PRODUCTION_CONTEXT_MODEL_ALLOWLIST_JSON` 同时约束默认/请求 chat 模型与 Memory 模型；`SERVER_SHUTDOWN_TIMEOUT_MS` 提供受限的停机窗口配置。
- Todo relative dueAt 收敛为单一单位 canonical wire contract：`days=0` 表示今天，absolute/relative deadline 均解析为 evidence message 所在用户时区目标日期结束后的首个日界线；Provider schema、本地 validator、Reducer、prompt 与权威契约文档同步更新。
- `output_schema_invalid` 的唯一即时重试改为 durable repair retry：有界校验 path/message 同时写入 task `schemaRepairFeedback` 与 `output_schema_invalid_retry` ops log，并注入第二次 system prompt；进程恢复复用同一反馈，非法输出原文不落 task/log/prompt，第二次仍非法才写终态 `output_schema_invalid` 并 halt target。
- 增加 Provider raw/DeepSeek-compiled schema 与本地 dueAt validator 的边界一致性测试，以及今天日界线、修复反馈持久化/恢复/包装层透传/日志隐私测试。增加 health/readiness、启动顺序、严格恢复、全 scope cancel、后台 privacy drain、生产模型 allowlist、production fail-closed 和 fatal process event 测试；Windows 项目运行时 `npm test` 251/251 通过。
- 这里只完成 GATE-04 的应用代码部分；单实例/autoscaling/无重叠部署证明、真实停启服验证、两次生产历史副本 rehearsal、备份恢复和正式 cutover 仍未执行。

## 2026-07-13：Memory v1 退役审计修复

- 将消息编辑/截断、session trash/restore/permanent delete 与 trash purge 的 raw source mutation 接入 Memory per-scope 串行队列，并通过 `mutateSource(client)` 与 generation 初始化原子提交；HTTP 请求只等待安全的 rebuilding 状态建立，force drain 在同一 lane 后台继续。
- 装配真实 RAG staged rebuild/append/transactional commit；Recall 明确为 query-time projection，在 RAG 完成后推进独立 coverage checkpoint。normal append、source rebuild 与启动恢复都会触发 projection drain。
- Memory v2 启用时停用旧的独立 RAG best-effort indexing/delete kick，避免 projection checkpoint 与派生数据各自推进；v2 关闭时仍保留独立 RAG 行为。
- 删除重复的 `models/tableCreate/chat_preset_memory.sql`，Memory DDL 只保留在 `migrations/memory`；Provider probe 改为只经 `modules/memory/index.js` 公共入口访问模块。
- 将旧 RAG debug reason `no_summarized_history` 改为 `no_retrievable_history`。
- 增加 `npm run check:memory-schema`：WSL 网络连接失败时自动发现并调用 Windows `psql.exe`，不输出密码；已验证当前 Windows 数据库不存在 v1 checkpoint 表及 rolling/core/dirty/rebuild 列。

## 2026-07-13：RAG v2 收口与迁移入口

- 修复启动恢复使用错误 repository 方法名的问题；启动 recovery 与新增的周期 reconciliation 都会枚举已初始化 scope，并按 per-scope lane 追平 RAG/Recall projection。
- 新增 `CHAT_MEMORY_V2_PROJECTION_POLL_INTERVAL_MS`；projection staging/commit 失败会保留旧 checkpoint coverage，并持久化 `degraded/rebuilding + lastErrorReason`，由后续轮询重试。
- 将 RAG chunk、展示邻近窗口和 Scene Recall LLM 输入统一到 `messageId + contentHash` suppression gate；移除 Scene Recall debug 日志中的完整 prompt 与输出正文。
- Memory v2 启用时 direct RAG index/delete API 和旧 `regenerateChatRag.js` 明确拒绝执行；相似度查询同时排除已 trash session 的残留 chunk。
- 新增 `npm run migrate:memory-v2-data`：默认只读 inventory；rehearsal/cutover 必须显式 `--apply --report`，cutover 额外要求 `--service-stopped`，并经 Memory 模块公共入口装配正式 pipeline、RAG/Recall drain 和最终验证。
- migration CLI 支持在 raw boundary 未变化时续跑已有 rebuilding generation，并在 force-drain 中断报告中保留 target/task/outcome 摘要；system cleanup 审计事件统一写入契约规定的 `decision=system_cleanup`。
- `unable_to_decide` 的第二次有界尝试会按契约使用双倍 overlap contextWindow；force-drain 在同一执行中消费 `context_expansion_required` 中间态，不再把正常的两阶段判断误报为迁移失败。
- DeepSeek 不支持 `minItems/maxItems` 的边界通过 Provider wire adapter 收口：scene strict schema 使用单个 `evidenceRef` 对象，adapter 再归一化为内部既有 `evidenceRefs: [ref]`；本地 validator、Reducer 与 state 契约不放宽。force-drain 可在同一 generation 内把修复后的终态失败 task 续为新的可审计 task，且 target 状态转换保留 rebuild boundary。
- DeepSeek Beta strict-tools 偶发在完整 tool arguments 末尾多输出右花括号；transport 只允许移除最多两个末尾 `}`，且必须随后通过标准 `JSON.parse`，不修补截断内容、不改字段和值。真实 scene patch preflight 已覆盖该 wire schema、保守解析和 canonical 归一化。
- Provider 输出 validator 对 null/错误类型保持总函数语义：畸形 evidenceRefs 只形成 `output_schema_invalid`，不再因读取 `.length` 抛出未分类 TypeError；force-drain 的未预期异常报告携带 generation/target/cursor/task/stage 定位信息。
- 当前 Windows 数据库的只读 inventory 已验证：3 个 source scope、461 条有效消息；cutover dry-run 正确停在 `apply_required`。真实 DeepSeek 完整 Provider preflight 再次通过。
- 生产历史副本 rehearsal 与正式 cutover 仍未执行；在两次 rehearsal、调用量/容量/耗时确认和停服入口验证完成前，不把当前数据库标记为 `canStartService=true`。
