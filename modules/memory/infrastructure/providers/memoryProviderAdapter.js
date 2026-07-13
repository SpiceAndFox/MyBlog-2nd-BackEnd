const { validateProposerOutput, validateTaskEnvelope } = require("../../contracts");
const { buildOutputSchema } = require("./outputSchema");
const { isSafetySignal, isTruncationSignal } = require("./providerProtocol");

const ERROR_REASONS = Object.freeze(["llm_call_failed", "safety_policy_blocked", "max_output_truncated", "output_schema_invalid"]);

function normalizeProviderOutput(output, task) {
  if (task?.proposer !== "currentStateProposer" || !output?.sectionResults?.scene?.patches) return output;
  const normalized = structuredClone(output);
  normalized.sectionResults.scene.patches = normalized.sectionResults.scene.patches.map((patch) => {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, "evidenceRef")
      || Object.prototype.hasOwnProperty.call(patch, "evidenceRefs")) return patch;
    const { evidenceRef, ...rest } = patch;
    return { ...rest, evidenceRefs: [evidenceRef] };
  });
  return normalized;
}

function createMemoryProviderAdapter({ invokeStructured, promptLoader } = {}) {
  if (typeof invokeStructured !== "function") throw new Error("invokeStructured is required");
  if (typeof promptLoader !== "function") throw new Error("promptLoader is required");
  return Object.freeze({
    async propose(envelope) {
      let response;
      try {
        const envelopeResult = validateTaskEnvelope(envelope);
        if (!envelopeResult.ok) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "input", errors: envelopeResult.errors } };
        const { task } = envelope;
        const schema = buildOutputSchema(task.proposer, task.targetSections);
        response = await invokeStructured({
          proposer: task.proposer,
          systemPrompt: await promptLoader(task.proposer),
          userPayload: envelope,
          responseSchema: schema,
        });
      } catch (error) {
        if (isSafetySignal(error?.code, error?.message)) return { status: "error", reason: "safety_policy_blocked", detail: { code: error?.code ?? null } };
        return { status: "error", reason: "llm_call_failed", detail: { code: error?.code ?? null, message: error instanceof Error ? error.message : String(error), ...(error?.detail || {}) } };
      }
      const { task } = envelope;
      if (response?.refusal || response?.safetyBlocked || isSafetySignal(response?.finishReason)) return { status: "error", reason: "safety_policy_blocked", detail: null };
      if (isTruncationSignal(response?.finishReason)) return { status: "error", reason: "max_output_truncated", detail: null };
      const output = normalizeProviderOutput(response?.output, task);
      const validated = validateProposerOutput(output, task);
      if (!validated.ok) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: validated.errors } };
      return { status: "ok", output, usage: response?.usage ?? null, model: response?.model ?? null };
    },
  });
}

function createMockMemoryProviderAdapter({ outputs, promptLoader = async () => "mock" } = {}) {
  const queue = Array.isArray(outputs) ? outputs.slice() : null;
  return Object.freeze({
    async propose(envelope) {
      const proposer = envelope?.task?.proposer;
      const value = queue ? queue.shift() : outputs?.[proposer];
      const result = typeof value === "function" ? await value(envelope) : value;
      if (result?.status === "error") return result;
      const adapter = createMemoryProviderAdapter({ promptLoader, invokeStructured: async () => ({ output: result?.status === "ok" ? result.output : result }) });
      return adapter.propose(envelope);
    },
  });
}

module.exports = { createMemoryProviderAdapter, createMockMemoryProviderAdapter, normalizeProviderOutput, ERROR_REASONS };
