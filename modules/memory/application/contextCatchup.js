function createContextCatchup({ repositories, ensureState, sourceRebuild, enqueueByKey, runInBackground }) {
  const pending = new Map();
  return function requestContextCatchup(userId, presetId) {
    const key = `${userId}:${presetId}`;
    if (pending.has(key)) return pending.get(key);
    const promise = runInBackground(() => enqueueByKey(key, async ({ signal }) => {
      if (await repositories.privacy?.hasIncompleteOperation?.(userId, presetId)) {
        return { status: "skipped", reason: "privacy_delete_pending" };
      }
      const state = await ensureState(userId, presetId, { signal });
      if (!state) return { status: "skipped", reason: "state_recovery_pending" };
      const statuses = await repositories.runtime.getTargetStatuses(userId, presetId);
      const boundaries = [...new Set(statuses.filter(row =>
        Number(row.source_generation ?? row.sourceGeneration) === state.meta.sourceGeneration)
        .map(row => row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId)
        .filter(value => value != null).map(Number))];
      if (boundaries.length > 1) throw new Error("Memory rebuilding targets have inconsistent boundaries");
      // A rebuild keeps its frozen boundary and Librarian schedule. Ordinary
      // lag uses normal target tasks: it must not create or extend that schedule.
      if (boundaries.length) return sourceRebuild.forceDrainTo(userId, presetId, {
        sourceGeneration: state.meta.sourceGeneration, boundaryMessageId: boundaries[0], signal,
      });
      return sourceRebuild.forceDrainTargetsTo(userId, presetId, {
        sourceGeneration: state.meta.sourceGeneration,
        boundaryMessageId: await repositories.source.getBoundary(userId, presetId),
        rebuildBoundaryMessageId: null, finalizeTargets: false, signal,
      });
    }));
    pending.set(key, promise);
    const release = () => { if (pending.get(key) === promise) pending.delete(key); };
    void promise.then(release, release);
    return promise;
  };
}

module.exports = { createContextCatchup };
