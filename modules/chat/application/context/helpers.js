function normalizeText(value) {
  return String(value || "");
}

function normalizeMessageId(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return null;
  return number;
}

function normalizePositiveIntLimit(value, fallback, { name } = {}) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid ${name || "limit"}: ${String(value)}`);
  }
  return Math.floor(number);
}

function normalizeNonNegativeIntRequired(value, { name } = {}) {
  if (value === undefined || value === null) {
    throw new Error(`Missing required ${name || "limit"}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${name || "limit"}: ${String(value)}`);
  }
  return Math.floor(number);
}

function buildAssistantGistMessageFromBody(gistBody, { prefix } = {}) {
  const header = String(prefix || "").trim();
  if (!header) throw new Error("Missing assistantGistPrefix");
  const prefixText = `${header} `;
  const normalizedBody = String(gistBody || "").trim();
  if (!normalizedBody) return "";
  return `${prefixText}${normalizedBody}`;
}

function getAssistantGistFromMap(assistantGistMap, messageId) {
  if (!assistantGistMap || messageId === null || messageId === undefined) return "";
  if (assistantGistMap instanceof Map) {
    return String(assistantGistMap.get(messageId) || "");
  }
  if (typeof assistantGistMap === "object") {
    return String(assistantGistMap[messageId] || "");
  }
  return "";
}

module.exports = {
  normalizeText,
  normalizeMessageId,
  normalizePositiveIntLimit,
  normalizeNonNegativeIntRequired,
  buildAssistantGistMessageFromBody,
  getAssistantGistFromMap,
};
