# Memory 前台重建与故障恢复

`rebuild:memory-v2` 等待普通 target、容量维护、Librarian 和 RAG 投影完成，再执行原有完整性验证。`migrate:memory-v2-data` 与 `librarian:memory-v2` 复用同一前台等待器。后台 `forceDrainTo`、`runManual` 仍推进一轮，由既有调度继续；`shadow:memory-v2` 保持只读诊断和自身输出修复流程。

## 手动执行与恢复

```powershell
npm run rebuild:memory-v2 -- --userId 1 --presetId Lina-Weil
```

默认 `--mode resume` 继续同一 generation 的可恢复进度。每次手动启动前台命令都会获得新的内存重试预算。任务执行过程中的排队、轮询、容量维护和任务记录替换不会刷新同一逻辑工作的预算；这些任务记录并不是子进程。`--mode fresh` 明确开启新 generation，不需要为了清空重试次数使用它。

任务状态、下一次调度时间、累计 attempt、输出修复历史、cursor 与 checkpoint 继续持久化；用于判断“还允许重试几次”的计数仅保存在执行实例的内存中。历史 `stage_payload.providerRecovery`、`schemaInvalidAttempts`、`transportInvalidAttempts` 不再作为新执行的预算来源；旧字段无需数据库迁移，也不主动清理审计数据。

预算耗尽后，任务停止自动调用并记录 `retry_budget_exhausted` 阶段，不跳过任务或推进 cursor。下一次手动前台执行只重新开放同一 generation 中明确标记为预算耗尽的失败任务，复用原任务和已保存的提案、修复上下文。它不会自动解除编译/一致性失败或其他任务造成的 halt。旧版本没有明确预算耗尽标记的失败任务也不会被猜测性地恢复；确认原因并修复后，使用既有显式 target 恢复入口，或 Librarian 的 `--resume-failed`。后者创建的是数据库中的后继任务记录。

源 generation、源消息边界改变，或存在未完成的 privacy operation 时，前台停止推进。恢复仍须通过现有 revision、cursor、来源证据和提交校验。

## 故障、预算与等待

| 情况 | 行为 |
| --- | --- |
| 明确临时故障：超时、连接中断、HTTP 408/425/429/5xx | 使用独立 transient 预算，按任务退避后再调用 |
| 未知调用错误、安全拒绝、输出被截断 | 使用有限 provider 预算；容量维护使用自己的 compaction 有限重试预算 |
| provider admission 队列满 | 只推迟调度，不消耗调用预算或增加 attempt |
| 认证、模型/请求配置错误等不可重试故障 | 停止，保留错误与进度 |
| transport/schema/输出协议校验失败 | 使用各自独立的输出修复预算 |
| 无法压缩、提交不变量失败、stale、其他 halt | 保留原有正确性门禁 |

`RETRY_MAX=N` 表示首次失败后最多允许 N 次额外实际调用，0 表示首次失败就停止该类别的自动尝试。不同类别独立计数，切换错误类别不算成功。HTTP 调用成功清除对应网络连续失败计数；transport 校验成功清除 transport 计数；完整输出通过校验才清除 schema 计数。HTTP 成功但输出无效不会刷新 schema 预算。累计尝试与审计历史不会随成功清零。

普通任务、容量维护、Librarian 按逻辑工作隔离预算；Profile 的并行 specialist 网络请求分别计数。一个任务的请求失败不会扣除其他任务的预算，也不会因为另一个任务成功而清空自身预算。前台 RAG 投影调用使用同样的临时/未知故障分类与有限预算；成功的 embedding 请求会重置其连续网络失败计数，单纯 checkpoint 变化不会。

当前显式配置（`.env` 和 `.env.example`，缺失或非法值会在加载时拒绝）：

```dotenv
CHAT_MEMORY_V2_PROVIDER_RETRY_MAX=2
CHAT_MEMORY_V2_PROVIDER_TRANSIENT_RETRY_MAX=5
CHAT_MEMORY_V2_PROVIDER_TRANSPORT_INVALID_RETRY_MAX=2
CHAT_MEMORY_V2_PROVIDER_SCHEMA_INVALID_RETRY_MAX=2
CHAT_MEMORY_V2_COMPACTION_RETRY_MAX=2
CHAT_MEMORY_V2_PROVIDER_BACKOFF_BASE_MS=30000
CHAT_MEMORY_V2_PROVIDER_BACKOFF_MAX_MS=120000
```

连续 provider 失败按 30、60、120、120…秒等待；Memory 和 embedding HTTP 响应中更晚的 `Retry-After` 会进一步延后调用。成功后退避从基准值重新开始。单次 HTTP 请求超时保持原有配置。

系统已统一移除熔断器，包括 Memory、在线 RAG embedding、管理命令和健康接口中的共享冷却、半开探测及请求阻断。保留现有 provider 并发/队列控制和任务退避；不发送额外探测请求。健康状态仅报告最近真实请求的结果，不参与请求放行。健康接口中的显式重试仍执行实际的任务恢复或投影 drain。

## CLI 日志与停止

三个前台命令均不再接受 `--wait-timeout-ms`，没有默认无进展等待期限，也没有 `CHAT_MEMORY_V2_CLI_WAIT_TIMEOUT_MS` 配置。自动调用由重试预算限制；队列等待和调度检查不扣预算。

stderr 使用简短的单行提示，区分：

- `[等待 N]`：包含 scope、阶段、当前阻塞任务的 ID 前 8 位、原因及本机时区的下次执行时间；不展开整轮执行历史。
- `[继续调度]`：期限已到，即将继续调度，不表示 provider 或持久化进度已经恢复。
- `[进度已推进]`：确认 revision、cursor 或 checkpoint 推进后记录。

提示中的 N 来自 `waitCount`，确认持久化进度后归零，再次阻塞从 1 开始。`totalWaitCount` 仍保留在执行结果中，但不在等待提示中重复显示。两者都不参与执行预算，完整任务 ID 与审计历史仍保留在原有记录中。

Ctrl+C 停止后续调度和输出修复重试；已发出的请求结束或达到自身超时后，关闭数据库连接，退出码为 130。已保存的任务、退避时间和 checkpoint 保留，重新执行原命令即可在原进度上获得新的预算。

## 验证与运行边界

继续遵循原有离线重建要求，避免同一 scope 被多个 CLI/在线写入者同时操作；本改动不引入跨进程单写者租约。成功报告仍取决于 target、cursor、快照/事件链、源边界与 RAG checkpoint 的完整验证，等待结束不代表重建成功。

离线测试覆盖成功归零、旧持久化计数兼容、同一任务手动续跑、容量维护与 Librarian 恢复、预算耗尽、任务隔离、halt/privacy/generation 门禁、日志和 Ctrl+C。验证命令为 `npm run test:offline`，无需真实 provider、真实重建或数据迁移。受保护的 prompt JSON 示例保持不变。
