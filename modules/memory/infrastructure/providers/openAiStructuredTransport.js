function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function createOpenAiStructuredTransport({ baseUrl, apiKey, model, timeoutMs, fetchImpl = globalThis.fetch, extraHeaders = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!String(apiKey || "").trim()) throw new Error("Memory Provider apiKey is required");
  if (!String(model || "").trim()) throw new Error("Memory Provider model is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Memory Provider timeoutMs must be a positive integer");
  const endpoint = new URL("chat/completions", normalizeBaseUrl(baseUrl)).toString();

  return async function invokeStructured({ systemPrompt, userPayload, responseSchema }) {
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
          response_format: { type: "json_schema", json_schema: responseSchema },
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
      const message = choice?.message;
      if (message?.refusal) return { refusal: true, finishReason: choice?.finish_reason, model: data?.model, usage: data?.usage };
      const content = message?.parsed ?? message?.content;
      let output = content;
      if (typeof content === "string") {
        try { output = JSON.parse(content); }
        catch { output = null; }
      }
      return { output, finishReason: choice?.finish_reason, model: data?.model ?? model, usage: data?.usage ?? null };
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = { createOpenAiStructuredTransport };
