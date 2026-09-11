const crypto = require("node:crypto");
const { hydrateEvidenceInput } = require("./evidenceInput");
const { normalizeSourceMessage } = require("../domain/semanticCompiler");
const {
  SCHEMA_VERSION,
  LIBRARIAN_TARGET_KEY,
  LIBRARIAN_SECTIONS,
} = require("../contracts");
const { compileLibrarianProposal, reduceLibrarianProposal } = require("../domain/librarian");
const { buildLibrarianEnvelope, librarianDedupeKey } = require("./librarianRenderer");
const { mapEventToRow } = require("./eventMapper");
const { providerFailureDecision } = require("./providerRecoveryPolicy");
const { createRetryBudget } = require("./retryBudget");
const {
  appendRejectedOutputAttempt,
  createRepairFeedback,
  isTransportRepairFailure,
  latestRejectedOutput,
  repairAttemptCount,
} = require("./outputRepair");

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Memory Librarian ${label} must be a non-negative safe integer`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Memory Librarian ${label} must be a positive safe integer`);
  }
}

function validateLibrarianConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Memory Librarian config is required");
  const recovery = config.providerRecovery;
  if (!recovery || typeof recovery !== "object") {
    throw new Error("Memory Librarian providerRecovery config is required");
  }
  requireNonNegativeInteger(recovery.retryMax, "providerRecovery.retryMax");
  requireNonNegativeInteger(recovery.transientRetryMax, "providerRecovery.transientRetryMax");
  requireNonNegativeInteger(recovery.transportInvalidRetryMax, "providerRecovery.transportInvalidRetryMax");
  requireNonNegativeInteger(recovery.schemaInvalidRetryMax, "providerRecovery.schemaInvalidRetryMax");
  requirePositiveInteger(recovery.backoffBaseMs, "providerRecovery.backoffBaseMs");
  requirePositiveInteger(recovery.backoffMaxMs, "providerRecovery.backoffMaxMs");
  if (!config.librarian || typeof config.librarian !== "object") {
    throw new Error("Memory Librarian scheduling config is required");
  }
  requirePositiveInteger(config.librarian.lagThreshold, "librarian.lagThreshold");
  if (!config.sectionBudgets || typeof config.sectionBudgets !== "object") {
    throw new Error("Memory Librarian sectionBudgets config is required");
  }
  for (const section of LIBRARIAN_SECTIONS) {
    const budget = config.sectionBudgets[section];
    if (!budget || typeof budget !== "object") {
      throw new Error(`Memory Librarian section budget is required for ${section}`);
    }
    requirePositiveInteger(budget.maxItems, `sectionBudgets.${section}.maxItems`);
    requirePositiveInteger(budget.maxRenderedChars, `sectionBudgets.${section}.maxRenderedChars`);
  }
}

function validateLibrarianRepositories(repositories) {
  const requiredMethods = [
    ["withTransaction", repositories?.withTransaction],
    ["state.getState", repositories?.state?.getState],
    ["state.writeState", repositories?.state?.writeState],
    ["runtime.createTask", repositories?.runtime?.createTask],
    ["runtime.getTask", repositories?.runtime?.getTask],
    ["runtime.getTaskForUpdate", repositories?.runtime?.getTaskForUpdate],
    ["runtime.updateTask", repositories?.runtime?.updateTask],
    ["runtime.appendOpsLog", repositories?.runtime?.appendOpsLog],
    ["runtime.upsertLibrarianCheckpoint", repositories?.runtime?.upsertLibrarianCheckpoint],
    ["audit.insertSnapshot", repositories?.audit?.insertSnapshot],
    ["audit.insertEventGroup", repositories?.audit?.insertEventGroup],
    ["audit.insertEvents", repositories?.audit?.insertEvents],
    ["userTimeZones.getTimeZone", repositories?.userTimeZones?.getTimeZone],
  ];
  const missing = requiredMethods
    .filter(([, value]) => typeof value !== "function")
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Memory Librarian repository methods are required: ${missing.join(", ")}`);
  }
}

function librarianTaskRow(envelope) {
  const task = envelope.task;
  return {
    task_id: task.taskId,
    dedupe_key: librarianDedupeKey(task),
    user_id: task.userId,
    preset_id: task.presetId,
    target_key: LIBRARIAN_TARGET_KEY,
    source_generation: task.sourceGeneration,
    schema_version: task.schemaVersion,
    task_type: "maintenance",
    parent_task_id: null,
    predecessor_task_id: null,
    resume_epoch: 0,
    status: "queued",
    stage: "created",
    cursor_before: null,
    target_message_id: null,
    base_revision: task.baseRevision,
    task_payload: envelope,
    stage_payload: null,
    attempt: 0,
    context_expansion_attempt: 0,
    not_before: null,
    last_error_reason: null,
    result_revision: null,
  };
}

function createLibrarianTaskExecutor({
  repositories,
  providerAdapter,
  config,
  now = () => new Date(),
  idFactory = () => crypto.randomUUID(),
  metrics,
  retryBudget = createRetryBudget(),
} = {}) {
  validateLibrarianRepositories(repositories);
  if (!providerAdapter?.propose) throw new Error("Memory Librarian provider adapter is required");
  validateLibrarianConfig(config);

  async function appendOps(envelope, outcome, attempt, detail, client) {
    metrics?.increment("memory_ops_outcomes_total", {
      targetKey: LIBRARIAN_TARGET_KEY,
      proposer: envelope.task.proposer,
      outcome,
    });
    return repositories.runtime.appendOpsLog({
      user_id: envelope.task.userId,
      preset_id: envelope.task.presetId,
      source_generation: envelope.task.sourceGeneration,
      task_id: envelope.task.taskId,
      tick_id: envelope.task.tickId,
      target_key: LIBRARIAN_TARGET_KEY,
      section: null,
      proposer: envelope.task.proposer,
      outcome,
      attempt,
      detail: detail ?? null,
    }, { client });
  }

  async function createTask(userId, presetId, {
    boundaryMessageId,
    watermarkOrdinal,
    watermarkKind = "complete_turn",
    triggerType,
    taskId,
    tickId,
    resumeFailed = false,
  } = {}) {
    return repositories.withTransaction(async (client) => {
      const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!state) throw new Error("Memory state must be initialized before creating a Librarian task");
      const userTimeZone = await repositories.userTimeZones.getTimeZone(userId, { client });
      const envelope = buildLibrarianEnvelope({
        userId,
        presetId,
        state,
        config,
        boundaryMessageId,
        watermarkOrdinal,
        watermarkKind,
        triggerType,
        now: now(),
        userTimeZone,
        taskId,
        tickId,
      });
      await hydrateEvidenceInput(envelope, repositories.source, { client });
      const canonicalKey = librarianDedupeKey(envelope.task);
      let row = await repositories.runtime.getLatestTaskForDedupeKey?.(userId, presetId, canonicalKey, { client })
        || await repositories.runtime.createTask(librarianTaskRow(envelope), { client });
      if (String(rowValue(row, "task_id", "taskId")) !== envelope.task.taskId
        && ((resumeFailed && row.status === "failed")
          || (row.status === "cancelled" && rowValue(row, "last_error_reason", "lastErrorReason") === "revision_mismatch"))) {
        const retryEnvelope = buildLibrarianEnvelope({
          userId,
          presetId,
          state,
          config,
          boundaryMessageId,
          watermarkOrdinal,
          watermarkKind,
          triggerType,
          now: now(),
          userTimeZone,
        });
        await hydrateEvidenceInput(retryEnvelope, repositories.source, { client });
        const retryRow = librarianTaskRow(retryEnvelope);
        retryRow.predecessor_task_id = rowValue(row, "task_id", "taskId");
        retryRow.dedupe_key = `${canonicalKey}:retry:${retryRow.predecessor_task_id}`;
        row = await repositories.runtime.createTask(retryRow, { client });
        return rowValue(row, "task_payload", "taskPayload") ?? retryEnvelope;
      }
      return rowValue(row, "task_payload", "taskPayload") ?? envelope;
    });
  }

  async function persistFailure(envelope, reason, detail = null, rejectedOutput, retryBudgetExhausted = false, providerDecision, noProviderCall = false) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before failure persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) {
        return { status: rowValue(task, "status", "status"), taskId: envelope.task.taskId, duplicate: true };
      }
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + (noProviderCall ? 0 : 1);
      const decision = providerDecision || providerFailureDecision({ counters: retryBudget.forTask(envelope.task), result: { reason, detail },
        config: config.providerRecovery, retryMax: config.providerRecovery.retryMax, now: now() });
      const { halted: exhausted, notBefore } = decision;
      const taskChanges = {
        status: exhausted ? "failed" : "retry_wait",
        stage: decision.budgetExhausted || retryBudgetExhausted ? "retry_budget_exhausted" : exhausted ? "failed" : "retry_wait",
        attempt,
        not_before: notBefore,
        last_error_reason: reason,
      };
      if (reason === "output_schema_invalid") {
        const stagePayload = rowValue(task, "stage_payload", "stagePayload");
        taskChanges.stage_payload = appendRejectedOutputAttempt(
          stagePayload,
          { rejectedOutput },
          repairAttemptCount(stagePayload),
          config.providerRecovery.schemaInvalidRetryMax
            + config.providerRecovery.transportInvalidRetryMax
            + 1,
        );
      }
      await repositories.runtime.updateTask(envelope.task.taskId, taskChanges, { client });
      await appendOps(envelope, exhausted ? "failed" : "retry_wait", attempt, { reason, detail }, client);
      return { status: exhausted ? "failed" : "retry_wait", reason, taskId: envelope.task.taskId, notBefore, recoveryKind: decision.kind,
        stage: taskChanges.stage, mode: "librarian" };
    });
  }

  async function persistAdmissionDeferral(envelope) {
    const reason = "provider_queue_full";
    const fallbackRetryAt = new Date(
      now().getTime() + config.providerRecovery.backoffBaseMs,
    );
    const notBefore = fallbackRetryAt.toISOString();
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before admission deferral persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) {
        return { status: rowValue(task, "status", "status"), taskId: envelope.task.taskId, duplicate: true };
      }
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "retry_wait",
        stage: "provider_queue_full",
        not_before: notBefore,
        last_error_reason: reason,
      }, { client });
      await appendOps(envelope, reason, Number(rowValue(task, "attempt", "attempt") ?? 0), {
        nextRetryAt: notBefore,
      }, client);
      return {
        status: "retry_wait",
        reason,
        taskId: envelope.task.taskId,
        notBefore,
      };
    });
  }

  async function reserveSchemaInvalidRetry(envelope, adapterResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before schema retry persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) return null;
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      const transportFailure = isTransportRepairFailure(adapterResult.detail);
      const counters = retryBudget.forTask(envelope.task);
      const counter = transportFailure ? "transportFailures" : "schemaFailures";
      const used = counters[counter]++;
      const limit = transportFailure
        ? config.providerRecovery.transportInvalidRetryMax
        : config.providerRecovery.schemaInvalidRetryMax;
      if (used >= limit) { adapterResult.retryBudgetExhausted = true; return null; }
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
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
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running",
        stage: "schema_invalid_retry",
        stage_payload: nextStagePayload,
        attempt,
        not_before: null,
        last_error_reason: "output_schema_invalid",
      }, { client });
      await appendOps(envelope, "output_schema_invalid_retry", attempt, {
        repairFeedback: nextStagePayload.schemaRepairFeedback,
      }, client);
      return {
        feedback: nextStagePayload.schemaRepairFeedback,
        rejectedOutput: latestRejectedOutput(nextStagePayload, nextStagePayload.schemaRepairFeedback),
      };
    });
  }

  async function proposeWithRecovery(envelope, { signal } = {}) {
    const persisted = await repositories.runtime.getTask(envelope.task.taskId);
    const persistedStagePayload = rowValue(persisted, "stage_payload", "stagePayload");
    let repairFeedback = persistedStagePayload?.schemaRepairFeedback ?? null;
    let rejectedOutput = latestRejectedOutput(persistedStagePayload, repairFeedback);
    while (true) {
      if (signal?.aborted) return { terminalResult: { status: "interrupted", reason: "cancelled", taskId: envelope.task.taskId } };
      if (retryBudget.exhausted(envelope.task, config)) return { terminalResult:
        await persistFailure(envelope, "retry_budget_exhausted", null, undefined, true,
          { halted: true, budgetExhausted: true, notBefore: null, kind: "bounded", counters: retryBudget.forTask(envelope.task) }, true) };
      let adapterResult = await providerAdapter.propose(envelope, { repairFeedback, rejectedOutput, signal });
      if (adapterResult.status === "deferred" && adapterResult.reason === "operation_interrupted") {
        return { terminalResult: { status: "interrupted", reason: "cancelled", taskId: envelope.task.taskId } };
      }
      if (adapterResult.status === "ok" || adapterResult.reason === "output_schema_invalid") {
        retryBudget.providerSucceeded(envelope.task);
        if (!isTransportRepairFailure(adapterResult.detail)) retryBudget.forTask(envelope.task).transportFailures = 0;
      }
      if (adapterResult.status === "ok") {
        const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId);
        if (state?.meta.revision === envelope.task.baseRevision && state.meta.sourceGeneration === envelope.task.sourceGeneration) {
          try {
            const proposal = compileLibrarianProposal({ artifact: envelope.artifact, semanticResult: adapterResult.output, baseState: state });
            let serial = 0;
            reduceLibrarianProposal({ state, task: envelope.task, proposal, config, idFactory: () => 'preview-' + envelope.task.taskId + '-' + ++serial });
          } catch (error) {
            if (!["MEMORY_LIBRARIAN_PROPOSAL_INVALID", "MEMORY_WRITE_GUARD_INVALID"].includes(error.code)) throw error;
            adapterResult = { status: "error", reason: "output_schema_invalid", rejectedOutput: adapterResult.output,
              detail: { boundary: "output", errors: error.validationErrors || error.detail?.errors || [{ path: "$.operations", message: error.reason || error.message }] } };
          }
        }
      }
      if (adapterResult.status === "deferred" && adapterResult.reason === "provider_queue_full") {
        return { terminalResult: await persistAdmissionDeferral(envelope, adapterResult) };
      }
      const retryableSchemaOutput = adapterResult.status === "error"
        && adapterResult.reason === "output_schema_invalid"
        && adapterResult.detail?.boundary === "output";
      if (!retryableSchemaOutput) {
        if (adapterResult.status === "ok") retryBudget.outputSucceeded(envelope.task);
        return { adapterResult };
      }
      const reserved = await reserveSchemaInvalidRetry(envelope, adapterResult);
      if (!reserved) return { adapterResult };
      repairFeedback = reserved.feedback;
      rejectedOutput = reserved.rejectedOutput;
    }
  }

  async function persistSemanticResult(envelope, semanticResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before Semantic result persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) return false;
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      stagePayload.semanticResult = structuredClone(semanticResult);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running",
        stage: "semantic_result_persisted",
        stage_payload: stagePayload,
        not_before: null,
        last_error_reason: null,
      }, { client });
      return true;
    });
  }

  async function validateSources(envelope, proposal, state, client) {
    const refs = [];
    for (const op of proposal.operations || []) {
      refs.push(...(op.sourceRefs || []), ...(op.parts || []).flatMap(part => part.sourceRefs || []));
      for (const selector of [op.source, op.keeper, ...(op.sources || []), ...(op.duplicates || [])].filter(Boolean)) {
        const items = selector.section === "standingAgreements" ? state.working.standingAgreements : state.longTerm[selector.section];
        refs.push(...items.find(item => item.id === selector.itemId).sourceRefs);
      }
    }
    if (!refs.length) return;
    const rows = await repositories.source.getByIds(envelope.task.userId, envelope.task.presetId, [...new Set(refs.map(ref => ref.messageId))], { client });
    const messages = new Map(rows.map(row => { const m = normalizeSourceMessage(row); return [m.id, m]; }));
    for (const ref of refs) {
      const m = messages.get(ref.messageId);
      if (!m || m.contentHash !== ref.contentHash
        || (m.userId !== undefined && Number(m.userId) !== envelope.task.userId)
        || (m.presetId !== undefined && String(m.presetId) !== envelope.task.presetId)) {
        const error = new Error("Librarian evidence changed or disappeared");
        error.reason = "source_validation_failed";
        throw error;
      }
    }
  }

  async function processEnvelope(envelope, { signal } = {}) {
    if (signal?.aborted) return { status: "interrupted", reason: "cancelled", taskId: envelope.task.taskId };
    const persisted = await repositories.runtime.getTask(envelope.task.taskId);
    if (!persisted) throw new Error("Librarian task is not durable");
    const persistedStatus = rowValue(persisted, "status", "status");
    if (TERMINAL.has(persistedStatus)) {
      return {
        status: persistedStatus === "succeeded" ? "completed" : persistedStatus,
        taskId: envelope.task.taskId,
        revision: rowValue(persisted, "result_revision", "resultRevision") ?? null,
        duplicate: true,
        reason: rowValue(persisted, "last_error_reason", "lastErrorReason") ?? null,
      };
    }
    const persistedNotBefore = rowValue(persisted, "not_before", "notBefore");
    if (persistedStatus === "retry_wait" && persistedNotBefore && new Date(persistedNotBefore).getTime() > now().getTime()) {
      return {
        status: "retry_wait",
        reason: rowValue(persisted, "last_error_reason", "lastErrorReason") || "retry_wait",
        taskId: envelope.task.taskId,
        notBefore: persistedNotBefore,
        stage: persisted.stage,
        mode: envelope.task.mode,
      };
    }
    const current = await repositories.state.getState(envelope.task.userId, envelope.task.presetId);
    if (!current || current.meta.sourceGeneration !== envelope.task.sourceGeneration || current.meta.revision !== envelope.task.baseRevision) {
      await repositories.withTransaction(async (client) => {
        const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
        if (task && !TERMINAL.has(rowValue(task, "status", "status"))) {
          await repositories.runtime.updateTask(envelope.task.taskId, {
            status: "cancelled",
            stage: "stale",
            not_before: null,
            last_error_reason: "revision_mismatch",
          }, { client });
          await appendOps(envelope, "stale", Number(rowValue(task, "attempt", "attempt") ?? 0), {
            expectedRevision: envelope.task.baseRevision,
            actualRevision: current?.meta?.revision ?? null,
          }, client);
        }
      });
      return { status: "stale", reason: "revision_mismatch", taskId: envelope.task.taskId };
    }

    const durablePayload = rowValue(persisted, "stage_payload", "stagePayload");
    let semanticResult = durablePayload?.semanticResult || null;
    if (!semanticResult) {
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running",
        stage: "proposing",
        not_before: null,
        last_error_reason: null,
      });
      const proposed = await proposeWithRecovery(envelope, { signal });
      if (proposed.terminalResult) return proposed.terminalResult;
      const { adapterResult } = proposed;
      if (adapterResult.status !== "ok") {
        return persistFailure(
          envelope,
          adapterResult.reason || "llm_call_failed",
          adapterResult.detail,
          adapterResult.rejectedOutput,
          adapterResult.retryBudgetExhausted,
          adapterResult.providerDecision,
          adapterResult.noProviderCall,
        );
      }
      semanticResult = adapterResult.output;
      await persistSemanticResult(envelope, semanticResult);
    }

    let proposal;
    try {
      proposal = compileLibrarianProposal({
        artifact: envelope.artifact,
        semanticResult,
        baseState: current,
      });
    } catch (error) {
      return persistFailure(envelope, error.reason || "compile_invariant_failed", error.detail || { message: error.message });
    }

    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before commit");
      if (TERMINAL.has(rowValue(task, "status", "status"))) {
        return {
          status: rowValue(task, "status", "status") === "succeeded" ? "completed" : rowValue(task, "status", "status"),
          taskId: envelope.task.taskId,
          duplicate: true,
        };
      }
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      if (!state || state.meta.sourceGeneration !== envelope.task.sourceGeneration || state.meta.revision !== envelope.task.baseRevision) {
        await repositories.runtime.updateTask(envelope.task.taskId, {
          status: "cancelled", stage: "stale", not_before: null, last_error_reason: "revision_mismatch",
        }, { client });
        await appendOps(envelope, "stale", Number(rowValue(task, "attempt", "attempt") ?? 0), {
          expectedRevision: envelope.task.baseRevision,
          actualRevision: state?.meta?.revision ?? null,
        }, client);
        return { status: "stale", reason: "revision_mismatch", taskId: envelope.task.taskId };
      }

      let reduction;
      try {
        reduction = reduceLibrarianProposal({ state, task: envelope.task, proposal, config, idFactory });
        await validateSources(envelope, proposal, state, client);
      } catch (error) {
        await repositories.runtime.updateTask(envelope.task.taskId, {
          status: "failed", stage: "failed", not_before: null, last_error_reason: error.reason || "compile_invariant_failed",
        }, { client });
        await appendOps(envelope, "failed", Number(rowValue(task, "attempt", "attempt") ?? 0), {
          reason: error.reason || "compile_invariant_failed",
          detail: error.detail || { message: error.message },
        }, client);
        return { status: "failed", reason: error.reason || "compile_invariant_failed", taskId: envelope.task.taskId };
      }

      if (reduction.outcome === "noop") {
        await repositories.runtime.upsertLibrarianCheckpoint(envelope.task.userId, envelope.task.presetId, {
          sourceGeneration: envelope.task.sourceGeneration,
          completedOrdinal: envelope.task.watermarkOrdinal,
          watermarkKind: envelope.task.watermarkKind,
          boundaryMessageId: envelope.task.boundaryMessageId,
          lastTaskId: envelope.task.taskId,
        }, { client });
        await repositories.runtime.updateTask(envelope.task.taskId, {
          status: "succeeded", stage: "noop", result_revision: null, not_before: null, last_error_reason: null,
        }, { client });
        await appendOps(envelope, "noop", Number(rowValue(task, "attempt", "attempt") ?? 0), {
          boundaryMessageId: envelope.task.boundaryMessageId,
          watermarkOrdinal: envelope.task.watermarkOrdinal,
          reports: semanticResult.reports || [],
        }, client);
        return { status: "noop", taskId: envelope.task.taskId, revision: state.meta.revision };
      }

      await repositories.state.writeState(envelope.task.userId, envelope.task.presetId, reduction.state, { client });
      await repositories.audit.insertSnapshot(envelope.task.userId, envelope.task.presetId, {
        sourceGeneration: envelope.task.sourceGeneration,
        revision: reduction.state.meta.revision,
        schemaVersion: SCHEMA_VERSION,
        state: reduction.snapshot,
      }, { client });
      const groupId = idFactory();
      await repositories.audit.insertEventGroup({
        event_group_id: groupId,
        user_id: envelope.task.userId,
        preset_id: envelope.task.presetId,
        task_id: envelope.task.taskId,
        target_key: LIBRARIAN_TARGET_KEY,
        source_generation: envelope.task.sourceGeneration,
        schema_version: SCHEMA_VERSION,
        base_revision: state.meta.revision,
        result_revision: reduction.state.meta.revision,
        cursor_before: null,
        cursor_after: null,
        group_kind: "maintenance",
      }, { client });
      await repositories.audit.insertEvents(
        reduction.events.map((event, index) => mapEventToRow(event, envelope, groupId, index)),
        { client },
      );
      await repositories.runtime.upsertLibrarianCheckpoint(envelope.task.userId, envelope.task.presetId, {
        sourceGeneration: envelope.task.sourceGeneration,
        completedOrdinal: envelope.task.watermarkOrdinal,
        watermarkKind: envelope.task.watermarkKind,
        boundaryMessageId: envelope.task.boundaryMessageId,
        lastTaskId: envelope.task.taskId,
      }, { client });
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "succeeded",
        stage: "committed",
        result_revision: reduction.state.meta.revision,
        not_before: null,
        last_error_reason: null,
      }, { client });
      await appendOps(envelope, "committed", Number(rowValue(task, "attempt", "attempt") ?? 0), {
        revision: reduction.state.meta.revision,
        operationCount: reduction.events.length,
        reports: semanticResult.reports || [],
      }, client);
      return {
        status: "committed",
        taskId: envelope.task.taskId,
        revision: reduction.state.meta.revision,
        events: reduction.events,
      };
    });
  }

  return Object.freeze({
    createTask,
    processEnvelope,
  });
}

module.exports = {
  createLibrarianTaskExecutor,
  librarianTaskRow,
  validateLibrarianConfig,
};
