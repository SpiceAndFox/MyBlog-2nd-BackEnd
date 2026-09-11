const { createOpenAiStructuredTransport } = require("./openAiStructuredTransport");
const { buildStructuredHttpRequest } = require("./structuredHttpRequest");
const { parseJsonObjectContent } = require("./structuredJsonContent");
const { validateLocalJsonSchema } = require("../output/localJsonSchemaValidator");

function createOpenAiCompatibleTransport(config) {
  const jsonObject = config.adapter === "openai-compatible-json-object";
  return createOpenAiStructuredTransport({
    ...config,
    // Both preview and transport consume the same complete configuration and
    // request builder, including per-proposer models and repair policy.
    httpRequestBuilder: (_transportConfig, request) => buildStructuredHttpRequest(config, request),
    ...(jsonObject ? {
      parseContent: parseJsonObjectContent,
      validateOutputSchema: validateLocalJsonSchema,
    } : {}),
  });
}

module.exports = { createOpenAiCompatibleTransport };
