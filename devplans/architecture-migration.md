# 模块化单体渐进迁移计划

## 1. 定位与现状

项目继续保持一个应用、一个部署单元和同一 PostgreSQL schema，通过代码模块建立边界，不拆分微服务。

Memory Control 2.01 已落地于 `modules/memory`，其契约以 [Memory Control 2.01 顶层设计](./memory-control-v2/memory-control-v2-overview.md) 为准。本文只管理既有 Chat、RAG、Auth、Blog、LLM 及 Memory 接线层的后续整理，不改变 Memory 数据契约，也不绕过既有迁移与启服门禁。

当前主要问题：

- Chat Controller 同时承担 HTTP、业务编排、Memory、RAG、LLM 和文件操作；
- Memory 公共入口过宽，存在默认单例、内部路径导入和硬编码 RAG projection；
- 配置、数据库和日志尚未统一由启动装配层注入；
- RAG 当前只服务 Chat，不具备独立顶层模块的充分依据；
- Auth 尚未纳入目标模块结构。

## 2. 目标结构

只创建有真实职责的目录：

```text
app/
  composition/

modules/
  memory/
  chat/
    rag/
  auth/
  blog/
    articles/
    diaries/
    tags/

shared/
  db/
  config/
  logging/
```

RAG 暂作为 Chat 子模块；出现多个独立消费者后再评估提升为顶层模块。`services/llm` 暂不预设必须进入 `shared`，只有稳定且确实被多个模块复用的 transport、SSE 或协议适配能力才考虑迁入 `shared/llm`。

`shared` 只接收无业务归属且被多个模块复用的基础能力，目录移动本身不是目标。Blog 下的 `articles`、`diaries` 和 `tags` 先作为功能目录，不强制成为彼此隔离的子模块。

迁移保持轻量：端口优先使用普通 JavaScript 函数或对象并通过工厂参数注入，不建立接口类层级，不引入 DI 容器，也不为尚不存在的复用场景创建抽象目录。每个新抽象都应对应一个正在被移除的真实耦合。

迁移允许并要求必要的行为保持重构，但范围只限于建立模块边界、消除隐式依赖、拆分当前切片职责和删除已替代旧代码；不得混入全仓格式化、批量改名、技术栈替换或业务规则调整。Memory 只整理接线与分层，不改变 2.01 数据契约和领域语义；其他稳定模块不做机会主义清理。

## 3. 边界规则

1. `app/composition` 负责配置加载、依赖装配、生命周期和进程级实例；它不承载业务判断或业务事务。业务模块不得维护隐式默认单例。
2. 模块运行时入口只暴露最小 API；迁移、诊断等能力使用显式的 `admin.js` 等次级入口。生产代码不得导入其他模块的内部目录。
3. `domain` 保持纯逻辑；`application` 编排 use case 和事务；SQL、Provider SDK、HTTP 与文件系统访问归 infrastructure adapter。
4. 每张表有唯一 owner；跨模块数据访问通过注入的公开端口，不能在本模块 Repository 中直接查询其他模块拥有的表。
5. 跨模块事务由发起该业务流程的 application use case 拥有；composition 只注入 transaction executor 和参与端口。原始 `pg` client 只在 infrastructure adapter 间作为事务上下文使用，不进入 domain 或 HTTP 公共契约。
6. 只有配置加载边界可以读取 `process.env`；模块接收已校验的只读配置。通用 env 读取器可放入 `shared/config`，模块特有的配置校验仍由对应模块定义并由 composition 调用。
7. Memory 不识别具体 RAG、Chat 表或 Auth 表实现；projection、隐私存储、raw source reader 和 User time-zone reader 由 composition root 注入。
8. 依赖方向固定为 `app/composition -> modules 的公开入口 + shared`；业务模块只能依赖自身内部、`shared` 和被注入的其他模块端口；`shared` 不得反向依赖业务模块；任何模块不得依赖 `app/composition`。
9. 导入模块不得隐式打开数据库连接、创建目录、删除文件或启动 timer。数据库、日志、模块 runtime 和后台任务均由显式工厂创建，并向 composition 暴露必要的 `start`、`stop` 或 `drain` 生命周期操作。
10. 模块化不要求拆数据库、引入 ORM、DI 容器、接口类体系或事件总线。

### 数据归属基线

迁移开始时先采用以下归属，不因表名前缀改变 owner：

| 数据                                                                                   | Owner    | 跨模块访问方式                                            |
| -------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| `users`                                                                                | Auth     | 注入 User 查询端口；Memory 只读取所需的 time zone         |
| `chat_sessions`、`chat_messages`、Preset、Gist                                         | Chat     | Chat source reader 向 Memory 提供受约束的 raw source 视图 |
| `chat_rag_chunks`                                                                      | Chat RAG | 由 Chat RAG repository 和 projection adapter 访问         |
| `memory_state`、`chat_preset_memory`、Memory task/event/snapshot/checkpoint/privacy 表 | Memory   | 通过 Memory application API 访问                          |
| `articles`、`diaries`、`tags`、`article_tags`                                          | Blog     | Blog 内部可直接协作；暂不把功能目录当作强隔离边界         |

同一 PostgreSQL schema 内可以继续使用外键和共享事务，但表 owner 之外的模块不建立新的直接 SQL 依赖。确需原子修改 Chat 与 Memory 数据时，先定义一个明确的 application use case，再由共享 transaction executor 在同一事务中调用双方的 infrastructure adapter；不把该流程放进 composition。

## 4. 执行顺序

### A. 建立迁移基线

- 锁定现有 HTTP、事务、错误响应和后台任务行为；
- 增加依赖边界检查：禁止内部跨模块导入、禁止新增循环依赖；
- 以完整离线测试通过作为每批迁移的最低门槛。

实施记录：[A 阶段迁移基线](./architecture-migration-phase-a.md)。

### B. 建立启动装配层

- 将配置、数据库、日志、Server lifecycle 和模块实例装配集中到 `app/composition`，逐步改为显式工厂；
- 消除运行路径中分散的 `process.env` 读取，但不为改目录而搬动稳定代码。
- 先完成 Auth 的最小配置注入，使 JWT secret 不再由 Controller 或 Middleware 直接读取；Auth 的完整目录迁移仍留在后续阶段。
- 后台模块由 composition 统一启动和关闭，模块自身保留任务调度与排空逻辑。

实施记录：[B 阶段启动装配层](./architecture-migration-phase-b.md)。

### C. 收紧 Memory 接线

- 缩小 `modules/memory/index.js`，为运维工具建立显式次级入口；
- 移除模块级默认 runtime 和外部内部路径导入；
- 将 RAG projection、隐私存储、Chat raw source reader 和 User time-zone reader 等具体实现改为启动时注入；
- 将带 Repository I/O 的 Compiler 编排移出纯 domain。
- 接线调整只改变依赖位置，不削弱 Memory 2.01 现有的原子写入、generation fence、幂等、隐私恢复和启服门禁。

实施记录：[C 阶段 Memory 接线收紧](./architecture-migration-phase-c.md)。

### D. 迁移 Chat 垂直切片

按职责闭环逐批迁移，不整体搬运：

1. 消息发送、上下文编译和 Provider 调用；
2. 编辑、删除、恢复与隐私操作；
3. Preset、Session、头像和 Gist；
4. HTTP route/controller 变为薄入站适配器。

涉及 Chat 原始消息与 Memory generation/privacy 状态的流程，先定义 application use case 和事务责任，再移动 Repository；不得把现有原子检查拆成有竞态的多次独立调用。

实施记录（已完成）：[D 阶段 Chat 垂直切片](./architecture-migration-phase-d.md)。

### E. 整理 Chat RAG 与 LLM 端口

- 将 projection、retrieval、repository 和 degradation 归入 `modules/chat/rag`；
- 明确 Chat 对 Memory、RAG 和 LLM 的输入输出；
- Chat application 定义自己需要的 LLM 调用端口；`services/llm` 在复用接口稳定且出现多个真实消费者后，再决定是否仅将通用协议适配部分移动到 `shared/llm`。

实施记录：[E 阶段 Chat RAG 与 LLM 端口](./architecture-migration-phase-e.md)。

### F. Auth 与 Blog 按需迁移

Auth 的配置注入在 B 阶段先完成，完整模块整理在其行为测试完备后进行。Blog 仅在持续开发或现有边界明显增加维护成本时迁移，可以长期保持现状。

实施记录：[F 阶段 Auth 与 Blog 按需迁移](./architecture-migration-phase-f.md)。

## 5. 单批流程

每批只迁移一个可独立验证的职责闭环：

1. 列出入口、调用方、数据 owner、事务和配置依赖；
2. 补足 characterization tests；
3. 定义公开接口并切换调用方；
4. 删除旧入口和重复逻辑，不保留无期限兼容层；
5. 运行相关测试、完整离线测试和必要 smoke；
6. 记录未迁移依赖、回退点和下一触发条件。

## 6. 完成标准

- 非测试生产代码不存在跨模块内部路径导入；
- 本地依赖图无循环；
- `shared` 不依赖业务模块，业务模块不依赖 `app/composition`；
- `process.env` 只在配置加载与启动边界读取；
- SQL、Provider SDK 和 HTTP 不进入纯 domain；
- 模块导入无数据库、文件系统或 timer 启动副作用，进程级实例均由 composition 显式创建；
- Chat、Memory、RAG、LLM 的依赖方向和数据 owner 明确；
- 跨模块事务由明确的 application use case 拥有，composition 不包含业务事务；
- Memory 的 source、projection、privacy 和 User time-zone 实现均由外部注入，且现有恢复与一致性语义不变；
- 模块内部重构不要求调用方同步修改内部引用；
- 不存在重复写入、双 authority 或无期限兼容分支；
- 全部离线测试通过，关键 HTTP、事务、隐私和恢复行为保持不变。

## 7. 非目标

- 不拆分微服务或独立数据库；
- 不强制更换 Express、`pg`、CommonJS 或引入 ORM；
- 不一次性迁移全部旧代码；
- 不为目录统一而迁移稳定的 Blog 或共享基础设施；
- 不借架构迁移修改 Memory 2.01 业务契约或放宽生产门禁。
