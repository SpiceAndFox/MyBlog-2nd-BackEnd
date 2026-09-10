# Memory integrity implementation

状态：本地实现及真实数据库一致性验收完成（2026-09-10）。已按用户授权更新本机 blog_dev 表结构、清空旧 Memory，并完成 default 的 480 条真实历史重建。Provider 用量统计有一次缺失，单独保留为审计限制。

## Scope

- Implement P0, P1, P2 and their rehearsal gates. Keep multi-round Librarian and episode/milestone separation out of this change.
- Use one section policy, one bounded repair mechanism and the existing task/revision/transaction lifecycle.
- Make evidence selection explicit and bounded. Preserve lineage in audit events within the configured retention period; retained snapshots guarantee replay, not permanent historical lineage.
- Keep supported Librarian sections unchanged. Unsupported removals are reported without mutating memory.
- Use sanitized offline scenarios and the authorized DeepSeek API for live model evaluation. The subsequent database reset and default rebuild were explicitly authorized by the user on 2026-09-10.
- Preserve protected prompt JSON examples unless the user explicitly approves a concrete necessary change.

## Delivery gates

- [x] Section actions, text/evidence limits, deterministic append, atomic rejection and bounded repair.
- [x] Explicit current evidence through normal writes, compaction and Librarian; lifecycle timestamps and exact event replay.
- [x] Deterministic legacy/mixed-history scheduling, persisted watermarks, barrier and restart/final deduplication.
- [x] Bounded evidence input; Librarian move/revise/correct/split/merge/duplicate remove.
- [x] Diagnostics, failure/restart scenarios, full offline regression and live DeepSeek evaluation.
- [x] Requirement-by-requirement completion audit and documentation.

## Initial baseline

Before implementation: Memory offline 327/327; full offline 431/432. The RAG HTTP 429 timing-sensitive test passed when rerun separately (3/3 in that file).

The user explicitly approved adding only `"supportRefs":["UP1-E1"]` to the protected regular compaction JSON example. All other protected examples remain unchanged.

## 实现与验收对应关系

| 计划 | 实现 | 验证 |
| --- | --- | --- |
| P0 写入动作 | 共用 section policy；普通文本 update 改为 revise/correct，recentEpisodes 使用 append；scene correct 保留独立审计动作 | action 矩阵、Unicode 边界、完整结果长度、来源上限 |
| P0 有界失败 | reducer 固定拼接 ` → `；不截断文本或来源；普通 proposal 机械失败整体拒绝；写入前预演复用持久化 schema repair | 拼接越界、repair 耗尽、重启不重置额度、不推进 cursor |
| P1 当前证据 | revise/correct 替换来源；append 合并旧来源与新片段来源；compaction 显式选择被合并项的证据 | 119 次连续改写来源不累积；合并证据权限、来源上限 |
| P1 生命周期 | 创建/修改时间使用任务消息边界，不由来源最大 ID 反推 | normal、scene、Librarian 事件回放恢复相同 state |
| P1 legacy 调度 | complete_turn / message_batch；按有序消息 ID 划分批次；checkpoint 持久化调度边界，共用 barrier | 无 turn、混合历史、稀疏 ID、配置变化后的重启、periodic/final 去重 |
| P2 Librarian | 单轮 move/revise/correct/split/merge/remove；split 可留在同栏；remove 仅支持有 keeper 的 duplicate | 来源、身份、时间与回放；其他移除原因拒绝，reports 不修改 state |
| P2 证据输入 | task 创建时固定摘录；最多 48 个引用、每条 800 字、总计不超过 12,000 字 | 原文缺失、hash/scope 不匹配和预算不足的别名不可选择；不截断权威来源 |
| 事务与恢复 | 复用 task/revision/transaction 生命周期；提交时重新验证来源；Librarian 编译和 reducer 错误进入有界 repair | state/snapshot/group/events/checkpoint/task 六个写入边界故障回滚；恢复重用结果，不重复调用或提交 |
| 诊断 | inspect 输出字符数、来源数；shadow/eval 输出 action、拒绝原因、结果尺寸和逐栏 before/after；写入拒绝指标 | 全量离线回归与合成 API 评估 |

配置默认值集中在 `modules/memory/contracts/sectionPolicy.js`，创建 task 时捕获，重试沿用原值：

| Section | 单项字符 | 来源数量 | append 增量 |
| --- | ---: | ---: | ---: |
| scene / todos / standingAgreements / milestones / worldFacts / relationship | 300 | 16 | 不支持 |
| userProfile / assistantProfile | 200 | 16 | 不支持 |
| recentEpisodes | 600 | 32 | 160 |

这些是写入上限，不是模型一定能无损压缩到该长度的承诺。无法可靠压缩时允许 unable_to_compact，保留现有 halted/manual-resume 流程。容量维护继续保护被 pending proposal 引用的 item。

## DeepSeek thinking 与 schema

本地 `.env` 的 Memory thinking 已改为 `enabled`，reasoning effort 为 `low`。low 仍会思考，最终实测返回 reasoning token 计数。支持 low/high/max 以及 proposer 的 effort 覆盖。`THINKING_MODE=high` 无效，high 应放到 reasoning effort。

实际请求使用 `thinking: {type: "enabled"}`、`reasoning_effort: "low"`、`tool_choice: "auto"`。实测启用 thinking 时强制指定函数会返回 HTTP 400。修复调用使用独立请求，将旧错误结果引用为诊断数据，不伪造缺少 reasoning_content 的 assistant 历史。

普通 proposer 在 DeepSeek 和 OpenCode 共用 `sectionStatuses + changes[]` 扁平协议。Compaction 仍是 sectionResults/changes；Librarian 仍是 operations/parts。此次只在 DeepSeek 传输层适配 Librarian 的根对象和空数组 schema，未将维护协议全部扁平化。本地语义校验继续负责 status/operations 联动等限制。

API 参考：[DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)、[strict tool calls](https://api-docs.deepseek.com/guides/tool_calls/)。实际兼容性以本次 API 调用结果为准。

## 验证结果

- `npm run test:offline`：**462/462**，包含架构检查。
- 修正 RAG 响应类测试的过短 deadline，仅为 HTTP 429/错误维度测试增加等待余量；真正的 timeout 测试保留原有短 deadline，未修改生产 RAG 行为。
- 受保护 JSON 示例逐块对照 HEAD：只有已明确批准的 compaction 常规示例增加 supportRefs；其他示例原样保留。
- `git diff --check` 通过。

最终 `npm run eval:memory-v2-integrity`：deepseek-v4-flash，thinking enabled / low，**10/10** 通过机械约束和对应定向质量断言：

1. 开启 thinking 的修复请求。
2. 情绪互动不写入 worldFacts。
3. 同一 episode 的增量拼接。
4. worldFact 纠错只引用新证据。
5. 可合并信息的 compaction。
6. 冲突信息拒绝强行压缩。
7. Librarian 将误分类偏好移入 Profile。
8. 同栏复合 Profile 拆分且各取自己的证据。
9. 根据原文纠正错误事实。
10. 删除重复项且保留 keeper。

最终一轮 10 次 API 调用约 22.4 秒；输入 31,035 tokens，输出 2,626 tokens（含 reasoning 1,229）。此统计不含排查期间的调用。小规模合成样本通过，不代表任意真实历史语义准确率为 100%。

本地报告：`reports/memory-integrity-live.json`（合成 before/after、操作、usage）和 `reports/memory-integrity-offline.log`。可按名称子串筛选，例如 `npm run eval:memory-v2-integrity -- librarian`。

## 运行边界

- 初始验收仅使用合成样本。后续用户明确授权清空旧 Memory 并验证 `default`；Lina-Weil 仅做原始数据指纹检查和旧衍生状态清理，不调用模型重建。
- 新增 `014-memory-librarian-schedule.sql`，用于更新已有 checkpoint 表的字段；迁移本身不清空 Memory。用户授权的旧数据清理单独在事务内执行，避免普通 schema migration 意外删除衍生状态。
- lineage 通过事件、事件组和快照在配置保留期内追溯。保留期后的 anchor snapshot 保证后续回放，不等同于永久保留全部历史演变。
- 不实现多轮 Librarian、Episode/Milestone 分离、无 keeper 的自由删除或语义“证明器”。分类与信息保留继续由模型及评估负责。

## 真实数据库验证（2026-09-10）

- 目标：本机 `localhost:5432/blog_dev`，userId=1、presetId=default，480 条消息、213,582 字符、边界 messageId=7773。
- 014 已执行并重复执行验证幂等性，schema 检查 clean=true。清空 default 与 Lina-Weil 的旧 Memory authority、快照、事件、任务、检查点及诊断；清除未完成 RAG staging，保留原始消息及已发布的 RAG 索引。没有启动后台服务。
- 清理前后全部 5,606 条原始消息的整行指纹一致。清理报告：`reports/memory-db-reset-20260910.json`。
- 真实数据发现 thinking + tool_choice=auto 可能将合法 JSON 放在 content。DeepSeek transport 现接受经过完整 bound schema 本地验证的纯 JSON content；不接受解释文字、截断对象、越权来源，不覆盖已有错误 tool call。受保护 prompt 示例未变。
- 上述兼容修复后全量离线测试 **466/466**。真实重建从已提交进度恢复，继续使用同一 source generation。
- 第二个真实数据问题：模型将多次独立经历追加至同一条目，完整结果达到 608 字而触发 600 字上限；旧错误只被归类为泛化 CONTRACT_INVALID。现为每条经历显示剩余 append 字数，将长度失败归类为 TEXT_LENGTH_EXCEEDED，并在修复中提供“现有文本 + 分隔符 + 增量”的精确预算；增加独立互动弧的文字说明，未改受保护 JSON 示例。保留原有硬限制，不截断结果或证据。恢复后该批提交成功，下一批为独立事件新增了两条记录。
- 上述改动后全量离线测试 **467/467**。中途独立核验 68 份已提交快照、67 组事件回放和 2,277 次来源引用，均通过；原始数据整行指纹仍一致。
- 最终 default：sourceGeneration=1、revision=251；六个 target 全部 healthy，cursor 均到 messageId=7773。250 个常规任务和 5 个 Librarian 任务完成；两次修复前的失败任务留作审计记录，当前无挂起任务。5 次 Librarian 均为 noop，真实数据验证了调度/检查点，但未覆盖其全部修改操作。
- RAG 重建完成，投影检查点 healthy，generation=1、boundary=7773。Lina-Weil 未调用模型重建。
- 独立核验 **251 份快照、250 组事件回放、5,191 次条目检查、21,931 次来源引用检查全部通过**；每版事件回放与快照逐字一致，所有条目的字符/来源上限通过，全部 5,606 条原始消息整行指纹与清理前一致。
- 再次执行同一 scope 的 resume：**0 个常规任务、0 次 Memory Provider 调用**，generation/revision 不变，也未增加最终 Librarian 任务。
- 全量离线测试最终为 **467/467**，schema 检查 clean=true，受保护 JSON 示例基线及 git diff --check 通过。
- 成本记录合并初次失败、两次修复后的续跑与一次诊断：已记录输入 **10,304,676 tokens**（其中缓存命中 822,144）、输出 **386,194 tokens**。一次 Provider 响应缺少结构化输出、finish reason 和 usage，自动重试成功；无法补回该次计费数据，因此这些是已记录用量的下界，且不含 RAG embedding。270 次为逻辑 propose 调用计数，Profile 一次可能拆成三个 HTTP 请求，不能当作精确 HTTP 请求数。
- 最后一轮重建的 `migrationStatus=completed`，但报告总状态保留 `evidence_incomplete`，唯一问题为 `provider_token_usage_incomplete`；没有修改验收门槛或伪造缺失统计。独立数据验收通过；随后零调用 resume 报告的 evidence gate 通过只代表该次 resume，不补足此前的统计缺口。
- 语义观察：早期第一条经历仍跨越多个事件（最终 578 字、29 个来源）；后续已产生独立条目。source hash/回放/长度一致性不等同于完整语义质量证明。本次是在修复后续跑，未花费额外调用将最终版本从零再重建一遍。

最终报告：

- `reports/memory-default-summary-20260910.json`：汇总结果、用量与限制。
- `reports/memory-default-verification-20260910.json`：独立快照、事件和来源核验。
- `reports/memory-default-resume-20260910.json`：零调用恢复与最终去重验证。
- `reports/memory-default-rendered-20260910.txt`：实际生成的 Memory 内容，供人工查看。
- `reports/memory-default-rebuild-20260910-1.json` 至 `-4.json`：各次执行的原始报告。
