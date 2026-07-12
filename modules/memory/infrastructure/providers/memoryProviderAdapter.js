const { validateProposerOutput, validateTaskEnvelope } = require("../../contracts");
const { buildOutputSchema } = require("./outputSchema");

const ERROR_REASONS = Object.freeze(["llm_call_failed", "safety_policy_blocked", "max_output_truncated", "output_schema_invalid"]);

function createMemoryProviderAdapter({ invokeStructured, promptLoader } = {}) {
  if (typeof invokeStructured !== "function") throw new Error("invokeStructured is required");
  if (typeof promptLoader !== "function") throw new Error("promptLoader is required");
  return Object.freeze({
    async propose(envelope) {
      const envelopeResult = validateTaskEnvelope(envelope);
      if (!envelopeResult.ok) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "input", errors: envelopeResult.errors } };
      const { task } = envelope;
      const schema = buildOutputSchema(task.proposer);
      let response;
      try {
        response = await invokeStructured({
          proposer: task.proposer,
          systemPrompt: await promptLoader(task.proposer),
          userPayload: envelope,
          responseSchema: schema,
        });
      } catch (error) {
        return { status: "error", reason: "llm_call_failed", detail: { message: error instanceof Error ? error.message : String(error) } };
      }
      if (response?.refusal || response?.safetyBlocked) return { status: "error", reason: "safety_policy_blocked", detail: null };
      if (["length", "max_tokens", "max_output_tokens"].includes(response?.finishReason)) return { status: "error", reason: "max_output_truncated", detail: null };
      const output = response?.output;
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

module.exports = { createMemoryProviderAdapter, createMockMemoryProviderAdapter, ERROR_REASONS };
