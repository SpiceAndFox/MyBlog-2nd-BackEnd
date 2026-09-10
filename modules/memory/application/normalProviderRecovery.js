const {
  appendRejectedOutputAttempt,
  createRepairFeedback,
  isTransportRepairFailure,
  latestRejectedOutput,
  repairAttemptCount,
  summarizeOutputShape,
} = require("./outputRepair");
const { providerBusinessRejection } = require("../infrastructure/providers/providerBusinessRejection");

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const RETRYABLE_ADAPTER_ERRORS = new Set([
  "llm_call_failed",
  "safety_policy_blocked",
  "max_output_truncated",
]);
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
      const attempt = numberValue(task, "attempt", "attempt") + 1;
      const consecutiveErrors = numberValue(
        target,
        "consecutive_errors",
        "consecutiveErrors",
      ) + 1;
      const retryable = RETRYABLE_ADAPTER_ERRORS.has(adapterResult.reason);
      const haltAfter = config.providerRecovery.haltAfterConsecutiveErrors;
      const maintenanceLimitReached = envelope.task.mode === "maintenance"
        && attempt > config.compaction.retryMax;
      const normalLimitReached = envelope.task.mode !== "maintenance"
        && attempt > config.providerRecovery.retryMax;
      const halted = !retryable
        || maintenanceLimitReached
        || normalLimitReached
        || (envelope.task.mode !== "maintenance" && consecutiveErrors >= haltAfter);
      const delay = retryable && !halted
        ? Math.min(
          config.providerRecovery.backoffMaxMs,
          config.providerRecovery.backoffBaseMs * (2 ** Math.max(0, attempt - 1)),
        )
        : null;
      const retryAt = delay === null ? null : new Date(now().getTime() + delay).toISOString();
      const taskChanges = {
        status: halted ? "failed" : "retry_wait",
        stage: "provider_error",
        attempt,
        not_before: retryAt,
        last_error_reason: adapterResult.reason,
      };
      if (["output_schema_invalid", "semantic_schema_invalid"].includes(adapterResult.reason)) {
        const stagePayload = rowValue(task, "stage_payload", "stagePayload");
        taskChanges.stage_payload = appendRejectedOutputAttempt(
          stagePayload,
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
          consecutiveErrors,
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
        consecutiveErrors,
        notBefore: retryAt,
      };
    });
  }

  async function recordProviderCircuitDeferral(envelope, adapterResult) {
    const providerHealth = adapterResult.providerHealth || {};
    const needsAttention = providerHealth.status === "needs_attention";
    const nextRetryAt = needsAttention ? null : providerHealth.nextRetryAt || null;
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
      const taskStatus = needsAttention ? "failed" : "retry_wait";
      const targetStatus = needsAttention ? "halted" : "retry_wait";
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: taskStatus,
        stage: "provider_circuit_open",
        not_before: nextRetryAt,
        last_error_reason: "provider_circuit_open",
      }, { client });
      await repositories.runtime.upsertTargetStatus(
        envelope.task.userId,
        envelope.task.presetId,
        {
          targetKey: envelope.task.targetKey,
          sourceGeneration: envelope.task.sourceGeneration,
          status: targetStatus,
          consecutiveErrors: numberValue(target, "consecutive_errors", "consecutiveErrors"),
          lastErrorReason: "provider_circuit_open",
          lastTaskId: envelope.task.taskId,
          nextRetryAt,
        },
        { client },
      );
      await appendOps(
        envelope,
        "provider_circuit_open",
        numberValue(task, "attempt", "attempt"),
        {
          providerStatus: providerHealth.status || "degraded",
          nextRetryAt,
        },
        client,
      );
      return {
        status: needsAttention ? "halted" : "retry_wait",
        outcome: "provider_circuit_open",
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
      const counter = transportFailure ? "transportInvalidAttempts" : "schemaInvalidAttempts";
      const used = Number(stagePayload[counter] || 0);
      const limit = transportFailure
        ? config.providerRecovery.transportInvalidRetryMax
        : config.providerRecovery.schemaInvalidRetryMax;
      if (used >= limit) return false;
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
      nextStagePayload[counter] = used + 1;
      nextStagePayload.schemaRepairFeedback = createRepairFeedback(
        adapterResult.detail,
        repairAttempt + 1,
        envelope.task,
      );
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

  async function proposeWithSchemaRetry(envelope) {
    const persisted = repositories.runtime.getTask
      ? await repositories.runtime.getTask(envelope.task.taskId)
      : null;
    const persistedStagePayload = rowValue(persisted, "stage_payload", "stagePayload");
    let repairFeedback = persistedStagePayload?.schemaRepairFeedback ?? null;
    let rejectedOutput = latestRejectedOutput(persistedStagePayload, repairFeedback);
    while (true) {
      const startedAt = monotonicNow();
      let result;
      try {
        result = await providerAdapter.propose(envelope, { repairFeedback, rejectedOutput });
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
      const providerCallCount = Number.isSafeInteger(result.callCount) && result.callCount > 0
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
      if (!retryableSchemaOutput) return result;
      const reserved = await reserveSchemaInvalidRetry(envelope, result);
      if (!reserved) return result;
      repairFeedback = reserved.feedback;
      rejectedOutput = reserved.rejectedOutput;
    }
  }

  return Object.freeze({
    recordAdapterError,
    recordProviderCircuitDeferral,
    proposeWithSchemaRetry,
  });
}

module.exports = { createNormalProviderRecovery };
