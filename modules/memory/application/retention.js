const { isDeepStrictEqual } = require("node:util");
const { assertMemoryState } = require("../contracts");
const { createDiagnosticProjection } = require("./diagnosticProjection");
const { replayEventGroups } = require("../domain/eventReplay");

function cutoff(now, days) { return new Date(new Date(now).getTime() - days * 86_400_000); }

function createMemoryRetention({ repositories, config, diagnosticProjection, now = () => new Date() } = {}) {
  if (!repositories?.withTransaction || !repositories.state || !repositories.audit || !repositories.runtime || !repositories.sidecars) throw new Error("Retention repositories are required");
  if (!config?.retention) throw new Error("Memory retention config is required");
  const eventDiagnosticProjection = diagnosticProjection || (repositories.diagnosticProjection
    ? createDiagnosticProjection({ repositories })
    : null);
  async function runScope(userId, presetId) {
    if (eventDiagnosticProjection) await eventDiagnosticProjection.syncScope(userId, presetId);
    return repositories.withTransaction(async (client) => {
      const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!state) return { status: "skipped", reason: "state_missing" };
      assertMemoryState(state);
      const snapshots = await repositories.audit.listSnapshots(userId, presetId, state.meta.sourceGeneration, { client });
      const authoritySnapshot = snapshots.find((row) => Number(row.revision) === state.meta.revision);
      if (!authoritySnapshot || !isDeepStrictEqual(authoritySnapshot.state, state)) throw new Error("Current authority snapshot is not a valid retention anchor");
      const snapshotCutoff = cutoff(now(), config.retention.snapshotDays).getTime();
      const eventCutoff = cutoff(now(), config.retention.eventDays).getTime();
      const groups = await repositories.audit.listRevisionGroups(userId, presetId, state.meta.sourceGeneration, -1, { client });
      const oldGroupRevisions = new Set(groups.filter((row) => new Date(row.created_at ?? row.createdAt).getTime() <= eventCutoff).map((row) => Number(row.result_revision ?? row.resultRevision)));
      const eligible = snapshots.filter((row) => {
        const revision = Number(row.revision);
        return new Date(row.created_at ?? row.createdAt).getTime() <= snapshotCutoff && (revision === Number(snapshots[0]?.revision) || oldGroupRevisions.has(revision));
      });
      const anchor = eligible.at(-1) || snapshots[0];
      if (!anchor) throw new Error("Active generation has no retention anchor snapshot");
      assertMemoryState(anchor.state);
      const oldAnchor = snapshots[0];
      const absorbedGroups = groups.filter((row) => Number(row.result_revision ?? row.resultRevision) > Number(oldAnchor.revision) && Number(row.result_revision ?? row.resultRevision) <= Number(anchor.revision));
      const absorbedEvents = await repositories.audit.listEventsForGroups(absorbedGroups.map((row) => row.event_group_id ?? row.eventGroupId), { client });
      const replayedAnchor = replayEventGroups(oldAnchor.state, absorbedGroups, absorbedEvents, { userId, presetId });
      if (!isDeepStrictEqual(replayedAnchor, anchor.state)) throw new Error("Retention anchor does not equal deterministic event replay");
      let expected = Number(anchor.revision) + 1;
      for (const group of groups.filter((row) => Number(row.result_revision ?? row.resultRevision) > Number(anchor.revision))) {
        if (Number(group.base_revision ?? group.baseRevision) !== expected - 1 || Number(group.result_revision ?? group.resultRevision) !== expected) throw new Error("Cannot promote a retention anchor across a revision gap");
        expected += 1;
      }
      if (expected - 1 !== state.meta.revision) throw new Error("Retention replay chain does not reach authority revision");
      const promoted = Number(anchor.revision) > Number(snapshots[0].revision)
        ? await repositories.audit.promoteAnchor(userId, presetId, state.meta.sourceGeneration, Number(anchor.revision), { client })
        : { snapshotsDeleted: 0, groupsDeleted: 0 };
      const statuses = await repositories.runtime.getTargetStatuses(userId, presetId, { client });
      const checkpoints = await repositories.sidecars.listProjectionCheckpoints(userId, presetId, { client });
      const targetsCurrent = statuses.length === 6 && statuses.every((row) => Number(row.source_generation ?? row.sourceGeneration) === state.meta.sourceGeneration && (row.rebuild_boundary_message_id ?? row.rebuildBoundaryMessageId) == null);
      const projectionsCurrent = checkpoints.length === 2 && checkpoints.every((row) => Number(row.processed_generation ?? row.processedGeneration) === state.meta.sourceGeneration && row.status === "healthy");
      const expiredAudit = await repositories.audit.deleteExpiredAudit(userId, presetId, {
        currentGeneration: state.meta.sourceGeneration,
        eventBefore: cutoff(now(), config.retention.eventDays),
        snapshotBefore: cutoff(now(), config.retention.snapshotDays),
        allowOldGenerations: targetsCurrent && projectionsCurrent,
      }, { client });
      const runtime = await repositories.runtime.deleteRetainedRuntime(userId, presetId, {
        taskBefore: cutoff(now(), config.retention.taskDays), opsBefore: cutoff(now(), config.retention.opsLogDays), anchorRevision: Number(anchor.revision),
      }, { client });
      return { status: "completed", anchorRevision: Number(anchor.revision), snapshotsDeleted: promoted.snapshotsDeleted, groupsDeleted: promoted.groupsDeleted, ...expiredAudit, ...runtime };
    });
  }
  return Object.freeze({ runScope });
}

module.exports = { createMemoryRetention };
