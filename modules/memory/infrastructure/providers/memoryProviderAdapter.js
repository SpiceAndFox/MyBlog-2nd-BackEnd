const {
  validateRendererArtifact,
  validateSemanticResult,
} = require("../../contracts");
const { buildOutputSchema } = require("./outputSchema");
const { isSafetySignal, isTruncationSignal } = require("./providerProtocol");

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

function schemaRepairPrompt(systemPrompt, feedback) {
  const errors = Array.isArray(feedback?.errors) ? feedback.errors.slice(0, 8) : [];
  if (!errors.length) return systemPrompt;
  const lines = errors.map((error, index) => (
    `${index + 1}. ${String(error.path || "$").slice(0, 240).replace(/[^A-Za-z0-9_$.[\]-]/g, "?")}: ${String(error.message || "does not satisfy the contract").replace(/[\r\n]+/g, " ").slice(0, 240)}`
  ));
  const hasRefNamespaceError = errors.some((error) => /rendered as (?:read-only|writable) Memory/i.test(String(error?.message || "")));
  const copiedRenderedLines = [...new Set(errors.flatMap((error) => {
    const match = String(error?.message || "").match(/\bref\s+([A-Z][A-Z0-9-]*)\s*\|.+?was not rendered as (read-only|writable) Memory/i);
    return match ? [`${match[1]}:${match[2]}`] : [];
  }))];
  const refRepair = hasRefNamespaceError
    ? `\n[REF_NAMESPACE_REPAIR]\nref 目标只能逐字复制“可修改”分区显示的短引用；supportRefs 只能逐字复制“辅助”分区显示的短引用。删除放错命名空间或自行创造的引用，不要把可修改 ref 移到 supportRefs。${copiedRenderedLines.length ? ` 检测到把 Memory 整行误当引用：${copiedRenderedLines.map((value) => value.split(":")[0]).join("、")}。竖线及其右侧文本绝不是 ref；只在该短引用确实位于错误所要求的分区时改为短 token，否则删除它。` : ""}删除后每个 change 仍须保留至少一个实际显示的 evidenceMessageId 或合法辅助 ref；若无法满足则移除该 change，并重新判断该 section 的终局。`
    : "";
  return `${systemPrompt}\n\n[SCHEMA_REPAIR]\n上一份 tool arguments 未通过本地契约校验。请根据以下错误重新生成一份完整的替代结果，不要只返回局部字段，也不要解释。\n${lines.join("\n")}${refRepair}\n只修复格式或契约错误；事实判断仍必须完全依据原始 Memory task。`;
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
  return {
    ...userPayload,
    task: {
      ...userPayload.task,
      proposer: specialist.proposer,
      targetSections: [specialist.section],
    },
  };
}

function buildSpecialistArtifact(artifact, specialist) {
  return {
    ...artifact,
    publicInput: {
      ...artifact.publicInput,
      task: {
        ...artifact.publicInput.task,
        proposer: specialist.proposer,
        targetSections: [specialist.section],
      },
    },
  };
}

function bindSpecialistSchema(schema, artifact, section) {
  const bound = structuredClone(schema);
  const writableRefs = Object.entries(artifact.refMap?.writable || {})
    .filter(([, entry]) => entry.section === section)
    .map(([ref]) => ref);
  const readOnlyRefs = Object.keys(artifact.refMap?.readOnly || {});
  const messageIds = Object.keys(artifact.messageMeta || {}).map(Number).filter(Number.isSafeInteger);
  const resultSchema = bound.schema.properties.sectionResults.properties[section];
  const changesBranch = resultSchema.oneOf.find((branch) => branch.properties?.status?.const === "changes");
  if (!changesBranch) return bound;
  const variants = changesBranch.properties.changes.items.oneOf.filter((variant) => {
    if (variant.properties.ref) {
      if (!writableRefs.length) return false;
      variant.properties.ref = { type: "string", enum: writableRefs };
    }
    if (messageIds.length) variant.properties.evidenceMessageIds.items = { type: "integer", enum: messageIds };
    else {
      delete variant.properties.evidenceMessageIds;
      variant.anyOf = variant.anyOf.filter((entry) => !entry.required?.includes("evidenceMessageIds"));
    }
    if (readOnlyRefs.length) variant.properties.supportRefs.items = { type: "string", enum: readOnlyRefs };
    else {
      delete variant.properties.supportRefs;
      variant.anyOf = variant.anyOf.filter((entry) => !entry.required?.includes("supportRefs"));
    }
    return variant.anyOf.length > 0;
  });
  if (variants.length) changesBranch.properties.changes.items.oneOf = variants;
  else resultSchema.oneOf = resultSchema.oneOf.filter((branch) => branch !== changesBranch);
  return bound;
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
        const userPayload = buildProposerUserPayload(envelope);
        if (task.proposer === "profileRelationshipProposer") {
          const responses = [];
          const sectionResults = {};
          for (const specialist of PROFILE_SPECIALISTS) {
            const specialistPayload = buildSpecialistPayload(userPayload, specialist);
            const specialistArtifact = buildSpecialistArtifact(envelope.artifact, specialist);
            const specialistResponse = await invokeStructured({
              proposer: specialist.proposer,
              systemPrompt: schemaRepairPrompt(await promptLoader(specialist.proposer), repairFeedback),
              userPayload: specialistPayload,
              responseSchema: bindSpecialistSchema(
                buildOutputSchema(specialist.proposer, [specialist.section]),
                specialistArtifact,
                specialist.section,
              ),
            });
            responses.push(specialistResponse);
            if (specialistResponse?.refusal || specialistResponse?.safetyBlocked || isSafetySignal(specialistResponse?.finishReason)) {
              return { status: "error", reason: "safety_policy_blocked", detail: null, usage: mergeUsage(responses), model: specialistResponse?.model ?? null, callCount: responses.length };
            }
            if (isTruncationSignal(specialistResponse?.finishReason)) {
              return { status: "error", reason: "max_output_truncated", detail: null, usage: mergeUsage(responses), model: specialistResponse?.model ?? null, callCount: responses.length };
            }
            const specialistValidation = validateSemanticResult(specialistResponse?.output, specialistArtifact);
            if (!specialistValidation.ok) {
              return {
                status: "error", reason: "output_schema_invalid",
                detail: { boundary: "output", specialist: specialist.proposer, errors: specialistValidation.errors },
                usage: mergeUsage(responses), model: specialistResponse?.model ?? null, callCount: responses.length,
              };
            }
            sectionResults[specialist.section] = specialistResponse.output.sectionResults[specialist.section];
          }
          response = {
            output: { tickId: task.tickId, proposer: task.proposer, sectionResults },
            usage: mergeUsage(responses),
            model: responses.map((entry) => entry?.model).find(Boolean) ?? null,
            callCount: responses.length,
          };
        } else {
          const schema = buildOutputSchema(task.proposer, task.targetSections);
          const loadedPrompt = await promptLoader(task.proposer);
          const basePrompt = schemaRepairPrompt(loadedPrompt, repairFeedback);
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
      const output = response?.output;
      const validated = validateSemanticResult(output, envelope.artifact);
      if (!validated.ok) {
        return {
          status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: validated.errors },
          usage: response?.usage ?? null, model: response?.model ?? null, callCount: response?.callCount ?? 1,
        };
      }
      return { status: "ok", output, usage: response?.usage ?? null, model: response?.model ?? null, callCount: response?.callCount ?? 1 };
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
