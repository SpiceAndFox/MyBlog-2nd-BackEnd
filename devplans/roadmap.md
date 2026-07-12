# Memory Control v2 开发顺序

## 原则

每阶段先补 Harness fixture，再实现；未通过本阶段验收，不进入下一阶段。真实 LLM 最后接入，前期全部使用固定 proposal。

## 代码规范

- 禁止在业务代码中硬编码环境、部署或运营相关配置；配置应集中管理。
- 配置必须区分必填项和可选项。必填项缺失或非法时应立即报错；可选项可以有统一、明确的默认值。
- 禁止通过默认值、空 catch 或静默忽略掩盖配置错误和程序错误。
- 对用户输入、数据库、文件及第三方服务等外部边界，必须进行必要的校验和异常处理。
- 模块应职责清晰、高内聚、低耦合；文件承担多个职责或难以测试、修改时，应及时拆分。
- 禁止循环依赖、重复逻辑和无意义的复制粘贴。
- 复杂或关键业务逻辑应编写测试，确保代码可修改、可维护。

## 开发阶段

1. **状态与存储骨架**：实现 v2 schema/校验器、配置入口、全部 DDL/repository、revision 0 初始化；建立 Harness runner 与 fixture 目录。
2. **纯代码核心**：依次实现 evidence/quote matcher、policy gate、生命周期、Reducer、Renderer；覆盖 accepted/rejected/noop、event/snapshot、effective view 的单元与 golden 测试。
3. **Normal 写入链路**：实现 envelope/schema、六个 Proposer prompt、Memory Provider Adapter、Observer、窗口/eligibility、cursor、durable task 与原子提交；先 mock Adapter，后用真实模型做 prompt golden。
4. **恢复与幂等**：实现 retry/halt/resume、successor task、phase identity、commit outcome unknown、进程重启恢复和后台 housekeeping；故障注入验证无重复 revision/event/cursor。
5. **容量维护**：实现 section budget、recentEpisodes 滚出、deferred、compaction child task、pending-item 保护、原 proposal replay 与容量类 resume。
6. **上下文与健康**：接入单一 memory segment、跨 session recent window、GapBridge、target/diagnostic 健康聚合、持续告警与 recovery notification；保持 v1 注入关闭开关可控。
7. **重建与抑制**：实现 source mutation/generation、force-drain（中间批次保持 rebuilding）、RAG/Recall checkpoints、correction/forget tombstone、查询末端过滤、retention 与 privacy hard delete。
8. **迁移与切换**：用生产历史副本做全量 rebuild 演练、容量/耗时测量和端到端 smoke；停服后删除旧 Memory、正式 rebuild/校验，再启用 v2 并移除 v1 worker/注入路径。

## 完成标准

`harness.md` 全部用例通过；迁移演练可重复；任一 Provider、Reducer、事务、重启或 source mutation 故障均不会产生静默丢失、重复写入、旧 source 泄漏或全局聊天阻断。
