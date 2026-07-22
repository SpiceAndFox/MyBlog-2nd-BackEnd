# Memory Control 2.01 算法契约索引

## 权威边界

算法文档定义顺序敏感的确定性步骤、状态转移、失败分支和幂等规则。静态 shape/DDL 见 [状态契约](../state-contract.md)，Semantic/Compiler shape 见 [Semantic 写入契约](../semantic-write-contract.md)。

任何实现改变算法行为时，应先修改对应算法文档和 Harness；不得在 service/repository 内形成第二套未记录状态机。

## 算法清单

| 文档 | 权威范围 |
| --- | --- |
| [Semantic 编译与 Source 校验](semantic-compilation-and-source-validation.md) | ref resolution、support provenance 展开、source validation、date anchor、action→op、compile failure |
| [Reducer Apply](reducer-application.md) | compiled patch 校验、模拟、apply、event 与 revision 提交 |
| [Task 执行、Cursor 与幂等](task-execution-and-idempotency.md) | task stage、cursor、retry、successor、phase identity 与 crash recovery |
| [Compaction 与 Proposal Replay](compaction-and-replay.md) | capacity-blocked、semantic merge、compile、compiled proposal replay |
| [领域生命周期](domain-lifecycle.md) | Scene TTL、Todo、Episode 滑动窗口和 effective view |
| [Source Rebuild 与 Projection](source-rebuild-and-projection.md) | sourceGeneration、force drain、RAG generation/boundary checkpoint |
| [Active Forget、Privacy 与 Retention](active-forget-privacy-and-retention.md) | active-state forget、privacy hard delete、snapshot/event/task retention |
| [Context Coverage](context-coverage.md) | recent window、needsMemory、GapBridge、RAG/Recall cutoff 与健康 |
| [异常诊断投影](diagnostic-projection.md) | 从 committed events 派生 scene capacity 等诊断 |

2.01 已不包含 evidenceKind、quote matcher 或 context-suppression tombstone；算法文件名均以当前职责命名，不保留会暗示旧协议仍有效的兼容名称。

## 通用结构

每个算法文档应说明：

1. 输入与 authority；
2. 顺序敏感步骤；
3. 失败分类和是否推进 cursor/revision；
4. 幂等/恢复条件；
5. Harness 落点。
