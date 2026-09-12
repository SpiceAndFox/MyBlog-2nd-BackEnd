const {
  createInitialMemoryState,
  assertMemoryState,
  SCHEMA_VERSION,
  TARGETS,
  TARGET_KEYS,
} = require("../contracts");
const { isDeepStrictEqual } = require("node:util");
const {
  nextLibrarianPeriodicOrdinal,
  furthestLibrarianBarrierCursor,
  findAlignedLibrarianBoundary,
  buildRebuildLibrarianSchedule,
  validateRebuildLibrarianSchedule,
} = require("../domain/librarianSchedule");

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const MAX_SNAPSHOT_RESTORE_ATTEMPTS = 8;

function normalizeAffectedFromMessageId(value) {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error("affectedFromMessageId must be a positive safe integer");
  }
  return normalized;
}

function collectSourceRefs(value, refs = new Map()) {
  if (!value || typeof value !== "object") return refs;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!collectSourceRefs(entry, refs)) return null;
    }
    return refs;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "sourceRefs") {
      if (!collectSourceRefs(entry, refs)) return null;
      continue;
    }
    for (const ref of entry) {
      const previous = refs.get(ref.messageId);
      if (previous && previous !== ref.contentHash) return null;
      refs.set(ref.messageId, ref.contentHash);
    }
  }
  return refs;
}

function cloneSnapshotState(snapshot, current, sourceGeneration) {
  const next = structuredClone(snapshot.state);
  next.meta.revision = current.meta.revision + 1;
  next.meta.sourceGeneration = sourceGeneration;
  next.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, next.meta.targetCursors[key] ?? 0]));
  assertMemoryState(next);
  return next;
}

function createMemorySourceRebuild({ repositories, normalWritePipeline, librarian, config, enqueueByKey = (_key, work) => work(), now = () => new Date() } = {}) {
  if (!repositories?.withTransaction || !repositories.state || !repositories.source || !repositories.runtime || !repositories.audit || !repositories.sidecars) throw new Error("Source rebuild repositories are required");
  if (!normalWritePipeline?.createTask || !normalWritePipeline?.processEnvelope) throw new Error("Source rebuild requires the normal write pipeline");
  if (!librarian?.runAt || !librarian?.runFinal) throw new Error("Source rebuild requires the Memory Librarian");
  if (typeof repositories.source.listCompleteTurnBoundaries !== "function") {
    throw new Error("Source rebuild requires a complete-turn boundary reader");
  }
  if (typeof repositories.runtime.getLibrarianCheckpoint !== "function") {
    throw new Error("Source rebuild requires the Librarian checkpoint repository");
  }

  async function findSafeSnapshotState(userId, presetId, current, affectedFromMessageId, boundaryMessageId, client) {
    if (affectedFromMessageId === null) return null;
    if (typeof repositories.audit.getLatestSnapshotBeforeMessage !== "function") {
      throw new Error("Source rebuild snapshot restore repository is required");
    }
    let beforeRevision = current.meta.revision + 1;
    const maxCursorMessageId = Math.min(boundaryMessageId, affectedFromMessageId - 1);
    for (let attempt = 0; attempt < MAX_SNAPSHOT_RESTORE_ATTEMPTS; attempt += 1) {
      const snapshot = await repositories.audit.getLatestSnapshotBeforeMessage(userId, presetId, {
        sourceGeneration: current.meta.sourceGeneration,
        beforeRevision,
        affectedFromMessageId,
        maxCursorMessageId,
      }, { client });
      if (!snapshot) return null;
      const revision = Number(rowValue(snapshot, "revision", "revision"));
      beforeRevision = Number.isSafeInteger(revision) ? revision : beforeRevision - 1;
      try {
        if (!Number.isSafeInteger(revision) || revision < 0 || revision > current.meta.revision) continue;
        if (Number(rowValue(snapshot, "source_generation", "sourceGeneration")) !== current.meta.sourceGeneration) continue;
        if (String(rowValue(snapshot, "schema_version", "schemaVersion")) !== SCHEMA_VERSION) continue;
        assertMemoryState(snapshot.state);
        if (snapshot.state.meta.revision !== revision || snapshot.state.meta.sourceGeneration !== current.meta.sourceGeneration) continue;
        const cursorsAreSafe = TARGET_KEYS.every((key) => {
          const cursor = snapshot.state.meta.targetCursors[key] ?? 0;
          return cursor < affectedFromMessageId && cursor <= boundaryMessageId;
        });
        if (!cursorsAreSafe) continue;
        const refs = collectSourceRefs(snapshot.state);
        if (!refs || [...refs.keys()].some((messageId) => messageId >= affectedFromMessageId)) continue;
        if (refs.size) {
          const sourceRows = await repositories.source.getByIds(userId, presetId, [...refs.keys()], { client });
          if (sourceRows.length !== refs.size) continue;
          if (sourceRows.some((message) => refs.get(message.id) !== message.contentHash)) continue;
        }
        return { state: cloneSnapshotState(snapshot, current, current.meta.sourceGeneration + 1), revision };
      } catch (error) {
        if (error?.code !== "MEMORY_V201_STATE_INVALID") throw error;
      }
    }
    return null;
  }

  async function canKeepCurrentState(userId, presetId, current, { affectedFromMessageId, sourceUnchanged, boundary }, client) {
    if (!sourceUnchanged && affectedFromMessageId === null) return false;
    if (!TARGET_KEYS.every(key => {
      const cursor = current.meta.targetCursors[key] ?? 0;
      return cursor <= boundary && (sourceUnchanged || cursor < affectedFromMessageId);
    })) return false;
    const refs = collectSourceRefs(current);
    if (!refs || (!sourceUnchanged && [...refs.keys()].some(id => id >= affectedFromMessageId))) return false;
    if (!refs.size) return true;
    const messages = await repositories.source.getByIds(userId, presetId, [...refs.keys()], { client });
    return messages.length === refs.size && messages.every(message => refs.get(message.id) === message.contentHash);
  }

  async function initializeGeneration(userId, presetId, {
    mutateSource = async () => {},
    purgeDerived = null,
    reason = "source_mutation",
    affectedFromMessageId: affectedFromOption = null,
    sourceAlreadyExcluded = false,
  } = {}) {
    return repositories.withTransaction(async (client) => {
      await repositories.sourceWriteGuard.lockScope(userId, presetId, { client });
      const current = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!current) throw new Error("Memory state must be initialized before source mutation");
      const mutationResult = await mutateSource(client);
      if (mutationResult === null || mutationResult === false || mutationResult === 0) {
        return { mutationResult, rebuildRequired: false, sourceGeneration: current.meta.sourceGeneration };
      }
      const affectedFromMessageId = normalizeAffectedFromMessageId(
        typeof affectedFromOption === "function"
          ? await affectedFromOption(mutationResult, client)
          : affectedFromOption,
      );
      const boundary = await repositories.source.getBoundary(userId, presetId, { client });
      if (typeof affectedFromOption === "function" && affectedFromMessageId === null && !purgeDerived) {
        return { mutationResult, rebuildRequired: false, sourceGeneration: current.meta.sourceGeneration,
          revision: current.meta.revision, boundaryMessageId: boundary };
      }
      const sourceGeneration = current.meta.sourceGeneration + 1;
      // A callback that found no messages denotes an empty session. An omitted
      // boundary (manual rebuild) must still retain its full-rebuild meaning.
      const sourceUnchanged = sourceAlreadyExcluded
        || (typeof affectedFromOption === "function" && affectedFromMessageId === null);
      const keepCurrent = await canKeepCurrentState(userId, presetId, current, {
        affectedFromMessageId, sourceUnchanged, boundary,
      }, client);
      const restored = keepCurrent
        ? { state: cloneSnapshotState({ state: current }, current, sourceGeneration), revision: current.meta.revision }
        : await findSafeSnapshotState(userId, presetId, current, affectedFromMessageId, boundary, client);
      const oldStatuses = keepCurrent && repositories.runtime.getTargetStatuses
        ? await repositories.runtime.getTargetStatuses(userId, presetId, { client }) : [];
      const rebuildRequired = !keepCurrent || oldStatuses.some(row =>
        rowValue(row, "rebuild_boundary_message_id", "rebuildBoundaryMessageId") != null);
      const oldCheckpoint = keepCurrent
        ? await repositories.runtime.getLibrarianCheckpoint(userId, presetId, current.meta.sourceGeneration, { client }) : null;
      if (purgeDerived) await purgeDerived(client, { sourceGeneration, boundaryMessageId: boundary,
        revision: current.meta.revision + 1, rebuildRequired });
      const next = restored?.state ?? createInitialMemoryState();
      if (!restored) {
        next.meta.revision = current.meta.revision + 1;
        next.meta.sourceGeneration = sourceGeneration;
        next.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 0]));
      }
      assertMemoryState(next);
      await repositories.runtime.cancelNonTerminalTasks(userId, presetId, sourceGeneration, reason, { client });
      await repositories.state.writeState(userId, presetId, next, { client });
      await repositories.audit.insertSnapshot(userId, presetId, { sourceGeneration, revision: next.meta.revision, schemaVersion: SCHEMA_VERSION, state: next }, { client });
      for (const targetKey of TARGET_KEYS) {
        await repositories.runtime.upsertTargetStatus(userId, presetId, {
          targetKey, sourceGeneration, rebuildBoundaryMessageId: rebuildRequired ? boundary : null, status: rebuildRequired ? "rebuilding" : "healthy",
          consecutiveErrors: 0, lastErrorReason: null, lastTaskId: null, nextRetryAt: null,
        }, { client });
      }
      // Only the unchanged current state can carry its completion proof forward.
      // An older restored snapshot must never inherit a later Librarian result.
      const checkpointBoundary = Number(rowValue(oldCheckpoint, "boundary_message_id", "boundaryMessageId"));
      if (oldCheckpoint && checkpointBoundary <= boundary
        && (sourceUnchanged || checkpointBoundary < affectedFromMessageId)) {
        await repositories.runtime.upsertLibrarianCheckpoint(userId, presetId, {
          sourceGeneration, boundaryMessageId: checkpointBoundary,
          completedOrdinal: Number(rowValue(oldCheckpoint, "completed_ordinal", "completedOrdinal")),
          watermarkKind: rowValue(oldCheckpoint, "watermark_kind", "watermarkKind") ?? "complete_turn",
          lastTaskId: null,
        }, { client });
      }
      if (repositories.sidecars.resolveDiagnosticsOutsideGeneration) await repositories.sidecars.resolveDiagnosticsOutsideGeneration(userId, presetId, sourceGeneration, { client });
      return {
        sourceGeneration,
        revision: next.meta.revision,
        boundaryMessageId: boundary,
        mutationResult,
        rebuildRequired,
        ...(affectedFromMessageId === null ? {} : {
          affectedFromMessageId,
          restoredFromSnapshotRevision: restored?.revision ?? null,
        }),
      };
    });
  }

  async function initializeRecoveryGeneration(userId, presetId, { reason = "state_schema_invalid" } = {}) {
    return repositories.withTransaction(async (client) => {
      await repositories.sourceWriteGuard.lockScope(userId, presetId, { client });
      const raw = await repositories.state.getRawState(userId, presetId, { client, forUpdate: true });
      if (raw === null) throw new Error("Memory authority row is missing during recovery");
      const head = await repositories.audit.getRecoveryHead(userId, presetId, { client });
      const rawRevision = Number.isSafeInteger(raw?.meta?.revision) && raw.meta.revision >= 0 ? raw.meta.revision : 0;
      const rawGeneration = Number.isSafeInteger(raw?.meta?.sourceGeneration) && raw.meta.sourceGeneration >= 0 ? raw.meta.sourceGeneration : 0;
      const boundary = await repositories.source.getBoundary(userId, presetId, { client });
      const next = createInitialMemoryState();
      next.meta.revision = Math.max(rawRevision, head.revision) + 1;
      next.meta.sourceGeneration = Math.max(rawGeneration, head.sourceGeneration) + 1;
      await repositories.runtime.cancelNonTerminalTasks(userId, presetId, next.meta.sourceGeneration, reason, { client });
      await repositories.state.writeState(userId, presetId, next, { client });
      await repositories.audit.insertSnapshot(userId, presetId, { sourceGeneration: next.meta.sourceGeneration, revision: next.meta.revision, schemaVersion: SCHEMA_VERSION, state: next }, { client });
      for (const targetKey of TARGET_KEYS) {
        await repositories.runtime.upsertTargetStatus(userId, presetId, { targetKey, sourceGeneration: next.meta.sourceGeneration, rebuildBoundaryMessageId: boundary, status: "rebuilding", consecutiveErrors: 0, lastErrorReason: reason, lastTaskId: null, nextRetryAt: null }, { client });
      }
      if (repositories.sidecars.resolveDiagnosticsOutsideGeneration) await repositories.sidecars.resolveDiagnosticsOutsideGeneration(userId, presetId, next.meta.sourceGeneration, { client });
      return { sourceGeneration: next.meta.sourceGeneration, revision: next.meta.revision, boundaryMessageId: boundary, recoveredFromRaw: true };
    });
  }

  async function validateTarget(userId, presetId, targetKey, sourceGeneration, boundaryMessageId) {
    return repositories.withTransaction(async (client) => {
      let state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      const status = await repositories.runtime.getTargetStatus(userId, presetId, targetKey, { client, forUpdate: true });
      if (!state || state.meta.sourceGeneration !== sourceGeneration) return { status: "stale", reason: "generation_mismatch" };
      if (Number(rowValue(status, "source_generation", "sourceGeneration")) !== sourceGeneration) return { status: "stale", reason: "target_generation_mismatch" };
      if ((state.meta.targetCursors[targetKey] ?? 0) < boundaryMessageId) throw new Error(`Target ${targetKey} has not reached its rebuild boundary`);
      const snapshot = await repositories.audit.getSnapshot(userId, presetId, state.meta.revision, { client });
      if (!snapshot || Number(snapshot.source_generation ?? snapshot.sourceGeneration) !== sourceGeneration) throw new Error("Current rebuild revision has no valid generation snapshot");
      if (String(snapshot.schema_version ?? snapshot.schemaVersion) !== SCHEMA_VERSION) throw new Error("Current rebuild revision snapshot schema mismatch");
      assertMemoryState(snapshot.state);
      if (!isDeepStrictEqual(snapshot.state, state)) throw new Error("Current rebuild snapshot does not equal authority state");
      const snapshots = await repositories.audit.listSnapshots(userId, presetId, sourceGeneration, { client });
      const revisionSet = new Set(snapshots.map((row) => Number(row.revision)));
      const anchorRevision = Number(snapshots[0]?.revision);
      if (!Number.isSafeInteger(anchorRevision)) throw new Error("Rebuild generation has no anchor snapshot");
      const groups = await repositories.audit.listRevisionGroups(userId, presetId, sourceGeneration, anchorRevision, { client });
      let expectedRevision = anchorRevision + 1;
      for (const group of groups) {
        if (Number(group.base_revision ?? group.baseRevision) !== expectedRevision - 1 || Number(group.result_revision ?? group.resultRevision) !== expectedRevision || !revisionSet.has(expectedRevision)) throw new Error("Rebuild event/snapshot revision chain is not continuous");
        expectedRevision += 1;
      }
      if (expectedRevision - 1 !== state.meta.revision) throw new Error("Rebuild event/snapshot chain does not reach authority state");
      await repositories.runtime.upsertTargetStatus(userId, presetId, {
        targetKey, sourceGeneration, rebuildBoundaryMessageId: null, status: "healthy", consecutiveErrors: 0,
        lastErrorReason: null, lastTaskId: rowValue(status, "last_task_id", "lastTaskId") ?? null, nextRetryAt: null,
      }, { client });
      return { status: "healthy", targetKey, cursor: state.meta.targetCursors[targetKey] ?? 0 };
    });
  }

  async function forceDrainTargetsTo(userId, presetId, {
    sourceGeneration,
    boundaryMessageId,
    resumeHalted = false,
    targetKeys = TARGET_KEYS,
    rebuildBoundaryMessageId = boundaryMessageId,
    finalizeTargets = true,
    signal,
  }) {
    if (typeof normalWritePipeline.prepareEnvelope !== "function"
      || typeof normalWritePipeline.commitPreparedWave !== "function") {
      throw new Error("Source rebuild requires wave-aware prepare and commit pipeline operations");
    }
    const results = [];
    while (true) {
      if (signal?.aborted) return { status: "interrupted", reason: "cancelled", sourceGeneration, results };
      const state = await repositories.state.getState(userId, presetId);
      if (!state || state.meta.sourceGeneration !== sourceGeneration) return { status: "stale", sourceGeneration, results };
      const candidates = [];
      for (const targetKey of targetKeys) {
        if (!TARGETS[targetKey]) throw new Error(`Invalid force-drain target: ${targetKey}`);
        const cursor = state.meta.targetCursors[targetKey] ?? 0;
        if (cursor >= boundaryMessageId) continue;
        const targetStatus = await repositories.runtime.getTargetStatus(userId, presetId, targetKey);
        if (!targetStatus || Number(rowValue(targetStatus, "source_generation", "sourceGeneration")) !== sourceGeneration) {
          return { status: "stale", sourceGeneration, results };
        }
        const targetRuntimeStatus = rowValue(targetStatus, "status", "status");
        const targetBoundary = Number(rowValue(
          targetStatus,
          "rebuild_boundary_message_id",
          "rebuildBoundaryMessageId",
        ));
        if (targetRuntimeStatus === "halted" && !resumeHalted) {
          return {
            status: "incomplete",
            sourceGeneration,
            targetKey,
            result: {
              status: "halted",
              reason: rowValue(targetStatus, "last_error_reason", "lastErrorReason") ?? "provider_halted",
              taskId: rowValue(targetStatus, "last_task_id", "lastTaskId") ?? null,
            },
            results,
          };
        }
        if (targetBoundary !== rebuildBoundaryMessageId
          || (resumeHalted && targetRuntimeStatus === "halted")) {
          await repositories.runtime.upsertTargetStatus(userId, presetId, {
            targetKey,
            sourceGeneration,
            rebuildBoundaryMessageId,
            status: "rebuilding",
            consecutiveErrors: 0,
            lastErrorReason: null,
            lastTaskId: rowValue(targetStatus, "last_task_id", "lastTaskId") ?? null,
            nextRetryAt: null,
          });
        }
        const targetConfig = config.targets[targetKey];
        const messages = await repositories.source.getForceDrainWindow(userId, presetId, cursor, boundaryMessageId, {
          newBatchSize: targetConfig.lagThreshold, contextWindow: targetConfig.contextWindow,
        });
        if (!messages.length) throw new Error(`No valid source remains between cursor ${cursor} and rebuild boundary ${boundaryMessageId}`);
        const targetMessageId = Math.max(...messages.filter((message) => message.id > cursor).map((message) => message.id));
        if (!Number.isSafeInteger(targetMessageId) || targetMessageId <= cursor || targetMessageId > boundaryMessageId) {
          throw new Error(`Invalid force-drain targetMessageId for ${targetKey}`);
        }
        candidates.push({ targetKey, cursor, targetMessageId, messages });
      }
      if (!candidates.length) break;

      const sourceWatermark = Math.min(...candidates.map((candidate) => candidate.targetMessageId));
      const wave = candidates.filter((candidate) => candidate.targetMessageId === sourceWatermark);
      const envelopes = [];
      const capacityBlockedEnvelopes = [];
      for (const candidate of wave) {
        const { targetKey, cursor, targetMessageId, messages } = candidate;
        const intent = {
          targetKey,
          proposer: TARGETS[targetKey].proposer,
          targetSections: TARGETS[targetKey].sections.slice(),
          cursorBefore: cursor,
          trigger: { type: "forceDrain", sourceWatermark },
        };
        const tasks = typeof repositories.runtime.listTasksForTarget === "function"
          ? await repositories.runtime.listTasksForTarget(userId, presetId, targetKey)
          : [];
        const latest = tasks.find((task) => (
          rowValue(task, "task_type", "taskType") !== "maintenance"
          && Number(rowValue(task, "source_generation", "sourceGeneration")) === sourceGeneration
          && Number(rowValue(task, "cursor_before", "cursorBefore")) === cursor
          && Number(rowValue(task, "target_message_id", "targetMessageId")) === targetMessageId
        ));
        const latestStatus = rowValue(latest, "status", "status");
        const notBefore = rowValue(latest, "not_before", "notBefore");
        if (latestStatus === "retry_wait" && notBefore && new Date(notBefore).getTime() > now().getTime()) {
          const result = { status: "retry_wait", taskId: rowValue(latest, "task_id", "taskId"), notBefore,
            reason: rowValue(latest, "last_error_reason", "lastErrorReason"), stage: latest.stage,
            mode: rowValue(latest, "task_payload", "taskPayload")?.task?.mode };
          results.push(result);
          return { status: "incomplete", sourceGeneration, sourceWatermark, targetKey, result, results };
        }
        let envelope;
        if (latest && !TERMINAL_TASK_STATUSES.has(latestStatus)) {
          envelope = rowValue(latest, "task_payload", "taskPayload");
        } else {
          const latestTaskId = rowValue(latest, "task_id", "taskId");
          const dedupeSuffix = latest && ["failed", "cancelled"].includes(latestStatus)
            ? `force-drain:${sourceGeneration}:${boundaryMessageId}:resume:${latestTaskId}`
            : `force-drain:${sourceGeneration}:${boundaryMessageId}`;
          envelope = await normalWritePipeline.createTask(userId, presetId, intent, { messages, dedupeSuffix });
        }
        if (!envelope?.task) throw new Error(`Force-drain task payload is missing for ${targetKey}`);
        envelopes.push(envelope);
        if (rowValue(latest, "stage", "stage") === "capacity_blocked") capacityBlockedEnvelopes.push(envelope);
      }

      if (envelopes.some((envelope) => envelope.task.baseRevision !== state.meta.revision)) {
        if (typeof normalWritePipeline.cancelPreparedWave !== "function") {
          throw new Error("Source rebuild stale-wave recovery requires wave cancellation");
        }
        await normalWritePipeline.cancelPreparedWave(envelopes, "wave_baseline_mismatch");
        continue;
      }

      if (capacityBlockedEnvelopes.length) {
        if (typeof normalWritePipeline.resolvePreparedWaveCapacity !== "function"
          || typeof normalWritePipeline.cancelPreparedWave !== "function") {
          throw new Error("Source rebuild capacity recovery requires wave-aware pipeline operations");
        }
        const capacityResult = await normalWritePipeline.resolvePreparedWaveCapacity(capacityBlockedEnvelopes[0], { signal });
        results.push(capacityResult);
        if (!["compaction_applied", "capacity_resolved"].includes(capacityResult.status)) {
          return {
            status: "incomplete",
            sourceGeneration,
            sourceWatermark,
            targetKey: capacityBlockedEnvelopes[0].task.targetKey,
            result: capacityResult,
            results,
          };
        }
        await normalWritePipeline.cancelPreparedWave(envelopes, capacityResult.status === "capacity_resolved" ? "wave_capacity_resolved" : "wave_capacity_compacted");
        continue;
      }

      let prepared;
      try {
        prepared = await Promise.all(envelopes.map((envelope) => normalWritePipeline.prepareEnvelope(envelope, { signal })));
        if (prepared.some((result) => result.status === "context_expansion_required")) {
          prepared = await Promise.all(envelopes.map((envelope, index) => (
            prepared[index].status === "context_expansion_required"
              ? normalWritePipeline.prepareEnvelope(envelope, { signal })
              : prepared[index]
          )));
        }
      } catch (error) {
        error.migrationDetail ||= {
          sourceGeneration,
          sourceWatermark,
          targetKeys: wave.map((candidate) => candidate.targetKey),
          stage: "prepare_wave",
        };
        throw error;
      }
      const incompleteIndex = prepared.findIndex((result) => !["prepared", "committed"].includes(result.status));
      if (incompleteIndex >= 0) {
        const result = prepared[incompleteIndex];
        results.push(...prepared);
        return {
          status: "incomplete",
          sourceGeneration,
          sourceWatermark,
          targetKey: wave[incompleteIndex].targetKey,
          result,
          results,
        };
      }
      if (prepared.some(result => result.status === "committed")) {
        // A previous execution completed while this wave was preparing. Reload the
        // persisted cursor instead of applying this wave against its old baseline.
        results.push(...prepared.filter(result => result.status === "committed"));
        await normalWritePipeline.cancelPreparedWave(envelopes.filter((_, index) => prepared[index].status === "prepared"), "wave_baseline_mismatch");
        continue;
      }
      const committed = await normalWritePipeline.commitPreparedWave(prepared);
      if (committed.status === "capacity_deferred") {
        if (typeof normalWritePipeline.deferPreparedWaveCapacity !== "function"
          || typeof normalWritePipeline.resolvePreparedWaveCapacity !== "function"
          || typeof normalWritePipeline.cancelPreparedWave !== "function") {
          throw new Error("Source rebuild capacity handling requires wave-aware pipeline operations");
        }
        const capacityEntry = prepared.find((entry) => entry.envelope.task.taskId === committed.taskId);
        if (!capacityEntry) throw new Error("Capacity-deferred wave member is missing");
        const deferred = await normalWritePipeline.deferPreparedWaveCapacity(capacityEntry);
        if (deferred.status !== "capacity_deferred") {
          results.push(deferred);
          return {
            status: deferred.status === "stale" ? "stale" : "incomplete",
            sourceGeneration,
            sourceWatermark,
            targetKey: committed.targetKey,
            result: deferred,
            results,
          };
        }
        const capacityResult = await normalWritePipeline.resolvePreparedWaveCapacity(capacityEntry.envelope, { signal });
        results.push(deferred, capacityResult);
        if (!["compaction_applied", "capacity_resolved"].includes(capacityResult.status)) {
          return {
            status: "incomplete",
            sourceGeneration,
            sourceWatermark,
            targetKey: committed.targetKey,
            result: capacityResult,
            results,
          };
        }
        await normalWritePipeline.cancelPreparedWave(envelopes, capacityResult.status === "capacity_resolved" ? "wave_capacity_resolved" : "wave_capacity_compacted");
        continue;
      }
      results.push(...(committed.results ?? [committed]));
      if (committed.status !== "committed") {
        return {
          status: committed.status === "stale" ? "stale" : "incomplete",
          sourceGeneration,
          sourceWatermark,
          targetKey: committed.targetKey,
          result: committed,
          results,
        };
      }
    }
    if (finalizeTargets) {
      for (const targetKey of targetKeys) {
        const validated = await validateTarget(userId, presetId, targetKey, sourceGeneration, boundaryMessageId);
        if (validated.status === "stale") return { status: "stale", sourceGeneration, results };
      }
    }
    return { status: "completed", sourceGeneration, boundaryMessageId, results };
  }

  async function forceDrainTo(userId, presetId, options) {
    const { sourceGeneration, boundaryMessageId } = options;
    if (options.signal?.aborted) return { status: "interrupted", reason: "cancelled", sourceGeneration };
    const checkpoint = await repositories.runtime.getLibrarianCheckpoint(userId, presetId, sourceGeneration);
    let schedule = rowValue(checkpoint, "rebuild_schedule", "rebuildSchedule");
    if (!schedule) {
      const [messages, turns] = await Promise.all([
        repositories.source.listSchedulingMessages(userId, presetId, boundaryMessageId),
        repositories.source.listCompleteTurnBoundaries(userId, presetId, boundaryMessageId),
      ]);
      schedule = await repositories.runtime.initializeLibrarianRebuildSchedule(userId, presetId, sourceGeneration,
        buildRebuildLibrarianSchedule({ messages, turns, sourceBoundary: boundaryMessageId,
          lagThreshold: config.librarian.lagThreshold, messageBatchSize: config.librarian.messageBatchSize }));
    }
    validateRebuildLibrarianSchedule(schedule, boundaryMessageId);
    const turns = schedule.boundaries;
    const checkpointKind = rowValue(checkpoint, "watermark_kind", "watermarkKind") ?? "complete_turn";
    let completed = checkpointKind === schedule.watermarkKind
      ? Number(rowValue(checkpoint, "completed_ordinal", "completedOrdinal") ?? 0)
      : turns.filter((entry) => entry.boundaryMessageId <= Number(rowValue(checkpoint, "boundary_message_id", "boundaryMessageId") ?? 0)).length;
    const results = [];
    const alignPeriodicBoundary = async (desiredOrdinal) => {
      const state = await repositories.state.getState(userId, presetId);
      if (!state || state.meta.sourceGeneration !== sourceGeneration) return { status: "stale" };
      const aligned = findAlignedLibrarianBoundary(turns, {
        minimumOrdinal: desiredOrdinal,
        minimumBoundaryMessageId: furthestLibrarianBarrierCursor(state),
      });
      return aligned ? { status: "ready", ...aligned } : { status: "awaiting_complete_turn" };
    };
    let nextOrdinal = nextLibrarianPeriodicOrdinal(
      completed,
      schedule.interval,
    );
    while (nextOrdinal <= turns.length) {
      const aligned = await alignPeriodicBoundary(nextOrdinal);
      if (aligned.status === "stale") return { status: "stale", sourceGeneration, results };
      if (aligned.status === "awaiting_complete_turn") break;
      const periodicBoundary = aligned.boundaryMessageId;
      const periodicOrdinal = aligned.watermarkOrdinal;
      const drained = await forceDrainTargetsTo(userId, presetId, {
        ...options,
        boundaryMessageId: periodicBoundary,
        rebuildBoundaryMessageId: boundaryMessageId,
        finalizeTargets: false,
      });
      results.push(...(drained.results || []));
      if (drained.status !== "completed") return { ...drained, results };
      if (options.signal?.aborted) return { status: "interrupted", reason: "cancelled", sourceGeneration, results };
      const maintained = await librarian.runAt(userId, presetId, {
        sourceGeneration,
        boundaryMessageId: periodicBoundary,
        watermarkOrdinal: periodicOrdinal,
        watermarkKind: schedule.watermarkKind,
        triggerType: "rebuild",
        skipBarrier: true,
        signal: options.signal,
      });
      results.push(maintained);
      if (!["committed", "noop", "completed"].includes(maintained.status)) {
        return {
          status: "incomplete",
          sourceGeneration,
          boundaryMessageId: periodicBoundary,
          reason: "librarian_not_terminal",
          result: maintained,
          results,
        };
      }
      completed = periodicOrdinal;
      nextOrdinal = nextLibrarianPeriodicOrdinal(
        completed,
        schedule.interval,
      );
    }
    const drained = await forceDrainTargetsTo(userId, presetId, {
      ...options,
      rebuildBoundaryMessageId: boundaryMessageId,
      finalizeTargets: false,
    });
    results.push(...(drained.results || []));
    if (drained.status !== "completed") return { ...drained, results };
    if (options.signal?.aborted) return { status: "interrupted", reason: "cancelled", sourceGeneration, results };
    const final = await librarian.runFinal(userId, presetId, boundaryMessageId, {
      sourceGeneration,
      signal: options.signal,
      triggerType: "rebuild_final",
      skipBarrier: true,
      schedule,
    });
    results.push(...(final.results || []));
    if (final.status !== "completed") {
      return {
        status: "incomplete",
        sourceGeneration,
        boundaryMessageId,
        reason: "librarian_final_not_terminal",
        result: final,
        results,
      };
    }
    const finalized = await forceDrainTargetsTo(userId, presetId, options);
    results.push(...(finalized.results || []));
    if (finalized.status !== "completed") return { ...finalized, results };
    return { status: "completed", sourceGeneration, boundaryMessageId, results };
  }

  function mutateAndRebuild(userId, presetId, options = {}) {
    return enqueueByKey(`${userId}:${presetId}`, async () => {
      const initialized = await initializeGeneration(userId, presetId, options);
      if (initialized.rebuildRequired === false) return { ...initialized, status: "completed" };
      const drained = await forceDrainTo(userId, presetId, initialized);
      return { ...initialized, ...drained };
    });
  }

  return Object.freeze({ initializeGeneration, initializeRecoveryGeneration, forceDrainTo, forceDrainTargetsTo, validateTarget, mutateAndRebuild });
}

module.exports = { createMemorySourceRebuild };
