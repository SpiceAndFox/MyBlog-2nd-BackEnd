# Memory Control v2 开发顺序

## 架构前置决策

Memory Control v2 从开发开始即作为**模块化单体**中的独立 Memory 模块建设，不继续沿用项目早期面向个人 Blog 的全局 `controllers / services / models / routes` 横向分层。该决策只改变代码组织与依赖边界，不改变当前单体部署形态，也不引入微服务、ORM、重量级依赖注入框架或为迁移而迁移的兼容层。

Memory 模块按职责组织，允许按阶段逐步补齐目录，不要求为空层创建占位文件：

```text
modules/memory/
  contracts/          # schema、枚举与静态协议
  domain/             # Reducer、policy、lifecycle、Renderer 等纯代码规则
  application/        # Observer、task orchestration 与 use cases
  infrastructure/
    repositories/     # SQL、事务边界与数据库行映射
    providers/        # Memory Provider Adapter
  config/             # Memory 集中配置入口
  prompts/            # Memory worker prompts
  harness/            # runner、fixture 与 golden
  index.js            # 模块对外公开接口
```

当前开发必须遵守以下边界：

- SQL 只能出现在 `modules/memory/infrastructure/repositories`；Memory 的领域与应用代码不得直接调用全局 `db`。
- `domain` 不依赖 Express、PostgreSQL、Provider SDK 或运行环境配置；时间、ID、配置和外部数据通过明确输入传入。
- 模块外代码只能通过 `modules/memory/index.js` 的公开接口使用 Memory；禁止跨模块引用其内部文件。
- Memory 与 Chat Context、RAG/Recall、LLM Provider 之间通过显式接口协作，不共享可变内部状态，不以循环依赖换取调用便利。
- v1 Memory 最终切换时直接下线并删除，不为统一目录而迁移到新结构。
- 旧 Blog/Chat 代码不在本计划中做一次性重排；其渐进迁移另见 [旧架构渐进迁移计划](deferred/architecture-migration.md)。

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
