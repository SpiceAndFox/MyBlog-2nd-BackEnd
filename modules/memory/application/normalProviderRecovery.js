const {
  appendRejectedOutputAttempt,
  createRepairFeedback,
  isTransportRepairFailure,
  latestRejectedOutput,
  repairAttemptCount,
  repairContextForInput,
  summarizeOutputShape,
} = require("./outputRepair");
const { providerBusinessRejection } = require("../infrastructure/providers/providerBusinessRejection");
const { providerFailureDecision } = require("./providerRecoveryPolicy");
const { createRetryBudget } = require("./retryBudget");

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const ADAPTER_METRIC_RESULTS = new Set([
  "ok",
  "llm_call_failed",
  "safety_policy_blocked",
  "max_output_truncated",
  "output_schema_invalid",
  "semantic_schema_invalid",
]);

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function numberValue(row, snake, camel, fallback = 0) {
  return Number(rowValue(row, snake, camel) ?? fallback);
}

function schemaErrorLogDetail(detail, feedback) {
  return {
    boundary: detail?.boundary ?? null,
    ...(detail?.validationLayer ? { validationLayer: detail.validationLayer } : {}),
    ...(detail?.specialist ? { specialist: detail.specialist } : {}),
    ...(detail?.shape ? { shape: detail.shape } : {}),
    ...(detail?.transportError ? { transportError: detail.transportError } : {}),
    ...(detail?.transportRecovery ? { transportRecovery: detail.transportRecovery } : {}),
    ...(detail?.finishReason ? { finishReason: detail.finishReason } : {}),
    repairPolicyVersion: feedback.policyVersion,
    errors: feedback.errors,
  };
}

function createNormalProviderRecovery({
  repositories,
  providerAdapter,
  config,
  metrics,
  monotonicNow,
  now,
  appendOps,
  observeTaskAge,
  observedMessages,
  validateProviderOutput,
  retryBudget = createRetryBudget(),
} = {}) {
  async function recordAdapterError(envelope, adapterResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task disappeared before provider error persistence");
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        return { status: task.status, taskId: envelope.task.taskId, duplicate: true };
      }
      const target = await repositories.runtime.getTargetStatus(
        envelope.task.userId,
        envelope.task.presetId,
        envelope.task.targetKey,
        { client, forUpdate: true },
      );
      const attempt = numberValue(task, "attempt", "attempt") + (adapterResult.noProviderCall ? 0 : 1);
      const counters = adapterResult.providerDecision?.counters || retryBudget.forTask(envelope.task);
      const consecutiveErrors = counters.boundedFailures + 1;
      const decision = adapterResult.providerDecision || providerFailureDecision({ counters, result: adapterResult, config: config.providerRecovery,
        retryMax: envelope.task.mode === "maintenance" ? config.compaction.retryMax : config.providerRecovery.retryMax,
        consecutiveErrors, haltAfter: envelope.task.mode === "maintenance" ? Infinity : config.providerRecovery.haltAfterConsecutiveErrors,
        now: now() });
      const { halted, notBefore: retryAt } = decision;
      const taskChanges = {
        status: halted ? "failed" : "retry_wait",
        stage: decision.budgetExhausted || adapterResult.retryBudgetExhausted ? "retry_budget_exhausted" : "provider_error",
        attempt,
        not_before: retryAt,
        last_error_reason: adapterResult.reason,
      };
      if (["output_schema_invalid", "semantic_schema_invalid"].includes(adapterResult.reason)) {
        const stagePayload = rowValue(task, "stage_payload", "stagePayload");
        taskChanges.stage_payload = appendRejectedOutputAttempt(
          taskChanges.stage_payload || stagePayload,
          adapterResult,
          repairAttemptCount(stagePayload),
          config.providerRecovery.schemaInvalidRetryMax
            + config.providerRecovery.transportInvalidRetryMax
            + 1,
        );
      }
      await repositories.runtime.updateTask(envelope.task.taskId, taskChanges, { client });
      const targetStatus = halted
        ? "halted"
        : envelope.task.mode === "maintenance"
          ? "capacity_blocked"
          : "retry_wait";
      if (halted) {
        metrics?.increment("memory_target_halted_total", {
          targetKey: envelope.task.targetKey,
          reason: adapterResult.reason,
        });
        observeTaskAge(task, "halt", envelope.task.targetKey);
      }
      await repositories.runtime.upsertTargetStatus(
        envelope.task.userId,
        envelope.task.presetId,
        {
          targetKey: envelope.task.targetKey,
          sourceGeneration: envelope.task.sourceGeneration,
          status: targetStatus,
          consecutiveErrors: counters.boundedFailures,
          lastErrorReason: adapterResult.reason,
          lastTaskId: envelope.task.taskId,
          nextRetryAt: retryAt,
        },
        { client },
      );
      const detail = ["output_schema_invalid", "semantic_schema_invalid"].includes(
        adapterResult.reason,
      )
        ? schemaErrorLogDetail(
          adapterResult.detail,
          createRepairFeedback(adapterResult.detail, 0, envelope.task),
        )
        : adapterResult.detail;
      await appendOps(envelope, adapterResult.reason, attempt, detail, client);
      const { rejectedOutput: _rejectedOutput, ...safeAdapterResult } = adapterResult;
      return {
        ...safeAdapterResult,
        taskId: envelope.task.taskId,
        halted,
        attempt,
        consecutiveErrors: counters.boundedFailures,
        notBefore: retryAt,
        recoveryKind: decision.kind,
        stage: taskChanges.stage,
        mode: envelope.task.mode,
        taskStatus: halted ? "failed" : "retry_wait",
      };
    });
  }

  async function recordProviderAdmissionDeferral(envelope) {
    const nextRetryAt = new Date(now().getTime() + config.providerRecovery.backoffBaseMs).toISOString();
    const reason = "provider_queue_full";
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task disappeared before provider deferral persistence");
      if (TERMINAL_TASK_STATUSES.has(rowValue(task, "status", "status"))) {
        return {
          status: rowValue(task, "status", "status"),
          taskId: envelope.task.taskId,
          duplicate: true,
        };
      }
      const target = await repositories.runtime.getTargetStatus(
        envelope.task.userId,
        envelope.task.presetId,
        envelope.task.targetKey,
        { client, forUpdate: true },
      );
      const taskStatus = "retry_wait";
      const targetStatus = envelope.task.mode === "maintenance" ? "capacity_blocked" : "retry_wait";
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: taskStatus,
        stage: "provider_queue_full",
        not_before: nextRetryAt,
        last_error_reason: reason,
      }, { client });
      await repositories.runtime.upsertTargetStatus(
        envelope.task.userId,
        envelope.task.presetId,
        {
          targetKey: envelope.task.targetKey,
          sourceGeneration: envelope.task.sourceGeneration,
          status: targetStatus,
          consecutiveErrors: numberValue(target, "consecutive_errors", "consecutiveErrors"),
          lastErrorReason: reason,
          lastTaskId: envelope.task.taskId,
          nextRetryAt,
        },
        { client },
      );
      await appendOps(
        envelope,
        reason,
        numberValue(task, "attempt", "attempt"),
        {
          nextRetryAt,
        },
        client,
      );
      return {
        status: "retry_wait",
        outcome: reason,
        taskId: envelope.task.taskId,
        notBefore: nextRetryAt,
      };
    });
  }

  async function reserveSchemaInvalidRetry(envelope, adapterResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Memory task disappeared before schema retry persistence");
      if (TERMINAL_TASK_STATUSES.has(rowValue(task, "status", "status"))) return false;
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      const transportFailure = isTransportRepairFailure(adapterResult.detail);
      const counters = retryBudget.forTask(envelope.task);
      const counter = transportFailure ? "transportFailures" : "schemaFailures";
      const used = counters[counter]++;
      const limit = transportFailure
        ? config.providerRecovery.transportInvalidRetryMax
        : config.providerRecovery.schemaInvalidRetryMax;
      if (used >= limit) { adapterResult.retryBudgetExhausted = true; return false; }
      const attempt = numberValue(task, "attempt", "attempt") + 1;
      const repairAttempt = repairAttemptCount(stagePayload);
      const nextStagePayload = appendRejectedOutputAttempt(
        stagePayload,
        adapterResult,
        repairAttempt,
        config.providerRecovery.schemaInvalidRetryMax
          + config.providerRecovery.transportInvalidRetryMax
          + 1,
      );
      nextStagePayload.schemaRepairFeedback = createRepairFeedback(
        adapterResult.detail,
        repairAttempt + 1,
        envelope.task,
      );
      nextStagePayload.schemaRepairFeedback.inputVariant = numberValue(task, "context_expansion_attempt", "contextExpansionAttempt") > 0
        ? "expanded" : "base";
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running",
        stage: "schema_invalid_retry",
        stage_payload: nextStagePayload,
        attempt,
        not_before: null,
        last_error_reason: "output_schema_invalid",
      }, { client });
      await appendOps(envelope, "output_schema_invalid_retry", attempt, {
        ...schemaErrorLogDetail(adapterResult.detail, nextStagePayload.schemaRepairFeedback),
        repairFeedback: nextStagePayload.schemaRepairFeedback,
      }, client);
      return {
        feedback: nextStagePayload.schemaRepairFeedback,
        rejectedOutput: latestRejectedOutput(nextStagePayload, nextStagePayload.schemaRepairFeedback),
      };
    });
  }

  async function proposeWithSchemaRetry(envelope, { signal } = {}) {
    const persisted = repositories.runtime.getTask
      ? await repositories.runtime.getTask(envelope.task.taskId)
      : null;
    const persistedStagePayload = rowValue(persisted, "stage_payload", "stagePayload");
    const inputVariant = numberValue(persisted, "context_expansion_attempt", "contextExpansionAttempt") > 0 ? "expanded" : "base";
    let { repairFeedback, rejectedOutput } = repairContextForInput(persistedStagePayload, inputVariant);
    while (true) {
      if (signal?.aborted) return { status: "deferred", reason: "operation_interrupted" };
      if (retryBudget.exhausted(envelope.task, config)) return { status: "error", reason: "retry_budget_exhausted",
        retryBudgetExhausted: true, noProviderCall: true, providerDecision: { halted: true, budgetExhausted: true,
          notBefore: null, kind: "bounded", counters: retryBudget.forTask(envelope.task) } };
      const startedAt = monotonicNow();
      let result;
      try {
        result = await providerAdapter.propose(envelope, { repairFeedback, rejectedOutput, signal });
      } finally {
        metrics?.observe(
          "memory_provider_latency_ms",
          { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer },
          monotonicNow() - startedAt,
        );
      }
      if (result.status === "deferred") {
        metrics?.increment("memory_provider_admission_deferred_total", {
          targetKey: envelope.task.targetKey,
          proposer: envelope.task.proposer,
        });
        return result;
      }
      // Connectivity recovered even if the response still needs output repair.
      // A different provider error is not a success and must not reset budgets.
      if (result.status === "ok" || result.reason === "output_schema_invalid") {
        retryBudget.providerSucceeded(envelope.task);
        if (!isTransportRepairFailure(result.detail)) retryBudget.forTask(envelope.task).transportFailures = 0;
      }
      const providerCallCount = Number.isSafeInteger(result.callCount) && result.callCount >= 0
        ? result.callCount
        : 1;
      metrics?.increment(
        "memory_provider_calls_total",
        {
          targetKey: envelope.task.targetKey,
          proposer: envelope.task.proposer,
          status: result.status,
        },
        providerCallCount,
      );
      const messageCount = observedMessages(envelope).length;
      metrics?.increment(
        "memory_provider_observed_messages_total",
        { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer },
        messageCount * providerCallCount,
      );
      metrics?.observe(
        "memory_provider_calls_per_message",
        { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer },
        providerCallCount / Math.max(1, messageCount),
      );
      const inputTokens = Number(result.usage?.input_tokens ?? result.usage?.prompt_tokens);
      if (result.protocol) {
        const protocolLabels = { targetKey: envelope.task.targetKey, outputProtocol: result.protocol.outputProtocol,
          outputChannel: result.protocol.outputChannel, rawSchemaValid: String(result.protocol.rawSchemaValid) };
        metrics?.increment("memory_provider_wire_results_total", protocolLabels);
        metrics?.observe("memory_provider_schema_bytes", { outputProtocol: result.protocol.outputProtocol }, result.protocol.schemaBytes);
        if (Number.isSafeInteger(result.protocol.wireSchemaBytes)) {
          metrics?.observe("memory_provider_wire_schema_bytes", { outputProtocol: result.protocol.outputProtocol }, result.protocol.wireSchemaBytes);
        }
        if (result.normalizations?.length) metrics?.increment("memory_provider_wire_normalizations_total", protocolLabels);
      }
      const outputTokens = Number(result.usage?.output_tokens ?? result.usage?.completion_tokens);
      if (Number.isFinite(inputTokens)) {
        metrics?.observe(
          "memory_provider_input_tokens",
          { targetKey: envelope.task.targetKey, model: result.model ?? "unknown" },
          inputTokens,
        );
      }
      if (Number.isFinite(outputTokens)) {
        metrics?.observe(
          "memory_provider_output_tokens",
          { targetKey: envelope.task.targetKey, model: result.model ?? "unknown" },
          outputTokens,
        );
      }
      if (result.status !== "error") {
        const validation = await validateProviderOutput(result.output, envelope);
        if (!validation.ok) {
          const feedback = providerBusinessRejection(result, validation, envelope.task);
          result = {
            ...result,
            status: "error",
            reason: "output_schema_invalid",
            detail: {
              boundary: "output",
              validationLayer: validation.validationLayer ?? "semantic",
              errors: feedback.errors,
              shape: summarizeOutputShape(feedback.rejectedOutput),
            },
            rejectedOutput: feedback.rejectedOutput,
            rejectedOutputKind: feedback.rejectedOutputKind,
          };
        }
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
      if (!retryableSchemaOutput) {
        if (result.status === "ok") retryBudget.outputSucceeded(envelope.task);
        return result;
      }
      const reserved = await reserveSchemaInvalidRetry(envelope, result);
      if (!reserved) return result;
      repairFeedback = reserved.feedback;
      rejectedOutput = reserved.rejectedOutput;
    }
  }

  return Object.freeze({
    recordAdapterError,
    recordProviderAdmissionDeferral,
    proposeWithSchemaRetry,
  });
}

module.exports = { createNormalProviderRecovery };
