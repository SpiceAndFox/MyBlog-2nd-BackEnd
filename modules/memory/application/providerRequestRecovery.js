const { providerFailureDecision } = require("./providerRecoveryPolicy");

// One budget lane per actual provider request (including Profile specialists).
// Scheduling remains with the task executor; no shared request gate exists.
function createProviderRequestControl({ health, retryBudget, config, now = () => new Date() }) {
  return async function requestControl(invoke, request, task) {
    const lane = { ...task, providerLane: request.proposer };
    if (retryBudget.exhausted(lane, config)) {
      throw Object.assign(new Error("Provider retry budget exhausted"), { code: "MEMORY_PROVIDER_RETRY_EXHAUSTED",
        noProviderCall: true, providerDecision: { halted: true, budgetExhausted: true, notBefore: null,
          kind: "bounded", counters: retryBudget.forTask(lane) } });
    }
    try {
      const response = await invoke(request);
      retryBudget.providerSucceeded(lane);
      health.recordSuccess();
      return response;
    } catch (error) {
      health.recordFailure(error);
      const failure = { reason: "llm_call_failed", detail: { code: error.code ?? error.cause?.code,
        status: error.status, retryable: error.retryable, retryAfterAt: error.retryAfterAt } };
      error.providerDecision = providerFailureDecision({ counters: retryBudget.forTask(lane), result: failure,
        config: config.providerRecovery, retryMax: task.mode === "maintenance" ? config.compaction.retryMax : config.providerRecovery.retryMax, now: now() });
      throw error;
    }
  };
}

module.exports = { createProviderRequestControl };
