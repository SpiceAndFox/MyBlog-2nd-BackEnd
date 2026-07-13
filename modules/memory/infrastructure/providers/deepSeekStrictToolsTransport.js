const { compileDeepSeekSchema } = require("./deepSeekSchemaCompiler");

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function createDeepSeekStrictToolsTransport({ baseUrl, apiKey, model, timeoutMs, fetchImpl = globalThis.fetch, extraHeaders = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!String(apiKey || "").trim()) throw new Error("Memory Provider apiKey is required");
  if (!String(model || "").trim()) throw new Error("Memory Provider model is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Memory Provider timeoutMs must be a positive integer");
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (normalizedBaseUrl.hostname === "api.deepseek.com" && !normalizedBaseUrl.pathname.endsWith("/beta/")) {
    throw new Error("DeepSeek strict tools require CHAT_MEMORY_V2_PROVIDER_BASE_URL=https://api.deepseek.com/beta");
  }
  const endpoint = new URL("chat/completions", normalizedBaseUrl).toString();

  return async function invokeStructured({ systemPrompt, userPayload, responseSchema }) {
    const functionName = responseSchema?.name;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(functionName || ""))) throw new Error("Structured output schema name is not a valid tool name");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Memory Provider request timeout")), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
          tools: [{
            type: "function",
            function: {
              name: functionName,
              description: "Return the schema-constrained Memory proposer result.",
              strict: true,
              parameters: compileDeepSeekSchema(responseSchema.schema),
            },
          }],
          tool_choice: { type: "function", function: { name: functionName } },
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(data?.error?.message || `Memory Provider HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === "content_filter") {
        return { safetyBlocked: true, finishReason: choice.finish_reason, model: data?.model, usage: data?.usage };
      }
      const toolCall = choice?.message?.tool_calls?.find((entry) => entry?.function?.name === functionName);
      let output = null;
      const argumentsValue = toolCall?.function?.arguments;
      if (typeof argumentsValue === "string") {
        try { output = JSON.parse(argumentsValue); }
        catch { output = null; }
      } else if (argumentsValue && typeof argumentsValue === "object") {
        output = argumentsValue;
      }
      return { output, finishReason: choice?.finish_reason, model: data?.model ?? model, usage: data?.usage ?? null };
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = { createDeepSeekStrictToolsTransport };
