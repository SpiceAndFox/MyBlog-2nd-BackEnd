// Encode user settings only after gateway/model capabilities are resolved.
// Controls unused by a known encoding are intentionally omitted: a mixed-model
// configuration may supply both effort and thinking mode globally.
function buildProviderInferenceControls(policy, { reasoningEffort, thinkingMode } = {}) {
  const context = `${policy.profile}/${policy.model}`;
  function effort() {
    if (!policy.reasoningEfforts.includes(reasoningEffort)) {
      throw new Error(`CHAT_MEMORY_V2_PROVIDER_REASONING_EFFORT for ${context} must be one of: ${policy.reasoningEfforts.join(", ")}`);
    }
    return reasoningEffort;
  }
  function mode(value = thinkingMode) {
    if (!policy.thinkingModes.includes(value)) {
      throw new Error(`CHAT_MEMORY_V2_PROVIDER_THINKING_MODE for ${context} must be one of: ${policy.thinkingModes.join(", ")}`);
    }
    return value;
  }
  switch (policy.reasoningEncoding) {
    case "none":
      if (reasoningEffort !== undefined || thinkingMode !== undefined) {
        throw new Error(`No reasoning encoding configured for ${context}; remove reasoning settings or declare a provider/model policy`);
      }
      return {};
    case "reasoning-effort": {
      if (!policy.thinkingModes.includes("disabled") && reasoningEffort === "none") throw new Error(`Reasoning is mandatory for ${context}`);
      const selected = effort();
      mode(selected === "none" ? "disabled" : "enabled");
      return { reasoning_effort: selected };
    }
    case "thinking":
      return { thinking: { type: mode() } };
    case "openrouter": {
      // Explicit off takes precedence over a global default effort.
      if (thinkingMode !== undefined && mode() === "disabled") return { reasoning: { enabled: false } };
      if (reasoningEffort !== undefined) {
        if (reasoningEffort === "none" && (thinkingMode === "enabled" || !policy.thinkingModes.includes("disabled"))) {
          throw new Error(`reasoningEffort=none conflicts with enabled/mandatory thinking for ${context}`);
        }
        const selected = effort();
        mode(selected === "none" ? "disabled" : "enabled");
        return { reasoning: { effort: selected } };
      }
      return thinkingMode === undefined ? {} : { reasoning: { enabled: true } };
    }
    default: throw new Error(`Unsupported reasoning encoding: ${policy.reasoningEncoding}`);
  }
}

function validateProviderOutputMode(policy, adapter) {
  const mode = adapter === "openai-compatible-json-object" ? "json_object" : "json_schema";
  if (!policy.outputModes.includes(mode)) throw new Error(`${policy.profile}/${policy.model} does not support configured output mode ${mode}`);
  return mode;
}

module.exports = { buildProviderInferenceControls, validateProviderOutputMode };
