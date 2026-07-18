# Memory Control v2.1 延后方向

本目录记录当前修复完成后可能继续考虑的方向。它们有长期价值，但不是本轮 Memory Control v2 修复的完成条件。

现阶段只保留方向，不预先确定具体 schema、状态机或实施顺序。

## 1. 统一语义观察与动态路由

- 连续扫描原始消息并持久保存通用语义候选。
- 按候选信号决定调用哪些专业 Proposer。
- 分离 source 扫描进度与候选消费进度。
- 为 late discovery、候选 noop 和失败建立统一生命周期。

## 2. 更完整的跨窗口语义状态

- 通用保存跨消息的提议、接受、拒绝、完成和取消线索。
- 维护可跨窗口延续的 open episode / semantic arc。
- 按候选检索相关原文，而不只依赖固定 overlap。

## 3. Profile 与 Relationship 长期模式累计

- 跨多个独立互动场合累计支持证据与反证。
- 让 profile/relationship 模式判断不依赖单个 context window 或 episode 摘要。
- 支持 reaffirm、refine、supersede 等自然演化语义。

## 4. 更强的语义一致性与诊断

- 扩展不同 batch、overlap、session 分组和 target 顺序下的语义等价评测。
- 建立围绕候选生命周期的完整健康度与诊断。
- 进一步统一在线处理、重建和 late discovery 的语义行为。
