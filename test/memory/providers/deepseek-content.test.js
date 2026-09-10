const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeepSeekStrictToolsTransport } = require("../../../modules/memory/infrastructure/providers/deepSeekStrictToolsTransport");

const responseSchema = {
  name: "memory_result",
  schema: {
    type: "object", additionalProperties: false, required: ["source"],
    properties: { source: { type: "string", enum: ["message:101"] } },
  },
};

async function invoke(message, { finishReason = "stop", thinkingMode = "enabled" } = {}) {
  const transport = createDeepSeekStrictToolsTransport({
    baseUrl: "https://api.deepseek.com/beta", apiKey: "test-key", model: "deepseek-v4-flash",
    thinkingMode, timeoutMs: 1000, maxInputTokens: 100000, maxOutputTokens: 1024,
    fetchImpl: async () => ({ ok: true, json: async () => ({
      choices: [{ finish_reason: finishReason, message }], usage: { prompt_tokens: 10, completion_tokens: 5 },
    }) }),
  });
  return transport({ systemPrompt: "Return the result", userPayload: {}, responseSchema });
}

test("thinking auto tool choice accepts complete content JSON through the bound schema", async () => {
  const result = await invoke({ content: '{"source":"message:101"}' });
  assert.deepEqual(result.output, { source: "message:101" });
  assert.equal(result.transportError, null);
  assert.equal(result.transportRecovery, "accepted_schema_valid_json_content");
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5 });
});

test("content fallback enforces source permissions, required fields and exact object shape", async () => {
  for (const content of ['{"source":"message:999"}', '{}', '{"source":"message:101","extra":true}', 'null', '[]']) {
    const result = await invoke({ content });
    assert.ok(result.outputSchemaErrors.length > 0, content);
    assert.equal(result.transportRecovery, null);
  }
});

test("content fallback rejects malformed, wrapped or truncated JSON", async () => {
  for (const content of ['{"source":', 'Here is {"source":"message:101"}', '```json\n{"source":"message:101"}\n```']) {
    const result = await invoke({ content });
    assert.equal(result.output, null);
    assert.ok(result.transportError);
  }
  const incomplete = await invoke({ content: '{"source":' }, { finishReason: "abort" });
  assert.equal(incomplete.transportError, "content_incomplete_json");
});

test("valid content cannot hide invalid tool arguments, an unexpected tool or a refusal", async () => {
  const content = '{"source":"message:101"}';
  const invalid = await invoke({ content, tool_calls: [{ function: { name: "memory_result", arguments: '{"source":' } }] });
  assert.equal(invalid.output, null);
  assert.equal(invalid.transportError, "tool_arguments_invalid_json");
  const unexpected = await invoke({ content, tool_calls: [{ function: { name: "another_tool", arguments: content } }] });
  assert.equal(unexpected.transportError, "tool_call_missing");
  const refusal = await invoke({ content, refusal: "safety_policy_blocked" });
  assert.equal(refusal.safetyBlocked, true);
  assert.equal((await invoke({ content }, { thinkingMode: "disabled" })).transportError, "tool_call_missing");
});
