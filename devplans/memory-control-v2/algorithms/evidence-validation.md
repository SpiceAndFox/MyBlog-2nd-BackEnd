# Evidence 校验与 Quote 匹配算法

本文是 version 3 patch 的 observation registry gate、raw source 校验和 quote 匹配算法的单一权威来源。静态 shape 与 reason enum 见 [状态契约](../state-contract.md) §2、§5。

## 1. 适用范围

算法适用于：

- `semanticSignalObserver` 输出的 observation/arc/occasion evidence；
- 专业 Proposer 的所有非 `mergeItems` patch evidence；
- scene `epochTransition.evidenceRef`。

`mergeItems` 不接收新 raw evidence。Reducer 从 source items 继承完整 evidenceGroups，并重新校验 item 未被 pending proposal 保护；不对历史 quote 再做模糊匹配。

version 3 没有 `newBatch evidence` 或 `overlap_only_evidence` 规则。专业 patch 可以使用较早 evidence，但它必须已登记在当前 observation/version 中；任意 recent overlap、readOnlyContext 或派生 summary 都不是证据 authority。

## 2. Scan-time raw evidence 校验

Coordinator 在持久化 observer output 前，对每个 evidenceRef：

1. `messageId` 必须存在于 scan envelope 的 `observedMessages`，且不大于 `sourceBoundaryMessageId`；
2. 每个 create/append/supersede/invalidate action 至少引用一个 `newMessageIds` 中的 message；supporting-only 消息不能单独产生新 action；
3. 从数据库重新读取 message，校验 user/preset、有效性、role、createdAt、contentHash 与 envelope 捕获值一致；
4. 执行 §4 quote 校验；
5. 用数据库真实 `contentHash` 持久化 `chat_memory_observation_evidence`，不能信任 LLM 自报 hash；
6. append/supersede/invalidate 还必须校验 related observation/arc/occasion 的 scope、generation、detectorVersion 与 compare-and-set version。

任何 action 的一条 evidence 无效时，该 action 失败；任何 action 失败时整个 scan output 事务失败，assessment 与 scan checkpoint 都不推进。不得只落 `no_relevant_signal` 后跳过非法 action。

## 3. Proposal-time registry 与 source 一致性

对每个非 compaction patch，Reducer 先冻结 observation set，再逐 ref 校验：

1. patch 的每个 `observationId` 必须出现在 task 的 `observationVersions`，且 master row 属于相同 scope/source generation；
2. observation current version 必须等于冻结 version，当前 `observation_targets` 行必须属于本 target 且状态为 `processing`；
3. 每个 evidenceRef 必须能在所列 observation 的 registry 中匹配同一 `messageId + quote`；数据库 `contentHash` 必须等于 registry 中的 hash；
4. ref 的 source boundary 不得晚于 cycle boundary，arc/occasion 必须属于同 generation；
5. 数据库 message 仍存在、有效并属于同一 scope，role/createdAt/contentHash 与 scan-time registry 一致；
6. source key 未被 privacy gate 删除；对普通增量读取，命中 active suppression tombstone 的 ref 不得支持新写入；
7. evidenceKind 带发言方语义时按数据库真实 role 校验：`user_*` 只接受 user，`assistant_*` 只接受 assistant；
8. 执行 §4 quote 匹配与 §5 group-level 信息量校验。

失败映射：

| 条件 | reason |
| --- | --- |
| observation 不存在/版本变化/target 不符 | `observation_not_found` / `observation_version_stale` / `observation_target_mismatch` |
| ref 未登记 | `evidence_not_registered` |
| message 不存在 | `message_id_not_found` |
| scope/role/time/hash/source 有变化 | `evidence_source_mismatch` |
| evidenceKind 与真实 role 不符 | `evidence_role_mismatch` |
| quote 信息量/长度/匹配失败 | `quote_too_short` / `quote_too_long` / `quote_not_found` |

Patch 通过后，Reducer 只使用数据库/registry 中已验证的 hash 写 evidenceGroup。`correct` 要 suppress 的旧 source 来自被修正字段的 pre-state current-value fingerprint lineage，`forget` 来自 item 全部 evidenceGroups；两者都不由 Proposer 自报。

## 4. Quote 归一化与匹配

### 4.1 计数与归一化

长度按 Unicode code point（`Array.from`），不是 UTF-16 code unit。原始 quote 必须非空且最多 200 code points。

统一忽略标点集：

```js
QUOTE_IGNORABLE_PUNCTUATION = [
  ",", ".", "!", "?", ";", ":", "\"", "'", "(", ")", "[", "]", "-",
  "，", "。", "！", "？", "；", "：", "“", "”", "‘", "’", "（", "）",
  "【", "】", "《", "》", "〈", "〉", "、", "…", "—"
]
```

`normalizeEvidenceText` 是唯一实现：locale-independent lowercase 后，按 code point 移除 Unicode `White_Space` 与上述固定标点。不做 NFKC/NFKD、同义词替换、数字转换或 Provider 专属预处理。

归一化结果中不属于 Unicode White_Space/Punctuation/Symbol 的 code point 是信息字符。零信息字符拒绝为 `quote_too_short`。

### 4.2 短 quote

归一化后只有 1–2 个信息字符的 quote：

1. 必须作为连续 normalized substring exact 命中 raw content；
2. 禁止 Levenshtein fallback；
3. registry relation 必须是 `accepts|rejects|supports|completes|cancels` 之一；
4. 不能成为一个 establish/refine/supersede patch 的唯一实质证据。

该规则允许 `好`、`好吃`、`OK` 保留其真实对话作用，同时阻止短词脱离被关联的提议制造长期事实。

### 4.3 一般 quote 的有界 Levenshtein

达到实质长度的 quote 使用：

1. 先对完整 normalized raw content 做线性 exact-substring；命中即接受；
2. 未命中时，令 `k=floor((1-threshold)*quoteLength)`，只检查等长窗口；
3. 用 rolling q-gram profile 的安全下界过滤，再用 band 宽 `k` 的 bounded Levenshtein；首个 `distance<=k` 的窗口即接受；
4. normalized content 的模糊扫描上限 20,000 code points；每个 quote 最多运行 256 个 bounded Levenshtein；预算耗尽 fail closed 为 `quote_not_found`；
5. 默认 similarity threshold 为 0.75，由集中配置统一读取。

exact 路径不受模糊工作预算限制。模糊匹配只容忍复制偏差，不能证明语义蕴含；数字、否定或姓名的低编辑距离变化仍是已知风险，交给 observer/Proposer 的语义判断与 harness 管理。

## 5. Group-level 信息量与关系链

一个 observation 或 patch evidence group 至少含一条“实质 ref”：

- 含 Han/Hiragana/Katakana/Hangul 信息字符时，至少 2 个信息字符；
- 其他文字至少 3 个信息字符。

短 ref 只有在同一 observation root 的关系链中存在实质 ref 时合法。例如：

```text
"以后每天早上都给你做"  -- proposes，实质 ref
"好"                    -- accepts，短 ref
```

两条可以共同支持 agreement；只有 `好` 不可以。Reducer 通过 patch observationIds 查询完整 registry 关系链，不要求两条 evidence 来自同一 scan task，也不要求其中一条位于当前 boundary。

profile/relationship 的 `observedPattern` 还必须从这些 refs 的 registry 计算至少 3 个 distinct occasionId、2 个 distinct 非空 arcId。message 数、重复 quote 或 LLM 自报 occasion 数都不能替代。

## 6. 幂等与 source mutation

- scan evidence 的稳定 identity 是 observationId + messageId + contentHash + relation；重复 delivery 使用同一行；
- quote 相同但 contentHash 变化表示 source mutation，必须新 generation rebuild，不能原位接受；
- late discovery 为旧 message 新增 observation 时，写新的 assessment event 并提升 assessment master version，不修改旧审计事实；
- privacy hard delete 必须物理删除 registry quote/hash 与所有受控 payload；普通 forget/correct 只写 suppression tombstone。

## 7. Harness

至少覆盖：中文两字 `好吃`、单字接受链、英文 `OK`、短词单独建立事实失败、registered old evidence 成功、任意 overlap evidence 失败、hash/source mutation、跨 boundary propose→accept、3 occasions/2 arcs、exact 快路径与模糊预算 fail-closed。完整清单见 [Harness](../harness.md)。
