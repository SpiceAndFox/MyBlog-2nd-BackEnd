# Semantic 编译与 Source 校验算法

本文是 2.01 short ref resolution、support provenance 展开、raw source validation、Todo date anchor 与 action→op 编译的单一算法权威。2.01 不再使用 evidenceKind、LLM quote 或 quote matcher。

## 1. 输入

Compiler 输入：

- immutable task metadata；
- `semanticInputVariant` 对应的 base/expanded public input 与 messageMeta，以及 immutable base private ref map；
- 已通过本地 Semantic Schema 的 Semantic IR；
- task base revision 对应的 authority state；
- source repository；
- task 固化的 userTimeZone。

Compiler 输出：

```text
compiled proposal
或结构化 compile error
```

Compiler 不写数据库、不调用 LLM、不做开放式语义判断。

## 2. 前置 stale 校验

开始 compile 前读取当前 state：

1. `sourceGeneration` 不同：旧 task stale/cancel；
2. target cursor 不等于 `cursorBefore`：旧 task stale/cancel；
3. normal task revision 不等于 `baseRevision`：创建 successor，重新 render/propose；
4. 全部匹配后才能使用 task ref map。

Stale/successor 优先于 compile failure，避免把合法并发变化错误记录成 ref/source failure。

## 3. Semantic Schema

- outer `tickId/proposer/sectionResults` 与 task 匹配；
- sectionResults 恰好覆盖 target sections；
- 任一 section 为 `unable_to_decide`，或 compaction 结果为 `unable_to_compact` 时，整个结果都不是 Compiler 输入，必须返回 task unable分支而不是生成 patch；
- status/action/领域字段符合对应 Proposer schema；
- target ref 只来自 writable namespace；
- support ref 只来自 read-only namespace；
- direct messageId 只来自 effective public input messages；
- normal change 至少有 direct/support 之一；
- compaction merge 不带 direct/support sources；
- relative Todo date 必须有 direct anchorMessageId。

Provider 输出边界 schema error 可使用已有一次 repair；耗尽后为 `semantic_schema_invalid`。

## 4. Target Ref Resolution

逐 change 按 section 解析：

- add 禁止携带 target ref；
- update/correct/forget/terminal 必须携带 writable ref；
- refMap entry 的 section 必须等于当前 section；
- item entry 必须包含真实 itemId，且该 item 在 base state 中仍存在；
- scene entry 必须解析成固定 field path；
- compaction `refs[]` 至少两个、同 section、各自唯一。

失败返回 `ref_resolution_failed`，detail 只记录 change index、section、ref 和有界 reason，不记录完整 Memory text。

Compiler 不进行相似度匹配，不选择“最像”的 item，也不把无法解析的 update 降级成 add。

## 5. Source Expansion

### 5.1 Direct

每个 `evidenceMessageId`：

1. 必须存在于 `semanticInputVariant` 对应 effective artifact 的 `messageMeta`；
2. 取该 effective artifact 捕获的 role/createdAt/contentHash；
3. 加入 source candidate set。

Direct message 可以是 overlap 或 new batch；不执行 new-batch gate。

### 5.2 Support

每个 `supportRef`：

1. 必须存在于 `refMap.readOnly`；
2. entry section/item/field 必须与 artifact 一致；
3. entry 必须含结构合法的非空 `sourceRefs`；
4. 展开全部 raw source refs；
5. 不持久化 supportRef 或 Memory item relation。

Support 底层消息可以位于 observed window 外。Repository 查询不能以 `observedMessageIds` 限制这些历史 IDs。

### 5.3 合并

- 合并 direct 与 support sources；
- 按 `messageId + contentHash` 去重；
- 按 `messageId ASC, contentHash ASC` 稳定排序；
- normal change 合并后不得为空。

## 6. Database Validation

按去重后的 messageIds 批量读取数据库，并对每个 source 依次校验：

1. row 存在；
2. `userId/presetId` 与 task scope 相同；
3. message 的当前 role 是有效 User/Assistant source；
4. direct candidate 的 role/createdAt 与 effective artifact `messageMeta` 一致；support candidate 的持久化 provenance 只有 `messageId + contentHash`，不虚构或比较不存在的 role/createdAt 快照，其 createdAt 以当前权威数据库行为准；
5. raw content 的 UTF-8 SHA-256 等于 source contentHash；
6. message 仍属于当前 generation 的有效 source 集合。

任一失败返回 `source_validation_failed`。Compiler 不自动替换 hash、不忽略缺失 source，也不使用 Memory text 代替 raw provenance。

2.01 不做：

- quote substring/fuzzy matching；
- source role 到 evidenceKind 的映射；
- overlap-only/new-batch 检查；
- correction/forget tombstone gate。

## 7. Todo 日期

Absolute：把 `YYYY-MM-DD` 解析为用户时区下该日期结束后的首个日界线。

Relative：

1. `anchorMessageId` 必须属于同 change 的 direct `evidenceMessageIds`；
2. 读取该消息已校验的数据库 createdAt；
3. 转为 userTimeZone 本地日期；
4. 按 days/months/years 做日历运算；
5. 月末取目标月最后一天；
6. DST overlap/gap 使用 Temporal `compatible`；
7. 转为目标日期结束后的首个日界线 ISO timestamp。

support-only change 出现 relative date、anchor 非 direct source 或 anchor metadata 不一致时返回 `date_anchor_invalid`。不得使用 task.now/worker time 猜测。

## 8. Action 编译

按 [Semantic 写入契约 §5.2](../semantic-write-contract.md) 的固定表映射 action→op。

- correct 与 update 同为 updateItem/setField，Compiler 输出中不保留差异；
- scene forget 与 clear 同为 clearField；
- item forget 对所有 item section编译为 forgetItem；
- terminal action 保留本次 sourceRefs 用于 event audit；
- compaction merge 只映射 refs→itemIds，不从 Proposer读取 sources。

字段无法由 action、target 和明确领域字段唯一确定时返回 `compile_invariant_failed`。

## 9. 持久化与恢复

Semantic IR 通过 schema 后先持久化，再 compile。Compiled proposal 通过本地 compiled schema 后再持久化。进程在任一阶段重启：

- `semantic_result_persisted`：复用 Semantic IR，重新执行确定性 Compiler；
- `compiled_proposal_persisted`：复用 compiled proposal，直接进入 Reducer；
- source/revision/cursor 先重新校验；stale 时不得继续。

同一 base ref map + effective artifact + Semantic IR + base state + source rows 必须得到字节级可规范化相同的 compiled proposal。

## 10. Harness

至少覆盖：

- writable/read-only namespace 混用；
- retry/repair/expansion/restart refs 稳定；
- support-only、old direct-only、mixed sources；
- support 展开 observed window 外 sources；
- source dedup/order；
- missing/stale ref、missing message、scope/hash mismatch；
- relative date direct anchor、support-only relative reject、月末/DST；
- correct→update 不保留诊断差异；
- all-section forget mapping；
- Compiler crash/recovery 和 determinism；
- compile error 不推进 cursor/revision。
