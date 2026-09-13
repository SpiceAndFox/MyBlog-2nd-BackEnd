const { validateMemoryState, SCHEMA_VERSION } = require("../contracts");
const { replayEventGroups } = require("../domain/eventReplay");
const { recoverySnapshots, isSafeRecoveryCheckpoint } = require("./checkpointSafety");

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function validateSupportedState(state) {
  return validateMemoryState(state);
}

function createMemoryStateRecovery({ repositories, sourceRebuild } = {}) {
  if (!repositories?.state || !repositories?.audit || !repositories.withTransaction || !sourceRebuild?.initializeRecoveryGeneration) {
    throw new Error("Memory state recovery dependencies are required");
  }

  async function restoreLatestCompleteSnapshot(userId, presetId) {
    return repositories.withTransaction(async (client) => {
      await repositories.sourceWriteGuard.lockScope(userId, presetId, { client });
      const raw = await repositories.state.getRawState(userId, presetId, { client, forUpdate: true });
      if (raw === null) return { status: "missing" };
      if (raw.version !== SCHEMA_VERSION) {
        const error = new Error(`Memory state schema ${String(raw.version)} cannot be recovered by the 2.01-only runtime`);
        error.code = "MEMORY_V201_CUTOVER_REQUIRED";
        throw error;
      }
      if (validateSupportedState(raw).ok) return { status: "healthy", state: raw };
      const head = await repositories.audit.getRecoveryHead(userId, presetId, { client });
      const rawGeneration = Number.isSafeInteger(raw?.meta?.sourceGeneration) ? raw.meta.sourceGeneration : 0;
      const sourceGeneration = Math.max(rawGeneration, head.sourceGeneration);
      const boundaryMessageId = await repositories.source.getBoundary(userId, presetId, { client });
      const safety = { sourceGeneration, maxRevision: head.revision, boundaryMessageId,
        source: repositories.source, userId, presetId, client };
      for await (const row of recoverySnapshots(repositories.audit, userId, presetId, { client, sourceGeneration })) {
        const state = rowValue(row, "state", "state");
        const revision = Number(rowValue(row, "revision", "revision"));
        const generation = Number(rowValue(row, "source_generation", "sourceGeneration"));
        if (!await isSafeRecoveryCheckpoint(row, safety)) continue;
        if (revision === head.revision) {
          await repositories.state.writeState(userId, presetId, state, { client });
          return { status: "snapshot_restored", revision, sourceGeneration: generation, state };
        }
        if (typeof repositories.audit.listRevisionGroups !== "function" || typeof repositories.audit.listEventsForGroups !== "function") return { status: "rebuild_required" };
        try {
          const groups = await repositories.audit.listRevisionGroups(userId, presetId, generation, revision, { client });
          if (!groups.length || Number(rowValue(groups.at(-1), "result_revision", "resultRevision")) !== head.revision) return { status: "rebuild_required" };
          const groupIds = groups.map((group) => rowValue(group, "event_group_id", "eventGroupId"));
          const events = await repositories.audit.listEventsForGroups(groupIds, { client });
          const replayed = replayEventGroups(state, groups, events, { userId, presetId });
          if (replayed.meta.revision !== head.revision || replayed.meta.sourceGeneration !== head.sourceGeneration) return { status: "rebuild_required" };
          if (!await isSafeRecoveryCheckpoint({ state: replayed, revision: replayed.meta.revision,
            sourceGeneration, schemaVersion: SCHEMA_VERSION }, safety)) return { status: "rebuild_required" };
          await repositories.state.writeState(userId, presetId, replayed, { client });
          return { status: "events_replayed", revision: replayed.meta.revision, sourceGeneration: generation, state: replayed };
        } catch (error) {
          if (!["MEMORY_V201_EVENT_REPLAY_INVALID", "MEMORY_V201_STATE_INVALID"].includes(error?.code)) throw error;
          // A trusted checkpoint is already available. Replaying increasingly
          // long tails from every older snapshot adds no value to suffix repair.
          return { status: "rebuild_required" };
        }
      }
      return { status: "rebuild_required" };
    });
  }

  // This phase may replace the authority generation. The runtime must place it
  // behind both Chat sends and prior Memory work, without holding a model call.
  async function prepareScopeRecovery(userId, presetId) {
    const restored = await restoreLatestCompleteSnapshot(userId, presetId);
    if (restored.status !== "rebuild_required") return restored;
    const initialized = await sourceRebuild.initializeRecoveryGeneration(userId, presetId);
    return { status: "rebuild_initialized", ...initialized };
  }

  async function drainPreparedRecovery(userId, presetId, initialized, { signal } = {}) {
    const drained = await sourceRebuild.forceDrainTo(userId, presetId, { ...initialized, signal });
    return { ...initialized, ...drained, status: drained.status === "completed" ? "rebuilt" : "rebuild_incomplete" };
  }

  return Object.freeze({ prepareScopeRecovery, drainPreparedRecovery, restoreLatestCompleteSnapshot });
}

module.exports = { createMemoryStateRecovery };
