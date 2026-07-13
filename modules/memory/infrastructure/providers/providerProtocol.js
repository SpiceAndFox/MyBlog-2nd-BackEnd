function normalizedReason(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isSafetySignal(...values) {
  const joined = values.map(normalizedReason).join(" ");
  return /content[_ -]?filter|safety|refus|moderation|policy[_ -]?block/.test(joined);
}

function isTruncationSignal(value) {
  const reason = normalizedReason(value);
  return reason === "length"
    || reason.includes("max_tokens")
    || reason.includes("max_output_tokens")
    || reason.includes("max_output_length")
    || reason.includes("output_length");
}

function assertStructuredRequestLimits({ systemPrompt, userPayload, maxInputTokens, maxOutputTokens }) {
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) throw new Error("Memory Provider maxInputTokens must be a positive safe integer");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("Memory Provider maxOutputTokens must be a positive safe integer");
  const bytes = Buffer.byteLength(String(systemPrompt ?? ""), "utf8")
    + Buffer.byteLength(JSON.stringify(userPayload), "utf8");
  // A tokenizer-independent upper bound: a token cannot encode less than one
  // input byte. This is deliberately conservative and prevents dispatching a
  // request that can exceed the configured physical context window.
  if (bytes > maxInputTokens) {
    const error = new Error(`Memory Provider input exceeds configured context capability (${bytes} > ${maxInputTokens})`);
    error.code = "MEMORY_PROVIDER_INPUT_LIMIT";
    error.detail = { inputUtf8Bytes: bytes, maxInputTokens };
    throw error;
  }
  return { inputUtf8Bytes: bytes, maxInputTokens, maxOutputTokens };
}

module.exports = { isSafetySignal, isTruncationSignal, assertStructuredRequestLimits };
