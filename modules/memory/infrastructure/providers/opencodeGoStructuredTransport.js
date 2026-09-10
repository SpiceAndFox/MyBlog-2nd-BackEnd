const { createOpenAiStructuredTransport } = require("./openAiStructuredTransport");
const { compileOpencodeGoSchema } = require("./opencodeGoSchemaCompiler");
const { buildOpencodeGoInferenceControls } = require("./opencodeGoRequestPolicy");

// OpenCode Go 网关（OpenAI 兼容）的结构化输出 transport，与标准 openai-json-schema 的差异：
//   1. 上游 guided decoding 拒绝 uniqueItems → 编译时剥离（见 opencodeGoSchemaCompiler）；
//   2. 推理控制参数因模型而异：MiMo 使用 thinking，其他现有模型沿用
//      reasoning_effort。两条 transport 与请求预览共用同一策略。
function createOpencodeGoStructuredTransport({
  model,
  proposerModels = {},
  reasoningEffort,
  thinkingMode,
  extraBody,
  ...options
} = {}) {
  const providerConfig = {
    model,
    proposerModels,
    reasoningEffort,
    thinkingMode,
  };
  return createOpenAiStructuredTransport({
    model,
    proposerModels,
    ...options,
    extraBody: (request) => ({
      ...buildOpencodeGoInferenceControls(providerConfig, request.proposer),
      ...(typeof extraBody === "function" ? extraBody(request) : extraBody),
    }),
    compileSchema: compileOpencodeGoSchema,
  });
}

module.exports = { createOpencodeGoStructuredTransport };
