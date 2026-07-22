# 架构迁移 F 阶段：Auth 与 Blog 按需迁移

状态：已完成
完成日期：2026-07-22

## 1. 完成范围

F 阶段完成 Auth 的完整模块整理，并按计划对 Blog 做出"保持现状"的显式决策。本阶段未改变 HTTP 路径、HTTP 响应契约、数据库 schema、JWT 签发/验证语义、七日 token 过期、认证状态码与错误体，也未改变 Memory Control 2.01 数据契约或后台任务调度。

1. Auth 的 controller、middleware 和 user repository 从遗留的 `controllers/`、`middleware/`、`models/` 迁入 `modules/auth/`；
2. 删除遗留的 deferred-configuration 单例（`configureAuthController`、`configureAuthMiddleware`、`installLegacyAuthBindings`）和对应的 delegating 默认导出；
3. 消费 auth middleware 的 4 个路由文件改为工厂函数，由 composition 注入 `authMiddleware`，与 Chat 路由工厂模式一致；
4. `userTimeZoneReader` 随 Auth 模块归位，仍由 composition 注入 Memory；
5. Blog 经评估保持现状，不迁移。

## 2. Auth 模块结构

```text
modules/auth/
  index.js              — 公开入口：createAuthModule({ config, logger, userModel?, bcrypt?, jwt?, withRequestContext?, database? }) → { middleware, controller, userTimeZoneReader }
  controller.js         — createAuthController：login / me / updateTimeZone 三个 use case（bcrypt、jwt、logger、userModel 由工厂注入）
  middleware.js         — createAuthMiddleware：Bearer token 验证，attach req.user
  userRepository.js     — createUserRepository({ database })：users 表查询（findByUsername / findById / updateTimeZone），SQL 收口于此
  userTimeZoneReader.js — createUserTimeZoneReader({ database })：Memory 读取用户 time zone 的注入端口（B 阶段建立，本阶段随模块归位）
```

`createAuthModule` 在 `userModel` 未传入时从 `database` 构造 `userRepository`；传入时直接使用（测试与已有调用方兼容）。`userTimeZoneReader` 仅在 `database` 存在时创建。bcrypt/jwt 保留库默认值，可被工厂参数覆盖。

模块内部为扁平结构，不设 `domain/application/infrastructure` 子目录：Auth 没有可提取的纯 domain 逻辑（密码校验依赖 bcrypt、token 依赖 jwt，均由外部注入），且总体约 180 行，按主计划"不为尚不存在的复用场景创建抽象目录"保持轻量。SQL 已收口在 `userRepository.js`，controller/middleware 不直接访问数据库。

## 3. 路由接线

遗留的 auth 单例要求路由在模块加载时读取一个进程级已配置实例。F 阶段删除该单例后，消费 auth 的路由改为工厂函数，由 composition 显式注入：

| 路由文件 | 旧形态 | 新形态 | 注入参数 |
| --- | --- | --- | --- |
| `routes/auth.js` | 直接 require `@controllers/authController` + `@middleware/authMiddleware` | `createAuthRouter({ authMiddleware, authController })` | 两者均由 auth 模块提供 |
| `routes/diaries.js` | 直接 require `@middleware/authMiddleware` | `createDiariesRouter({ authMiddleware })` | diaryController 仍内部 require |
| `routes/admin/tags.js` | 直接 require `@middleware/authMiddleware` | `createAdminTagsRouter({ authMiddleware })` | tagController 仍内部 require；保留 `router.use(authMiddleware)` 全局认证 |
| `routes/admin/articles.js` | 直接 require `@middleware/authMiddleware` | `createAdminArticlesRouter({ authMiddleware })` | articleController 与 upload middleware 仍内部 require |

`routes/tags.js`、`routes/articles.js`（公开无认证路由）不变。

### 装配流程

`app/composition/createApplication.js`：

1. `createAuthModule({ config: config.authConfig, database, logger, withRequestContext })` 创建 auth runtime（`{ middleware, controller, userTimeZoneReader }`）；
2. 不再调用 `installLegacyAuthBindings`；
3. `auth.userTimeZoneReader` 注入 Memory 模块（B 阶段接线不变）；
4. `auth.middleware` 注入 Chat composition（B 阶段接线不变）；
5. `auth` 传入 `createHttpApplication`。

`app/composition/httpApplication.js` 接收 `auth`，调用 4 个路由工厂构造 `authRouter`、`diariesRouter`、`adminTagsRouter`、`adminArticlesRouter`，与 `chatRouter` 一同挂载。路由工厂在 `createHttpApplication` 内部调用，此时 composition 已完成 config、database、logger、Auth 和模块 runtime 装配。

## 4. 删除的旧入口

- `controllers/authController.js`（含 `createAuthController`、`configureAuthController`、delegating 默认导出）；
- `middleware/authMiddleware.js`（含 `createAuthMiddleware`、`configureAuthMiddleware`、delegating 默认导出）；
- `models/userModel.js`（直接 require `../db` 的遗留 user 仓储）；
- `modules/auth/index.js` 的 `installLegacyAuthBindings` 导出；
- `test/tmp/auth-http-baseline.test.js`（A 阶段冻结的临时基线测试，由 `test/auth/auth-behavior.test.js` 替换）。

不保留兼容转发层。`@controllers`、`@middleware`、`@models` module-alias 组保留（Blog controller/middleware/model 仍在使用）。

## 5. 行为测试

F 阶段先补齐 Auth 行为测试（主计划 Phase F 前置条件："完整模块整理在其行为测试完备后进行"），再执行模块迁移。

`test/auth/auth-behavior.test.js`（新增，21 项）通过 `createAuthModule` 公开入口测试，所有依赖显式注入，不引用遗留 controller/middleware/model 路径，因此迁移前后均有效：

| 行为面 | 覆盖 |
| --- | --- |
| login | 缺少凭据 400；未知用户 401；密码错误 401；成功 200 + 七日 token + `jwt.sign` 参数 |
| middleware | 无 Authorization header 403；Bearer 格式错误 401；token 无效 401；有效 token attach `req.user` 并 next |
| /me | 无 `req.user` 401；用户不存在 404；成功 200 + user shape（`avatar_url` 缺失 coerce 为 null）；仓储异常 500 |
| /me/time-zone | 无 `req.user` 401；空/无效 IANA time_zone 400；用户不存在 404；成功 200 + user shape；仓储异常 500 |

`test/server/http-contract.test.js` 更新为调用路由工厂构造 router，路由形状期望（method、path、auth 位置、handler name、globalAuth）完全不变。

`test/architecture/dependency-boundaries.test.js` 新增第四项测试，断言三个遗留 auth 文件保持删除状态，且 `modules/auth/index.js` 不再引用 `installLegacyAuthBindings` 或遗留路径。

## 6. Blog 决策

Blog 经评估保持现状，不迁移。依据：

- `modules/blog/` 边界已在 B 阶段建立（`articles/infrastructure/articleTempImageCleanup.js` + 公开入口）；
- 遗留 Blog 代码约 1510 行（3 controller、3 model、5 route、2 upload middleware），稳定且无活跃开发压力；
- 无架构门禁告警，无跨模块内部导入债务；
- `test/server/http-contract.test.js` 已覆盖 15 个 Blog 路由的形状契约。

F 阶段对 Blog 的唯一改动是 3 个消费 auth 的路由文件改为工厂函数以接收注入的 `authMiddleware`——这是消除 auth 隐式单例的必要接线变更，不是 Blog 模块重构。Blog controller/model 仍在 `controllers/`、`models/` 原位。

触发 Blog 后续迁移的条件（来自主计划"Blog 仅在持续开发或现有边界明显增加维护成本时迁移"）：

- 开始新的 Blog 功能开发；
- 重复的 `promoteTempContentImages` 逻辑（article/diary controller 各一份）出现需要同步修复的缺陷；
- 架构依赖检查开始告警 Blog 跨模块违规；
- 需要变更上传文件目录布局。

## 7. 一致性与行为保持

本阶段保留以下关键边界：

- JWT secret 仍由 composition 从 `config.authConfig` 注入，controller/middleware 不读 `process.env`；
- 七日 token、`jwt.sign` payload（`{ id, username }`）、`expiresIn: "7d"` 不变；
- 认证状态码与错误体不变（403 缺 header、401 格式错误/无效 token、401 未授权、404 用户不存在、400 time_zone 无效、500 内部错误，中文消息逐字保留）；
- `/me` 与 `/me/time-zone` 的 user 响应 shape 不变（`avatar_url` 缺失 coerce 为 null）；
- `users` 表仍由 Auth 持有；Memory 通过注入的 `userTimeZoneReader` 只读 time zone；
- HTTP 路由 method、path、auth 位置、upload 中间件、controller 绑定不变（http-contract 测试期望未改）；
- 后台任务、Memory 恢复、隐私、RAG 降级、生产模型策略等既有行为不受影响。

## 8. 测试与完成门禁

完成验证：

- `npm run check:architecture`：通过，189 个 JavaScript 文件、380 条本地依赖边、无循环（较 E 阶段 386 条减少 6 条，为删除遗留单例接线）；
- `npm test`：318 项离线测试全部通过（含 21 项 Auth 行为测试、http-contract 契约测试、composition 装配测试、新增 Auth 退役守卫测试）。

已知 flake：`test/rag/http-degradation.test.js` 的 "real embedding HTTP 429" 用例为本地 mock server 计时竞态，与 Auth 无关，重跑可通过。

本阶段没有数据库迁移或外部写入，不需要数据回滚。代码回退边界是 `modules/auth/`（5 文件）、4 个路由工厂、`app/composition/createApplication.js`、`app/composition/httpApplication.js`、`test/auth/auth-behavior.test.js`、`test/server/http-contract.test.js`、`test/architecture/dependency-boundaries.test.js` 及 3 个已删除的遗留文件。

## 9. 完成标准对照

| 主计划完成标准 | F 阶段状态 |
| --- | --- |
| 非测试生产代码不存在跨模块内部路径导入 | 通过（架构检查） |
| 本地依赖图无循环 | 通过 |
| `shared` 不依赖业务模块，业务模块不依赖 `app/composition` | 通过 |
| `process.env` 只在配置加载与启动边界读取 | 通过 |
| SQL、Provider SDK 和 HTTP 不进入纯 domain | Auth SQL 收口在 `userRepository.js` |
| 模块导入无数据库/文件系统/timer 启动副作用 | Auth 模块导入无副作用 |
| Chat、Memory、RAG、LLM 依赖方向和数据 owner 明确 | 前序阶段已达成；Auth owner 明确 |
| 跨模块事务由明确 application use case 拥有 | 前序阶段已达成 |
| Memory source/projection/privacy/User time-zone 由外部注入 | `userTimeZoneReader` 随 Auth 归位，仍由 composition 注入 Memory |
| 不存在重复写入、双 authority 或无期限兼容分支 | 遗留 auth 单例与 delegating 导出已删除 |
| 全部离线测试通过 | 318 项通过 |

## 10. 剩余过渡状态

以下为前序阶段保留、F 阶段未处理的过渡状态（不违反架构门禁）：

| 依赖 | 方向 | 说明 |
| --- | --- | --- |
| `modules/chat/rag/*` → 根 `config` / `logger` / `services/llm/*` / 根 `db` | modules → 外部 | E 阶段冻结，待 `shared/llm` 评估与 config 工厂注入 |
| `services/chat/memoryRuntime.js` → `modules/memory` | services → modules | C 阶段建立的 Memory facade，待 Memory 接线最终整理归位 |
| Blog controller/model 仍在 `controllers/`、`models/` | — | 按计划保持现状，触发条件见第 6 节 |

## 11. 后续跟进：serverLifecycle 归位

F 阶段完成后，按依赖方向修正把 `services/serverLifecycle.js` 迁入 `app/composition/serverLifecycle.js`（2026-07-22）。该模块为进程级生命周期工厂（health 状态、健康端点、生产启动门禁、listen/drain、shutdown 编排、进程信号处理），按边界规则 #1 本属 composition 职责。迁移后其 `services → modules/chat`（读生产模型策略）归正为 `app/composition → modules/chat`，消除最后一条 `services → modules` 方向债。更新 `app.js`、`app/composition/httpApplication.js`、`app/composition/createApplication.js`、`test/server/lifecycle.test.js` 四处引用，行为不变，318 项测试通过。

迁移后 `services/` 收敛为两项计划内过渡状态：`services/llm/`（待多消费者出现评估 `shared/llm`）与 `services/chat/memoryRuntime.js`（待 Memory 接线整理归位）。

## 12. 阶段总结

F 阶段是迁移计划的最后一个执行阶段。Auth 完成完整模块整理，行为测试完备并迁移安全；Blog 按需保持现状并记录触发条件。主计划第 6 节全部完成标准已满足。后续如需推进，输入为第 10 节的过渡状态与 Blog 触发条件，不再有预设的下一阶段。
