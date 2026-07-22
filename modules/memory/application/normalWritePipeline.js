const crypto = require("node:crypto");
const {
  MEMORY_CONTROL_V201_SCHEMA_VERSION,
  SEMANTIC_NORMAL_PROPOSERS,
  COMPILE_ERROR_REASONS,
  validateProposerOutput,
  validateSemanticResult,
  validateCompiledProposal,
} = require("../contracts");
const { reduceProposal } = require("../domain/reducer");
const { reduceCompiledProposalV201 } = require("../domain/compiledReducerV201");
const { createSemanticCompiler, SemanticCompileError } = require("../domain/semanticCompiler");
const {
  buildNormalEnvelope,
  buildSemanticNormalEnvelope,
  isSemanticTaskEnvelope,
  normalDedupeKey,
} = require("./envelope");
const { expandProposerTaskArtifact } = require("./proposerTaskRenderer");
const { createCapacityMaintenance, stablePhaseId } = require("./capacityMaintenance");
const { mapEventToRow } = require("./eventMapper");
const { isDeepStrictEqual } = require("node:util");

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const RETRYABLE_ADAPTER_ERRORS = new Set(["llm_call_failed", "safety_policy_blocked", "max_output_truncated"]);
const ADAPTER_METRIC_RESULTS = new Set(["ok", "llm_call_failed", "safety_policy_blocked", "max_output_truncated", "output_schema_invalid", "semantic_schema_invalid"]);
const NORMAL_REDUCTION_STAGES = new Set([
  "proposing", "proposal_persisted", "provider_error", "schema_invalid_retry",
  "semantic_result_persisted", "compiling", "compiled_proposal_persisted",
  "context_expansion", "resumed", "transaction_failed", "commit_outcome_unknown",
]);

function phaseId(taskId, phase = "normal_commit") {
  const hex = crypto.createHash("sha256").update(`${taskId}:${phase}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function taskRow(envelope, overrides = {}) {
  const task = envelope.task;
  return {
    task_id: task.taskId, dedupe_key: normalDedupeKey(task), user_id: task.userId, preset_id: task.presetId,
    target_key: task.targetKey, source_generation: task.sourceGeneration, task_type: "normal",
    schema_version: task.schemaVersion,
    parent_task_id: null, predecessor_task_id: null, resume_epoch: 0, status: "queued", stage: "proposing",
    cursor_before: task.cursorBefore, target_message_id: task.targetMessageId, base_revision: task.baseRevision,
    task_payload: envelope, stage_payload: null, attempt: 0, context_expansion_attempt: 0,
    not_before: null, last_error_reason: null, result_revision: null, ...overrides,
  };
}
function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function numberValue(row, snake, camel, fallback = 0) { return Number(rowValue(row, snake, camel) ?? fallback); }
function safeRepairPath(value) {
  return String(value || "$").slice(0, 240).replace(/[^A-Za-z0-9_$.[\]-]/g, "?");
}
function schemaRepairFeedback(detail, attempt) {
  const source = Array.isArray(detail?.errors) ? detail.errors : [];
  const errors = source.slice(0, 8).map((error) => ({
    path: safeRepairPath(error?.path),
    message: String(error?.message || "does not satisfy the local output contract").replace(/[\r\n]+/g, " ").slice(0, 240),
  }));
  if (!errors.length) errors.push({ path: "$", message: "does not satisfy the local output contract" });
  return { attempt, errors };
}
function schemaErrorLogDetail(detail, feedback) {
  return { boundary: detail?.boundary ?? null, errors: feedback.errors };
}
async function recordSuccessfulTarget(repositories, envelope, client) {
  const args = { targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration, taskId: envelope.task.taskId };
  if (repositories.runtime.recordSuccessfulTargetTask) return repositories.runtime.recordSuccessfulTargetTask(envelope.task.userId, envelope.task.presetId, args, { client });
  return repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, { ...args, lastTaskId: args.taskId, status: "healthy", consecutiveErrors: 0, lastErrorReason: null, nextRetryAt: null }, { client });
}
function createNormalWritePipeline({ observer, providerAdapter, repositories, config, metrics, semanticCompiler, monotonicNow = () => performance.now(), now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
  if (!observer || !providerAdapter || !repositories?.source || !repositories.withTransaction) throw new Error("Normal Memory pipeline dependencies are required");
  let compiler = semanticCompiler || null;

  function semanticCompilerForTask() {
    if (!compiler) compiler = createSemanticCompiler({ sourceRepository: repositories.source });
    return compiler;
  }

  function validateProviderOutput(output, envelope) {
    return isSemanticTaskEnvelope(envelope)
      ? validateSemanticResult(output, envelope.artifact)
      : validateProposerOutput(output, envelope.task);
  }

  function observedMessages(envelope) {
    return envelope.observedMessages || envelope.artifact?.publicInput?.messages || [];
  }

  async function loadEvidenceMessages(envelope, client) {
    return repositories.source.getByIds(
      envelope.task.userId,
      envelope.task.presetId,
      envelope.task.observedMessageIds,
      { client },
    );
  }

  const capacity = createCapacityMaintenance({ repositories, providerAdapter, config, metrics, now, idFactory, recordAdapterError, proposeWithSchemaRetry, loadEvidenceMessages });

  async function createTask(userId, presetId, intent, options = {}) {
    const create = async (client) => {
      const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!state) throw new Error("Memory state must be initialized before creating normal tasks");
      const cursorBefore = state.meta.targetCursors[intent.targetKey] ?? 0;
      const targetConfig = config.targets[intent.targetKey];
      const userTimeZone = repositories.users?.getTimeZone
        ? await repositories.users.getTimeZone(userId, { client })
        : "UTC";
      const messages = options.messages ?? await repositories.source.getObservedWindow(userId, presetId, cursorBefore, {
        newBatchSize: targetConfig.lagThreshold,
        contextWindow: targetConfig.contextWindow,
      }, { client });
      const buildEnvelope = state.version === MEMORY_CONTROL_V201_SCHEMA_VERSION
        && SEMANTIC_NORMAL_PROPOSERS.includes(intent.proposer)
        ? buildSemanticNormalEnvelope
        : buildNormalEnvelope;
      const envelope = buildEnvelope({
        userId, presetId, state, intent: { ...intent, cursorBefore }, messages, now: now(),
        taskId: options.taskId, tickId: options.tickId, userTimeZone, config,
      });
      const overrides = { stage_payload: { normalContextWindow: targetConfig.contextWindow } };
      if (options.predecessorTaskId) {
        overrides.predecessor_task_id = options.predecessorTaskId;
        overrides.dedupe_key = `${normalDedupeKey(envelope.task)}:predecessor:${options.predecessorTaskId}:revision:${state.meta.revision}`;
      } else if (options.dedupeSuffix) overrides.dedupe_key = `${normalDedupeKey(envelope.task)}:${options.dedupeSuffix}`;
      const row = await repositories.runtime.createTask(taskRow(envelope, overrides), { client });
      return rowValue(row, "task_payload", "taskPayload") ?? envelope;
    };
    return options.client ? create(options.client) : repositories.withTransaction(create);
  }

  async function appendOps(envelope, outcome, attempt, detail, client) {
    metrics?.increment("memory_ops_outcomes_total", { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer, outcome });
    return repositories.runtime.appendOpsLog({
      user_id: envelope.task.userId, preset_id: envelope.task.presetId, source_generation: envelope.task.sourceGeneration,
      task_id: envelope.task.taskId, tick_id: envelope.task.tickId, target_key: envelope.task.targetKey,
      section: null, proposer: envelope.task.proposer, outcome, attempt, detail: detail ?? null,
    }, { client });
  }

  function observeTaskAge(task, workflow, targetKey) {
    const createdAt = rowValue(task, "created_at", "createdAt");
    if (!createdAt) return;
    const age = now().getTime() - new Date(createdAt).getTime();
    if (Number.isFinite(age)) metrics?.observe("memory_workflow_age_ms", { workflow, targetKey }, Math.max(0, age));
  }

  async function recordAdapterError(envelope, adapterResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task disappeared before provider error persistence");
      if (TERMINAL_TASK_STATUSES.has(task.status)) return { status: task.status, taskId: envelope.task.taskId, duplicate: true };
      const target = await repositories.runtime.getTargetStatus(envelope.task.userId, envelope.task.presetId, envelope.task.targetKey, { client, forUpdate: true });
      const attempt = numberValue(task, "attempt", "attempt") + 1;
      const consecutiveErrors = numberValue(target, "consecutive_errors", "consecutiveErrors") + 1;
      const retryable = RETRYABLE_ADAPTER_ERRORS.has(adapterResult.reason);
      const haltAfter = config.providerRecovery.haltAfterConsecutiveErrors;
      const maintenanceLimitReached = envelope.task.mode === "maintenance"
        && attempt > config.compaction.retryMax;
      const normalLimitReached = envelope.task.mode !== "maintenance"
        && attempt > config.providerRecovery.retryMax;
      const halted = !retryable || maintenanceLimitReached
        || normalLimitReached
        || (envelope.task.mode !== "maintenance" && consecutiveErrors >= haltAfter);
      const delay = retryable && !halted
        ? Math.min(config.providerRecovery.backoffMaxMs, config.providerRecovery.backoffBaseMs * (2 ** Math.max(0, attempt - 1)))
        : null;
      const retryAt = delay === null ? null : new Date(now().getTime() + delay).toISOString();
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: halted ? "failed" : "retry_wait", stage: "provider_error", attempt,
        not_before: retryAt, last_error_reason: adapterResult.reason,
      }, { client });
      const targetStatus = halted ? "halted" : envelope.task.mode === "maintenance" ? "capacity_blocked" : "retry_wait";
      if (halted) {
        metrics?.increment("memory_target_halted_total", { targetKey: envelope.task.targetKey, reason: adapterResult.reason });
        observeTaskAge(task, "halt", envelope.task.targetKey);
      }
      await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
        targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration,
        status: targetStatus, consecutiveErrors,
        lastErrorReason: adapterResult.reason, lastTaskId: envelope.task.taskId, nextRetryAt: retryAt,
      }, { client });
      const detail = ["output_schema_invalid", "semantic_schema_invalid"].includes(adapterResult.reason)
        ? schemaErrorLogDetail(adapterResult.detail, schemaRepairFeedback(adapterResult.detail, 0))
        : adapterResult.detail;
      await appendOps(envelope, adapterResult.reason, attempt, detail, client);
      return { ...adapterResult, taskId: envelope.task.taskId, halted, attempt, consecutiveErrors, notBefore: retryAt };
    });
  }

  async function reserveSchemaInvalidRetry(envelope, adapterResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task disappeared before schema retry persistence");
      if (TERMINAL_TASK_STATUSES.has(rowValue(task, "status", "status"))) return false;
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      const used = Number(stagePayload.schemaInvalidAttempts || 0);
      const limit = config.providerRecovery.schemaInvalidRetryMax;
      if (used >= limit) return false;
      const attempt = numberValue(task, "attempt", "attempt") + 1;
      stagePayload.schemaInvalidAttempts = used + 1;
      stagePayload.schemaRepairFeedback = schemaRepairFeedback(adapterResult.detail, stagePayload.schemaInvalidAttempts);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running", stage: "schema_invalid_retry", stage_payload: stagePayload,
        attempt, not_before: null, last_error_reason: "output_schema_invalid",
      }, { client });
      await appendOps(envelope, "output_schema_invalid_retry", attempt, {
        ...schemaErrorLogDetail(adapterResult.detail, stagePayload.schemaRepairFeedback),
        repairFeedback: stagePayload.schemaRepairFeedback,
      }, client);
      return stagePayload.schemaRepairFeedback;
    });
  }

  async function proposeWithSchemaRetry(envelope) {
    const persisted = repositories.runtime.getTask ? await repositories.runtime.getTask(envelope.task.taskId) : null;
    let repairFeedback = rowValue(persisted, "stage_payload", "stagePayload")?.schemaRepairFeedback ?? null;
    while (true) {
      const startedAt = monotonicNow();
      let result;
      try { result = await providerAdapter.propose(envelope, { repairFeedback }); }
      finally { metrics?.observe("memory_provider_latency_ms", { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer }, monotonicNow() - startedAt); }
      if (result.status === "deferred") {
        metrics?.increment("memory_provider_admission_deferred_total", { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer });
        return result;
      }
      metrics?.increment("memory_provider_calls_total", { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer, status: result.status });
      const messageCount = observedMessages(envelope).length;
      metrics?.increment("memory_provider_observed_messages_total", { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer }, messageCount);
      metrics?.observe("memory_provider_calls_per_message", { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer }, 1 / Math.max(1, messageCount));
      const inputTokens = Number(result.usage?.input_tokens ?? result.usage?.prompt_tokens);
      const outputTokens = Number(result.usage?.output_tokens ?? result.usage?.completion_tokens);
      if (Number.isFinite(inputTokens)) metrics?.observe("memory_provider_input_tokens", { targetKey: envelope.task.targetKey, model: result.model ?? "unknown" }, inputTokens);
      if (Number.isFinite(outputTokens)) metrics?.observe("memory_provider_output_tokens", { targetKey: envelope.task.targetKey, model: result.model ?? "unknown" }, outputTokens);
      if (result.status !== "error") {
        const validation = validateProviderOutput(result.output, envelope);
        if (!validation.ok) result = { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: validation.errors } };
      }
      const metricResult = result.status === "error" ? result.reason : "ok";
      metrics?.increment("memory_provider_results_total", {
        targetKey: envelope.task.targetKey,
        proposer: envelope.task.proposer,
        result: ADAPTER_METRIC_RESULTS.has(metricResult) ? metricResult : "unknown",
      });
      const retryableSchemaOutput = result.status === "error"
        && result.reason === "output_schema_invalid"
        && result.detail?.boundary === "output";
      if (!retryableSchemaOutput) return result;
      const reservedFeedback = await reserveSchemaInvalidRetry(envelope, result);
      if (!reservedFeedback) return result;
      repairFeedback = reservedFeedback;
    }
  }

  async function buildExpandedEnvelope(envelope, client, normalContextWindow) {
    if (envelope.task.mode !== "normal" || typeof repositories.source.getForceDrainWindow !== "function") return envelope;
    const targetConfig = config.targets[envelope.task.targetKey];
    const contextWindow = Number.isSafeInteger(normalContextWindow) && normalContextWindow > 0
      ? normalContextWindow
      : targetConfig?.contextWindow;
    const currentMessages = observedMessages(envelope);
    const newBatchSize = currentMessages.filter((message) => (
      message.id > envelope.task.cursorBefore && message.id <= envelope.task.targetMessageId
    )).length;
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || newBatchSize < 1) return envelope;
    const messages = await repositories.source.getForceDrainWindow(
      envelope.task.userId,
      envelope.task.presetId,
      envelope.task.cursorBefore,
      envelope.task.targetMessageId,
      {
        newBatchSize,
        contextWindow: Math.max(contextWindow * 2, currentMessages.length + newBatchSize),
      },
      { client },
    );
    if (!messages.length) return envelope;
    const expanded = {
      ...envelope,
      task: { ...envelope.task, observedMessageIds: messages.map((message) => message.id) },
      observedMessages: messages,
    };
    if (isSemanticTaskEnvelope(envelope)) expanded.artifact = expandProposerTaskArtifact(envelope.artifact, messages);
    return expanded;
  }

  async function expandContextForRetry(envelope, persistedTask) {
    const expansionAttempt = numberValue(persistedTask, "context_expansion_attempt", "contextExpansionAttempt");
    if (expansionAttempt < 1) return envelope;
    const existing = rowValue(persistedTask, "stage_payload", "stagePayload")?.expandedEnvelope;
    if (existing) return structuredClone(existing);
    // Backward-compatible recovery for tasks created before expandedEnvelope
    // became durable. The task row lock makes the first recovered expansion the
    // canonical input for every later delivery.
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task not found while persisting expanded context");
      const payload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      if (payload.expandedEnvelope) return payload.expandedEnvelope;
      const expandedEnvelope = await buildExpandedEnvelope(envelope, client, payload.normalContextWindow);
      payload.expandedEnvelope = structuredClone(expandedEnvelope);
      await repositories.runtime.updateTask(envelope.task.taskId, { stage_payload: payload }, { client });
      return expandedEnvelope;
    });
  }

  async function recordStale(envelope, reason, { cancel = true } = {}) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task not found while recording stale result");
      if (!TERMINAL_TASK_STATUSES.has(task.status) && cancel) await repositories.runtime.updateTask(envelope.task.taskId, { status: "cancelled", stage: "stale", last_error_reason: reason }, { client });
      metrics?.increment("memory_stale_results_total", { targetKey: envelope.task.targetKey, reason });
      await appendOps(envelope, "stale_result", numberValue(task, "attempt", "attempt"), { reason }, client);
      return { status: "stale", reason, taskId: envelope.task.taskId };
    });
  }

  async function handleUnableToDecide(envelope, output) {
    return repositories.withTransaction(async (client) => {
      const groupId = phaseId(envelope.task.taskId, "unable_cursor_commit");
      const existing = await repositories.audit.getEventGroup(groupId, { client });
      if (existing) return { status: "committed", revision: Number(existing.result_revision), duplicate: true, taskId: envelope.task.taskId };
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task not found for unable_to_decide");
      const expansionAttempt = numberValue(task, "context_expansion_attempt", "contextExpansionAttempt");
      const attempt = numberValue(task, "attempt", "attempt") + 1;
      if (expansionAttempt === 0) {
        const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
        stagePayload[isSemanticTaskEnvelope(envelope) ? "semanticResult" : "persistedProposal"] = structuredClone(output);
        stagePayload.expandedEnvelope = await buildExpandedEnvelope(envelope, client, stagePayload.normalContextWindow);
        await repositories.runtime.updateTask(envelope.task.taskId, {
          status: "queued", stage: "context_expansion", stage_payload: stagePayload,
          attempt, context_expansion_attempt: 1, not_before: null, last_error_reason: "unable_to_decide",
        }, { client });
        await appendOps(envelope, "unable_to_decide", attempt, { contextExpansionAttempt: 1 }, client);
        return { status: "context_expansion_required", taskId: envelope.task.taskId };
      }
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      const cursor = state.meta.targetCursors[envelope.task.targetKey] ?? 0;
      if (state.meta.sourceGeneration !== envelope.task.sourceGeneration || cursor !== envelope.task.cursorBefore) return { status: "stale", reason: state.meta.sourceGeneration !== envelope.task.sourceGeneration ? "generation_mismatch" : "cursor_mismatch", taskId: envelope.task.taskId };
      if (state.meta.revision !== envelope.task.baseRevision) {
        return { status: "successor_required", taskId: envelope.task.taskId, currentRevision: state.meta.revision };
      }
      const nextState = structuredClone(state);
      nextState.meta.revision += 1;
      nextState.meta.targetCursors[envelope.task.targetKey] = envelope.task.targetMessageId;
      await appendOps(envelope, "unable_to_decide", attempt, { contextExpansionAttempt: 1, terminal: true }, client);
      await repositories.state.writeState(envelope.task.userId, envelope.task.presetId, nextState, { client });
      await repositories.audit.insertEventGroup({
        event_group_id: groupId, user_id: envelope.task.userId, preset_id: envelope.task.presetId,
        task_id: envelope.task.taskId, target_key: envelope.task.targetKey, source_generation: envelope.task.sourceGeneration,
        schema_version: envelope.task.schemaVersion, base_revision: state.meta.revision, result_revision: nextState.meta.revision,
        cursor_before: envelope.task.cursorBefore, cursor_after: envelope.task.targetMessageId, group_kind: "proposal",
      }, { client });
      await repositories.audit.insertSnapshot(envelope.task.userId, envelope.task.presetId, { sourceGeneration: nextState.meta.sourceGeneration, revision: nextState.meta.revision, schemaVersion: envelope.task.schemaVersion, state: nextState }, { client });
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      stagePayload[isSemanticTaskEnvelope(envelope) ? "semanticResult" : "persistedProposal"] = structuredClone(output);
      await repositories.runtime.updateTask(envelope.task.taskId, { status: "succeeded", stage: "unable_cursor_committed", stage_payload: stagePayload, attempt, result_revision: nextState.meta.revision, not_before: null, last_error_reason: null }, { client });
      await recordSuccessfulTarget(repositories, envelope, client);
      return { status: "committed", taskId: envelope.task.taskId, revision: nextState.meta.revision, cursorOnly: true };
    });
  }

  async function compileSemanticProposal(envelope, semanticResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task not found while compiling Semantic result");
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      if (state.meta.sourceGeneration !== envelope.task.sourceGeneration) return { status: "stale", reason: "generation_mismatch", taskId: envelope.task.taskId };
      if ((state.meta.targetCursors[envelope.task.targetKey] ?? 0) !== envelope.task.cursorBefore) return { status: "stale", reason: "cursor_mismatch", taskId: envelope.task.taskId };
      if (state.meta.revision !== envelope.task.baseRevision) return { status: "successor_required", taskId: envelope.task.taskId, currentRevision: state.meta.revision };
      const payload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      payload.semanticResult = structuredClone(semanticResult);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running", stage: "compiling", stage_payload: payload,
        not_before: null, last_error_reason: null,
      }, { client });
      const compiledProposal = await semanticCompilerForTask().compile({
        artifact: envelope.artifact,
        semanticResult,
        baseState: state,
        userId: envelope.task.userId,
        presetId: envelope.task.presetId,
        client,
      });
      payload.compiledProposal = structuredClone(compiledProposal);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running", stage: "compiled_proposal_persisted", stage_payload: payload,
        not_before: null, last_error_reason: null,
      }, { client });
      return { status: "compiled", proposal: compiledProposal };
    });
  }

  async function recordCompileFailure(envelope, error) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw error;
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      if (state.meta.sourceGeneration !== envelope.task.sourceGeneration) return { status: "stale", reason: "generation_mismatch", taskId: envelope.task.taskId };
      if ((state.meta.targetCursors[envelope.task.targetKey] ?? 0) !== envelope.task.cursorBefore) return { status: "stale", reason: "cursor_mismatch", taskId: envelope.task.taskId };
      if (state.meta.revision !== envelope.task.baseRevision) return { status: "successor_required", taskId: envelope.task.taskId, currentRevision: state.meta.revision };
      const reason = COMPILE_ERROR_REASONS.includes(error?.code) ? error.code : "compile_invariant_failed";
      const attempt = numberValue(task, "attempt", "attempt") + 1;
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "failed", stage: "compile_failed", attempt,
        not_before: null, last_error_reason: reason,
      }, { client });
      const target = await repositories.runtime.getTargetStatus(envelope.task.userId, envelope.task.presetId, envelope.task.targetKey, { client, forUpdate: true });
      await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
        targetKey: envelope.task.targetKey,
        sourceGeneration: envelope.task.sourceGeneration,
        status: "halted",
        consecutiveErrors: numberValue(target, "consecutive_errors", "consecutiveErrors"),
        lastErrorReason: reason,
        lastTaskId: envelope.task.taskId,
        nextRetryAt: null,
      }, { client });
      metrics?.increment("memory_target_halted_total", { targetKey: envelope.task.targetKey, reason });
      observeTaskAge(task, "halt", envelope.task.targetKey);
      await appendOps(envelope, reason, attempt, error?.detail || { message: String(error?.message || reason).slice(0, 500) }, client);
      return { status: "halted", outcome: reason, taskId: envelope.task.taskId };
    });
  }

  async function commit(envelope, output) {
    const semantic = isSemanticTaskEnvelope(envelope);
    const outputValidation = semantic
      ? validateCompiledProposal(output, envelope.task)
      : validateProposerOutput(output, envelope.task);
    if (!outputValidation.ok) return recordAdapterError(envelope, { status: "error", reason: "output_schema_invalid", detail: { errors: outputValidation.errors } });
    if (!semantic && Object.values(output.sectionResults).some((result) => result.status === "unable_to_decide")) return handleUnableToDecide(envelope, output);
    return repositories.withTransaction(async (client) => {
      const groupId = phaseId(envelope.task.taskId);
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task not found during commit");
      const existing = await repositories.audit.getEventGroup(groupId, { client });
      if (existing) return { status: "committed", taskId: envelope.task.taskId, revision: Number(existing.result_revision), duplicate: true };
      const capacityGroup = await repositories.audit.getEventGroup(stablePhaseId(envelope.task.taskId, "capacity_blocked"), { client });
      if (capacityGroup) {
        const stagePayload = rowValue(task, "stage_payload", "stagePayload");
        if (!stagePayload?.maintenanceTaskId || !stagePayload?.blockingViolation || !stagePayload?.identities) {
          const error = new Error("Capacity-blocked task is missing its durable maintenance chain");
          error.memoryOutcome = "reducer_failed";
          throw error;
        }
        return {
          status: "capacity_deferred",
          taskId: envelope.task.taskId,
          maintenanceTaskId: stagePayload.maintenanceTaskId,
          duplicate: true,
        };
      }
      if (TERMINAL_TASK_STATUSES.has(task.status)) return { status: task.status, taskId: envelope.task.taskId, revision: task.result_revision ? Number(task.result_revision) : null, duplicate: true };
      if (["capacity_blocked", "replaying_original_proposal"].includes(rowValue(task, "stage", "stage"))) {
        const error = new Error("Capacity task stage exists without its stable audit phase");
        error.memoryOutcome = "reducer_failed";
        throw error;
      }
      if (!NORMAL_REDUCTION_STAGES.has(rowValue(task, "stage", "stage"))) {
        const error = new Error(`Normal task cannot reduce from stage ${rowValue(task, "stage", "stage")}`);
        error.memoryOutcome = "reducer_failed";
        throw error;
      }
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      if (state.meta.sourceGeneration !== envelope.task.sourceGeneration) return { status: "stale", reason: "generation_mismatch", taskId: envelope.task.taskId };
      if ((state.meta.targetCursors[envelope.task.targetKey] ?? 0) !== envelope.task.cursorBefore) return { status: "stale", reason: "cursor_mismatch", taskId: envelope.task.taskId };
      if (state.meta.revision !== envelope.task.baseRevision) return { status: "successor_required", taskId: envelope.task.taskId, currentRevision: state.meta.revision };
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      stagePayload[semantic ? "compiledProposal" : "persistedProposal"] = structuredClone(output);
      await repositories.runtime.updateTask(envelope.task.taskId, { status: "running", stage: "reducing", stage_payload: stagePayload }, { client });
      let reduction;
      try {
        if (semantic) {
          reduction = reduceCompiledProposalV201({
            state,
            task: envelope.task,
            proposal: output,
            now: envelope.task.now,
            config,
            idFactory,
          });
        } else {
          const effectiveDatabaseMessages = await loadEvidenceMessages(envelope, client);
          reduction = reduceProposal({ state, task: envelope.task, proposal: output, observedMessages: envelope.observedMessages, databaseMessages: effectiveDatabaseMessages, now: envelope.task.now, timeZone: envelope.task.userTimeZone, config, metrics, idFactory });
        }
      } catch (error) {
        error.memoryOutcome = "reducer_failed";
        throw error;
      }
      if (reduction.outcome === "deferred") return capacity.deferNormal({ parentEnvelope: envelope, state, proposal: output, reduction, client });
      await repositories.state.writeState(envelope.task.userId, envelope.task.presetId, reduction.state, { client });
      await repositories.audit.insertEventGroup({ event_group_id: groupId, user_id: envelope.task.userId, preset_id: envelope.task.presetId, task_id: envelope.task.taskId, target_key: envelope.task.targetKey, source_generation: envelope.task.sourceGeneration, schema_version: envelope.task.schemaVersion, base_revision: state.meta.revision, result_revision: reduction.state.meta.revision, cursor_before: envelope.task.cursorBefore, cursor_after: envelope.task.targetMessageId, group_kind: "proposal" }, { client });
      await repositories.audit.insertEvents(reduction.events.map((event, index) => mapEventToRow(event, envelope, groupId, index)), { client });
      await repositories.audit.insertSnapshot(envelope.task.userId, envelope.task.presetId, { sourceGeneration: reduction.state.meta.sourceGeneration, revision: reduction.state.meta.revision, schemaVersion: envelope.task.schemaVersion, state: reduction.snapshot }, { client });
      await repositories.runtime.updateTask(envelope.task.taskId, { status: "succeeded", stage: "committed", stage_payload: stagePayload, result_revision: reduction.state.meta.revision, not_before: null, last_error_reason: null }, { client });
      await recordSuccessfulTarget(repositories, envelope, client);
      return { status: "committed", taskId: envelope.task.taskId, revision: reduction.state.meta.revision, events: reduction.events };
    });
  }

  async function persistProposal(envelope, output) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task not found while persisting provider proposal");
      if (TERMINAL_TASK_STATUSES.has(rowValue(task, "status", "status"))) return null;
      const payload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      const semantic = isSemanticTaskEnvelope(envelope);
      payload[semantic ? "semanticResult" : "persistedProposal"] = structuredClone(output);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running", stage: semantic ? "semantic_result_persisted" : "proposal_persisted", stage_payload: payload,
        not_before: null, last_error_reason: null,
      }, { client });
      return output;
    });
  }

  async function persistProposalWithRecovery(envelope, output) {
    try {
      return await persistProposal(envelope, output);
    } catch (error) {
      if (!error?.commitOutcomeUnknown) throw error;
      const task = await repositories.runtime.getTask(envelope.task.taskId);
      const semantic = isSemanticTaskEnvelope(envelope);
      const persisted = rowValue(task, "stage_payload", "stagePayload")?.[semantic ? "semanticResult" : "persistedProposal"];
      const expectedStage = semantic ? "semantic_result_persisted" : "proposal_persisted";
      if (rowValue(task, "stage", "stage") === expectedStage && isDeepStrictEqual(persisted, output)) return output;
      return persistProposal(envelope, output);
    }
  }

  async function createSuccessor(envelope) {
    return repositories.withTransaction(async (client) => {
      const oldTask = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!oldTask) throw new Error("Predecessor task not found");
      if (oldTask.status === "cancelled") {
        const tasks = await repositories.runtime.listTasksForTarget(envelope.task.userId, envelope.task.presetId, envelope.task.targetKey, { client });
        const existing = tasks.find((task) => rowValue(task, "predecessor_task_id", "predecessorTaskId") === envelope.task.taskId);
        if (existing) return rowValue(existing, "task_payload", "taskPayload");
      }
      if (!TERMINAL_TASK_STATUSES.has(oldTask.status)) await repositories.runtime.updateTask(envelope.task.taskId, { status: "cancelled", stage: "superseded", last_error_reason: "revision_mismatch" }, { client });
      await appendOps(envelope, "stale_result", numberValue(oldTask, "attempt", "attempt"), { reason: "revision_mismatch", successorRequired: true }, client);
      const intent = { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer, targetSections: envelope.task.targetSections, trigger: envelope.task.trigger };
      return createTask(envelope.task.userId, envelope.task.presetId, intent, { client, messages: envelope.observedMessages, predecessorTaskId: envelope.task.taskId });
    });
  }

  async function recordExecutionFailure(envelope, outcome, error) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw error;
      const attempt = numberValue(task, "attempt", "attempt") + 1;
      const reducerFailed = outcome === "reducer_failed";
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: reducerFailed ? "failed" : "queued", stage: outcome, attempt,
        not_before: null, last_error_reason: outcome,
      }, { client });
      if (reducerFailed) {
        metrics?.increment("memory_target_halted_total", { targetKey: envelope.task.targetKey, reason: outcome });
        observeTaskAge(task, "halt", envelope.task.targetKey);
        const target = await repositories.runtime.getTargetStatus(envelope.task.userId, envelope.task.presetId, envelope.task.targetKey, { client, forUpdate: true });
        await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
          targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration, status: "halted",
          consecutiveErrors: numberValue(target, "consecutive_errors", "consecutiveErrors"), lastErrorReason: outcome,
          lastTaskId: envelope.task.taskId, nextRetryAt: null,
        }, { client });
      }
      await appendOps(envelope, outcome, attempt, { code: error?.code ?? null, message: String(error?.message ?? outcome).slice(0, 500) }, client);
      return { status: reducerFailed ? "halted" : "queued", outcome, taskId: envelope.task.taskId };
    });
  }

  async function commitWithRecovery(envelope, output) {
    try {
      return await commit(envelope, output);
    } catch (error) {
      if (error?.commitOutcomeUnknown) {
        const unable = Object.values(output.sectionResults).some((result) => result.status === "unable_to_decide");
        const identity = phaseId(envelope.task.taskId, unable ? "unable_cursor_commit" : "normal_commit");
        const existing = await repositories.audit.getEventGroup(identity);
        if (existing) return { status: "committed", taskId: envelope.task.taskId, revision: Number(existing.result_revision), duplicate: true, reconciledCommitOutcome: true };
        const capacityGroup = await repositories.audit.getEventGroup(stablePhaseId(envelope.task.taskId, "capacity_blocked"));
        if (capacityGroup) return { status: "capacity_deferred", taskId: envelope.task.taskId, duplicate: true, reconciledCommitOutcome: true };
        return recordExecutionFailure(envelope, "commit_outcome_unknown", error);
      }
      return recordExecutionFailure(envelope, error?.memoryOutcome === "reducer_failed" ? "reducer_failed" : "transaction_failed", error);
    }
  }

  async function processEnvelope(envelope) {
    if (envelope.task.mode === "maintenance") return capacity.processMaintenanceEnvelope(envelope);
    const persistedTask = repositories.runtime.getTask ? await repositories.runtime.getTask(envelope.task.taskId) : null;
    if (TERMINAL_TASK_STATUSES.has(rowValue(persistedTask, "status", "status"))) {
      const status = rowValue(persistedTask, "status", "status");
      return { status: status === "succeeded" ? "committed" : status, taskId: envelope.task.taskId, revision: Number(rowValue(persistedTask, "result_revision", "resultRevision")) || null, duplicate: true };
    }
    if (["capacity_blocked", "replaying_original_proposal"].includes(rowValue(persistedTask, "stage", "stage"))) return capacity.resumeParent(envelope);
    const group = await repositories.audit.getEventGroup(phaseId(envelope.task.taskId))
      ?? await repositories.audit.getEventGroup(phaseId(envelope.task.taskId, "unable_cursor_commit"));
    if (group) return { status: "committed", taskId: envelope.task.taskId, revision: Number(group.result_revision), duplicate: true };
    const attemptEnvelope = await expandContextForRetry(envelope, persistedTask);
    const semantic = isSemanticTaskEnvelope(attemptEnvelope);
    const stage = rowValue(persistedTask, "stage", "stage");
    const durablePayload = rowValue(persistedTask, "stage_payload", "stagePayload") || {};
    let semanticResult = semantic && ["semantic_result_persisted", "compiling", "compiled_proposal_persisted", "transaction_failed", "commit_outcome_unknown"].includes(stage)
      ? durablePayload.semanticResult
      : null;
    let output = semantic
      ? (["compiled_proposal_persisted", "transaction_failed", "commit_outcome_unknown"].includes(stage) ? durablePayload.compiledProposal : null)
      : (["proposal_persisted", "transaction_failed", "commit_outcome_unknown"].includes(stage) ? durablePayload.persistedProposal : null);
    if (!output && !semanticResult) {
      const adapterResult = await proposeWithSchemaRetry(attemptEnvelope);
      if (adapterResult.status === "deferred") {
        return { status: "queued", outcome: adapterResult.reason, taskId: envelope.task.taskId };
      }
      if (adapterResult.status === "error") {
        if (semantic && adapterResult.reason === "output_schema_invalid" && adapterResult.detail?.boundary === "output") {
          adapterResult.reason = "semantic_schema_invalid";
        }
        return recordAdapterError(envelope, adapterResult);
      }
      if (semantic) semanticResult = adapterResult.output;
      else output = adapterResult.output;
      await persistProposalWithRecovery(attemptEnvelope, adapterResult.output);
    }
    if (semantic && !output) {
      if (Object.values(semanticResult.sectionResults).some((result) => result.status === "unable_to_decide")) {
        const unable = await handleUnableToDecide(attemptEnvelope, semanticResult);
        if (unable.status === "successor_required") {
          const successor = await createSuccessor(attemptEnvelope);
          return processEnvelope(successor);
        }
        if (unable.status === "stale") return recordStale(attemptEnvelope, unable.reason);
        return unable;
      }
      let compiled;
      try {
        compiled = await compileSemanticProposal(attemptEnvelope, semanticResult);
      } catch (error) {
        compiled = await recordCompileFailure(attemptEnvelope, error instanceof SemanticCompileError ? error : new SemanticCompileError("compile_invariant_failed", { message: String(error?.message || error).slice(0, 500) }));
      }
      if (compiled.status === "successor_required") {
        const successor = await createSuccessor(attemptEnvelope);
        return processEnvelope(successor);
      }
      if (compiled.status === "stale") return recordStale(attemptEnvelope, compiled.reason);
      if (compiled.status !== "compiled") return compiled;
      output = compiled.proposal;
    }
    let result = await commitWithRecovery(attemptEnvelope, output);
    if (result.status === "successor_required") {
      const successor = await createSuccessor(attemptEnvelope);
      return processEnvelope(successor);
    }
    if (result.status === "stale") result = await recordStale(attemptEnvelope, result.reason);
    if (result.maintenanceEnvelope) return capacity.processMaintenanceEnvelope(result.maintenanceEnvelope);
    if (result.status === "capacity_deferred") return capacity.resumeParent(envelope);
    if (result.status === "committed" && !result.duplicate && !result.cursorOnly && !semantic) {
      const hygiene = await capacity.maybeRunHygiene(attemptEnvelope);
      if (hygiene.length) result.hygiene = hygiene;
    }
    metrics?.increment("memory_task_outcomes_total", { targetKey: envelope.task.targetKey, status: result.status, mode: envelope.task.mode });
    return result;
  }

  async function processIntent(userId, presetId, intent) { return processEnvelope(await createTask(userId, presetId, intent)); }
  async function processScope(userId, presetId) {
    const observation = await observer.observe(userId, presetId);
    const results = [];
    for (const intent of observation.eligibleTasks) results.push(await processIntent(userId, presetId, intent));
    return results;
  }
  return Object.freeze({ processScope, processIntent, processEnvelope, createTask, createSuccessor, commit, commitWithRecovery, persistProposal, persistProposalWithRecovery, recordAdapterError, capacity });
}

module.exports = { createNormalWritePipeline, phaseId, taskRow, mapEvent: mapEventToRow };
