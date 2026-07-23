const {
  validateRendererArtifact,
  validateSemanticResult,
} = require("../../contracts");
const { buildOutputSchema } = require("./outputSchema");
const { isSafetySignal, isTruncationSignal } = require("./providerProtocol");
const {
  normalizeSemanticOutput,
  renderRepairInstruction,
  summarizeOutputShape,
} = require("../../application/outputRepair");
const { bindOutputSchema, bindSpecialistSchema } = require("./bindOutputSchema");

const ERROR_REASONS = Object.freeze(["llm_call_failed", "safety_policy_blocked", "max_output_truncated", "output_schema_invalid"]);
const PROFILE_SPECIALISTS = Object.freeze([
  Object.freeze({ proposer: "userProfileProposer", section: "userProfile" }),
  Object.freeze({ proposer: "assistantProfileProposer", section: "assistantProfile" }),
  Object.freeze({ proposer: "relationshipProposer", section: "relationship" }),
]);

function mergeUsage(responses) {
  const totals = {};
  for (const response of responses) {
    for (const [key, value] of Object.entries(response?.usage || {})) {
      if (Number.isFinite(Number(value))) totals[key] = (totals[key] || 0) + Number(value);
    }
  }
  return Object.keys(totals).length ? totals : null;
}

function schemaRepairPrompt(systemPrompt, feedback, task = null) {
  return renderRepairInstruction(systemPrompt, feedback, task);
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

function buildSpecialistPayload(userPayload, specialist) {
  const payload = structuredClone(userPayload);
  return {
    ...payload,
    task: {
      ...payload.task,
      proposer: specialist.proposer,
      targetSections: [specialist.section],
    },
  };
}

function buildSpecialistArtifact(artifact, specialist) {
  const specialistArtifact = structuredClone(artifact);
  return {
    ...specialistArtifact,
    publicInput: {
      ...specialistArtifact.publicInput,
      task: {
        ...specialistArtifact.publicInput.task,
        proposer: specialist.proposer,
        targetSections: [specialist.section],
      },
    },
  };
}

function createMemoryProviderAdapter({ invokeStructured, promptLoader } = {}) {
  if (typeof invokeStructured !== "function") throw new Error("invokeStructured is required");
  if (typeof promptLoader !== "function") throw new Error("promptLoader is required");
  const profileRepairCache = new WeakMap();

  function rememberProfileSections(envelope, sectionResults) {
    profileRepairCache.set(envelope, { sectionResults: structuredClone(sectionResults) });
  }

  return Object.freeze({
    async propose(envelope, { repairFeedback = null } = {}) {
      let response;
      try {
        const envelopeResult = validateSemanticEnvelope(envelope);
        if (!envelopeResult.ok) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "input", errors: envelopeResult.errors } };
        const { task } = envelope;
        const userPayload = buildProposerUserPayload(envelope);
        if (task.proposer === "profileRelationshipProposer") {
          const retrySpecialist = PROFILE_SPECIALISTS.find((entry) => entry.proposer === repairFeedback?.specialist) || null;
          const cached = retrySpecialist ? profileRepairCache.get(envelope) : null;
          const cacheComplete = cached && PROFILE_SPECIALISTS
            .filter((entry) => entry.proposer !== retrySpecialist.proposer)
            .every((entry) => Object.prototype.hasOwnProperty.call(cached.sectionResults, entry.section));
          const selectedSpecialists = cacheComplete ? [retrySpecialist] : PROFILE_SPECIALISTS;
          const settledRuns = await Promise.allSettled(selectedSpecialists.map(async (specialist) => {
            const specialistPayload = buildSpecialistPayload(userPayload, specialist);
            const specialistArtifact = buildSpecialistArtifact(envelope.artifact, specialist);
            const specialistFeedback = !repairFeedback
              ? null
              : !retrySpecialist || retrySpecialist.proposer === specialist.proposer
                ? repairFeedback
                : null;
            const specialistResponse = await invokeStructured({
              proposer: specialist.proposer,
              systemPrompt: schemaRepairPrompt(
                await promptLoader(specialist.proposer),
                specialistFeedback,
                specialistPayload.task,
              ),
              userPayload: specialistPayload,
              responseSchema: bindSpecialistSchema(
                buildOutputSchema(specialist.proposer, [specialist.section]),
                specialistArtifact,
                specialist.section,
              ),
            });
            return { specialist, specialistArtifact, specialistResponse };
          }));
          const rejected = settledRuns.find((run) => run.status === "rejected");
          if (rejected) throw rejected.reason;
          const specialistRuns = settledRuns.map((run) => run.value);
          const responses = specialistRuns.map((run) => run.specialistResponse);
          const sectionResults = structuredClone(cacheComplete ? cached.sectionResults : {});
          let invalidRun = null;
          for (const { specialist, specialistArtifact, specialistResponse } of specialistRuns) {
            if (specialistResponse?.refusal || specialistResponse?.safetyBlocked || isSafetySignal(specialistResponse?.finishReason)) {
              profileRepairCache.delete(envelope);
              return { status: "error", reason: "safety_policy_blocked", detail: null, usage: mergeUsage(responses), model: specialistResponse?.model ?? null, callCount: responses.length };
            }
            if (isTruncationSignal(specialistResponse?.finishReason)) {
              profileRepairCache.delete(envelope);
              return { status: "error", reason: "max_output_truncated", detail: null, usage: mergeUsage(responses), model: specialistResponse?.model ?? null, callCount: responses.length };
            }
            const normalized = normalizeSemanticOutput(specialistResponse?.output);
            const specialistValidation = validateSemanticResult(normalized.output, specialistArtifact);
            if (!specialistValidation.ok) {
              invalidRun ??= {
                specialist,
                specialistResponse,
                specialistValidation,
                normalizedOutput: normalized.output,
              };
              continue;
            }
            sectionResults[specialist.section] = normalized.output.sectionResults[specialist.section];
          }
          if (invalidRun) {
            if (cacheComplete) profileRepairCache.delete(envelope);
            else rememberProfileSections(envelope, sectionResults);
            return {
              status: "error",
              reason: "output_schema_invalid",
              detail: {
                boundary: "output",
                specialist: invalidRun.specialist.proposer,
                errors: invalidRun.specialistValidation.errors,
                shape: summarizeOutputShape(invalidRun.normalizedOutput),
              },
              usage: mergeUsage(responses),
              model: invalidRun.specialistResponse?.model ?? null,
              callCount: responses.length,
            };
          }
          profileRepairCache.delete(envelope);
          response = {
            output: { tickId: task.tickId, proposer: task.proposer, sectionResults },
            usage: mergeUsage(responses),
            model: responses.map((entry) => entry?.model).find(Boolean) ?? null,
            callCount: responses.length,
          };
        } else {
          const schema = bindOutputSchema(
            buildOutputSchema(task.proposer, task.targetSections),
            envelope.artifact,
            task.targetSections,
          );
          const loadedPrompt = await promptLoader(task.proposer);
          const basePrompt = schemaRepairPrompt(loadedPrompt, repairFeedback, userPayload.task);
          response = await invokeStructured({
            proposer: task.proposer,
            systemPrompt: basePrompt,
            userPayload,
            responseSchema: schema,
          });
        }
      } catch (error) {
        if (isSafetySignal(error?.code, error?.message)) return { status: "error", reason: "safety_policy_blocked", detail: { code: error?.code ?? null } };
        return { status: "error", reason: "llm_call_failed", detail: { code: error?.code ?? null, message: error instanceof Error ? error.message : String(error), ...(error?.detail || {}) } };
      }
      const { task } = envelope;
      if (response?.refusal || response?.safetyBlocked || isSafetySignal(response?.finishReason)) {
        return { status: "error", reason: "safety_policy_blocked", detail: null, usage: response?.usage ?? null, model: response?.model ?? null, callCount: response?.callCount ?? 1 };
      }
      if (isTruncationSignal(response?.finishReason)) {
        return { status: "error", reason: "max_output_truncated", detail: null, usage: response?.usage ?? null, model: response?.model ?? null, callCount: response?.callCount ?? 1 };
      }
      const normalized = normalizeSemanticOutput(response?.output);
      const output = normalized.output;
      const validated = validateSemanticResult(output, envelope.artifact);
      if (!validated.ok) {
        return {
          status: "error",
          reason: "output_schema_invalid",
          detail: {
            boundary: "output",
            errors: validated.errors,
            shape: summarizeOutputShape(output),
          },
          usage: response?.usage ?? null, model: response?.model ?? null, callCount: response?.callCount ?? 1,
        };
      }
      return {
        status: "ok",
        output,
        ...(normalized.applied.length ? { normalizations: normalized.applied } : {}),
        usage: response?.usage ?? null,
        model: response?.model ?? null,
        callCount: response?.callCount ?? 1,
      };
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
      const fixtureOutput = result?.status === "ok" ? result.output : result;
      const adapter = createMemoryProviderAdapter({
        promptLoader,
        invokeStructured: async (request) => {
          const specialist = PROFILE_SPECIALISTS.find((entry) => entry.proposer === request.proposer);
          if (!specialist || fixtureOutput?.proposer !== "profileRelationshipProposer") return { output: fixtureOutput };
          return { output: {
            tickId: fixtureOutput.tickId,
            proposer: specialist.proposer,
            sectionResults: { [specialist.section]: fixtureOutput.sectionResults?.[specialist.section] },
          } };
        },
      });
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
  bindSpecialistSchema,
  ERROR_REASONS,
};
