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

function isAbortSignal(value) {
  return normalizedReason(value) === "abort";
}

function isIncompleteJsonAtEof(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return false;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    if (stack.pop() !== expected) return false;
  }
  return inString || stack.length > 0;
}

function isAbortedIncompleteJson(value, finishReason) {
  return isAbortSignal(finishReason) && isIncompleteJsonAtEof(value);
}

function assertStructuredRequestLimits({ systemPrompt, userPayload, messages, tools, response_format, maxInputTokens, maxOutputTokens }) {
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) throw new Error("Memory Provider maxInputTokens must be a positive safe integer");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("Memory Provider maxOutputTokens must be a positive safe integer");
  const messageBytes = Array.isArray(messages)
    ? messages.reduce((total, message) => total + Buffer.byteLength(String(message?.content ?? ""), "utf8"), 0)
    : Buffer.byteLength(String(systemPrompt ?? ""), "utf8")
      + Buffer.byteLength(JSON.stringify(userPayload), "utf8");
  const schemaBytes = Buffer.byteLength(JSON.stringify({ ...(tools ? { tools } : {}), ...(response_format ? { response_format } : {}) }), "utf8") - 2;
  const bytes = messageBytes + schemaBytes;
  // Conservative input estimate, including schema definitions. API templates,
  // tokenization and server-side transformations still require usage monitoring.
  if (bytes > maxInputTokens) {
    const error = new Error(`Memory Provider input exceeds configured context capability (${bytes} > ${maxInputTokens})`);
    error.code = "MEMORY_PROVIDER_INPUT_LIMIT";
    error.detail = { inputUtf8Bytes: bytes, schemaUtf8Bytes: schemaBytes, maxInputTokens };
    throw error;
  }
  return { inputUtf8Bytes: bytes, maxInputTokens, maxOutputTokens };
}

module.exports = {
  assertStructuredRequestLimits,
  isAbortedIncompleteJson,
  isAbortSignal,
  isIncompleteJsonAtEof,
  isSafetySignal,
  isTruncationSignal,
};
