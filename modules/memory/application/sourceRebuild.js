const { createInitialMemoryState, assertMemoryState, SCHEMA_VERSION, TARGETS, TARGET_KEYS } = require("../contracts");
const { filterRebuiltState } = require("../domain/suppression");
const { isDeepStrictEqual } = require("node:util");

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function createMemorySourceRebuild({ repositories, normalWritePipeline, config, enqueueByKey = (_key, work) => work() } = {}) {
  if (!repositories?.withTransaction || !repositories.state || !repositories.source || !repositories.runtime || !repositories.audit || !repositories.sidecars) throw new Error("Source rebuild repositories are required");
  if (!normalWritePipeline?.createTask || !normalWritePipeline?.processEnvelope) throw new Error("Source rebuild requires the normal write pipeline");

  async function initializeGeneration(userId, presetId, { mutateSource = async () => {}, purgeDerived = null, reason = "source_mutation" } = {}) {
    return repositories.withTransaction(async (client) => {
      const current = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!current) throw new Error("Memory state must be initialized before source mutation");
      const mutationResult = await mutateSource(client);
      const boundary = await repositories.source.getBoundary(userId, presetId, { client });
      const sourceGeneration = current.meta.sourceGeneration + 1;
      if (purgeDerived) await purgeDerived(client);
      const next = createInitialMemoryState();
      next.meta.revision = current.meta.revision + 1;
      next.meta.sourceGeneration = sourceGeneration;
      next.meta.targetCursors = Object.fromEntries(TARGET_KEYS.map((key) => [key, 0]));
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
      return { sourceGeneration, revision: next.meta.revision, boundaryMessageId: boundary, mutationResult };
    });
  }

  async function validateTarget(userId, presetId, targetKey, sourceGeneration, boundaryMessageId) {
    return repositories.withTransaction(async (client) => {
      const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      const status = await repositories.runtime.getTargetStatus(userId, presetId, targetKey, { client, forUpdate: true });
      if (!state || state.meta.sourceGeneration !== sourceGeneration) return { status: "stale", reason: "generation_mismatch" };
      if (Number(rowValue(status, "source_generation", "sourceGeneration")) !== sourceGeneration) return { status: "stale", reason: "target_generation_mismatch" };
      if ((state.meta.targetCursors[targetKey] ?? 0) < boundaryMessageId) throw new Error(`Target ${targetKey} has not reached its rebuild boundary`);
      const snapshot = await repositories.audit.getSnapshot(userId, presetId, state.meta.revision, { client });
      if (!snapshot || Number(snapshot.source_generation ?? snapshot.sourceGeneration) !== sourceGeneration) throw new Error("Current rebuild revision has no valid generation snapshot");
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
      const tombstones = await repositories.sidecars.listTombstones(userId, presetId, { client });
      const filtered = filterRebuiltState(state, tombstones);
      const targetSections = new Set(TARGETS[targetKey].sections);
      const suppressedInTarget = filtered.removedItemIds.some((id) => {
        for (const section of targetSections) {
          const container = ["todos", "standingAgreements", "recentEpisodes"].includes(section) ? state.working : state.longTerm;
          if (container[section]?.some((item) => item.id === id)) return true;
        }
        return false;
      });
      const sceneSuppressed = targetKey === "scene" && !isDeepStrictEqual(filtered.state.current.scene, state.current.scene);
      if (suppressedInTarget || sceneSuppressed) throw new Error(`Target ${targetKey} still contains suppressed source after rebuild`);
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
        const targetConfig = config.targets[targetKey];
        const messages = await repositories.source.getForceDrainWindow(userId, presetId, cursor, boundaryMessageId, {
          newBatchSize: targetConfig.lagThreshold, contextWindow: targetConfig.contextWindow,
        });
        if (!messages.length) throw new Error(`No valid source remains between cursor ${cursor} and rebuild boundary ${boundaryMessageId}`);
        const intent = { targetKey, proposer: TARGETS[targetKey].proposer, targetSections: TARGETS[targetKey].sections.slice(), cursorBefore: cursor, trigger: { type: "forceDrain" } };
        const envelope = await normalWritePipeline.createTask(userId, presetId, intent, { messages, dedupeSuffix: `force-drain:${sourceGeneration}:${boundaryMessageId}` });
        const result = await normalWritePipeline.processEnvelope(envelope);
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

  return Object.freeze({ initializeGeneration, forceDrainTo, validateTarget, mutateAndRebuild });
}

module.exports = { createMemorySourceRebuild };
