const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpenAiStructuredTransport } = require("../../../modules/memory/infrastructure/providers/transport/openAiStructuredTransport");
const { createDeepSeekStrictToolsTransport } = require("../../../modules/memory/infrastructure/providers/transport/deepSeekStrictToolsTransport");
const { providerHttpError } = require("../../../modules/memory/infrastructure/providers/transport/providerFailure");

const request = { systemPrompt: "prompt", userPayload: {}, responseSchema: {
  name: "probe", schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
} };
const config = { baseUrl: "https://api.deepseek.com/beta", apiKey: "test", model: "deepseek-flash", timeoutMs: 10,
  maxInputTokens: 100_000, maxOutputTokens: 1024, thinkingMode: "disabled", reasoningEffort: "low" };

for (const [name, create] of [["OpenAI", createOpenAiStructuredTransport], ["DeepSeek", createDeepSeekStrictToolsTransport]]) {
  test(`${name} preserves a typed timeout both before headers and during response body consumption`, async () => {
    for (const phase of ["headers", "body"]) {
      const invoke = create({ ...config, fetchImpl: async (_url, { signal }) => {
        const wait = () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
        return phase === "headers" ? wait() : { ok: true, json: wait };
      } });
      await assert.rejects(invoke(request), { code: "MEMORY_PROVIDER_TIMEOUT", retryable: true });
    }
  });
  test(`${name} preserves response body connection errors rather than using schema repair`, async () => {
    const invoke = create({ ...config, fetchImpl: async () => ({ ok: true, json: async () => {
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    } }) });
    await assert.rejects(invoke(request), { code: "ECONNRESET" });
  });
}

test("provider HTTP errors retain status, code and both Retry-After formats", () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  for (const header of ["60", "Fri, 11 Sep 2026 00:01:00 GMT"]) {
    const error = providerHttpError({ status: 429, headers: { get: () => header } }, { error: { code: "rate_limit" } }, now);
    assert.equal(error.status, 429); assert.equal(error.code, "rate_limit");
    assert.equal(Date.parse(error.retryAfterAt), now + 60_000);
  }
});
