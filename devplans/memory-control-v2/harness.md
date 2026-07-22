# Memory Control 2.01 Harness 验收契约

Harness 是 2.01 的必要组成部分，分别验证 Semantic 行为、Renderer artifact、Compiler、Reducer、durability、Renderer/context 和 rebuild/privacy。任何测试不得通过把 Compiler 语义塞回 Reducer或放宽 source validation 来“修复”fixture。

## 1. 原则

- Semantic Proposer、Compiler、Reducer 分层测试；
- Provider mock 返回 Semantic IR，不返回 persistent Patch；
- Compiler fixture 使用确定性 artifact/ref map/state/source rows；
- Reducer fixture只接收 compiled proposal；
- Pipeline fixture覆盖真实 durable stage；
- Renderer 使用 golden；
- 所有时间、ID、hash、revision和 source rows固定；
- 故障注入逐事务写入点验证 rollback；
- fixture不保存真实用户敏感数据。

## 2. Fixture 形态

### 2.1 Renderer Artifact

```json
{
  "state": {},
  "proposer": "episodeProposer",
  "messages": [],
  "expectedPublicText": "...",
  "expectedWritableRefs": {},
  "expectedReadOnlyRefs": {},
  "expectedMessageMeta": {}
}
```

### 2.2 Semantic Compiler

```json
{
  "artifact": {},
  "semanticResult": {},
  "authorityState": {},
  "databaseMessages": [],
  "expectedCompiledProposal": {},
  "expectedError": null
}
```

### 2.3 Reducer

```json
{
  "state": {},
  "task": {},
  "compiledProposal": {},
  "expectedState": {},
  "expectedEvents": []
}
```

### 2.4 Pipeline Recovery

```json
{
  "taskRow": {},
  "artifact": {},
  "semanticResult": {},
  "compiledProposal": {},
  "crashPoint": "unable_result_persisted|context_expanded|semantic_result_persisted|compiled_proposal_persisted|commit_unknown",
  "unableAttempt": 0,
  "expectedProviderCalls": null,
  "expectedCompilerCalls": null
}
```

每个具体 fixture 必须把 expected calls 固化为数字，不使用通配值：

| crash point | 条件 | Provider | Compiler |
| --- | --- | ---: | ---: |
| `unable_result_persisted` | 首次 unable，expanded artifact尚未生成 | 1 | 1（expanded mock返回compiler-ready时） |
| `unable_result_persisted` | 二次 unable | 0 | 0 |
| `context_expanded` | expanded Provider结果尚未持久化 | 1 | 1（mock返回compiler-ready时） |
| `semantic_result_persisted` | compiler-ready result已持久化 | 0 | 1 |
| `compiled_proposal_persisted` | compiled proposal已持久化 | 0 | 0 |
| `commit_unknown` | durable compiled proposal已存在 | 0 | 0 |

若 expanded mock仍返回 unable，则对应 fixture 的 Compiler期望为 0，并验证 cursor-only分支。

## 3. 必测用例

### 3.1 Version 与 State

- `memory_state.version` 只接受字符串 `"2.01"`；number `2.01`、integer `2`、string `"2"` 均拒绝；
- snapshot/event group/task 的 `schema_version` 使用 `TEXT` 且等于 `"2.01"`；
- 旧 2.0 state/task/event/snapshot 不读取、不 replay；
- item 必含 `id/text/sourceRefs/createdAtMessageId/updatedAtMessageId`；
- sourceRefs 非空、二元去重、稳定排序、hash格式正确；
- Profile/Relationship 带 facet/canonicalKey/factBasis 时 schema 拒绝；
- scene populated field必须有非空 sourceRefs；empty field必须为 `sourceRefs=[]/updatedAtMessageId=null`；
- 全局 itemId 唯一；
- Todo领域/lifecycle字段完整。

### 3.2 ProposerTaskRenderer

- public input只含可读 Memory、short refs、消息和最少 metadata；
- public input不含真实 itemId、contentHash、sourceRefs、storage container JSON或 compiled op；
- private writable map含真实 target；read-only map含 sourceRefs；
- writable/read-only namespace明确区分；
- item与scene field粒度正确；
- 同一 artifact 的 retry/schema repair/context expansion/restart/shadow replay refs不变；
- context expansion只增加更早 messages，不重新编号 Memory refs；
- expanded public input与覆盖其中全部消息的 expanded messageMeta同事务持久化；restart不按当前数据库窗口重建；
- expanded input新增消息可以作为direct evidence，并使用expanded messageMeta通过Compiler复核；
- successor在新 revision重新 render，允许新 ref编号；
- 各 Proposer可见范围与 Semantic Contract表一致；
- fixed read-only scope完整渲染，Todo overdue使用配置窗口。

### 3.3 Semantic Schema

- normal outer status只允许 `changes/noop/unable_to_decide`；
- compaction只允许 `changes/unable_to_compact`；
- `unable_to_decide/unable_to_compact` 都进入 unable durable分支且绝不调用Compiler；
- sectionResults恰好覆盖 target sections；
- 联合结果任一section unable时整体不是compiler-ready，其他section changes不得部分compile/apply；
- add禁止 ref；修改/terminal要求 writable ref；
- supportRefs只接受 read-only namespace；
- evidenceMessageIds只接受生成该结果的base/expanded input实际显示消息；
- normal change direct/support至少一个；
- compaction merge不带 direct/support；
- IR 出现 itemId/op/evidenceKind/quote/contentHash/typed Profile字段时拒绝；
- 所有 item sections接受 add/update/correct/forget Semantic action；
- scene接受 set/correct/clear/forget；
- Todo/Agreement领域 terminal actions shape正确；
- relative Todo要求 anchorMessageId且属于 direct evidence；
- support-only relative date schema/compile失败；
- Provider输出schema repair最多一次，非法原文不持久化。

### 3.4 Source Resolution

- direct old-overlap-only合法；
- support-only合法；
- direct+support混合合法；
- 不存在 new-batch evidence gate或 overlap_only_evidence；
- support展开到 observed window外历史 source并成功批量查询；
- 多个support/direct共享 source时按 messageId+hash去重；
- 输出sourceRefs稳定排序；
- writable ref用作support、read-only ref用作target时 `ref_resolution_failed`；
- missing/stale ref、section不匹配、item不存在时fail closed；
- missing message 或 scope/hash不一致时 `source_validation_failed`；direct source 的 role/createdAt 与 effective base/expanded artifact `messageMeta` 不一致时失败；support source 只持久化 messageId/hash，createdAt 使用权威数据库值且 role 必须是有效 User/Assistant；
- Compiler不自动替换hash、不选择相似item、不把update降级成add。

### 3.5 Todo 日期

- absolute date按用户时区次日00:00；
- relative使用显式direct anchor message createdAt，不使用task.now；
- `days=0`、month-end、leap year、DST gap/overlap；
- anchor不在direct IDs中 `date_anchor_invalid`；
- support-only relative失败；
- Compiler输出ISO dueAt，Reducer不接收relative表达式；
- rebuild发生在deadline后仍能写入并由lifecycle转overdue。

### 3.6 Action 编译

- correct与update生成完全相同compiled op/shape，event不保留区别；
- scene clear/forget都编译clearField；
- all item-section forget编译forgetItem；
- Todo complete/cancel/expire和Agreement cancel映射正确；
- compaction merge refs映射真实itemIds；
- 无法唯一编译时 `compile_invariant_failed`；
- Compiler不做语义判断或数据库写入。

### 3.7 Reducer Provenance

- add item使用compiled sources；
- update/correct保留itemId/createdAt，合并旧新sources并更新updatedAt；
- merge继承所有source items sources并生成新ID；
- scene set支持多source refs并以本次compiled sources替换旧field provenance；clear写空sourceRefs；
- forget/terminal移除active对象，动作sources保存在event；
- correction/forget不写tombstone、不触发RAG invalidation；
- state/event/snapshot都不含evidenceKind/quote/supportRef；
- normalized operation足以不调用LLM/Compiler replay。

### 3.8 Reducer Policy 与状态安全

- state-contract section/op表全部合法组合接受；
- normal merge、cross-section merge、scene item op等非法组合拒绝；
- item/path不存在拒绝；
- 同bundle同target冲突拒绝；
- exact normalized text duplicate拒绝；
- 语义近似但text不相等不由Reducer拒绝；
- 不存在canonicalKey/observedPattern message-count gate；
- Todo active/overdue状态表、Scene TTL、Episode淘汰保持；
- accepted/rejected/noop cursor语义保持。

### 3.9 Capacity 与 Compaction

- maxItems/maxRenderedChars分别触发deferred；
- update增长text也检查容量；
- provenance/IDs/artifact/IR/compiled payload不计section容量；
- scene只检查values且单field capacity rejected；
- recentEpisodes确定性淘汰、不调用compaction；
- maintenance Renderer输出short refs，不暴露IDs/provenance；
- compaction Semantic merge经Compiler生成mergeItems；
- Profile/Relationship不要求facet/key相等；
- Todo merge领域字段必须相等；
- lengthBudget unable/rejection/容量未改善halt target；hygiene对应结果以noop/skipped终结并保持healthy；
- pending item保护、全部protected失败、多section顺序maintenance；
- original compiled proposal replay不重调normal Proposer/Compiler；
- original normal compiled proposal replay成功统一为`status=succeeded,stage=committed`；
- compaction/replay失败只halt对应target；resumeEpoch创建新child。

### 3.10 Cursor、Task 与 Recovery

- 同tick多个targets按最新revision逐个创建task；
- immutable task payload包含artifact；
- compiler-ready Semantic结果先持久化，再允许Compiler；
- unable结果进入独立`unable_result_persisted`分支，恢复时绝不调用Compiler；
- 首次unable的expanded artifact先持久化再重调Provider；二次unable不调用Compiler并提交cursor-only revision；
- 联合changes+unable首次整体重提、二次整体丢弃，不发生部分state写入；
- compiled proposal先持久化，再允许Reducer；
- semantic_result_persisted恢复不调LLM，只重跑Compiler；
- context_expanded恢复复用expanded input/messageMeta；
- compiled_proposal_persisted恢复不调LLM/Compiler；
- Provider/schema/compile error不推进cursor/revision/snapshot；
- compile error先发现stale时走successor而非误报compile failure；
- successor重新render/propose/compile，不复用旧refs/IR/Patch；
- unable首次扩窗保持ref map，二次cursor-only revision；
- capacity deferred不推进；
- phase identity、duplicate delivery、transaction failed、commit unknown不重复提交；
- per-target halt不阻塞其他targets/主聊天。

### 3.11 Event Replay

- accepted/system cleanup normalized operation完整；
- event schema无evidence_kind列；
- add/update/set/clear/forget/terminal/merge均可replay；
- clear/forget action sources不丢失；
- revision/cursor/generation/schema version chain严格验证；
- replay不调用Proposer、Compiler或source resolver；
- 2.0 event拒绝；
- 不存在suppression cleanup type。

### 3.12 Provider Adapter

- preflight覆盖六个Semantic normal schemas与compaction schema；
- unknown adapter拒绝启动，不回退裸JSON解析；
- `ok/error/deferred`归一化保持；`deferred/provider_queue_full` 返回 queued，且不增加 attempt/error counter、schema repair、target status、cursor、revision、event 或 snapshot；
- safety/max-output/network/schema分类保持；
- repair feedback持久化且跨重启不增加次数；
- Provider request只包含public input，不包含private ref map；
- metrics记录Semantic result和Compiler，不记录raw prompt/content。

### 3.13 Main Renderer 与 Context

- MainChatMemoryRenderer与ProposerTaskRenderer各自golden；
- 主Renderer不显示sourceRefs/IDs/events；
- empty sections、health markers、effective Scene/Todo、overdue budget稳定；
- needsMemory/recent window/user-boundary保持；
- GapBridge完整消息/omitted diagnostic/恢复保持；
- RAG与Memory并列；
- correction/forget后RAG/Recall仍可召回旧raw source；
- raw edit/delete generation变化后旧projection不能作为当前完整结果；
- context assembly不读取suppression tombstone。

### 3.14 Rebuild 与 Projection

- append不增加generation，source mutation增加并原子初始化rebuilding；
- edit/truncate/session visibility mutation传入最早受影响messageId；
- 最新安全snapshot的六target cursors必须全部早于受影响messageId，且不超过变化后的boundary；
- snapshot schema/generation/revision/state与全部sourceRefs hash复核通过后，克隆为新generation anchor并保留各target cursor；
- snapshot含受影响sourceRef、raw source缺失或hash变化时拒绝该candidate；无更早安全candidate时从cursor 0重建；
- privacy purge删除旧audit history后只保留克隆出的新generation anchor；
- forceDrain使用正式2.01 Renderer→Semantic→Compiler→Reducer pipeline；
- 六target到boundary前保持rebuilding；
- crash后target boundary reconciliation继续；
- rebuild不做terminal suppression filter，允许forgotten/corrected raw source再次形成Memory；
- RAG checkpoint只有generation/boundary，无processedTombstoneId；
- projection adapter不要求suppress；
- query-scoped requiredBoundary健康算法保持。

### 3.15 Privacy 与 Retention

- privacy purge覆盖raw、state/events/snapshots、base/expanded artifact、ref map/messageMeta、unable/Semantic result、compiled proposal、diagnostics/notifications、RAG和debug store；
- 任一store残留时operation不completed；
- 普通forget不执行privacy delete；
- 无tombstone表不削弱purge verification；
- anchor snapshot、连续event chain、active task引用、diagnostic projection先行保持；
- retention可以清理终态artifact/IR/Patch，但不能破坏active task或phase恢复。

## 4. 端到端 Smoke

至少包含：

1. Episode add/update/correct/forget垂直切片；
2. Profile support-only归纳且无typed metadata；
3. Todo direct relative日期与support-only relative失败；
4. Provider schema repair后refs不变；
5. unable扩窗后crash复用expanded messageMeta，compile后crash恢复不重复LLM；
6. capacity→Semantic merge→compile→original compiled replay；
7. source edit→从最新安全snapshot建立新generation anchor→只重放受影响后缀；
8. active forget后rebuild允许复活；
9. privacy hard delete清除artifact/IR/Patch；
10. Main context同时包含Memory、GapBridge、RAG和健康标记。

## 5. 测试入口

继续使用独立 memory test入口与 Harness runner。Fixture/golden命名应从 `evidence/patch` 迁移到 `semantic/compiler/source/provenance`，删除quote、evidenceKind、typed-profile和suppression fixtures；保留cursor、capacity、lifecycle、recovery、context、rebuild和privacy fixtures并更新2.01 shape。
