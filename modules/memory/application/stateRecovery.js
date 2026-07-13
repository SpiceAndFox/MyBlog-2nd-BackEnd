const { validateMemoryState } = require("../contracts/state");

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
        if (revision !== head.revision || state?.meta?.revision !== revision || state?.meta?.sourceGeneration !== generation) continue;
        if (!validateMemoryState(state).ok) continue;
        await repositories.state.writeState(userId, presetId, state, { client });
        return { status: "snapshot_restored", revision, sourceGeneration: generation, state };
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
