const { validateMemoryState } = require("../contracts/state");
const { replayEventGroups } = require("../domain/eventReplay");

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function createMemoryStateRecovery({ repositories, sourceRebuild } = {}) {
  if (!repositories?.state || !repositories?.audit || !repositories.withTransaction || !sourceRebuild?.initializeRecoveryGeneration) {
    throw new Error("Memory state recovery dependencies are required");
  }

  async function restoreLatestCompleteSnapshot(userId, presetId) {
    return repositories.withTransaction(async (client) => {
      const raw = await repositories.state.getRawState(userId, presetId, { client, forUpdate: true });
      if (raw === null) return { status: "missing" };
      if (validateMemoryState(raw).ok) return { status: "healthy", state: raw };
      const head = await repositories.audit.getRecoveryHead(userId, presetId, { client });
      const snapshots = await repositories.audit.listSnapshotsForRecovery(userId, presetId, { client });
      for (const row of snapshots) {
        const state = rowValue(row, "state", "state");
        const revision = Number(rowValue(row, "revision", "revision"));
        const generation = Number(rowValue(row, "source_generation", "sourceGeneration"));
        if (generation !== head.sourceGeneration || revision > head.revision || state?.meta?.revision !== revision || state?.meta?.sourceGeneration !== generation) continue;
        if (!validateMemoryState(state).ok) continue;
        if (revision === head.revision) {
          await repositories.state.writeState(userId, presetId, state, { client });
          return { status: "snapshot_restored", revision, sourceGeneration: generation, state };
        }
        if (typeof repositories.audit.listRevisionGroups !== "function" || typeof repositories.audit.listEventsForGroups !== "function") continue;
        try {
          const groups = await repositories.audit.listRevisionGroups(userId, presetId, generation, revision, { client });
          if (!groups.length || Number(rowValue(groups.at(-1), "result_revision", "resultRevision")) !== head.revision) continue;
          const groupIds = groups.map((group) => rowValue(group, "event_group_id", "eventGroupId"));
          const events = await repositories.audit.listEventsForGroups(groupIds, { client });
          const replayed = replayEventGroups(state, groups, events, { userId, presetId });
          if (replayed.meta.revision !== head.revision || replayed.meta.sourceGeneration !== head.sourceGeneration) continue;
          await repositories.state.writeState(userId, presetId, replayed, { client });
          return { status: "events_replayed", revision: replayed.meta.revision, sourceGeneration: generation, state: replayed };
        } catch (error) {
          if (error?.code !== "MEMORY_V2_EVENT_REPLAY_INVALID") throw error;
        }
      }
      return { status: "rebuild_required" };
    });
  }

  async function recoverScope(userId, presetId) {
    const restored = await restoreLatestCompleteSnapshot(userId, presetId);
    if (restored.status !== "rebuild_required") return restored;
    const initialized = await sourceRebuild.initializeRecoveryGeneration(userId, presetId);
    const drained = await sourceRebuild.forceDrainTo(userId, presetId, initialized);
    return { status: drained.status === "completed" ? "rebuilt" : "rebuild_incomplete", ...initialized, ...drained };
  }

  return Object.freeze({ recoverScope, restoreLatestCompleteSnapshot });
}

module.exports = { createMemoryStateRecovery };
