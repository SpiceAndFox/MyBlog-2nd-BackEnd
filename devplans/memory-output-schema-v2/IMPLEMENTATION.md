# Todo v2 实现记录

日期：2026-09-10。

新建的普通 Todo 任务使用 `todo-v2`，其他 proposer 保持原协议。DeepSeek 仍使用现有 `/beta/chat/completions`、strict tools、模型与 thinking 配置。只改变模型输出协议，不迁移 Memory `2.01` 状态或 Semantic IR。

## 实际行为

- 根结构使用 `results.todos`；noop/unable_to_decide 只有 status，changes 分支才包含非空 changes 数组。
- add、revise/correct、终止动作分别定义必需字段；修改字段使用独立的 keep/set；日期使用 due 内的 mode、整数 offset/day、date 和 anchorSource。
- 所有对象明确 required 与 additionalProperties=false。字段级 anyOf 保持互斥，避免枚举独立可选字段的全部组合。
- target/source 枚举与输入 artifact 绑定。无可修改目标时不提供修改/终止分支；无消息时不提供需要消息锚点的日期；无来源时只提供 noop/unable_to_decide。
- API 不支持的字符长度、数组数量和唯一性约束转成说明，并逐项记录 diagnostics；本地完整 schema 仍强制执行。真实日期、锚点属于 sources 等关系继续由语义层验证。
- tool arguments、普通 content 以及 OpenAI JSON 输出都执行完整 wire 校验。Todo v2 的自定义 transport 也不能直接返回内部 Semantic IR 绕过校验。
- 仅对完整且无多余字段的 `{"results":{"todos":{"status":"changes","changes":[]}}}` 保留 EMPTY_CHANGES_TO_NOOP。记录 rawSchemaValid=false 和 normalizations；不自动补缺失字段，不强制转换日期类型。
- 不匹配的联合类型在能确定 status/action/mode 时返回具体字段错误；修复消息使用 v2 路径和结构。

## 版本与恢复

`task_payload.task.outputProtocol` 是持久化的协议选择，`todo-v2` 代表固定的 wire/prompt/compiler 组合。相容性变化必须使用新 token，不能修改旧组合再继续重试旧任务。缺少字段按 `legacy-v1` 处理，不根据模型返回形状猜测版本。

新建 `modules/memory/prompts/todo-proposer-v2.md`，保留合法 noop 和常规 changes 示例。已有 prompt 文件及其受保护示例没有修改。

重试、上下文扩展、请求预览和 shadow replay 都按任务版本选择。成功/无法判断结果的 `stage_payload.providerProtocol`，以及拒绝候选记录中的 `protocol`，包含协议、完整本地 schema hash/字节数、实际发送 schema hash/字节数、输出通道、原始结构通过状态和归一化记录。mock transport 没有实际 HTTP schema 时，wire hash/字节数为空。

普通重试的同一绑定使用同一 hash；上下文扩展改变来源枚举后，协议不变而 hash 随绑定更新。预览使用当前 provider 配置重建请求；记录的 hash 可用于比较，不能当成历史完整 HTTP 快照。shadow replay 同样记录当次 protocol。

输入预算纳入 tools 和 response_format schema。UTF-8 字节估计不等于实际 token 数；实际 input/output/cache token 继续来自 API usage。新增协议、通道、归一化和 schema 字节数指标。

## 体积测量

实际生产 builder 与 compiler，同一组 10 个可修改目标、20 条消息、10 条 Memory 来源，使用 `.env.example` 的 Todo 写入限制：

| 实际发送的 DeepSeek parameters | UTF-8 字节数 |
| ------------------------------ | -----------: |
| v1，已有 28 分支优化           |       45,453 |
| Todo v2，不使用引用            |       10,627 |

该样本缩小 **76.6%**。完整本地 v2 schema 为 10,265 字节；发送版本包含约束说明，二者不应混用。该数字只衡量 schema，不代表整个请求或账单节省比例。显式 keep/set 会增加部分修改输出的长度。

## 验证

- `npm.cmd run test:offline`：架构检查及 491 项测试通过。
- 新专项测试覆盖 124 种合法动作/日期/字段组合的完整往返、错误字段/枚举/日期类型、Unicode 上限、来源数量与唯一性、空 changes 的窄归一化、不同输出通道、输入预算和精确错误路径。
- pipeline 测试覆盖新任务协议持久化、schema 修复、归一化审计、旧任务恢复、unable_to_decide 的上下文扩展与绑定 hash 更新。
- `node --use-env-proxy scripts/probe-memory-v2-provider.js --todo-v2-only`：使用当前 DeepSeek 配置和新完整 prompt，以合成内容请求精确输出。4/4 通过，均返回 tool_arguments；没有读取业务数据或写入数据库。

| API 探测     | prompt tokens | completion tokens |
| ------------ | ------------: | ----------------: |
| noop         |         4,369 |                62 |
| add-relative |         4,418 |               132 |
| revise-keep  |         4,424 |               194 |
| complete     |         4,390 |                94 |

请求模型为 `deepseek-flash`，响应 model 为 `deepseek-flash`，thinking=enabled。这些探测验证协议可以被当前 API 接受并返回预期分支；没有做真实业务样本的成对质量评估，不能由这 4 次调用推断首次合法率、事实提取质量、延迟或费用的统计收益。

## 保留边界

`$ref`/`$defs`/`$def` 未接入，也未声称完成它们的 API 能力测试。其他 proposer 的可选字段展开暂不改动。代码已修改，未执行服务重启、发布或数据库迁移；运行中的进程仍需按现有方式加载新代码。
