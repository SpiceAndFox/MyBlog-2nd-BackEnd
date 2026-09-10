const {
  resolveMemoryProviderModel,
  resolveMemoryProviderReasoningEffort,
} = require("../../config/loadProviderConfig");

// These OpenCode Go models expose `thinking` but do not accept
// `reasoning_effort`. Keep this compatibility policy at the request boundary
// so every Memory transport and preview path produces the same body.
const MODELS_USING_THINKING_CONTROL = new Set([
  "mimo-v2.5",
  "mimo-v2.5-pro",
]);

function normalizeModelId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function resolveThinkingMode(config) {
  if (!["enabled", "disabled"].includes(config?.thinkingMode)) throw new Error("Memory Provider thinkingMode is required");
  return config.thinkingMode;
}

function buildOpencodeGoInferenceControls(config, proposer) {
  const model = resolveMemoryProviderModel(config, proposer);
  if (MODELS_USING_THINKING_CONTROL.has(normalizeModelId(model))) {
    return { thinking: { type: resolveThinkingMode(config) } };
  }
  return {
    reasoning_effort: resolveMemoryProviderReasoningEffort(config, proposer),
  };
}

module.exports = {
  MODELS_USING_THINKING_CONTROL,
  buildOpencodeGoInferenceControls,
};
