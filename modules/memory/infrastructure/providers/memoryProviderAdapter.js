const {
  validateRendererArtifact,
  validateSemanticResult,
} = require("../../contracts");
const { buildOutputSchema } = require("./outputSchema");
const { isSafetySignal, isTruncationSignal } = require("./providerProtocol");

const ERROR_REASONS = Object.freeze(["llm_call_failed", "safety_policy_blocked", "max_output_truncated", "output_schema_invalid"]);

function schemaRepairPrompt(systemPrompt, feedback) {
  const errors = Array.isArray(feedback?.errors) ? feedback.errors.slice(0, 8) : [];
  if (!errors.length) return systemPrompt;
  const lines = errors.map((error, index) => (
    `${index + 1}. ${String(error.path || "$").slice(0, 240).replace(/[^A-Za-z0-9_$.[\]-]/g, "?")}: ${String(error.message || "does not satisfy the contract").replace(/[\r\n]+/g, " ").slice(0, 240)}`
  ));
  return `${systemPrompt}\n\n[SCHEMA_REPAIR]\n上一份 tool arguments 未通过本地契约校验。请根据以下错误重新生成一份完整的替代结果，不要只返回局部字段，也不要解释。\n${lines.join("\n")}\n只修复格式或契约错误；事实判断仍必须完全依据原始 Memory task。`;
}

function validateSemanticEnvelope(envelope) {
  const validation = validateRendererArtifact(envelope?.artifact);
  const errors = validation.errors.slice();
  const task = envelope?.task;
  const publicTask = envelope?.artifact?.publicInput?.task;
  if (!task || !publicTask) errors.push({ path: "$.task", message: "semantic task metadata is required" });
  else {
    for (const key of ["taskId", "tickId", "proposer", "targetKey", "cursorBefore", "targetMessageId", "now", "userTimeZone"]) {
      if (task[key] !== publicTask[key]) errors.push({ path: `$.task.${key}`, message: "must match Renderer artifact" });
    }
    if (JSON.stringify(task.targetSections) !== JSON.stringify(publicTask.targetSections)) {
      errors.push({ path: "$.task.targetSections", message: "must match Renderer artifact" });
    }
  }
  return { ok: errors.length === 0, errors };
}

function buildProposerUserPayload(envelope) {
  const publicInput = envelope?.artifact?.publicInput;
  const task = publicInput?.task;
  if (!publicInput || !task) throw new Error("semantic task public input is required");
  return {
    task: {
      tickId: task.tickId,
      proposer: task.proposer,
      targetKey: task.targetKey,
      targetSections: structuredClone(task.targetSections),
      cursorBefore: task.cursorBefore,
      targetMessageId: task.targetMessageId,
      userTimeZone: task.userTimeZone,
    },
    memoryText: publicInput.memoryText,
    messages: structuredClone(publicInput.messages),
  };
}

function createMemoryProviderAdapter({ invokeStructured, promptLoader } = {}) {
  if (typeof invokeStructured !== "function") throw new Error("invokeStructured is required");
  if (typeof promptLoader !== "function") throw new Error("promptLoader is required");
  return Object.freeze({
    async propose(envelope, { repairFeedback = null } = {}) {
      let response;
      try {
        const envelopeResult = validateSemanticEnvelope(envelope);
        if (!envelopeResult.ok) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "input", errors: envelopeResult.errors } };
        const { task } = envelope;
        const schema = buildOutputSchema(task.proposer, task.targetSections);
        const basePrompt = await promptLoader(task.proposer);
        response = await invokeStructured({
          proposer: task.proposer,
          systemPrompt: schemaRepairPrompt(basePrompt, repairFeedback),
          userPayload: buildProposerUserPayload(envelope),
          responseSchema: schema,
        });
      } catch (error) {
        if (isSafetySignal(error?.code, error?.message)) return { status: "error", reason: "safety_policy_blocked", detail: { code: error?.code ?? null } };
        return { status: "error", reason: "llm_call_failed", detail: { code: error?.code ?? null, message: error instanceof Error ? error.message : String(error), ...(error?.detail || {}) } };
      }
      const { task } = envelope;
      if (response?.refusal || response?.safetyBlocked || isSafetySignal(response?.finishReason)) {
        return { status: "error", reason: "safety_policy_blocked", detail: null, usage: response?.usage ?? null, model: response?.model ?? null };
      }
      if (isTruncationSignal(response?.finishReason)) {
        return { status: "error", reason: "max_output_truncated", detail: null, usage: response?.usage ?? null, model: response?.model ?? null };
      }
      const output = response?.output;
      const validated = validateSemanticResult(output, envelope.artifact);
      if (!validated.ok) {
        return {
          status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: validated.errors },
          usage: response?.usage ?? null, model: response?.model ?? null,
        };
      }
      return { status: "ok", output, usage: response?.usage ?? null, model: response?.model ?? null };
    },
  });
}

function createMockMemoryProviderAdapter({ outputs, promptLoader = async () => "mock" } = {}) {
  const queue = Array.isArray(outputs) ? outputs.slice() : null;
  return Object.freeze({
    async propose(envelope, options) {
      const proposer = envelope?.task?.proposer;
      const value = queue ? queue.shift() : outputs?.[proposer];
      const result = typeof value === "function" ? await value(envelope) : value;
      if (result?.status === "error") return result;
      const adapter = createMemoryProviderAdapter({ promptLoader, invokeStructured: async () => ({ output: result?.status === "ok" ? result.output : result }) });
      return adapter.propose(envelope, options);
    },
  });
}

module.exports = {
  createMemoryProviderAdapter,
  createMockMemoryProviderAdapter,
  buildProposerUserPayload,
  validateSemanticEnvelope,
  schemaRepairPrompt,
  ERROR_REASONS,
};
