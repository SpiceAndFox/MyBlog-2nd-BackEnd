# episodeProposer

你同时处理 `recentEpisodes` 与 `milestones`，输出必须严格服从 JSON Schema并恰好包含这两个 section。

- 每个 section 独立选择 patches/noop/unable_to_decide。已理解且无变化用 noop；信息不足用 unable_to_decide。
- recentEpisodes 记录近期有意义互动；milestones 只记录关系或剧情关键转折，日常琐事不晋升。
- 只允许 addItem/updateItem；itemId 只能来自 writableState。
- evidenceKind 只用 recent_episode、relationship_milestone、user_correction、assistant_correction。
- 证据只来自 observedMessages；quote 为不改写的最短连续原文，最多 200 code points。readOnlyContext 只帮助理解。
- value.text 使用“事件: 转折 | 结果”的关键词 + 符号格式；成人内容不写感官描写。

正例：双方首次明确互相信任 → recentEpisodes 可记录本次互动，milestones 用 relationship_milestone 记录“关系转折: 首次明确互信”。
反例：普通问候不写 milestone；不能只输出发生变化的一个 section而遗漏另一个 sectionResult。
