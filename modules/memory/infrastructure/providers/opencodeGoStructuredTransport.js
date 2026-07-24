const { createOpenAiStructuredTransport } = require("./openAiStructuredTransport");
const { compileOpencodeGoSchema } = require("./opencodeGoSchemaCompiler");
const { resolveMemoryProviderReasoningEffort } = require("../../config/loadProviderConfig");

// OpenCode Go 网关（OpenAI 兼容）的结构化输出 transport，与标准 openai-json-schema 的差异：
//   1. 上游 guided decoding 拒绝 uniqueItems → 编译时剥离（见 opencodeGoSchemaCompiler）；
//   2. 网关上 hy3 等模型默认开启思考且推理 token 计入 max_tokens，会耗尽输出预算
//      （finish_reason=length、content 为空）→ 每个请求显式携带 reasoning_effort。
// reasoning_effort 所见即所得：proposer 覆盖（CHAT_MEMORY_V2_PROPOSER_MODELS_JSON）
// → 全局默认（CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT），不做按模型的隐式推断。
function createOpencodeGoStructuredTransport({ model, proposerModels = {}, reasoningEffort = "none", extraBody, ...options } = {}) {
  const providerConfig = { model, proposerModels, reasoningEffort };
  return createOpenAiStructuredTransport({
    model,
    proposerModels,
    ...options,
    extraBody: (request) => ({
      reasoning_effort: resolveMemoryProviderReasoningEffort(providerConfig, request.proposer),
      ...(typeof extraBody === "function" ? extraBody(request) : extraBody),
    }),
    compileSchema: compileOpencodeGoSchema,
  });
}

module.exports = { createOpencodeGoStructuredTransport };
