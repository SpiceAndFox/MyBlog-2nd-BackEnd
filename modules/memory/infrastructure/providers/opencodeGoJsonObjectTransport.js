const { createOpenAiStructuredTransport } = require("./openAiStructuredTransport");
const { validateLocalJsonSchema } = require("./localJsonSchemaValidator");
const { buildOpencodeGoInferenceControls } = require("./opencodeGoRequestPolicy");
const { buildOpenAiJsonObjectHttpRequest } = require("./structuredHttpRequest");
const { parseJsonObjectContent } = require("./structuredJsonContent");

// OpenCode Go JSON mode deliberately avoids the gateway's json_schema guided
// decoding. The bound schema is rendered into the trusted system prompt and
// validated locally before the existing Semantic validator enforces domain rules.
function createOpencodeGoJsonObjectTransport({
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
    httpRequestBuilder: buildOpenAiJsonObjectHttpRequest,
    parseContent: parseJsonObjectContent,
    validateOutputSchema: validateLocalJsonSchema,
    extraBody: (request) => ({
      ...buildOpencodeGoInferenceControls(providerConfig, request.proposer),
      ...(typeof extraBody === "function" ? extraBody(request) : extraBody),
    }),
  });
}

module.exports = { createOpencodeGoJsonObjectTransport };
