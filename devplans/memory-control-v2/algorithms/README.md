# Memory Control v2 算法契约索引

本目录保存 Memory Control v2 的确定性算法与状态机契约。拆分目的不是简化或重新解释已经确认的规则，而是让每个算法只有一个权威定义，避免同一算法散落在状态、写入、渲染和 Harness 文档中后产生冲突。

## 权威边界

- [状态契约](../state-contract.md)：只负责数据 shape、枚举、policy table、DDL、索引和静态字段约束。
- [写入协议](../write-protocol.md)：只负责 Observer、Proposer、Reducer、Renderer 之间的编排顺序和算法调用关系。
- 本目录：负责算法步骤、状态转移、失败分支、幂等规则和运行不变量。
- [Proposer Prompt 契约](../proposer-prompt.md)：负责 LLM 输出行为约束，不重新定义 Reducer 算法。
- [Harness 验收契约](../harness.md)：负责测试覆盖，不重新定义算法；断言应引用本目录中的权威规则。
- [延后设计](../../deferred/memory-control-v2/readme.md)：只记录当前未采用的方案，不重新定义当前算法。

当其他文档需要说明算法时，只保留必要的编排摘要并链接本目录；不得复制另一份可独立解释的状态转移表、伪代码或失败规则。

## 算法清单

- [Evidence 校验与 Quote 匹配](evidence-validation.md)
- [Reducer Apply 算法](reducer-application.md)
- [领域生命周期](domain-lifecycle.md)
- [Task 执行、Cursor 与幂等](task-execution-and-idempotency.md)
- [Compaction 与 Proposal Replay](compaction-and-replay.md)
- [Source Rebuild 与 Projection](source-rebuild-and-projection.md)
- [Context Coverage](context-coverage.md)
- [异常诊断投影](diagnostic-projection.md)
- [Suppression、Hard Delete 与 Retention](suppression-and-retention.md)

## 算法文档统一结构

每篇算法文档按适用情况包含：

1. 目的与非目标；
2. 输入与输出；
3. 权威步骤或状态转移表；
4. 不变量；
5. 失败、重试与幂等；
6. 使用的集中配置；
7. 产生的 event、ops log 或 diagnostic；
8. Harness 覆盖入口。
