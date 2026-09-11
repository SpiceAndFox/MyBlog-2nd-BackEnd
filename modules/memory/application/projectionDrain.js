function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function errorReason(error) {
  const code = String(error?.code || error?.name || "projection_failed").trim();
  return code.slice(0, 200) || "projection_failed";
}

function createProjectionDrain({ repositories, projectionKey, adapter } = {}) {
  if (projectionKey !== "rag") throw new Error("projectionKey must be rag");
  if (!repositories?.state || !repositories?.source || !repositories?.sidecars || !repositories?.withTransaction) throw new Error("Projection drain repositories are required");
  if (!adapter?.rebuild || !adapter?.append || !adapter?.commit) throw new Error("Projection adapter requires staged rebuild, append, and transactional commit");

  async function drain(userId, presetId, { sourceGeneration, boundaryMessageId, signal } = {}) {
    if (signal?.aborted) return { status: "interrupted", reason: "cancelled" };
    const state = await repositories.state.getState(userId, presetId);
    if (!state) return { status: "skipped", reason: "state_missing" };
    const capturedGeneration = state.meta.sourceGeneration;
    const capturedBoundary = await repositories.source.getBoundary(userId, presetId);
    if ((sourceGeneration !== undefined && sourceGeneration !== capturedGeneration)
      || (boundaryMessageId !== undefined && boundaryMessageId !== capturedBoundary)) return { status: "stale", projectionKey };
    const checkpoint = await repositories.sidecars.getProjectionCheckpoint(userId, presetId, projectionKey);
    const processedGeneration = Number(rowValue(checkpoint, "processed_generation", "processedGeneration") ?? -1);
    const processedBoundary = Number(rowValue(checkpoint, "processed_boundary_message_id", "processedBoundaryMessageId") ?? 0);
    let mode = "noop";
    let staged = null;
    let rebuildProcessedGeneration = processedGeneration;
    let rebuildProcessedBoundary = processedBoundary;
    try {
      if (processedGeneration !== capturedGeneration || checkpoint?.status === "rebuilding") {
        mode = "rebuild";
        if (adapter.rebuildBatch && adapter.stageRebuildBatch && adapter.finalizeRebuild) {
          rebuildProcessedGeneration = capturedGeneration;
          rebuildProcessedBoundary = checkpoint?.status === "rebuilding"
            && processedGeneration === capturedGeneration
            ? processedBoundary
            : 0;
          while (true) {
            if (signal?.aborted) return { status: "interrupted", reason: "cancelled", projectionKey };
            staged = await adapter.rebuildBatch({
              userId,
              presetId,
              sourceGeneration: capturedGeneration,
              boundaryMessageId: capturedBoundary,
              afterMessageId: rebuildProcessedBoundary,
            });
            const nextBoundary = Number(staged?.processedBoundaryMessageId);
            if (!Number.isSafeInteger(nextBoundary)
              || nextBoundary < rebuildProcessedBoundary
              || nextBoundary > capturedBoundary) {
              throw new Error("RAG rebuild batch returned an invalid processed boundary");
            }
            const stagedResult = await repositories.withTransaction(async (client) => {
              const current = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
              const currentBoundary = await repositories.source.getBoundary(userId, presetId, { client });
              if (!current
                || current.meta.sourceGeneration !== capturedGeneration
                || currentBoundary !== capturedBoundary) return { status: "stale" };
              await adapter.stageRebuildBatch({
                staged,
                userId,
                presetId,
                sourceGeneration: capturedGeneration,
                boundaryMessageId: capturedBoundary,
                client,
              });
              await repositories.sidecars.upsertProjectionCheckpoint(userId, presetId, {
                projectionKey,
                processedGeneration: capturedGeneration,
                processedBoundaryMessageId: nextBoundary,
                status: "rebuilding",
                lastErrorReason: null,
              }, { client });
              return { status: "staged" };
            });
            if (stagedResult.status === "stale") return { status: "stale", projectionKey };
            rebuildProcessedBoundary = nextBoundary;
            if (!staged?.complete) continue;
            return repositories.withTransaction(async (client) => {
              const current = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
              const currentBoundary = await repositories.source.getBoundary(userId, presetId, { client });
              if (!current
                || current.meta.sourceGeneration !== capturedGeneration
                || currentBoundary !== capturedBoundary) return { status: "stale", projectionKey };
              await adapter.finalizeRebuild({
                userId,
                presetId,
                sourceGeneration: capturedGeneration,
                boundaryMessageId: capturedBoundary,
                client,
              });
              await repositories.sidecars.upsertProjectionCheckpoint(userId, presetId, {
                projectionKey,
                processedGeneration: capturedGeneration,
                processedBoundaryMessageId: capturedBoundary,
                status: "healthy",
                lastErrorReason: null,
              }, { client });
              return {
                status: "healthy",
                projectionKey,
                processedGeneration: capturedGeneration,
                processedBoundaryMessageId: capturedBoundary,
              };
            });
          }
        }
        staged = await adapter.rebuild({
          userId,
          presetId,
          sourceGeneration: capturedGeneration,
          boundaryMessageId: capturedBoundary,
        });
      } else if (processedBoundary < capturedBoundary) {
        mode = "append";
        staged = await adapter.append({ userId, presetId, sourceGeneration: capturedGeneration, afterMessageId: processedBoundary, boundaryMessageId: capturedBoundary });
      }
      return await repositories.withTransaction(async (client) => {
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
    } catch (error) {
      try {
        await repositories.withTransaction(async (client) => {
          const current = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
          if (!current || current.meta.sourceGeneration !== capturedGeneration) return;
          await repositories.sidecars.upsertProjectionCheckpoint(userId, presetId, {
            projectionKey,
            processedGeneration: mode === "rebuild" ? rebuildProcessedGeneration : capturedGeneration,
            processedBoundaryMessageId: mode === "rebuild" ? rebuildProcessedBoundary : processedBoundary,
            status: mode === "rebuild" ? "rebuilding" : "degraded",
            lastErrorReason: errorReason(error),
          }, { client });
        });
      } catch {
        // Preserve the projection failure as the primary error. The next poll retries from the durable checkpoint.
      }
      throw error;
    }
  }
  return Object.freeze({ drain });
}

module.exports = { createProjectionDrain };
