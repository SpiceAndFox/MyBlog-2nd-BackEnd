# 领域生命周期算法

本文是 scene TTL、Todo active/overdue/revive、dueAt 日历运算、recentEpisodes 滑动窗口和请求时 effective view 的单一权威来源。字段 shape、patch op、cleanup event shape 和容量配置 shape 见 [状态契约](../state-contract.md)。

## 1. 时间输入与日历运算

Semantic Todo 的 `dueAt` 表达式为 `{ "mode": "absolute", "date": "YYYY-MM-DD" }`、只含一个单位的 `{ "mode": "relative", "days": N }` / `{ "months": N }` / `{ "years": N }`，或 `{ "mode": "dayOfMonth", "day": 1..31 }`。`days` 允许大于等于 0，`months` / `years` 必须大于 0；今天规范表示为 `days=0`。Compiler 在生成 persistent Patch 前把它们解析为 ISO timestamp，Reducer 不接收未规范化表达式。

- absolute date 的 deadline 是该日期在用户时区下结束后的首个日界线（即用户时区次日 00:00）；用户时区从 User 字段读取并在 task 创建时固化，默认 UTC。
- relative/dayOfMonth deadline 必须显式携带 `anchorMessageId`，且该 ID 必须属于同一 Semantic change 的直接 `evidenceMessageIds`。Compiler 以该消息经数据库复核的 `createdAt` 为 anchor，先取得该 instant 在用户时区下的本地日历日期；relative 增加唯一时长单位，dayOfMonth 选择 anchor 当天或之后最近一次存在该日号的月份。support-only change 不得生成消息锚定 deadline。
- relative `months`/`years` 运算遵循日历月规则：若结果日期不存在（如 1 月 31 日 + 1 个月），取目标月的最后一天（2 月 28 日或 29 日）。
- relative 运算不保留 anchor 的时、分、秒和毫秒，统一解析为目标日期结束后的首个日界线。该日界线落入 DST overlap 时选择较早 instant；落入 DST gap 时按 transition gap 向后顺延，采用 Temporal `compatible` 的确定性 disambiguation。
- 禁止使用 task/worker 执行时间作 anchor。
- Compiler 负责确定性日期计算和 ISO 8601 格式化；Reducer 接收已规范化 dueAt。已到期的结果仍可写入，并由同一事务或随后 housekeeping 原位标记 overdue，不能因历史回放发生在 deadline 之后而拒绝事实。

Scene/Todo housekeeping 读取同一事务捕获的 `now`。Context compiler 为同一次请求捕获一个 `requestNow`；Renderer effective view 与持久化 housekeeping 必须调用同一组纯代码 lifecycle 函数。

## 2. Scene 生命周期

Scene TTL 基于 scene 四个非 null 字段中最大的 `updatedAtMessageId` 所对应消息的数据库 `createdAt` 加配置 TTL 计算；scene 全空时不读取 anchor、不产生过期动作。

当 `now >= sceneAnchorCreatedAt + TTL`：

1. 把到期的完整 `current.scene`（含字段 provenance）写入 `current.previousScene`；
2. 令 `expiredAt = sceneAnchorCreatedAt + TTL`；
3. 把 current.scene 四个固定字段分别重置为 `{ value:null, sourceRefs:[], updatedAtMessageId:null }`；
4. 写 `system_cleanup: scene_expired`；
5. 若覆盖了非 null 的旧 `previousScene`，同一 cleanup revision/event group 还必须写 `system_cleanup: expired_scene_evicted`；
6. `previousScene` 是单值字段，新 scene 到期时直接替换旧值，不调用 compactionProposer，也不参与 scene 的 `maxRenderedChars` 容量门。

## 3. Todo 状态与事实编辑

Todo 的事实编辑与期限分类相互独立。active 表示未结束且当前未逾期，不表示用户作出了一次新承诺；overdue 表示未结束且当前期限已过，不冻结事项。

有来源支持、属于同一事项的 reviseItem/correctItem 可以修改文本、执行者和期限，不因任务积压、历史 rebuild 或处理时已经逾期而拒绝。系统不得为了接受事实而编造未来日期或把处理时间用作日期锚点。

| 操作 | 事实处理 | 期限分类 |
| --- | --- | --- |
| addItem | 新建，必须提供 actor/requester | 初始化后由同次 lifecycle 按期限分类 |
| reviseItem/correctItem + keep | 保留期限，接受其他有证据的字段修改 | 按原期限判断 |
| reviseItem/correctItem + set | 接受有证据的新期限，包括过去期限 | dueAt <= now 为 overdue，否则 active |
| reviseItem/correctItem + clear | 仅在明确取消期限且事项仍成立时清除 | active，无期限 |
| completeTodo/cancelTodo/expireTodo/forgetItem | 有对应语义证据时移除 | 不要求未来期限，不因 overdue 禁止 |
| mergeItems | 仅维护模式合并相同 actor/requester/dueAt 的 active 项 | 保持既有维护边界 |

期限分类由纯函数 classifyTodoDeadline 统一计算：dueAt 非 null 且 dueAt <= now 时为 overdue，becameOverdueAt=dueAt；否则 active，becameOverdueAt=null。过去期限改成另一个过去期限时，两个日期字段同时更新。becameOverdueAt 表示当前期限对应的逾期起点，历史期限仍可从审计记录追溯。

普通 revise 必须保留 requester（最初提出方）；只有可见证据证明原记录从一开始就错误时才用 correct 更正，Reducer 不代替模型验证自然语言证据。actor 有明确转交事实可以 revise，录错可以 correct。这些规则与 active/overdue 无关。不得为绕过 requester 校验把没有纠错依据的 revise 改名为 correct。

未再次提及日期不代表取消期限，必须 keep。expire 表示有直接证据说明行动机会或成立条件消失，不等于期限已到；纯时间推移只标记 overdue，不自动移除事项。

完全相同的业务字段和来源输出审计 noop；仅来源变化替换证据并保留业务字段。来源、长度、同目标冲突及原子提交约束保持有效。

事实编辑在 accepted reviseItem/correctItem 的 normalizedOperation.value 中保存完整的修改后状态，供事件重放恢复；不再为编辑输出 todo_revived_from_overdue，以免把期限纠错、取消期限或普通修改误记为重新承诺。历史 todo_revived_from_overdue 事件继续支持读取和重放，不重写历史日志。

时钟推进导致 active 到期时，housekeeping/effective view 仍复用该分类函数，写 system_cleanup: todo_became_overdue（becameOverdueAt=dueAt）；重复 housekeeping 为 noop。

todos.maxItems/maxRenderedChars 只统计 active。清除期限或改到未来使事项重新占用 active 容量时，保留原 createdAtMessageId，遵循既有 FIFO 淘汰；不得以编辑刷新创建顺序。overdue 使用独立渲染预算。

本次不引入历史时钟或叙事时间。消息时间负责日期锚定，task.now 负责当前状态判断；二者不能互相替代。是否将整个 rebuild 改为历史时间重放需要另外评估 Scene TTL、跨 target cleanup、容量与最终状态结算。

## 4. Recent Episodes 滑动窗口

`recentEpisodes` 同时受 `maxItems + maxRenderedChars` 约束。Proposal apply 后超限时，Reducer 按 `createdAtMessageId`（再以 itemId 打破平局）滚出最旧 items，直到两项限制均满足，并为每个滚出项写 `system_cleanup: recent_episode_evicted`；不触发 compactionProposer。

## 5. Proposal 内归一化与后台 Housekeeping

若 lifecycle 变化由一个 proposal 的模拟 post-state 直接触发（例如新增已到 deadline 的 todo，或 recentEpisodes apply 后超窗口），对应 `system_cleanup` events 与 proposal decisions 共用该 proposal event group、revision 和完整 snapshot，保证最终 post-state 原子满足 lifecycle/容量规则。

没有 proposal 的后台 housekeeping 才创建 `group_kind=system_cleanup` 的独立 revision/group。两种路径都复用同一纯代码 lifecycle 函数；无变化不创建空 revision。

Cleanup event 使用正式 section/target 映射：

- scene cleanup：`section=scene,target_key=scene`；
- todo cleanup：`section=todos,target_key=todos`；
- episode cleanup：`section=recentEpisodes,target_key=episodes`。

System cleanup task 不拥有或推进 raw-message cursor。

## 6. 请求时 Effective View

Context compiler 捕获一次 `requestNow`，并按 current.scene 最大 `updatedAtMessageId` 读取对应消息 `createdAt` 作为 `sceneAnchorCreatedAt`，再调用纯代码 `buildEffectiveMemoryView(memoryState, lifecycleAnchors, requestNow, config)`；该函数只复制并转换运行时 view，不直接写数据库：

1. scene 已达到配置化 TTL 时，在 view 中把完整 current.scene（含 provenance）移到单值 previousScene、令 `expiredAt=sceneAnchorCreatedAt+TTL` 并清空 current.scene；因此本次请求不得继续把它称为当前状态。已有 previousScene 在 effective view 中被替换。
2. active todo 满足 `requestNow >= dueAt` 时，在 view 中原位显示为 overdue，并令 `becameOverdueAt=dueAt`；不得继续出现在 active 列表。
3. 发现上述未持久化变化时，幂等唤醒 housekeeping。effective view 不是新的 authority，也不能替代持久化。

## 7. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.5、§3.8、§4。
