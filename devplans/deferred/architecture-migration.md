# 模块化单体渐进迁移计划

## 1. 定位与现状

项目继续保持一个应用、一个部署单元和同一 PostgreSQL schema，通过代码模块建立边界，不拆分微服务。

Memory Control 2.01 已落地于 `modules/memory`，其契约以 [Memory Control 2.01 顶层设计](../memory-control-v2/memory-control-v2-overview.md) 为准。本文只管理既有 Chat、RAG、Auth、Blog、LLM 及 Memory 接线层的后续整理，不改变 Memory 数据契约，也不绕过既有迁移与启服门禁。

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
  llm/
```

RAG 暂作为 Chat 子模块；出现多个独立消费者后再评估提升为顶层模块。`shared` 只接收无业务归属且被多个模块复用的基础能力，目录移动本身不是目标。

## 3. 边界规则

1. `app/composition` 负责配置加载、依赖装配、生命周期和进程级实例；业务模块不得维护隐式默认单例。
2. 模块运行时入口只暴露最小 API；迁移、诊断等能力使用显式的 `admin.js` 等次级入口。生产代码不得导入其他模块的内部目录。
3. `domain` 保持纯逻辑；`application` 编排 use case 和事务；SQL、Provider SDK、HTTP 与文件系统访问归 infrastructure adapter。
4. 每张表有唯一 owner；跨模块数据访问通过公开端口，跨模块事务由明确的 use case 或 composition 层拥有。
5. 只有配置加载边界可以读取 `process.env`；模块接收已校验的只读配置。
6. Memory 不识别具体 RAG 实现；projection、隐私存储和 source reader 由 composition root 注入。
7. 模块化不要求拆数据库、引入 ORM、DI 容器或事件总线。

## 4. 执行顺序

### A. 建立迁移基线

- 锁定现有 HTTP、事务、错误响应和后台任务行为；
- 增加依赖边界检查：禁止内部跨模块导入、禁止新增循环依赖；
- 以完整离线测试通过作为每批迁移的最低门槛。

### B. 建立启动装配层

- 将配置、数据库、日志、Server lifecycle 和模块实例装配集中到 `app/composition`；
- 消除运行路径中分散的 `process.env` 读取，但不为改目录而搬动稳定代码。

### C. 收紧 Memory 接线

- 缩小 `modules/memory/index.js`，为运维工具建立显式次级入口；
- 移除模块级默认 runtime 和外部内部路径导入；
- 将 RAG projection、隐私存储等具体实现改为启动时注入；
- 将带 Repository I/O 的 Compiler 编排移出纯 domain。

### D. 迁移 Chat 垂直切片

按职责闭环逐批迁移，不整体搬运：

1. 消息发送、上下文编译和 Provider 调用；
2. 编辑、删除、恢复与隐私操作；
3. Preset、Session、头像和 Gist；
4. HTTP route/controller 变为薄入站适配器。

### E. 整理 Chat RAG 与 LLM 端口

- 将 projection、retrieval、repository 和 degradation 归入 `modules/chat/rag`；
- 明确 Chat 对 Memory、RAG 和 LLM 的输入输出；
- `services/llm` 在复用接口稳定后再决定是否移动到 `shared/llm`。

### F. Auth 与 Blog 按需迁移

Auth 在其行为测试完备后独立成模块。Blog 仅在持续开发或现有边界明显增加维护成本时迁移，可以长期保持现状。

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
- `process.env` 只在配置加载与启动边界读取；
- SQL、Provider SDK 和 HTTP 不进入纯 domain；
- Chat、Memory、RAG、LLM 的依赖方向和数据 owner 明确；
- 模块内部重构不要求调用方同步修改内部引用；
- 不存在重复写入、双 authority 或无期限兼容分支；
- 全部离线测试通过，关键 HTTP、事务、隐私和恢复行为保持不变。

## 7. 非目标

- 不拆分微服务或独立数据库；
- 不强制更换 Express、`pg`、CommonJS 或引入 ORM；
- 不一次性迁移全部旧代码；
- 不为目录统一而迁移稳定的 Blog 或共享基础设施；
- 不借架构迁移修改 Memory 2.01 业务契约或放宽生产门禁。
