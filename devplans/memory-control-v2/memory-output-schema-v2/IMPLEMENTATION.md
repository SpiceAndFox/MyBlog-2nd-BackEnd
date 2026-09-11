# Todo 输出协议实现记录

日期：2026-09-10。

所有普通 Todo 任务统一使用正式 `results.todos` 输出契约，其他 proposer 保持各自的输出结构。DeepSeek 仍使用现有 `/beta/chat/completions`、strict tools、模型与 thinking 配置。不迁移 Memory `2.01` 状态或 Semantic IR。

## 实际行为

- 根结构使用 `results.todos`；noop/unable_to_decide 只有 status，changes 分支才包含非空 changes 数组。
- add、revise/correct、终止动作分别定义必需字段；修改字段使用独立的 keep/set；日期使用 due 内的 mode、整数 offset/day、date 和 anchorSource。
- 所有对象明确 required 与 additionalProperties=false。字段级 anyOf 保持互斥，避免枚举独立可选字段的全部组合。
- target/source 枚举与输入 artifact 绑定。无可修改目标时不提供修改/终止分支；无消息时不提供需要消息锚点的日期；无来源时只提供 noop/unable_to_decide。
- API 不支持的字符长度、数组数量和唯一性约束转成说明，并逐项记录 diagnostics；本地完整 schema 仍强制执行。真实日期、锚点属于 sources 等关系继续由语义层验证。
- tool arguments、普通 content 以及 OpenAI JSON 输出都执行完整 wire 校验。Todo 的自定义 transport 也不能直接返回内部 Semantic IR 绕过校验。
- 仅对完整且无多余字段的 `{"results":{"todos":{"status":"changes","changes":[]}}}` 保留 EMPTY_CHANGES_TO_NOOP。记录 rawSchemaValid=false 和 normalizations；不自动补缺失字段，不强制转换日期类型。
- 不匹配的联合类型在能确定 status/action/mode 时返回具体字段错误；修复消息使用 `results.todos` 路径和结构。

## 正式入口与恢复

不再保存或读取 Todo 的协议选择标记。新任务、恢复任务、重试、上下文扩展、请求预览和 shadow replay 均使用当前正式实现；历史任务即使保存过协议元数据，也不据此切换实现。

已验证的提示词已晋升为 `modules/memory/prompts/todo-proposer.md`，原正式提示词原样移至 `archive/memory-v2-prompts/2026-9-10/todo-proposer.md`。新旧提示词的 noop 和常规 changes JSON 示例均完整保留。

代码使用正式命名 `todoWireProtocol.js`、`deepSeekTodoSchemaCompiler.js` 和 `usesTodoWireProtocol`；schema/tool 名为 `memory_todo`，探测参数为 `--todo-only`，不保留实验参数别名。旧 Todo flat schema、专用展开编译器和转换分支已移除，正式 wire 直接与 Semantic IR 相互转换。

`loadProposerPrompt("todoProposer")` 只读取正式提示词，`buildOutputSchema("todoProposer")` 只生成正式 schema。archive 是纯历史存档，不是运行时或测试依赖，可以独立移除。此代码更新不重写数据库中的已有任务、拒绝记录或 Memory 状态。

当前处于开发阶段，不支持旧 Todo 修复状态的跨契约恢复。请求构建只接受 `plan.expectedShape.results.todos` 为对象的 Todo 修复反馈；这份 expectedShape 由程序生成，不由模型输出。缺失或不符合时，在调用模型前返回 `MEMORY_REPAIR_CONTEXT_INVALID` 输入错误，现有任务错误策略将其停止；请求预览同样明确报错。需要按开发流程重建这类任务，不自动转换、丢弃反馈后重试或重置失败计数。原任务快照与拒绝历史保留，不修改 Memory 状态。这里没有新增版本选择、兼容指纹或迁移机制。

该检查针对反馈所记录的预期结构，不要求待修复候选已经合法。正式反馈下的错误根结构、缺少字段、候选缺失或截断仍按原有修复策略处理；已经持久化的内部 Semantic 结果沿用原有编译、校验和提交流程。

成功/无法判断结果的 `stage_payload.providerProtocol`，以及拒绝候选记录中的 `protocol`，继续记录当前格式、完整本地 schema hash/字节数、实际发送 schema hash/字节数、输出通道、原始结构通过状态和归一化记录。`outputProtocol` 在这些诊断中只是 `todo`、`flat` 或 `semantic` 标签，不参与选择实现。mock transport 没有实际 HTTP schema 时，wire hash/字节数为空。

普通重试的同一绑定使用同一 hash；上下文扩展改变来源枚举后，协议不变而 hash 随绑定更新。预览使用当前 provider 配置重建请求；记录的 hash 可用于比较，不能当成历史完整 HTTP 快照。shadow replay 同样记录当次 protocol。

输入预算纳入 tools 和 response_format schema。UTF-8 字节估计不等于实际 token 数；实际 input/output/cache token 继续来自 API usage。新增协议、通道、归一化和 schema 字节数指标。

## 当前体积测量

尚未绑定具体任务时，UTF-8 序列化字节数如下（不等于 token 数）：

| Proposer | 本地 schema | DeepSeek parameters | changes 顶层对象分支 |
| -------- | ----------: | ------------------: | ------------------: |
| Current State | 1,040 | 3,317 | 4 |
| Agreement | 1,089 | 3,435 | 4 |
| Episode | 1,179 | 3,552 | 4 |
| User Profile | 1,059 | 3,357 | 4 |
| Assistant Profile | 1,074 | 3,387 | 4 |
| Relationship | 1,062 | 3,363 | 4 |
| World Fact | 1,056 | 3,351 | 4 |
| Todo | 6,621 | 7,425 | 3 个动作组 |

普通 flat proposer 的 change 只有 `target`、`text` 两个可选字段，4 分支体积可控，暂不为结构一致性全面改写；以后按字段增长和实际校验失败情况决定是否改成动作判别结构。Todo 的字段级联合保留为嵌套结构，不做笛卡尔积展开，3 个动作组不等于全部字段组合数。新增离线回归约束 flat schema 的可选字段、4 分支和 4,000 字节预算，防止无意引入同类膨胀。

维护 proposer 使用独立结构：compaction 为 972 → 1,343 字节，Librarian 为 6,074 → 9,011 字节；同样没有本次 Todo 原先的数量级问题，不机械套用 Todo 契约。

实际生产 builder 与 compiler，同一组 10 个可修改目标、20 条消息、10 条 Memory 来源，使用 `.env.example` 的 Todo 写入限制：

| 实际发送的 DeepSeek parameters | UTF-8 字节数 |
| ------------------------------ | -----------: |
| 历史 Todo，已有 28 分支优化    |       45,453 |
| 正式 Todo，不使用引用          |       10,627 |

与历史测量相比，该样本缩小 **76.6%**。完整本地 schema 为 10,265 字节；发送版本包含约束说明，二者不应混用。该数字只衡量 schema，不代表整个请求或账单节省比例。显式 keep/set 会增加部分修改输出的长度。

## 验证

正式化清理与恢复边界补充回归：`npm.cmd run test:offline` 的架构检查及 529 项测试通过。另与晋升前版本核对：归档提示词逐字节一致，正式提示词仅移除输出契约标题中的实验版本字样，JSON 示例完全一致；5 种未绑定/绑定场景下，本地 schema 结构保持一致。schema/tool 名已更改，因此包含该名称的 hash 会改变，不声称与历史请求 hash 一致。新增测试要求提示词只能从正式目录读取。

- 初次接入的历史记录：`npm.cmd run test:offline` 架构检查及 491 项测试通过；本轮以以上 529 项回归结果为准。
- 新专项测试覆盖 124 种合法动作/日期/字段组合的完整往返、错误字段/枚举/日期类型、Unicode 上限、来源数量与唯一性、空 changes 的窄归一化、不同输出通道、输入预算和精确错误路径。
- pipeline 测试覆盖无版本选择的新任务、schema 修复、归一化审计、恢复任务统一使用正式实现、unable_to_decide 的上下文扩展与绑定 hash 更新。
- HTTP 请求构建测试覆盖启用/关闭 thinking 时的正式 tool 名与绑定 schema；预览、修复和合成 preflight 的离线测试通过。
- 补充覆盖不兼容修复反馈在模型调用前停止且不改 Memory/历史/重试计数，以及当前错误根结构、缺字段、候选缺失/截断仍可修复；探测 CLI 参数解析使用离线测试验证，未知参数不会触发 API 探测。

以下为最初接入时的历史 API 探测，不是此次重命名后的重新调用：Todo 合成内容精确输出 4/4 通过，均返回 tool_arguments，没有读取业务数据或写入数据库。现在的对应命令为 `node --use-env-proxy scripts/probe-memory-v2-provider.js --todo-only`；本轮未调用真实 API。

| API 探测     | prompt tokens | completion tokens |
| ------------ | ------------: | ----------------: |
| noop         |         4,369 |                62 |
| add-relative |         4,418 |               132 |
| revise-keep  |         4,424 |               194 |
| complete     |         4,390 |                94 |

请求模型为 `deepseek-flash`，响应 model 为 `deepseek-flash`，thinking=enabled。这些探测验证协议可以被当前 API 接受并返回预期分支；没有做真实业务样本的成对质量评估，不能由这 4 次调用推断首次合法率、事实提取质量、延迟或费用的统计收益。

## 保留边界

`$ref`/`$defs`/`$def` 未接入，也未声称完成它们的 API 能力测试。其他 proposer 的可选字段展开暂不改动。代码已修改，未执行服务重启、发布或数据库迁移；运行中的进程仍需按现有方式加载新代码。
