function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function createProjectionDrain({ repositories, projectionKey, adapter } = {}) {
  if (!["rag", "recall"].includes(projectionKey)) throw new Error("projectionKey must be rag or recall");
  if (!repositories?.state || !repositories?.source || !repositories?.sidecars || !repositories?.withTransaction) throw new Error("Projection drain repositories are required");
  if (!adapter?.rebuild || !adapter?.append || !adapter?.commit) throw new Error("Projection adapter requires staged rebuild, append, and transactional commit");

  async function drain(userId, presetId) {
    const state = await repositories.state.getState(userId, presetId);
    if (!state) return { status: "skipped", reason: "state_missing" };
    const capturedGeneration = state.meta.sourceGeneration;
    const capturedBoundary = await repositories.source.getBoundary(userId, presetId);
    const checkpoint = await repositories.sidecars.getProjectionCheckpoint(userId, presetId, projectionKey);
    const processedGeneration = Number(rowValue(checkpoint, "processed_generation", "processedGeneration") ?? -1);
    const processedBoundary = Number(rowValue(checkpoint, "processed_boundary_message_id", "processedBoundaryMessageId") ?? 0);
    const tombstones = await repositories.sidecars.listTombstones(userId, presetId);
    let mode = "noop";
    let staged = null;
    if (processedGeneration !== capturedGeneration) {
      mode = "rebuild";
      staged = await adapter.rebuild({ userId, presetId, sourceGeneration: capturedGeneration, boundaryMessageId: capturedBoundary, tombstones });
    } else if (processedBoundary < capturedBoundary) {
      mode = "append";
      staged = await adapter.append({ userId, presetId, sourceGeneration: capturedGeneration, afterMessageId: processedBoundary, boundaryMessageId: capturedBoundary, tombstones });
    }
    return repositories.withTransaction(async (client) => {
      const current = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      const currentBoundary = await repositories.source.getBoundary(userId, presetId, { client });
      if (!current || current.meta.sourceGeneration !== capturedGeneration || currentBoundary !== capturedBoundary) return { status: "stale", projectionKey };
      if (mode !== "noop") await adapter.commit({ mode, staged, userId, presetId, sourceGeneration: capturedGeneration, boundaryMessageId: capturedBoundary, client });
      await repositories.sidecars.upsertProjectionCheckpoint(userId, presetId, {
        projectionKey, processedGeneration: capturedGeneration, processedBoundaryMessageId: capturedBoundary,
        status: "healthy", lastErrorReason: null,
      }, { client });
      return { status: "healthy", projectionKey, processedGeneration: capturedGeneration, processedBoundaryMessageId: capturedBoundary };
    });
  }
  return Object.freeze({ drain });
}

module.exports = { createProjectionDrain };
