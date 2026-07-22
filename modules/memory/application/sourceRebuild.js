const { createInitialMemoryState, assertMemoryState, SCHEMA_VERSION, TARGETS, TARGET_KEYS } = require("../contracts");
const { isDeepStrictEqual } = require("node:util");

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

function createMemorySourceRebuild({ repositories, normalWritePipeline, config, enqueueByKey = (_key, work) => work(), now = () => new Date() } = {}) {
  if (!repositories?.withTransaction || !repositories.state || !repositories.source || !repositories.runtime || !repositories.audit || !repositories.sidecars) throw new Error("Source rebuild repositories are required");
  if (!normalWritePipeline?.createTask || !normalWritePipeline?.processEnvelope) throw new Error("Source rebuild requires the normal write pipeline");

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

  async function initializeGeneration(userId, presetId, {
    mutateSource = async () => {},
    purgeDerived = null,
    reason = "source_mutation",
    affectedFromMessageId: affectedFromOption = null,
  } = {}) {
    return repositories.withTransaction(async (client) => {
      await repositories.sourceWriteGuard.lockScope(userId, presetId, { client });
      const current = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!current) throw new Error("Memory state must be initialized before source mutation");
      const mutationResult = await mutateSource(client);
      const affectedFromMessageId = normalizeAffectedFromMessageId(
        typeof affectedFromOption === "function"
          ? await affectedFromOption(mutationResult, client)
          : affectedFromOption,
      );
      const boundary = await repositories.source.getBoundary(userId, presetId, { client });
      const sourceGeneration = current.meta.sourceGeneration + 1;
      const restored = await findSafeSnapshotState(
        userId,
        presetId,
        current,
        affectedFromMessageId,
        boundary,
        client,
      );
      if (purgeDerived) await purgeDerived(client, { sourceGeneration, boundaryMessageId: boundary, revision: current.meta.revision + 1 });
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
          targetKey, sourceGeneration, rebuildBoundaryMessageId: boundary, status: "rebuilding",
          consecutiveErrors: 0, lastErrorReason: null, lastTaskId: null, nextRetryAt: null,
        }, { client });
      }
      if (repositories.sidecars.markProjectionsRebuilding) await repositories.sidecars.markProjectionsRebuilding(userId, presetId, sourceGeneration, { client });
      if (repositories.sidecars.resolveDiagnosticsOutsideGeneration) await repositories.sidecars.resolveDiagnosticsOutsideGeneration(userId, presetId, sourceGeneration, { client });
      return {
        sourceGeneration,
        revision: next.meta.revision,
        boundaryMessageId: boundary,
        mutationResult,
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
      if (repositories.sidecars.markProjectionsRebuilding) await repositories.sidecars.markProjectionsRebuilding(userId, presetId, next.meta.sourceGeneration, { client });
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

  async function forceDrainTo(userId, presetId, { sourceGeneration, boundaryMessageId }) {
    const results = [];
    for (const targetKey of TARGET_KEYS) {
      while (true) {
        const state = await repositories.state.getState(userId, presetId);
        if (!state || state.meta.sourceGeneration !== sourceGeneration) return { status: "stale", sourceGeneration, results };
        const cursor = state.meta.targetCursors[targetKey] ?? 0;
        if (cursor >= boundaryMessageId) break;
        const targetStatus = await repositories.runtime.getTargetStatus(userId, presetId, targetKey);
        if (!targetStatus || Number(rowValue(targetStatus, "source_generation", "sourceGeneration")) !== sourceGeneration) {
          return { status: "stale", sourceGeneration, results };
        }
        if (rowValue(targetStatus, "status", "status") !== "rebuilding"
          || Number(rowValue(targetStatus, "rebuild_boundary_message_id", "rebuildBoundaryMessageId")) !== boundaryMessageId) {
          await repositories.runtime.upsertTargetStatus(userId, presetId, {
            targetKey,
            sourceGeneration,
            rebuildBoundaryMessageId: boundaryMessageId,
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
        const intent = { targetKey, proposer: TARGETS[targetKey].proposer, targetSections: TARGETS[targetKey].sections.slice(), cursorBefore: cursor, trigger: { type: "forceDrain" } };
        const targetMessageId = Math.max(...messages.filter((message) => message.id > cursor).map((message) => message.id));
        const tasks = typeof repositories.runtime.listTasksForTarget === "function"
          ? await repositories.runtime.listTasksForTarget(userId, presetId, targetKey)
          : [];
        const latest = tasks.find((task) => (
          Number(rowValue(task, "source_generation", "sourceGeneration")) === sourceGeneration
          && Number(rowValue(task, "cursor_before", "cursorBefore")) === cursor
          && Number(rowValue(task, "target_message_id", "targetMessageId")) === targetMessageId
        ));
        const latestStatus = rowValue(latest, "status", "status");
        const notBefore = rowValue(latest, "not_before", "notBefore");
        if (latestStatus === "retry_wait" && notBefore && new Date(notBefore).getTime() > now().getTime()) {
          const result = { status: "retry_wait", taskId: rowValue(latest, "task_id", "taskId"), notBefore };
          results.push(result);
          return { status: "incomplete", sourceGeneration, targetKey, result, results };
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
        let result;
        try {
          result = await normalWritePipeline.processEnvelope(envelope);
          if (result.status === "context_expansion_required") result = await normalWritePipeline.processEnvelope(envelope);
        } catch (error) {
          error.migrationDetail ||= {
            sourceGeneration,
            targetKey,
            cursorBefore: cursor,
            targetMessageId,
            taskId: envelope.task.taskId ?? null,
            stage: "process_envelope",
          };
          throw error;
        }
        results.push(result);
        if (!["committed"].includes(result.status)) return { status: "incomplete", sourceGeneration, targetKey, result, results };
      }
      const validated = await validateTarget(userId, presetId, targetKey, sourceGeneration, boundaryMessageId);
      if (validated.status === "stale") return { status: "stale", sourceGeneration, results };
    }
    return { status: "completed", sourceGeneration, boundaryMessageId, results };
  }

  function mutateAndRebuild(userId, presetId, options = {}) {
    return enqueueByKey(`${userId}:${presetId}`, async () => {
      const initialized = await initializeGeneration(userId, presetId, options);
      const drained = await forceDrainTo(userId, presetId, initialized);
      return { ...initialized, ...drained };
    });
  }

  return Object.freeze({ initializeGeneration, initializeRecoveryGeneration, forceDrainTo, validateTarget, mutateAndRebuild });
}

module.exports = { createMemorySourceRebuild };
