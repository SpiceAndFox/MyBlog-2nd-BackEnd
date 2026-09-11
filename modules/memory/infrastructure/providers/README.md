# Memory providers

本目录按职责组织。要修改网关/模型能力，从 `gateways/` 开始；要修改用户选择的网关、模型和推理强度，使用环境配置。

| 位置 | 职责 |
| --- | --- |
| 根目录 | `memoryProviderAdapter` 将 proposer 调用协调为统一结果；`structuredTransportFactory` 选择协议实现；Profile 协调及业务拒绝处理 |
| `gateways/<gateway>/profile.js` | 网关默认请求规则和模型注册 |
| `gateways/<gateway>/models/*.js` | 该网关内模型的专属规则；无差异的模型不需要单独文件 |
| `policies/` | 规则校验、合并、有效设置解析及参数编码 |
| `providerRequestContext.js` | 从任务提取通用 scope/taskId 元数据；不包含网关编码，也不进入模型输入 |
| `transport/` | HTTP 请求构建、响应解析、传输限制，以及发往网关前的 schema 转换 |
| `output/` | Memory 输出 schema、动态绑定、wire 编解码、本地校验与协议元数据 |
| `diagnostics/` | 接入探测和请求预览，复用正式请求/输出逻辑 |

传输层依赖输出契约和配置；输出层不依赖 HTTP 或网关配置。诊断工具复用正式实现，不复制 provider 判断。DeepSeek 编译器属于传输层，因为它转换的是发送格式，本地仍使用输出层的完整契约校验。

例如 `opencodeGo/profile.js` 声明默认使用 reasoning_effort，`opencodeGo/models/mimoV25.js` 声明该网关的 MiMo 模型改用 thinking。`policies/` 解析最终规则，`transport/` 据此构建和发送请求。同名模型在其他网关下不自动使用该例外。

OpenCode Go 的会话头由 profile 声明 `headerPolicy`，在 `transport/providerHeaders.js` 中根据通用请求上下文生成。业务层不生成网关 session ID，也不读取或传递 OpenCode 专属头；发送和诊断预览复用同一构建结果。

`gateways/registry.js` 显式注册网关并检查重复声明。稳定规则放入代码，JSON 环境覆盖仅用于临时接入实验。DeepSeek strict tools 仍是独立协议 adapter，不使用通用网关规则。

`../../config/` 保留环境解析与 proposer 设置继承；`../../configuration.js` 组合配置解析和 provider 初始化校验，避免配置解析反向依赖 infrastructure。完整配置说明见 [Provider adapters](../../../../devplans/memory-control-v2/provider-adapters.md)。
