function stripCodeFences(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return trimmed;
  if (!lines[lines.length - 1].trim().startsWith("```")) return trimmed;

  return lines.slice(1, -1).join("\n").trim();
}

function clipText(text, maxChars) {
  const normalized = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return normalized;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

module.exports = {
  stripCodeFences,
  clipText,
};

