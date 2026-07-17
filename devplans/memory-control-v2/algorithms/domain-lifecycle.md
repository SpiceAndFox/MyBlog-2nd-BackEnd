# 领域生命周期算法

本文是 version 3 的事件时间、Scene epoch/字段 TTL、Todo due/overdue、episode window 与请求时 effective view 的单一权威来源。静态字段见 [状态契约](../state-contract.md)。

## 1. 两类时钟

Memory 明确区分：

- `semanticNow`：在线 cycle 创建时捕获的当前时间；重建时使用 [Source Rebuild 与 Projection](source-rebuild-and-projection.md) §3.3 的单调 `replayNow(boundary)`，即上一 boundary 时钟与本 boundary 新纳入消息最大有效 `createdAt` 的较大者；
- `wallClockNow`：重建到最终 captured boundary 后，用于一次最终 housekeeping 的真实当前时间；在线请求中也是 request 捕获时间。

同一 cycle、Reducer transaction 或 context request 只能捕获一次 now，并传给所有 lifecycle 函数。禁止在函数内部反复 `Date.now()`。

历史重建不得用 wall clock 代替每个 boundary 的 semanticNow，否则 scene 会在写入瞬间消失、todo 会提前 overdue。

## 2. Todo 日期解析

### 2.1 输入

```text
absolute: {mode:"absolute", date:"YYYY-MM-DD"}
relative: {mode:"relative", days:N>=0}
          {mode:"relative", months:N>0}
          {mode:"relative", years:N>0}
```

每次 relative `addItem` 或 `dueChange=set` 必须同时输出非空 `timeAnchorMessageId`；absolute 分支必须为 `null`，因为绝对日期本身不依赖消息时间锚。Reducer 对 relative anchor 校验：

1. 属于 patch observationIds 的当前 evidence registry；
2. ref 未被 suppression/privacy gate 排除；
3. 不晚于 cycle boundary；
4. 是 Proposer 标记为承载该 due expression 的 evidence，而不是默认取最大 evidence messageId。

纯代码无法判断自然语言里是否真的写了“明天”；这条语义由 todo Proposer + fixture 负责，Reducer 负责确保 anchor 是显式、注册且可审计的。接受、重申或履约消息更晚时不能替换原 anchor。

### 2.2 日历运算

用户 IANA 时区在 task 创建时冻结，缺省 UTC：

- absolute deadline：目标日期结束后的首个用户时区日界线；
- relative：先把 anchor message 的数据库 `createdAt` 转为用户本地日历日期，再增加唯一单位；
- days=0 表示“今天”，days=1 表示“明天”；
- 月/年结果日期不存在时取目标月最后一天；
- 不保留 anchor 的时分秒；
- DST overlap 选较早 instant，DST gap 按 transition gap 向后，等价于 Temporal `compatible`；
- 结果持久化为 ISO 8601 instant；relative 保存实际 `timeAnchorMessageId`，absolute 保存 `null`。

已经早于 semanticNow 的合法结果仍可写入，再由同一 post-state normalization 标 overdue；不能因为重建运行得晚而拒绝历史事实。

## 3. Scene epoch

### 3.1 建立与结束

当 `current.scene.epochId=null` 时，首个非空 scene patch 必须带 `epochTransition.start`。Reducer 用 transition observation root + event identity 生成稳定 epochId，并设置 `startedAtMessageId`。

`epochTransition.start` 且已有 current epoch：

1. 若该 epoch 尚未归档，按 transition 前的完整 last-known 字段归档为 previousScene，`endReason=new_epoch`，`endedAt` 取本次 start transition evidence message 经数据库复核后的 `createdAt`；
2. 清空四字段；
3. 创建新 epoch；
4. 应用同 section result 的字段 patches。

`epochTransition.end`：若尚未归档则以 `endReason=explicit_end` 归档，`endedAt` 取 end transition evidence message 经数据库复核后的 `createdAt`；随后清空四字段并令 epochId/startedAtMessageId 为 null。空 scene 再 end 是幂等 noop。

transition 的 `endedAt` 不使用 worker wall clock 或 cycle 执行时刻；online/rebuild 对同一 raw evidence 必须得到相同 instant。

无 transition 的 set/clear 只能修改当前 epoch 的一个字段；不能隐式新建、结束或重启 epoch。

### 3.2 字段级 TTL

四个字段各自以其 `updatedAtMessageId` 对应数据库 `createdAt + fieldTTL` 计算 expiry。一个字段更新只更新自己；不能给其他字段或 epoch 续期。

对 `semanticNow >= fieldExpiry` 的非空字段，按 `(expiryInstant,path)` 稳定排序处理：

1. 本 epoch 尚未归档时，先在任何字段清空前捕获四字段完整 last-known snapshot，写 `previousScene`，`endedAt=本次最早 fieldExpiry`，`endReason=field_ttl`；
2. 只清空到期字段；未到期字段继续留在 current scene；
3. 每个清空字段写 `system_cleanup: scene_field_expired`；首次归档另写 `system_cleanup: scene_epoch_archived`；
4. 同一 epoch 的后续字段到期不得覆盖 previousScene；
5. 所有字段都空后，令 current epochId/startedAtMessageId 为 null，并写一次 `scene_epoch_emptied`；不得再次归档残缺快照。

`previousScene` 只保留一条。更晚 epoch 首次归档时可以替换旧值，并写 `previous_scene_evicted`；同一 epoch 不可替换自己。

这一定义使 location、time、mood、note 具有独立新鲜度，同时仍保留该场景最后一次完整可解释快照。

### 3.3 Correction 与自然变化

- 当前字段值补充限定：`refine`，保留旧 evidence；
- 真实场景发生变化：同 epoch 字段 `supersede`，或明显新场景使用 new epoch；不 suppress 历史；
- 旧字段当时记录错误：`correct`，替换值并 suppress 被替换 source；
- clearField 不等于 forget；只有明确错误/遗忘语义才产生 tombstone。

## 4. Todo 状态机

Todo add 强制：`status=active`、`becameOverdueAt=null`。Proposer 不得直接设置 lifecycle 字段。

| 当前状态 | 操作 | 结果 |
| --- | --- | --- |
| active | update keep/clear/set | 保持 active；set 到已过期 deadline 后由 post-normalization 变 overdue |
| active | complete/cancel/expire | 从 active state 移除；历史 evidence 保留在 event/snapshot/RAG，除非另有 correct/forget |
| active | merge | 仅 actor/requester/dueAt/timeAnchorMessageId 分别兼容时允许 |
| overdue | complete/cancel | 移除 |
| overdue | update set future due | 原位 active，清空 becameOverdueAt，写 `todo_revived_from_overdue` |
| overdue | keep/clear/set past | `invalid_state_transition` |
| overdue | expire/merge | `invalid_state_transition` |

当 `now >= dueAt` 且 status=active：

1. 原位设 `status=overdue`；
2. `becameOverdueAt=dueAt`；
3. 保留 itemId、actor/requester、dueAt/timeAnchor 与全部 provenance；
4. 写 `todo_became_overdue`；
5. 重复 housekeeping noop，不重写首次时间。

`todos.maxItems/maxRenderedChars` 只统计 active；overdue 使用独立 render 上限且不触发 compaction。

## 5. Episode arc 与窗口

Semantic arc 的 `open|closed|invalidated` 由 Source Scan observation 控制面维护，不由 Memory state 猜测。

- 所有 open arc 都不创建 recentEpisode 占位；
- closed arc 达到“有回忆价值”时可由 episode Proposer add recentEpisode；
- session/turn/time gap 不能自动关闭 arc；
- milestone 必须是关系/剧情转折，不能由 recentEpisode 超容量自动晋升。

recentEpisodes apply 后同时受 maxItems/maxRenderedChars。超限时按 `(createdAtMessageId,itemId)` 从旧到新滚出，直到都满足；每项写 `recent_episode_evicted`，不触发 compaction。

## 6. Pre-cycle、post-apply 与后台 housekeeping

所有路径复用纯函数：

```text
normalizeLifecycle(state, anchors, now, config) -> {state, cleanupOperations}
```

调用点：

1. scan commit 后、cycle freeze 前，用 cycle semanticNow 做 pre-cycle normalization；若变化，先提交独立 cleanup revision，再把新 revision 设为 asOfRevision；
2. 每个 candidate atomic unit 模拟 apply 后，用同一 semanticNow 做 post-apply normalization；直接触发的 cleanup 与 proposal 共用 revision；
3. 在线无 candidate 时，durable housekeeping 可用当前 wall clock；
4. rebuild 到 captured final boundary 后，单独用 wallClockNow 做一次 final housekeeping。

无变化不创建空 revision。System cleanup task 不拥有 source scan cursor，也不改变 observation target lifecycle。

## 7. 请求时 Effective View

Context compiler 捕获一个 `requestNow`，读取 current state 和字段 anchor message time，调用：

```text
buildEffectiveMemoryView(state, lifecycleAnchors, requestNow, config)
```

它只复制并转换 view：

- 到期 scene 字段按 §3 在 view 清空，并在首次到期前构造完整 previousScene；
- 到期 active todo 在 view 显示 overdue；
- 不修改 authority、不提升 revision；
- 发现 authority 尚未持久化的变化时幂等唤醒 housekeeping；
- 本次响应不得继续把 view 中已过期字段称为当前状态。

effective view 和后台 normalization 必须共享同一实现与 fixture，不能维护两套时间逻辑。

## 8. 事件与幂等

固定 cleanup type：

```text
scene_epoch_archived | scene_field_expired | scene_epoch_emptied |
previous_scene_evicted | todo_became_overdue | todo_revived_from_overdue |
recent_episode_evicted
```

每个 operation 带稳定 identity（epochId+path+expiry、itemId+dueAt、episode itemId 等）。重复执行不得产生第二次 mutation/event。事件使用正式 section/target；previousScene 仍不是独立 section。

## 9. Harness

至少覆盖：历史 `明天` anchor、接受消息更晚不改 anchor、DST/月末、boundary event-time 与 final wall-clock、scene 四字段不同 TTL、同 epoch 只归档一次、新 epoch 替换 previous、todo overdue/revive 幂等、open arc 不投影、episode window。完整清单见 [Harness](../harness.md)。
