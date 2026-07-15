# Evidence 校验与 Quote 匹配算法

本文是普通 Memory patch 的 evidence source 校验、quote 归一化和 Levenshtein 匹配算法的单一权威来源。Evidence 数据 shape、evidenceKind 枚举和 reject reason 枚举见 [状态契约](../state-contract.md) §3、§4、§9.2。

## 1. 适用范围

Reducer 校验普通非 `mergeItems` patch 的 evidence source 与 quote。普通模式下，patch evidence 可以来自 newBatch 或 overlap，每个 `evidenceRefs.messageId` 都必须属于本 task 的 `observedMessages`，且至少一条必须满足 `cursorBefore < messageId <= targetMessageId`；全部 evidence 仅来自 overlap 时以 `overlap_only_evidence` 拒绝。add/update item 校验通过后，Reducer 为 refs 补入数据库 `contentHash`，再连同 `patch.evidenceKind` 包装为新的 `evidenceGroup` 追加到 item；forget evidence 只证明指令，不追加到被移除 item。item 派生字段（`createdAtMessageId`/`updatedAtMessageId`）的维护规则见 [状态契约](../state-contract.md) §1。

`mergeItems` 不接收 Proposer 输出的 `evidenceRefs`。Reducer 校验 source items 存在且带有结构合法的 `evidenceGroups`，继承到 merged item 并保留 group 边界；merged item 派生字段见 [状态契约](../state-contract.md) §1。source evidence 已在写入 source item 时通过 quote 校验。

## 2. Evidence source 一致性

对每个普通 evidenceRef，Reducer 必须重新读取数据库消息并依次校验：

1. `messageId` 存在于 proposal-time task payload 捕获的 `observedMessageIds/observedMessages`，并且数据库消息仍存在。
2. 数据库消息的 `userId`、`presetId` 与 task scope 完全相同。
3. 数据库消息的 `role`、`createdAt`、`contentHash` 与 proposal-time task payload 捕获的 observed message 完全相同。
4. 任一 scope/metadata/`contentHash` 不一致时拒绝对应 patch，reason=`evidence_source_mismatch`；messageId 不属于 task 或数据库消息不存在时使用 `message_id_not_found`。Reducer 不用 envelope 中的 role 覆盖数据库真实 role。
5. evidenceKind 带有明确发言方语义时按数据库真实 role 校验；例如 `user_correction`/`user_forget` 只接受 user evidence，`assistant_correction`/`assistant_forget` 只接受 assistant evidence。`long_term_fact` 对 user/assistant 都合法。role 与 evidenceKind 不匹配时拒绝，reason=`evidence_role_mismatch`。

## 3. Quote 长度、归一化与信息量

quote 按 Unicode code point（`Array.from(str).length`），不是 UTF-16 code unit 计数。

归一化允许忽略的标点集固定为：

```js
QUOTE_IGNORABLE_PUNCTUATION = [
  ",", ".", "!", "?", ";", ":", "\"", "'", "(", ")", "[", "]", "-",
  "，", "。", "！", "？", "；", "：", "“", "”", "‘", "’", "（", "）",
  "【", "】", "《", "》", "〈", "〉", "、", "…", "—"
]
```

该常量属于共享集中配置，正式值只能由统一 matcher 读取；Provider 或调用点不得增删字符或另写归一化逻辑。

1. 原始 quote 必须非空，且不能只有 Unicode whitespace、punctuation 或 symbol。
2. 原始 quote 最多 200 个 Unicode code points；超出时拒绝对应 patch，reason=`quote_too_long`，不得自动裁剪。
3. `normalizeEvidenceText(str)` 是唯一归一化函数：先做 locale-independent `toLowerCase()`，再按 Unicode code point 移除 Unicode `White_Space` property 字符和 `QUOTE_IGNORABLE_PUNCTUATION` 中的字符；不做 NFKC/NFKD、同义词替换、数字转换或 Provider 专属预处理。所有 Provider 与调用点共用同一实现。
4. 归一化 quote 中 Unicode property 不属于 `White_Space`、`Punctuation`、`Symbol` 的字符为“信息字符”；少于 3 个时拒绝对应 patch，reason=`quote_too_short`。

## 4. 有界 Levenshtein 匹配

所有长度的合法 quote 使用同一匹配规则，不设置“短文本精确、长文本模糊”的双路径：

1. 将 normalized quote 与 normalized raw content 都拆成 Unicode code point 数组。
2. 先对完整 normalized raw content 做线性 exact-substring 快速路径；命中等价于某个等长窗口 `similarity=1`，不是另一套接受规则。raw content 短于 quote 时直接失败。
3. 未 exact 命中时，只需判定是否存在达到集中配置阈值的等长窗口，不计算阈值以下的精确最大 similarity。令 `k=floor((1-threshold)*quote.length)`；窗口先用 rolling q-gram profile distance 的安全下界过滤（一次 edit 至多改变 `2q` 个 profile entries），再用 band 宽为 `k` 的 bounded Levenshtein，找到首个 `distance<=k` 的窗口即可接受。
4. 模糊 fallback 具有两个确定性工作上限：normalized content 最多 20,000 code points，且每次 quote 最多对 256 个下界合格窗口执行 bounded Levenshtein。任一上限耗尽时 fail closed 为 `quote_not_found`；不得为了提高召回而在同步请求路径继续无界扫描。完整 content 始终先执行不受这两个模糊上限影响的线性 exact 路径，因此 Proposer 按契约逐字复制的 quote 不会被该限制误拒。
5. 默认阈值为 0.75；找到 `distance<=k` 的窗口时接受，否则拒绝对应 patch，reason=`quote_not_found`。工作预算可能保守拒绝位于大量模糊候选之后的非逐字 quote，这是为同步 Reducer 的 CPU 上界明确接受的取舍。

模糊匹配只能容忍复制偏差，不能解决否定词删除、数字/姓名替换等低编辑距离但高语义影响的问题。系统明确接受这一剩余风险，不引入否定词专项规则、“高风险事实”识别或 NLI/自然语言蕴含验证，也不得宣称 Reducer 已证明 quote 语义蕴含 patch。

## 5. Harness

验收用例见 [Harness 验收契约](../harness.md) §3.2。
