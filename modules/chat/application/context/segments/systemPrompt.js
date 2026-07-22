function buildSystemPromptSegment({ systemPrompt } = {}) {
  const normalized = String(systemPrompt || "").trim();
  if (!normalized) return null;
  return { messages: [{ role: "system", content: normalized }] };
}

module.exports = {
  buildSystemPromptSegment,
};
