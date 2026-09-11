# Memory provider adapters

Memory 使用独立 provider 配置。Adapter 负责协议和输出通道，profile 负责网关约定，model rule 负责该网关内特定模型的差异。在线写入、rebuild、Librarian、probe、shadow replay 和 GUI 预览使用同一请求构建入口。

## 配置

| 配置项 | 用途 |
| --- | --- |
| `CHAT_MEMORY_V2_PROVIDER_ADAPTER` | `openai-compatible-json-schema`、`openai-compatible-json-object` 或 `deepseek-strict-tools` |
| `CHAT_MEMORY_V2_PROVIDER_PROFILE` | 兼容 adapter 的 `generic`（默认）、`opencode-go`、`openrouter` 或 `bai`；不根据域名推断 |
| `CHAT_MEMORY_V2_PROVIDER_BASE_URL` | 网关 API 基础地址；兼容 adapter 也接受完整 `/chat/completions` 地址，不重复追加路径 |
| `CHAT_MEMORY_V2_PROPOSER_MODELS_JSON` | 保留模型字符串格式；对象格式支持 `model`、`reasoningEffort`、`thinkingMode` |

API key、默认模型、超时及输入/输出预算保持原配置。模型 ID 大小写敏感，不去除命名空间、版本或 `:free` 等后缀。自定义代理地址可以显式选择原网关 profile。

稳定的网关/模型能力由代码声明、版本管理和测试维护；`.env` 只需选择网关、模型及运行设置。常规优先级为通用默认值 → 网关 `profile.js` 的 defaults → 模型文件的 policy。Proposer 只能选择模型和设置值，不能修改能力声明。

Profile 三个专家未单独配置时，继承 `profileRelationshipProposer` 的整条覆盖；专家一旦单独配置，就使用自身覆盖，未填写字段回到全局配置。这保留了已有继承语义。

兼容 adapter 的 proposer 可将 `reasoningEffort` 或 `thinkingMode` 设为 JSON `null`，明确清除对应全局设置。例如普通模型可配置 `{"model":"plain-model","reasoningEffort":null,"thinkingMode":null}` 并为该模型声明 `reasoningEncoding: "none"`。清除控制字段表示不发送该参数，不等于请求模型关闭思考；所选编码要求的必填设置仍会校验。

## 规则字段

| 字段 | 值及默认行为 |
| --- | --- |
| `reasoningEncoding` | `none`（默认）、`reasoning-effort`、`thinking`、`openrouter` |
| `reasoningEfforts` | 允许的档位数组，默认 `max/xhigh/high/medium/low/minimal/none`；空数组表示不支持选择 effort |
| `thinkingModes` | 允许的模式数组，默认 `enabled/disabled`；仅 `enabled` 表示思考不可关闭 |
| `schemaPolicy` | `preserve`（默认）或 `strip-unique-items` |
| `outputModes` | 允许的模式数组，默认 `json_schema/json_object` |
| `outputTokenField` | `max_tokens`（默认）或 `max_completion_tokens` |
| `repairRole` | `assistant`（默认）或 `user-diagnostic`；后者把修复候选作为 user 中的引用诊断文本，适用于不接受缺失思考历史的 assistant 消息的模型 |
| `headerPolicy` | `none`（默认）或 `opencode-session`；后者发送本系统 User-Agent 和稳定会话标识，不接受任意请求头 JSON |

`none` 编码不发送推理参数；如配置了推理设置，会报错提示声明编码。`reasoning-effort` 只消费 effort，`thinking` 只消费 thinkingMode；允许全局同时提供两者，以支持混合模型。未消费的设置不会发往 API。前者通过 effort=`none` 关闭推理，后者通过 thinkingMode=`disabled` 关闭。

`openrouter` 编码发送 `reasoning` 对象：thinkingMode=`disabled` 时发送 `{enabled:false}`；否则优先发送 `{effort:...}`，仅配置 enabled 时发送 `{enabled:true}`；两项都空则省略。enabled 与 effort=`none` 冲突，禁止静默转换。模型专属限制应通过规则声明。

OpenRouter 编码依据[官方推理参数文档](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。网关协议默认值不是对每个模型或动态上游的能力保证；配置之后应执行 probe。当前不自动获取或缓存远端模型列表，也不根据一次失败修改规则。

`opencode-go` 保留默认 `reasoning-effort` 和 `strip-unique-items`；`mimo-v2.5`、`mimo-v2.5-pro` 精确匹配后使用 `thinking`。GLM-5.3-Flash 精确匹配后只接受 `low/high/max`，当前集成启用已验证的 `json_object`。这些规则属于 OpenCode 网关，不会自动用于其他网关。

依据 [OpenCode Go 客户端要求](https://opencode.ai/docs/go/#where-can-i-use-it)，该 profile 默认使用 `headerPolicy: "opencode-session"`。正式请求发送 `User-Agent: BlogBackEnd-memory/1.0` 和 `x-opencode-session`，不是冒用 OpenCode 客户端名称。旧 adapter 别名也会继承该策略；B.AI、generic、OpenRouter 及独立 DeepSeek adapter 不自动添加这些头。

会话标识按 memory 已有的 `(userId, presetId)` scope 保持稳定，因此正常写入、各 proposer、Profile 专家、重试、重建和 Librarian 在同一 scope 内复用标识，不随 taskId 或 proposer 变化。使用 API key 对带版本的 scope 元组做 HMAC-SHA256，不将用户/预设标识直接发送到网关；更换 key 时会话标识随之变化。缺少 scope 的直接调用优先使用 taskId；完全没有业务上下文的合成 probe 使用进程内统一的诊断会话，进程重启后更新。

隔离边界：`providerRequestContext.js` 只从现有任务提取通用 scope/taskId 元数据，adapter 和诊断预览复用它；元数据不进入 LLM 输入或 memory schema。`transport/providerHeaders.js` 才解释网关策略并生成头；业务 application、domain、数据库和 Chat provider 无需知道 OpenCode 的头名称或编码。统一请求构建器同时服务发送和 GUI 预览，预览显示生成的网关头且不含 Authorization。生成的网关头会按大小写不敏感规则替换旧的同名 `extraHeaders`。

## 接入示例

OpenCode Go 的 GLM-5.3-Flash：

```dotenv
CHAT_MEMORY_V2_PROVIDER_ADAPTER=openai-compatible-json-object
CHAT_MEMORY_V2_PROVIDER_PROFILE=opencode-go
CHAT_MEMORY_V2_PROVIDER_BASE_URL=https://opencode.ai/zen/go/v1
CHAT_MEMORY_V2_PROVIDER_MODEL=glm-5.3-flash
CHAT_MEMORY_V2_PROVIDER_THINKING_MODE=
CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT=low
CHAT_MEMORY_V2_PROPOSER_MODELS_JSON={}
```

将 `CHAT_MEMORY_V2_PROVIDER_API_KEY` 设置为 OpenCode Go 专用密钥，并保留必填超时和 token 预算。`OPENCODE_GO_API_KEY` 不会自动覆盖 memory 专用 key。请求头由 profile 自动生成，不需要新增环境变量；切换时清除旧的高级 JSON 规则覆盖。

B.AI 的 GLM-5.3-Flash 使用以下配置；另将 `CHAT_MEMORY_V2_PROVIDER_API_KEY` 设置为 B.AI 专用密钥，不能沿用旧网关密钥：

```dotenv
CHAT_MEMORY_V2_PROVIDER_ADAPTER=openai-compatible-json-object
CHAT_MEMORY_V2_PROVIDER_PROFILE=bai
CHAT_MEMORY_V2_PROVIDER_BASE_URL=https://api.b.ai/v1
CHAT_MEMORY_V2_PROVIDER_MODEL=glm-5.3-flash
CHAT_MEMORY_V2_PROVIDER_THINKING_MODE=
CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT=low
CHAT_MEMORY_V2_PROPOSER_MODELS_JSON={}
```

保留必填的超时和输入/输出预算配置。`BAI_API_KEY` 不是运行时自动读取的别名，实际运行使用 `CHAT_MEMORY_V2_PROVIDER_API_KEY`。

依据 [B.AI 模型文档](https://docs.b.ai/llmservice/models/glm-5-3-flash/)，该模型始终开启思考，`reasoning_effort` 支持 `low/high/max`，上游默认 `max`。内置规则要求显式选择 effort，避免意外使用默认高预算。`THINKING_MODE` 留空表示不发送该字段，不是关闭思考；与其他 reasoning-effort 模型一致，该编码只消费 effort，混合配置中未消费的 thinkingMode 会被忽略。

当前内置集成仅启用 `json_object`，由现有请求构建器注入完整 schema，并在本地验证输出。[B.AI API 文档](https://docs.b.ai/llmservice/api/) 列出 JSON Schema 接口参数，但不保证 GLM-5.3-Flash 支持项目的完整严格 schema；只有验证后才扩展模型的 `outputModes`，不自动降级。修复请求先使用默认 assistant 角色；若网关实测要求思考历史，可使用已有 `repairRole: "user-diagnostic"` 声明。

`bai` 的默认规则为空，GLM 能力只精确匹配 `glm-5.3-flash`，不会自动应用于其他 B.AI 模型或其他网关。普通未声明模型可使用 `generic` 并留空推理设置，再通过 probe 验证。切换时检查所有 proposer 覆盖和高级 JSON 规则，避免沿用旧网关模型或遮蔽内置规则。

## 新增网关或模型规则

在 `modules/memory/infrastructure/providers/gateways/<gateway>/profile.js` 声明网关默认规则，在 `models/<model>.js` 声明该网关内模型的差异。模型文件只描述能力，不包含 HTTP、环境变量读取或 proposer 业务逻辑。没有特殊行为的模型继承网关默认规则，无需创建空文件。

例如以下虚构模型文件仅说明声明格式，不代表实际模型能力：

```js
// gateways/example/models/modelB.js
module.exports = {
  id: "vendor/model-b",
  policy: {
    reasoningEncoding: "thinking",
    thinkingModes: ["enabled"],
    outputTokenField: "max_completion_tokens",
    repairRole: "user-diagnostic",
  },
};
```

所属网关的 `profile.js` 显式导入并注册模型：

```js
const modelB = require("./models/modelB");
module.exports = {
  id: "example",
  defaults: { reasoningEncoding: "reasoning-effort" },
  models: [modelB],
};
```

新增网关还需在 `gateways/registry.js` 显式导入该 profile。注册时拒绝重复网关 ID、同一网关内重复模型 ID、非法字段及空 ID；不同网关可使用相同模型 ID。注册表持有冻结的声明副本，防止修改源对象改变运行规则。特殊行为相同的模型可以复用公共声明，但不根据同名模型自动跨网关继承规则。

## 高级：临时 JSON 规则覆盖

为接入实验保留以下可选环境变量，默认都为 `{}`，不再列入 `.env.example` 的常规配置：

| 配置项 | 用途 |
| --- | --- |
| `CHAT_MEMORY_V2_PROVIDER_POLICY_JSON` | 当前网关的默认规则覆盖 |
| `CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON` | 当前网关内按完整模型 ID 索引的规则覆盖 |

完整优先级：通用默认值 → 网关 defaults → `POLICY_JSON` → 网关内模型文件 → `MODEL_RULES_JSON`。JSON 中的数组整体替换。实验稳定后应将规则写入代码并清除覆盖，避免环境变量长期遮蔽代码中的规则；当前仍配置了这些变量的环境继续有效。

例如用虚构模型验证两种编码共存：

```dotenv
CHAT_MEMORY_V2_PROVIDER_MODEL=model-a
CHAT_MEMORY_V2_PROVIDER_MODEL_RULES_JSON={"model-a":{"reasoningEncoding":"reasoning-effort","reasoningEfforts":["low","high"]},"vendor/model-b":{"reasoningEncoding":"thinking","thinkingModes":["enabled"],"outputTokenField":"max_completion_tokens","repairRole":"user-diagnostic"}}
CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT=low
CHAT_MEMORY_V2_PROVIDER_THINKING_MODE=enabled
CHAT_MEMORY_V2_PROPOSER_MODELS_JSON={"episodeProposer":"vendor/model-b","profileRelationshipProposer":{"model":"model-a","reasoningEffort":"high"}}
```

## 兼容和验证

旧 ID 仍在配置边界接受，但内部及新报告记录规范名称：

- `opencode-go-json-schema` → `openai-compatible-json-schema` + 默认 `opencode-go` profile。
- `opencode-go-json-object` → `openai-compatible-json-object` + 默认 `opencode-go` profile。
- `openai-json-schema` → `openai-compatible-json-schema` + 默认 `generic` profile；保留原先忽略全局推理变量的行为。使用推理策略时应迁移到新名称。

建议同步更新 adapter 和 profile。保留 `.env` 中的凭据，不需要数据库迁移。配置在进程启动时加载；修改文件不会热切换正在运行的 rebuild。

`deepseek-strict-tools` 保留独立的 schema 编译、工具调用、思考和修复逻辑；通用 profile/policy/modelRules 不应用于该 adapter。仍要求原有显式思考配置，不支持 proposer 单独覆盖 thinkingMode。

公开配置入口通过 `modules/memory/configuration.js` 组合两个步骤：`config/` 只解析运行设置和 JSON 数据；provider 层再校验网关/模型规则、默认模型和全部 proposer 的最终设置。应用启动、管理脚本和 GUI 使用相同入口；transport 工厂也校验直接注入的配置，在发送请求前拒绝无效组合。

发现非法字段、枚举、推理设置或不支持的输出模式立即报错。不会自动从 JSON Schema 降级到 JSON Object。schema 转换只影响发往网关的副本，本地始终按原始 schema 校验；prompt 示例和 memory 语义契约保持独立。

推荐验证顺序：离线测试 → `npm run probe:memory-v2-provider` → `npm run smoke:memory-v2-provider` → 按需运行 synthetic integrity/shadow replay → rebuild。在线命令会调用配置的 API；rebuild 会写入所选 scope。`eval:memory-v2-integrity` 已支持配置的任意 adapter，不再限定 DeepSeek。

## 扩展位置

- `modules/memory/infrastructure/providers/gateways/`：每个网关一个目录，`profile.js` 声明默认规则、`models/` 保存模型差异。
- `modules/memory/infrastructure/providers/policies/`：规则字段校验、规则合并、有效设置校验及推理参数编码。
- `modules/memory/config/loadProviderConfig.js`：环境解析、proposer 继承；不依赖 infrastructure。
- `modules/memory/configuration.js`：公开配置加载的组合入口，连接解析与 provider 初始化校验。
- `modules/memory/infrastructure/providers/transport/structuredHttpRequest.js`：唯一完整请求构建入口，供传输和预览复用。
- `modules/memory/infrastructure/providers/transport/schemaPolicies.js`：schema 副本转换；不能修改原契约或字面量数据。

没有任意脚本加载、任意请求体 JSON 合并或 Chat 模块内部依赖。若新增非 Chat Completions 协议，再添加 adapter。新增已支持编码的网关或模型优先使用声明，不在业务流程中增加 provider 判断。
