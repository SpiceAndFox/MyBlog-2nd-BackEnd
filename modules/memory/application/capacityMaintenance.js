const crypto = require("node:crypto");
const { SCHEMA_VERSION, validateProposerOutput } = require("../contracts");
const { reduceProposal } = require("../domain/reducer");
const { buildMaintenanceEnvelope, maintenanceDedupeKey } = require("./envelope");
const { mapEventToRow } = require("./eventMapper");
const { isDeepStrictEqual } = require("node:util");
const { buildDeterministicExactMergeOutput, sectionItems } = require("../domain/itemDeduplication");

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function isHygiene(envelope) { return envelope.task.trigger?.type === "hygiene"; }
function stablePhaseId(taskId, phase) {
  const hex = crypto.createHash("sha256").update(`${taskId}:${phase}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function maintenanceTaskRow(envelope) {
  const task = envelope.task;
  return {
    task_id: task.taskId, dedupe_key: maintenanceDedupeKey(task), user_id: task.userId, preset_id: task.presetId,
    target_key: task.targetKey, source_generation: task.sourceGeneration, task_type: "maintenance",
    parent_task_id: task.parentTaskId, predecessor_task_id: null, resume_epoch: task.resumeEpoch,
    status: "queued", stage: "pending", cursor_before: null, target_message_id: task.targetMessageId,
    base_revision: task.baseRevision, task_payload: envelope, stage_payload: null, attempt: 0,
    context_expansion_attempt: 0, not_before: null, last_error_reason: null, result_revision: null,
  };
}
function proposalItemIds(proposal) {
  if (!proposal?.sectionResults) return [];
  return Object.values(proposal.sectionResults).flatMap((result) => (result.patches || []).flatMap((patch) => [patch.itemId, ...(patch.itemIds || [])].filter(Boolean)));
}

function createCapacityMaintenance({ repositories, providerAdapter, config, metrics, now = () => new Date(), idFactory = () => crypto.randomUUID(), recordAdapterError, proposeWithSchemaRetry, loadEvidenceMessages } = {}) {
  if (!repositories?.withTransaction || !repositories.runtime || !providerAdapter) throw new Error("Capacity maintenance dependencies are required");

  async function appendOps(envelope, outcome, attempt, detail, client) {
    metrics?.increment("memory_ops_outcomes_total", { targetKey: envelope.task.targetKey, proposer: envelope.task.proposer, outcome });
    return repositories.runtime.appendOpsLog({
      user_id: envelope.task.userId, preset_id: envelope.task.presetId,
      source_generation: envelope.task.sourceGeneration, task_id: envelope.task.taskId,
      tick_id: envelope.task.tickId, target_key: envelope.task.targetKey, section: envelope.task.targetSections[0],
      proposer: envelope.task.proposer, outcome, attempt, detail: detail ?? null,
    }, { client });
  }

  function observeWorkflowAge(task, workflow, targetKey) {
    const createdAt = rowValue(task, "created_at", "createdAt");
    if (!createdAt) return;
    const age = now().getTime() - new Date(createdAt).getTime();
    if (Number.isFinite(age)) metrics?.observe("memory_workflow_age_ms", { workflow, targetKey }, Math.max(0, age));
  }

  async function recordTransactionFailure(envelope, taskId, stage, error) {
    if (isHygiene(envelope)) return finishHygieneWithoutMutation(envelope, stage, { reason: stage, message: String(error?.message || stage).slice(0, 500) });
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(taskId, { client });
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
      const recoveryStage = rowValue(task, "task_type", "taskType") === "maintenance" ? "compacting" : "capacity_blocked";
      await repositories.runtime.updateTask(taskId, { status: "running", stage: recoveryStage, attempt, last_error_reason: stage }, { client });
      await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
        targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration,
        status: "capacity_blocked", consecutiveErrors: 0, lastErrorReason: stage,
        lastTaskId: taskId, nextRetryAt: null,
      }, { client });
      await appendOps(envelope, stage, attempt, { message: String(error?.message || stage).slice(0, 500) }, client);
      return { status: "queued", outcome: stage, taskId };
    });
  }

  async function createChild(parentEnvelope, state, violation, resumeEpoch, client) {
    const envelope = buildMaintenanceEnvelope({ parentEnvelope, state, section: violation.section, violation, resumeEpoch, config });
    const row = await repositories.runtime.createTask(maintenanceTaskRow(envelope), { client });
    return rowValue(row, "task_payload", "taskPayload") || envelope;
  }

  async function createHygieneChild(parentEnvelope, state, section, client) {
    const maxItems = config.sectionBudgets[section].maxItems;
    const itemCount = (["todos", "standingAgreements", "recentEpisodes"].includes(section) ? state.working[section] : state.longTerm[section]).length;
    const trigger = { type: "hygiene", itemCount, maxItems, highWatermarkPercent: config.hygiene?.highWatermarkPercent ?? 70 };
    const envelope = buildMaintenanceEnvelope({ parentEnvelope, state, section, trigger, resumeEpoch: 0, config });
    const row = await repositories.runtime.createTask(maintenanceTaskRow(envelope), { client });
    return rowValue(row, "task_payload", "taskPayload") || envelope;
  }

  async function deferNormal({ parentEnvelope, state, proposal, reduction, client }) {
    const groupId = stablePhaseId(parentEnvelope.task.taskId, "capacity_blocked");
    const existing = await repositories.audit.getEventGroup(groupId, { client });
    if (existing) {
      const task = await repositories.runtime.getTaskForUpdate(parentEnvelope.task.taskId, { client });
      const payload = rowValue(task, "stage_payload", "stagePayload");
      if (!payload?.maintenanceTaskId || !payload?.blockingViolation || !payload?.identities) {
        throw new Error("Capacity-blocked audit phase is missing its durable maintenance chain");
      }
      return { status: "capacity_deferred", taskId: parentEnvelope.task.taskId, duplicate: true, maintenanceTaskId: payload.maintenanceTaskId };
    }
    const parentTask = await repositories.runtime.getTaskForUpdate(parentEnvelope.task.taskId, { client });
    observeWorkflowAge(parentTask, "deferred", parentEnvelope.task.targetKey);
    metrics?.increment("memory_capacity_deferred_total", { targetKey: parentEnvelope.task.targetKey, section: reduction.capacityViolation.section });
    const child = await createChild(parentEnvelope, state, reduction.capacityViolation, 0, client);
    const maintenanceTaskId = child.task.taskId;
    const stagePayload = {
      persistedProposal: structuredClone(proposal), identities: structuredClone(reduction.identities),
      maintenanceTaskId, blockingViolation: structuredClone(reduction.capacityViolation), attemptedSections: [],
    };
    await repositories.audit.insertEventGroup({
      event_group_id: groupId, user_id: parentEnvelope.task.userId, preset_id: parentEnvelope.task.presetId,
      task_id: parentEnvelope.task.taskId, target_key: parentEnvelope.task.targetKey,
      source_generation: parentEnvelope.task.sourceGeneration, schema_version: SCHEMA_VERSION,
      base_revision: state.meta.revision, result_revision: null, cursor_before: parentEnvelope.task.cursorBefore,
      cursor_after: parentEnvelope.task.cursorBefore, group_kind: "proposal",
    }, { client });
    await repositories.audit.insertEvents(reduction.events.map((event, index) => mapEventToRow(event, parentEnvelope, groupId, index, { maintenanceTaskId })), { client });
    await repositories.runtime.updateTask(parentEnvelope.task.taskId, { status: "running", stage: "capacity_blocked", stage_payload: stagePayload, last_error_reason: "capacity_blocked" }, { client });
    await repositories.runtime.upsertTargetStatus(parentEnvelope.task.userId, parentEnvelope.task.presetId, {
      targetKey: parentEnvelope.task.targetKey, sourceGeneration: parentEnvelope.task.sourceGeneration,
      status: "capacity_blocked", consecutiveErrors: 0, lastErrorReason: "capacity_blocked",
      lastTaskId: parentEnvelope.task.taskId, nextRetryAt: null,
    }, { client });
    return { status: "capacity_deferred", taskId: parentEnvelope.task.taskId, maintenanceTaskId, maintenanceEnvelope: child, reduction };
  }

  async function halt(envelope, reason, { parent = false } = {}) {
    return repositories.withTransaction(async (client) => {
      const taskId = parent ? envelope.task.parentTaskId : envelope.task.taskId;
      const task = await repositories.runtime.getTaskForUpdate(taskId, { client });
      if (!task) throw new Error("Memory task not found while halting capacity workflow");
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
      if (parent) await repositories.runtime.updateTask(taskId, { status: "failed", stage: "replay_failed", attempt, last_error_reason: reason }, { client });
      else await repositories.runtime.updateTask(taskId, { status: "failed", stage: "compaction_failed", attempt, last_error_reason: reason }, { client });
      observeWorkflowAge(task, "halt", envelope.task.targetKey);
      metrics?.increment("memory_target_halted_total", { targetKey: envelope.task.targetKey, reason });
      await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
        targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration, status: "halted",
        consecutiveErrors: 0, lastErrorReason: reason, lastTaskId: taskId, nextRetryAt: null,
      }, { client });
      const opsEnvelope = parent ? rowValue(task, "task_payload", "taskPayload") : envelope;
      await appendOps(opsEnvelope, reason, attempt, { parentTaskId: envelope.task.parentTaskId }, client);
      return { status: "halted", reason, taskId };
    });
  }

  async function pendingProtectedIds(envelope, client) {
    const tasks = await repositories.runtime.listTasksForTarget(envelope.task.userId, envelope.task.presetId, envelope.task.targetKey, { client });
    return [...new Set(tasks.flatMap((task) => {
      if (rowValue(task, "task_id", "taskId") === envelope.task.taskId || TERMINAL_STATUSES.has(rowValue(task, "status", "status"))) return [];
      const stage = rowValue(task, "stage", "stage");
      if (!["capacity_blocked", "replaying_original_proposal", "compacting"].includes(stage)) return [];
      return proposalItemIds(rowValue(task, "stage_payload", "stagePayload")?.persistedProposal);
    }))];
  }

  async function markStale(envelope, reason) {
    if (isHygiene(envelope)) return finishHygieneWithoutMutation(envelope, "hygiene_stale", { reason });
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (task && !TERMINAL_STATUSES.has(rowValue(task, "status", "status"))) await repositories.runtime.updateTask(envelope.task.taskId, { status: "cancelled", stage: "stale", last_error_reason: reason }, { client });
      const parent = await repositories.runtime.getTaskForUpdate(envelope.task.parentTaskId, { client });
      if (parent && !TERMINAL_STATUSES.has(rowValue(parent, "status", "status"))) await repositories.runtime.updateTask(envelope.task.parentTaskId, { status: "cancelled", stage: "stale", last_error_reason: reason }, { client });
      await appendOps(envelope, "stale_result", Number(rowValue(task, "attempt", "attempt") ?? 0), { reason }, client);
      return { status: "stale", reason, taskId: envelope.task.taskId };
    });
  }

  async function failUnable(envelope) {
    if (isHygiene(envelope)) return finishHygieneWithoutMutation(envelope, "hygiene_noop", { reason: "unable_to_compact" });
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (TERMINAL_STATUSES.has(rowValue(task, "status", "status"))) return { status: rowValue(task, "status", "status"), duplicate: true, taskId: envelope.task.taskId };
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
      await repositories.runtime.updateTask(envelope.task.taskId, { status: "failed", stage: "compaction_failed", stage_payload: { persistedProposal: { unableToCompact: true } }, attempt, last_error_reason: "unable_to_compact" }, { client });
      await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, { targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration, status: "halted", consecutiveErrors: 0, lastErrorReason: "unable_to_compact", lastTaskId: envelope.task.taskId, nextRetryAt: null }, { client });
      await appendOps(envelope, "unable_to_compact", attempt, { parentTaskId: envelope.task.parentTaskId }, client);
      return { status: "halted", reason: "unable_to_compact", taskId: envelope.task.taskId };
    });
  }

  async function finishHygieneWithoutMutation(envelope, stage = "hygiene_noop", detail = {}) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Hygiene task not found");
      if (TERMINAL_STATUSES.has(rowValue(task, "status", "status"))) return { status: "hygiene_noop", duplicate: true, taskId: envelope.task.taskId };
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
      const payload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      if (!payload.persistedProposal && detail.persistedProposal) payload.persistedProposal = structuredClone(detail.persistedProposal);
      payload.resultItemCount = envelope.task.trigger.itemCount;
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "succeeded", stage, stage_payload: payload, attempt,
        not_before: null, last_error_reason: detail.reason || null,
      }, { client });
      await appendOps(envelope, stage, attempt, detail, client);
      return { status: "hygiene_noop", reason: detail.reason || null, taskId: envelope.task.taskId };
    });
  }

  async function persistMaintenanceProposal(envelope, output) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Maintenance task not found while persisting provider proposal");
      if (TERMINAL_STATUSES.has(rowValue(task, "status", "status"))) return null;
      const payload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      payload.persistedProposal = structuredClone(output);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running", stage: "proposal_persisted", stage_payload: payload,
        not_before: null, last_error_reason: null,
      }, { client });
      return output;
    });
  }

  async function persistMaintenanceProposalWithRecovery(envelope, output) {
    try {
      return await persistMaintenanceProposal(envelope, output);
    } catch (error) {
      if (!error?.commitOutcomeUnknown) throw error;
      const task = await repositories.runtime.getTask(envelope.task.taskId);
      const persisted = rowValue(task, "stage_payload", "stagePayload")?.persistedProposal;
      if (rowValue(task, "stage", "stage") === "proposal_persisted" && isDeepStrictEqual(persisted, output)) return output;
      return persistMaintenanceProposal(envelope, output);
    }
  }

  async function commitCompaction(envelope, output) {
    return repositories.withTransaction(async (client) => {
      const hygiene = isHygiene(envelope);
      const groupId = stablePhaseId(envelope.task.taskId, "compaction_commit");
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      const parent = await repositories.runtime.getTaskForUpdate(envelope.task.parentTaskId, { client });
      if (!task || !parent) throw new Error("Compaction task chain is incomplete");
      const existing = await repositories.audit.getEventGroup(groupId, { client });
      if (existing) {
        if (existing.result_revision !== null && existing.result_revision !== undefined) {
          return { status: hygiene ? "hygiene_applied" : "compaction_applied", revision: Number(existing.result_revision), duplicate: true };
        }
        if (hygiene) return { status: "hygiene_noop", taskId: envelope.task.taskId, duplicate: true };
        return {
          status: "halted",
          reason: rowValue(task, "last_error_reason", "lastErrorReason") || "compaction_failed",
          taskId: envelope.task.taskId,
          duplicate: true,
        };
      }
      if (TERMINAL_STATUSES.has(rowValue(task, "status", "status"))) return { status: rowValue(task, "stage", "stage"), duplicate: true };
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      if (state.meta.sourceGeneration !== envelope.task.sourceGeneration) return { status: "stale", reason: "generation_mismatch" };
      const parentEnvelope = rowValue(parent, "task_payload", "taskPayload");
      if (hygiene) {
        if (state.meta.revision !== envelope.task.baseRevision) return { status: "stale", reason: "revision_mismatch" };
      } else if ((state.meta.targetCursors[envelope.task.targetKey] ?? 0) !== parentEnvelope.task.cursorBefore || TERMINAL_STATUSES.has(rowValue(parent, "status", "status"))) {
        return { status: "stale", reason: "parent_not_active" };
      }
      await repositories.runtime.updateTask(envelope.task.taskId, { status: "running", stage: "compacting", stage_payload: { persistedProposal: output } }, { client });
      const reduction = reduceProposal({ state, task: envelope.task, proposal: output, observedMessages: [], databaseMessages: [], now: envelope.task.now, config, idFactory, protectedItemIds: await pendingProtectedIds(envelope, client) });
      const accepted = reduction.events.filter((event) => event.decision === "accepted");
      if (!accepted.length) {
        const allProtected = reduction.events.length > 0 && reduction.events.every((event) => event.rejectReason === "item_protected_by_pending_proposal");
        const reason = allProtected ? "unable_to_compact" : "compaction_failed";
        const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
        await repositories.audit.insertEventGroup({ event_group_id: groupId, user_id: envelope.task.userId, preset_id: envelope.task.presetId, task_id: envelope.task.taskId, target_key: envelope.task.targetKey, source_generation: envelope.task.sourceGeneration, schema_version: SCHEMA_VERSION, base_revision: state.meta.revision, result_revision: null, cursor_before: null, cursor_after: null, group_kind: "maintenance" }, { client });
        await repositories.audit.insertEvents(reduction.events.map((event, index) => mapEventToRow(event, envelope, groupId, index)), { client });
        if (hygiene) {
          await repositories.runtime.updateTask(envelope.task.taskId, {
            status: "succeeded", stage: "hygiene_noop",
            stage_payload: { persistedProposal: output, resultItemCount: envelope.task.trigger.itemCount },
            attempt, last_error_reason: reason,
          }, { client });
          await appendOps(envelope, "hygiene_noop", attempt, { reason }, client);
          return { status: "hygiene_noop", reason, taskId: envelope.task.taskId, events: reduction.events };
        }
        await repositories.runtime.updateTask(envelope.task.taskId, { status: "failed", stage: "compaction_failed", stage_payload: { persistedProposal: output }, attempt, last_error_reason: reason }, { client });
        await repositories.runtime.upsertTargetStatus(envelope.task.userId, envelope.task.presetId, {
          targetKey: envelope.task.targetKey, sourceGeneration: envelope.task.sourceGeneration,
          status: "halted", consecutiveErrors: 0, lastErrorReason: reason,
          lastTaskId: envelope.task.taskId, nextRetryAt: null,
        }, { client });
        await appendOps(envelope, reason, attempt, { parentTaskId: envelope.task.parentTaskId }, client);
        observeWorkflowAge(task, "compaction", envelope.task.targetKey);
        return { status: "halted", reason, taskId: envelope.task.taskId, events: reduction.events };
      }
      await repositories.state.writeState(envelope.task.userId, envelope.task.presetId, reduction.state, { client });
      await repositories.audit.insertEventGroup({ event_group_id: groupId, user_id: envelope.task.userId, preset_id: envelope.task.presetId, task_id: envelope.task.taskId, target_key: envelope.task.targetKey, source_generation: envelope.task.sourceGeneration, schema_version: SCHEMA_VERSION, base_revision: state.meta.revision, result_revision: reduction.state.meta.revision, cursor_before: null, cursor_after: null, group_kind: "maintenance" }, { client });
      await repositories.audit.insertEvents(reduction.events.map((event, index) => mapEventToRow(event, envelope, groupId, index)), { client });
      await repositories.audit.insertSnapshot(envelope.task.userId, envelope.task.presetId, { sourceGeneration: reduction.state.meta.sourceGeneration, revision: reduction.state.meta.revision, schemaVersion: SCHEMA_VERSION, state: reduction.snapshot }, { client });
      const resultItemCount = sectionItems(reduction.state, envelope.task.targetSections[0]).length;
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "succeeded", stage: hygiene ? "hygiene_applied" : "compaction_applied",
        stage_payload: { persistedProposal: output, resultItemCount },
        result_revision: reduction.state.meta.revision, last_error_reason: null,
      }, { client });
      if (!hygiene) {
        const parentPayload = structuredClone(rowValue(parent, "stage_payload", "stagePayload"));
        parentPayload.attemptedSections = [...new Set([...(parentPayload.attemptedSections || []), envelope.task.targetSections[0]])];
        await repositories.runtime.updateTask(envelope.task.parentTaskId, { status: "running", stage: "capacity_blocked", stage_payload: parentPayload, last_error_reason: "capacity_blocked" }, { client });
      }
      observeWorkflowAge(task, "compaction", envelope.task.targetKey);
      return { status: hygiene ? "hygiene_applied" : "compaction_applied", revision: reduction.state.meta.revision, events: reduction.events };
    });
  }

  async function advanceParent(parentEnvelope) {
    return repositories.withTransaction(async (client) => {
      const replayGroupId = stablePhaseId(parentEnvelope.task.taskId, "original_proposal_replay");
      const existing = await repositories.audit.getEventGroup(replayGroupId, { client });
      if (existing) return { status: "committed", revision: Number(existing.result_revision), duplicate: true, taskId: parentEnvelope.task.taskId };
      const parent = await repositories.runtime.getTaskForUpdate(parentEnvelope.task.taskId, { client });
      if (!parent) throw new Error("Parent normal task is missing during replay");
      if (rowValue(parent, "status", "status") === "succeeded") return { status: "committed", revision: Number(rowValue(parent, "result_revision", "resultRevision")), duplicate: true };
      const payload = rowValue(parent, "stage_payload", "stagePayload");
      if (!payload?.persistedProposal) throw new Error("Capacity-blocked task has no persisted proposal");
      const state = await repositories.state.getState(parentEnvelope.task.userId, parentEnvelope.task.presetId, { client, forUpdate: true });
      if (state.meta.sourceGeneration !== parentEnvelope.task.sourceGeneration) return { status: "stale", reason: "generation_mismatch" };
      if ((state.meta.targetCursors[parentEnvelope.task.targetKey] ?? 0) !== parentEnvelope.task.cursorBefore) return { status: "stale", reason: "cursor_mismatch" };
      const databaseMessages = loadEvidenceMessages
        ? await loadEvidenceMessages(parentEnvelope, client)
        : await repositories.source.getByIds(parentEnvelope.task.userId, parentEnvelope.task.presetId, parentEnvelope.task.observedMessageIds, { client });
      const reduction = reduceProposal({ state, task: parentEnvelope.task, proposal: payload.persistedProposal, observedMessages: parentEnvelope.observedMessages, databaseMessages, now: parentEnvelope.task.now, config, idFactory, identities: payload.identities });
      if (reduction.outcome === "deferred") {
        if ((payload.attemptedSections || []).includes(reduction.capacityViolation.section)) return { status: "replay_failed", reason: "capacity_still_exceeded" };
        const child = await createChild(parentEnvelope, state, reduction.capacityViolation, 0, client);
        await repositories.runtime.updateTask(parentEnvelope.task.taskId, { status: "running", stage: "capacity_blocked", stage_payload: { ...payload, maintenanceTaskId: child.task.taskId, blockingViolation: reduction.capacityViolation, identities: reduction.identities }, last_error_reason: "capacity_blocked" }, { client });
        return { status: "capacity_deferred", taskId: parentEnvelope.task.taskId, maintenanceTaskId: child.task.taskId, maintenanceEnvelope: child };
      }
      await repositories.runtime.updateTask(parentEnvelope.task.taskId, { status: "running", stage: "replaying_original_proposal", stage_payload: payload }, { client });
      await repositories.state.writeState(parentEnvelope.task.userId, parentEnvelope.task.presetId, reduction.state, { client });
      await repositories.audit.insertEventGroup({ event_group_id: replayGroupId, user_id: parentEnvelope.task.userId, preset_id: parentEnvelope.task.presetId, task_id: parentEnvelope.task.taskId, target_key: parentEnvelope.task.targetKey, source_generation: parentEnvelope.task.sourceGeneration, schema_version: SCHEMA_VERSION, base_revision: state.meta.revision, result_revision: reduction.state.meta.revision, cursor_before: parentEnvelope.task.cursorBefore, cursor_after: parentEnvelope.task.targetMessageId, group_kind: "proposal" }, { client });
      await repositories.audit.insertEvents(reduction.events.map((event, index) => mapEventToRow(event, parentEnvelope, replayGroupId, index)), { client });
      await repositories.audit.insertSnapshot(parentEnvelope.task.userId, parentEnvelope.task.presetId, { sourceGeneration: reduction.state.meta.sourceGeneration, revision: reduction.state.meta.revision, schemaVersion: SCHEMA_VERSION, state: reduction.snapshot }, { client });
      await repositories.runtime.updateTask(parentEnvelope.task.taskId, { status: "succeeded", stage: "committed", stage_payload: payload, result_revision: reduction.state.meta.revision, last_error_reason: null }, { client });
      observeWorkflowAge(parent, "replay", parentEnvelope.task.targetKey);
      if (repositories.runtime.recordSuccessfulTargetTask) {
        await repositories.runtime.recordSuccessfulTargetTask(parentEnvelope.task.userId, parentEnvelope.task.presetId, { targetKey: parentEnvelope.task.targetKey, sourceGeneration: parentEnvelope.task.sourceGeneration, taskId: parentEnvelope.task.taskId }, { client });
      } else {
        await repositories.runtime.upsertTargetStatus(parentEnvelope.task.userId, parentEnvelope.task.presetId, { targetKey: parentEnvelope.task.targetKey, sourceGeneration: parentEnvelope.task.sourceGeneration, status: "healthy", consecutiveErrors: 0, lastErrorReason: null, lastTaskId: parentEnvelope.task.taskId, nextRetryAt: null }, { client });
      }
      return { status: "committed", taskId: parentEnvelope.task.taskId, revision: reduction.state.meta.revision, replayed: true, events: reduction.events };
    });
  }

  async function processMaintenanceEnvelope(envelope) {
    const current = await repositories.runtime.getTask(envelope.task.taskId);
    if (rowValue(current, "stage", "stage") === "compaction_applied") return advanceParent((await repositories.runtime.getTask(envelope.task.parentTaskId)).task_payload ?? (await repositories.runtime.getTask(envelope.task.parentTaskId)).taskPayload);
    if (TERMINAL_STATUSES.has(rowValue(current, "status", "status"))) return { status: rowValue(current, "status", "status"), reason: rowValue(current, "last_error_reason", "lastErrorReason"), duplicate: true };
    const notBefore = rowValue(current, "not_before", "notBefore");
    if (rowValue(current, "status", "status") === "retry_wait" && notBefore && new Date(notBefore).getTime() > now().getTime()) {
      return { status: "retry_wait", taskId: envelope.task.taskId, notBefore };
    }
    let output = ["proposal_persisted", "compacting"].includes(rowValue(current, "stage", "stage"))
      ? rowValue(current, "stage_payload", "stagePayload")?.persistedProposal
      : null;
    if (!output) {
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId);
      output = buildDeterministicExactMergeOutput(state, envelope.task);
      if (!output) {
        const adapterResult = proposeWithSchemaRetry
          ? await proposeWithSchemaRetry(envelope)
          : await providerAdapter.propose(envelope);
        if (adapterResult.status === "deferred") {
          return { status: "queued", outcome: adapterResult.reason, taskId: envelope.task.taskId };
        }
        if (adapterResult.status === "error") {
          if (isHygiene(envelope)) return finishHygieneWithoutMutation(envelope, "hygiene_skipped", { reason: adapterResult.reason });
          return recordAdapterError(envelope, adapterResult);
        }
        output = adapterResult.output;
      } else {
        metrics?.increment("memory_deterministic_exact_merge_total", { targetKey: envelope.task.targetKey, section: envelope.task.targetSections[0] });
      }
      await persistMaintenanceProposalWithRecovery(envelope, output);
    }
    const validation = validateProposerOutput(output, envelope.task);
    if (!validation.ok) {
      if (isHygiene(envelope)) return finishHygieneWithoutMutation(envelope, "hygiene_skipped", { reason: "output_schema_invalid" });
      return recordAdapterError(envelope, { status: "error", reason: "output_schema_invalid", detail: validation.errors });
    }
    const sectionResult = output.sectionResults[envelope.task.targetSections[0]];
    if (sectionResult.status === "unable_to_compact") return failUnable(envelope);
    let result;
    try {
      result = await commitCompaction(envelope, output);
    } catch (error) {
      if (error?.commitOutcomeUnknown) {
        const existing = await repositories.audit.getEventGroup(stablePhaseId(envelope.task.taskId, "compaction_commit"));
        if (existing?.result_revision !== null && existing?.result_revision !== undefined) {
          result = { status: isHygiene(envelope) ? "hygiene_applied" : "compaction_applied", revision: Number(existing.result_revision), duplicate: true, reconciledCommitOutcome: true };
        } else if (existing) {
          const task = await repositories.runtime.getTask(envelope.task.taskId);
          result = isHygiene(envelope)
            ? { status: "hygiene_noop", taskId: envelope.task.taskId, duplicate: true, reconciledCommitOutcome: true }
            : {
              status: "halted",
              reason: rowValue(task, "last_error_reason", "lastErrorReason") || "compaction_failed",
              taskId: envelope.task.taskId,
              duplicate: true,
              reconciledCommitOutcome: true,
            };
        }
        else return recordTransactionFailure(envelope, envelope.task.taskId, "commit_outcome_unknown", error);
      } else return recordTransactionFailure(envelope, envelope.task.taskId, "transaction_failed", error);
    }
    if (result.status === "stale") return markStale(envelope, result.reason);
    if (result.status === "halted") return result;
    if (isHygiene(envelope)) return result;
    const parent = await repositories.runtime.getTask(envelope.task.parentTaskId);
    let advanced;
    try {
      advanced = await advanceParent(rowValue(parent, "task_payload", "taskPayload"));
    } catch (error) {
      if (error?.commitOutcomeUnknown) {
        const existing = await repositories.audit.getEventGroup(stablePhaseId(envelope.task.parentTaskId, "original_proposal_replay"));
        if (existing) return { status: "committed", taskId: envelope.task.parentTaskId, revision: Number(existing.result_revision), duplicate: true, reconciledCommitOutcome: true };
        return recordTransactionFailure(envelope, envelope.task.parentTaskId, "commit_outcome_unknown", error);
      }
      return recordTransactionFailure(envelope, envelope.task.parentTaskId, "transaction_failed", error);
    }
    if (advanced.status === "stale") return markStale(envelope, advanced.reason);
    if (advanced.status === "replay_failed") return halt(envelope, advanced.reason, { parent: true });
    if (advanced.maintenanceEnvelope) return processMaintenanceEnvelope(advanced.maintenanceEnvelope);
    return advanced;
  }

  async function resumeParent(parentEnvelope) {
    const parent = await repositories.runtime.getTask(parentEnvelope.task.taskId);
    const payload = rowValue(parent, "stage_payload", "stagePayload");
    const child = payload?.maintenanceTaskId ? await repositories.runtime.getTask(payload.maintenanceTaskId) : null;
    if (child && !TERMINAL_STATUSES.has(rowValue(child, "status", "status"))) return processMaintenanceEnvelope(rowValue(child, "task_payload", "taskPayload"));
    if (child && rowValue(child, "stage", "stage") === "compaction_applied") return advanceParent(parentEnvelope);
    return advanceParent(parentEnvelope);
  }

  async function createResumeChild(parentEnvelope, violation, resumeEpoch, client) {
    const state = await repositories.state.getState(parentEnvelope.task.userId, parentEnvelope.task.presetId, { client, forUpdate: true });
    return createChild(parentEnvelope, state, violation, resumeEpoch, client);
  }

  async function maybeRunHygiene(parentEnvelope) {
    const highWatermarkPercent = config.hygiene?.highWatermarkPercent ?? 70;
    const minItemDelta = config.hygiene?.minItemDelta ?? 5;
    const created = [];
    for (const section of parentEnvelope.task.targetSections) {
      const budget = config.sectionBudgets[section];
      if (!budget || section === "recentEpisodes") continue;
      let child;
      try {
        child = await repositories.withTransaction(async (client) => {
          const state = await repositories.state.getState(parentEnvelope.task.userId, parentEnvelope.task.presetId, { client, forUpdate: true });
          if (!state || state.meta.sourceGeneration !== parentEnvelope.task.sourceGeneration) return null;
          const itemCount = sectionItems(state, section).length;
          const highWatermark = Math.ceil(budget.maxItems * highWatermarkPercent / 100);
          if (itemCount < highWatermark) return null;
          const tasks = await repositories.runtime.listTasksForTarget(parentEnvelope.task.userId, parentEnvelope.task.presetId, parentEnvelope.task.targetKey, { client });
          const previous = tasks.find((row) => {
            const payload = rowValue(row, "task_payload", "taskPayload");
            return rowValue(row, "task_type", "taskType") === "maintenance"
              && payload?.task?.sourceGeneration === parentEnvelope.task.sourceGeneration
              && payload?.task?.trigger?.type === "hygiene"
              && payload.task.targetSections?.[0] === section;
          });
          const previousPayload = rowValue(previous, "stage_payload", "stagePayload");
          const previousTrigger = rowValue(previous, "task_payload", "taskPayload")?.task?.trigger;
          const baseline = Number(previousPayload?.resultItemCount ?? previousTrigger?.itemCount);
          if (Number.isFinite(baseline) && itemCount < baseline + minItemDelta) return null;
          return createHygieneChild(parentEnvelope, state, section, client);
        });
      } catch (error) {
        metrics?.increment("memory_hygiene_schedule_errors_total", { targetKey: parentEnvelope.task.targetKey, section });
        created.push({ status: "hygiene_schedule_failed", section, reason: String(error?.message || "schedule_failed").slice(0, 200) });
        continue;
      }
      if (!child) continue;
      try {
        created.push(await processMaintenanceEnvelope(child));
      } catch (error) {
        metrics?.increment("memory_hygiene_execution_errors_total", { targetKey: parentEnvelope.task.targetKey, section });
        created.push({ status: "hygiene_queued", section, taskId: child.task.taskId, reason: String(error?.message || "execution_failed").slice(0, 200) });
      }
    }
    return created;
  }

  return Object.freeze({ deferNormal, processMaintenanceEnvelope, advanceParent, resumeParent, createResumeChild, maybeRunHygiene, persistMaintenanceProposal, persistMaintenanceProposalWithRecovery });
}

module.exports = { createCapacityMaintenance, stablePhaseId, maintenanceTaskRow, proposalItemIds };
