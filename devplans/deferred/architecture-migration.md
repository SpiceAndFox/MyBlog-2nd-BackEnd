# 旧架构渐进迁移计划（Deferred）

## 文档定位

本文件记录项目从早期个人 Blog 的全局横向分层，逐步迁移到模块化单体的长期计划。它不属于 Memory Control v2 当前功能范围，也不是启动下一开发阶段前必须完成的全项目重构。

Memory Control v2 立即采用新模块边界，具体约束以 [Memory Control v2 开发顺序](../roadmap.md) 的“架构前置决策”为准；本文只管理既有 Blog、Chat、RAG、LLM 等旧代码的后续迁移。

## 1. 背景与判断

项目早期使用全局 `controllers / services / models / routes` 横向目录，适合职责较少的个人 Blog。Chat 子系统引入后，项目已经包含主聊天编排、上下文编译、Memory、RAG/Recall、LLM Provider、durable task、恢复与健康状态等不同领域。继续把它们拆散到全局横向目录会逐渐带来：

- 一个功能变更需要跨多个顶层目录定位代码；
- 全局 `models` 和 `services` 变成缺少领域边界的公共集合；
- Chat、Memory、RAG 容易直接引用彼此内部实现并形成循环依赖；
- SQL、事务、领域规则和外部 Provider 编排难以独立测试；
- 模块所有权与公开接口不明确，局部修改的影响范围持续扩大。

因此目标架构确定为**模块化单体**：保持一个应用、一个部署单元和现有 PostgreSQL 基础设施，通过代码模块与接口建立边界。当前没有拆分微服务的收益依据。

## 2. 目标结构

目标形态示意如下，实际迁移时只创建有真实职责的目录：

```text
modules/
  memory/
    contracts/
    domain/
    application/
    infrastructure/
    index.js
  chat/
    domain/
    application/
    infrastructure/
    index.js
  rag/
    domain/
    application/
    infrastructure/
    index.js
  blog/
    articles/
    diaries/
    tags/
    index.js

shared/
  db/
  config/
  logging/
  llm/
```

`shared` 只接收确实被多个模块复用且不属于某一业务领域的基础能力。不得为了减少相对路径而把领域逻辑放进 `shared`。

## 3. 模块边界规则

1. 每个模块通过根 `index.js` 暴露最小公共 API；其他模块不得引用其内部目录。
2. `domain` 保存纯业务规则，不依赖数据库、HTTP 框架、进程环境或 Provider SDK。
3. `application` 编排 use case、事务意图和外部端口，不包含 SQL。
4. `infrastructure` 实现 repository、Provider、队列和框架适配；SQL 只存在于 repository 或显式 migration 文件。
5. HTTP route/controller 是模块的入站适配器，不直接访问 repository。
6. 跨模块调用使用明确输入/输出，不共享可变单例状态；发现循环依赖时先收窄接口或提取真正的共享基础能力。
7. 数据库表可以继续位于同一个 PostgreSQL schema；模块化不要求按模块拆数据库。
8. 配置仍由统一启动边界加载和校验，但按模块导出只读配置对象；运行路径不得直接读取 `process.env`。

## 4. 渐进迁移原则

- **新代码服从新边界**：Memory v2 作为首个模块执行；后续新增的大型 Chat/RAG 能力也应进入所属模块。
- **修改时迁移**：只有旧模块因功能开发、缺陷修复或边界改造需要发生实质变化时，才迁移相关代码；不单独发起无行为收益的大规模目录搬运。
- **先测试后移动**：迁移前补足当前行为测试或 characterization test，迁移中保持对外行为不变。
- **小批次可回退**：一次只迁移一个职责闭环，并在每批完成后运行测试和 smoke；禁止长期保留新旧两套同时写入的实现。
- **先建立出口，再搬内部**：先定义模块公共接口并让调用方依赖接口，再移动内部实现，避免一次修改全部调用点。
- **不迁移即将删除的代码**：v1 rolling summary/core memory 在 Memory v2 切换后直接删除，不迁入新模块。

## 5. 建议迁移顺序

1. **Memory v2**：按新结构完成 contracts、domain、application、infrastructure 与公开接口。
2. **Chat Context 边界**：让上下文编译器只通过 Memory 公共接口读取 memory segment 和健康信息。
3. **RAG/Recall**：整理 projection、retrieval、suppression/checkpoint 的公开边界，消除对 Chat/Memory 内部文件的引用。
4. **Chat 主链路**：迁移会话、消息、上下文编排与 HTTP 适配器，明确 Chat 对 Memory/RAG/LLM 的端口。
5. **LLM 基础设施**：在真实复用关系稳定后整理为 `shared/llm`；业务 prompt、业务 schema 和 Memory Adapter 仍归所属模块。
6. **Blog 模块**：articles/diaries/tags 仅在持续开发或维护成本出现时迁移；稳定代码可以长期保留旧结构。

该顺序是依赖方向，不是要求连续执行的项目排期。每一步都可以在业务需要出现前保持 deferred。

## 6. 单批迁移流程

每次迁移一个旧职责时执行：

1. 列出当前入口、调用方、数据库访问和配置依赖；
2. 补充能够锁定当前行为的测试；
3. 定义目标模块的公共接口和依赖方向；
4. 将纯规则与基础设施访问分离；
5. 迁移实现并切换调用方；
6. 删除旧入口和重复逻辑，不保留无期限 compatibility wrapper；
7. 运行相关单元、集成和 smoke 测试；
8. 记录仍未迁移的依赖和下一触发条件。

## 7. 启动迁移的触发条件

满足任一条件时，可以把对应旧职责从 deferred 提升为实际任务：

- 新功能需要同时修改多个旧顶层目录，且现有边界明显增加实现风险；
- 出现跨模块循环依赖或同类 SQL/业务规则重复；
- 某职责无法在不启动完整服务器或真实外部服务的情况下测试；
- Memory v2、RAG 或 Chat 的公共接口需要旧代码配合才能保持单向依赖；
- 某旧模块进入持续开发期，迁移收益能够覆盖当次改造成本。

仅因目录风格不统一、文件看起来陈旧或希望“一次整理干净”，不构成迁移触发条件。

## 8. 非目标

- 不拆分微服务或独立数据库；
- 不引入事件总线来替代简单的进程内调用；
- 不因架构调整强制更换 Express、`pg` 或 CommonJS；
- 不以引入 ORM、容器式依赖注入或 repository 抽象层数量作为完成标准；
- 不承诺一次性迁移全部 Blog 代码；
- 不允许架构迁移阻塞 Memory v2 已明确的分阶段交付。

## 9. 完成判断

长期迁移是否有效，以以下结果判断，而不是以目录搬完为准：

- Chat、Memory、RAG 的依赖方向清晰且不存在循环引用；
- SQL、Provider SDK 与 HTTP 框架不会进入纯领域规则；
- 每个模块存在稳定、最小的公开接口；
- 一个模块的内部重构不要求其他模块同步修改内部引用；
- 新旧实现不存在重复写入、双 authority 或长期兼容分支；
- 稳定的 Blog 功能可以在未迁移时继续正常维护和运行。
