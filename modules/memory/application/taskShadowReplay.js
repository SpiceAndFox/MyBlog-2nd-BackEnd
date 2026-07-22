const crypto = require("node:crypto");
const {
  validateSemanticResult,
  assertMemoryState,
} = require("../contracts");
const { reduceCompiledProposal } = require("../domain/compiledReducer");
const { createSemanticCompiler } = require("../domain/semanticCompiler");
const { isSemanticTaskEnvelope } = require("./envelope");
const { buildOutputSchema } = require("../infrastructure/providers/outputSchema");
const { loadProposerPrompt } = require("../prompts");

function rowValue(row, snake, camel = snake) {
  return row?.[snake] ?? row?.[camel];
}

function effectiveReplayEnvelope(baseEnvelope, stagePayload, contextExpansionAttempt) {
  const inputVariant = stagePayload.semanticInputVariant
    ?? (Number(contextExpansionAttempt || 0) > 0 ? "expanded" : "base");
  if (inputVariant === "base") return { envelope: baseEnvelope, inputVariant };
  // Read-only compatibility for terminal tasks written before expandedArtifact was introduced.
  const expandedArtifact = stagePayload.expandedArtifact
    ?? (stagePayload.expandedEnvelope?.artifact ? {
      publicInput: stagePayload.expandedEnvelope.artifact.publicInput,
      messageMeta: stagePayload.expandedEnvelope.artifact.messageMeta,
    } : null);
  if (inputVariant !== "expanded" || !expandedArtifact?.publicInput || !expandedArtifact?.messageMeta) {
    throw new Error("Expanded shadow-replay input is missing from durable state");
  }
  const envelope = structuredClone(baseEnvelope);
  envelope.artifact = {
    ...envelope.artifact,
    publicInput: structuredClone(expandedArtifact.publicInput),
    messageMeta: structuredClone(expandedArtifact.messageMeta),
    refMap: structuredClone(baseEnvelope.artifact.refMap),
  };
  envelope.task.observedMessageIds = (envelope.artifact.publicInput.messages || []).map((message) => message.id);
  return { envelope, inputVariant };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const content = typeof value === "string" ? value : stableJson(value);
  return `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function deterministicId(taskId, index) {
  const hex = crypto.createHash("sha256").update(`${taskId}:shadow:${index}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function semanticResultSummary(semanticResult, targetSections = []) {
  const statuses = { changes: 0, noop: 0, unable_to_decide: 0, unable_to_compact: 0 };
  let changeCount = 0;
  for (const section of targetSections) {
    const result = semanticResult?.sectionResults?.[section];
    if (Object.prototype.hasOwnProperty.call(statuses, result?.status)) statuses[result.status] += 1;
    if (Array.isArray(result?.changes)) changeCount += result.changes.length;
  }
  return { sectionStatuses: statuses, changeCount };
}

function reducerSummary(reduction) {
  const decisions = { accepted: 0, rejected: 0, noop: 0, deferred: 0 };
  const rejectReasons = {};
  for (const event of reduction?.events || []) {
    if (Object.prototype.hasOwnProperty.call(decisions, event.decision)) decisions[event.decision] += 1;
    if (event.decision === "rejected") {
      const reason = event.rejectReason || "unknown";
      rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
    }
  }
  return {
    status: "passed",
    outcome: reduction.outcome,
    decisions,
    rejectReasons,
    capacityViolation: reduction.capacityViolation || null,
    resultRevision: reduction.state?.meta?.revision ?? null,
    events: (reduction?.events || []).map((event) => ({
      section: event.section ?? null,
      decision: event.decision ?? null,
      op: event.op ?? null,
      rejectReason: event.rejectReason ?? null,
      cleanupType: event.cleanupType ?? null,
    })),
  };
}

function createMemoryTaskShadowReplay({ repositories, config, providerAdapter, promptLoader = loadProposerPrompt } = {}) {
  if (!repositories?.runtime?.getTask || !repositories?.audit?.getSnapshot || !repositories?.source?.getByIds) {
    throw new Error("Task shadow replay requires read-only Memory repositories");
  }
  if (!config?.enabled || !config?.provider) throw new Error("Memory v2 must be enabled for task shadow replay");
  if (!providerAdapter?.propose) throw new Error("Task shadow replay providerAdapter is required");

  async function replay(taskId) {
    const row = await repositories.runtime.getTask(taskId);
    if (!row) throw new Error(`Memory task not found: ${taskId}`);
    const baseEnvelope = structuredClone(rowValue(row, "task_payload", "taskPayload"));
    if (!baseEnvelope?.task) throw new Error(`Memory task has no replayable task_payload: ${taskId}`);

    if (!isSemanticTaskEnvelope(baseEnvelope)) throw new Error(`Memory task is not a 2.01 Semantic task: ${taskId}`);
    const stagePayload = rowValue(row, "stage_payload", "stagePayload") || {};
    const { envelope, inputVariant } = effectiveReplayEnvelope(
      baseEnvelope,
      stagePayload,
      rowValue(row, "context_expansion_attempt", "contextExpansionAttempt"),
    );
    const prompt = await promptLoader(envelope.task.proposer);
    const outputSchema = buildOutputSchema(envelope.task.proposer, envelope.task.targetSections);
    const persistedSemanticResult = stagePayload.semanticResult ?? null;
    const persistedUnableResult = stagePayload.unableResult ?? null;
    const persistedResult = persistedSemanticResult ?? persistedUnableResult;
    const report = {
      reportVersion: 1,
      mode: "read_only_task_shadow_replay",
      status: "running",
      task: {
        taskId: envelope.task.taskId,
        taskType: rowValue(row, "task_type", "taskType") ?? envelope.task.mode,
        status: row.status ?? null,
        stage: row.stage ?? null,
        userId: envelope.task.userId,
        presetId: envelope.task.presetId,
        targetKey: envelope.task.targetKey,
        proposer: envelope.task.proposer,
        sourceGeneration: envelope.task.sourceGeneration,
        baseRevision: envelope.task.baseRevision,
        sourceBoundary: {
          cursorBefore: envelope.task.cursorBefore ?? null,
          targetMessageId: envelope.task.targetMessageId,
        },
        observedMessageIds: envelope.task.observedMessageIds.slice(),
        semanticInputVariant: inputVariant,
      },
      provenance: {
        adapter: config.provider.adapter,
        requestedModel: config.provider.model,
        thinkingMode: config.provider.thinkingMode ?? null,
        promptHash: sha256(prompt),
        outputSchemaHash: sha256(outputSchema),
        windowConfig: {
          configured: config.targets?.[envelope.task.targetKey] ?? null,
          persistedContextWindow: rowValue(row, "stage_payload", "stagePayload")?.normalContextWindow ?? null,
          observedCount: envelope.task.observedMessageIds.length,
        },
      },
      baseline: persistedResult ? {
        resultKind: persistedSemanticResult ? "semanticResult" : "unableResult",
        resultHash: sha256(persistedResult),
        semanticResultHash: persistedSemanticResult ? sha256(persistedSemanticResult) : null,
        unableResultHash: persistedUnableResult ? sha256(persistedUnableResult) : null,
        summary: semanticResultSummary(persistedResult, envelope.task.targetSections),
        semanticResult: persistedSemanticResult,
        unableResult: persistedUnableResult,
      } : null,
      replay: null,
    };

    const providerAttempts = [];
    let providerResult;
    const schemaRetryMax = Number(config.providerRecovery?.schemaInvalidRetryMax ?? 0);
    for (let attempt = 0; attempt <= schemaRetryMax; attempt += 1) {
      const repairFeedback = attempt === 0 ? null : {
        attempt,
        errors: providerResult?.detail?.errors ?? [],
      };
      providerResult = await providerAdapter.propose(envelope, { repairFeedback });
      providerAttempts.push({
        attempt,
        status: providerResult.status,
        reason: providerResult.reason ?? null,
        model: providerResult.model ?? config.provider.model,
        usage: providerResult.usage ?? null,
      });
      const retryableSchemaFailure = providerResult.status === "error"
        && providerResult.reason === "output_schema_invalid"
        && providerResult.detail?.boundary === "output";
      if (!retryableSchemaFailure) break;
    }
    if (providerResult.status !== "ok") {
      report.status = "provider_error";
      report.replay = {
        model: providerResult.model ?? config.provider.model,
        usage: providerResult.usage ?? null,
        providerAttempts,
        provider: { status: "error", reason: providerResult.reason, detail: providerResult.detail ?? null },
        schemaValidation: providerResult.reason === "output_schema_invalid"
          ? { passed: false, errors: providerResult.detail?.errors ?? [] }
          : null,
        reducerPreflight: null,
        semanticResult: null,
      };
      return report;
    }

    const validation = validateSemanticResult(providerResult.output, envelope.artifact);
    const replay = {
      model: providerResult.model ?? config.provider.model,
      usage: providerResult.usage ?? null,
      providerAttempts,
      provider: { status: "ok" },
      semanticResultHash: sha256(providerResult.output),
      summary: semanticResultSummary(providerResult.output, envelope.task.targetSections),
      schemaValidation: { passed: validation.ok, errors: validation.errors },
      reducerPreflight: null,
      semanticResult: providerResult.output,
    };
    report.replay = replay;
    if (!validation.ok) {
      report.status = "schema_invalid";
      return report;
    }

    const snapshot = await repositories.audit.getSnapshot(
      envelope.task.userId,
      envelope.task.presetId,
      envelope.task.baseRevision,
    );
    if (!snapshot) {
      report.status = "preflight_unavailable";
      replay.reducerPreflight = { status: "unavailable", reason: "base_snapshot_missing" };
      return report;
    }
    const snapshotGeneration = Number(rowValue(snapshot, "source_generation", "sourceGeneration"));
    if (snapshotGeneration !== envelope.task.sourceGeneration) {
      report.status = "preflight_unavailable";
      replay.reducerPreflight = { status: "unavailable", reason: "base_snapshot_generation_mismatch", snapshotGeneration };
      return report;
    }

    try {
      let nextId = 0;
      let reduction;
      const state = assertMemoryState(structuredClone(snapshot.state));
      if (Object.values(providerResult.output.sectionResults).some((result) => result.status === "unable_to_decide")) {
        replay.reducerPreflight = { status: "unavailable", reason: "unable_to_decide" };
        report.status = "completed";
        return report;
      }
      const compiled = await createSemanticCompiler({ sourceRepository: repositories.source }).compile({
        artifact: envelope.artifact,
        semanticResult: providerResult.output,
        baseState: state,
        userId: envelope.task.userId,
        presetId: envelope.task.presetId,
      });
      reduction = reduceCompiledProposal({
        state,
        task: envelope.task,
        proposal: compiled,
        now: envelope.task.now,
        config,
        idFactory: () => deterministicId(envelope.task.taskId, nextId++),
      });
      replay.reducerPreflight = reducerSummary(reduction);
      report.status = "completed";
    } catch (error) {
      report.status = "preflight_failed";
      replay.reducerPreflight = {
        status: "failed",
        reason: error?.code ?? error?.name ?? "reducer_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return report;
  }

  return Object.freeze({ replay });
}

module.exports = {
  createMemoryTaskShadowReplay,
  semanticResultSummary,
  reducerSummary,
  sha256,
  stableJson,
};
