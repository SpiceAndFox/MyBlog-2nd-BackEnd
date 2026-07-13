const PROJECTION_KEY = "scene_capacity_diagnostics";
const DIAGNOSTIC_TYPE = "scene_capacity_exceeded";

function rowValue(row, camel, snake = camel) { return row?.[camel] ?? row?.[snake]; }
function eventPath(event) {
  const summary = rowValue(event, "patchSummary", "patch_summary");
  return summary?.path ?? null;
}

function groupEvents(events) {
  const groups = [];
  const byId = new Map();
  for (const event of events) {
    const groupId = rowValue(event, "eventGroupId", "event_group_id");
    let group = byId.get(groupId);
    if (!group) {
      group = { id: groupId, events: [] };
      byId.set(groupId, group);
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}

function createDiagnosticProjection({ repositories } = {}) {
  if (!repositories?.withTransaction || !repositories?.diagnosticProjection || !repositories?.sidecars) {
    throw new Error("Diagnostic projection repositories are required");
  }

  async function recordFailure(userId, presetId, error) {
    try {
      await repositories.withTransaction((client) => repositories.diagnosticProjection.recordProjectionError(
        userId,
        presetId,
        PROJECTION_KEY,
        error?.code || error?.message || "diagnostic_projection_failed",
        { client },
      ));
    } catch {}
  }

  async function syncScope(userId, presetId) {
    try {
      return await repositories.withTransaction(async (client) => {
        const checkpoint = await repositories.diagnosticProjection.lockCheckpoint(userId, presetId, PROJECTION_KEY, { client });
        const processedEventId = Number(rowValue(checkpoint, "processedEventId", "processed_event_id") ?? 0);
        const events = await repositories.diagnosticProjection.listCommittedEventsAfter(userId, presetId, processedEventId, { client });
        const activeRows = await repositories.sidecars.listActiveDiagnostics(userId, presetId, { client });
        let active = activeRows.find((row) => (
          rowValue(row, "subjectKind", "subject_kind") === "target"
          && rowValue(row, "subjectKey", "subject_key") === "scene"
          && rowValue(row, "diagnosticType", "diagnostic_type") === DIAGNOSTIC_TYPE
        )) || null;
        const pendingPaths = new Set(active?.detail?.rejectedPaths || []);
        let opened = 0;
        let resolved = 0;

        for (const group of groupEvents(events)) {
          const sceneEvents = group.events.filter((event) => (
            rowValue(event, "groupKind", "group_kind") === "proposal"
            && rowValue(event, "targetKey", "target_key") === "scene"
            && rowValue(event, "section") === "scene"
          ));
          if (!sceneEvents.length) continue;
          for (const event of sceneEvents) {
            const path = eventPath(event);
            if (!path) continue;
            if (rowValue(event, "decision") === "rejected" && rowValue(event, "rejectReason", "reject_reason") === "capacity_exceeded") pendingPaths.add(path);
            else if (rowValue(event, "decision") === "accepted") pendingPaths.delete(path);
          }
          const lastEvent = sceneEvents.at(-1);
          if (pendingPaths.size) {
            active = await repositories.sidecars.upsertActiveDiagnostic(userId, presetId, {
              subjectKind: "target",
              subjectKey: "scene",
              diagnosticType: DIAGNOSTIC_TYPE,
              targetCursor: Number(rowValue(lastEvent, "cursorAfter", "cursor_after") ?? 0),
              truncated: false,
              detail: {
                rejectedPaths: [...pendingPaths].sort(),
                sourceEventGroupId: group.id,
                sourceGeneration: Number(rowValue(lastEvent, "groupSourceGeneration", "group_source_generation") ?? 0),
                sourceRevision: Number(rowValue(lastEvent, "resultRevision", "result_revision") ?? 0),
              },
            }, { client });
            opened += 1;
          } else if (active) {
            const recovered = await repositories.sidecars.resolveDiagnostic(Number(active.id), { client });
            if (recovered) {
              await repositories.sidecars.createRecoveryNotification(userId, presetId, {
                subjectKind: "target",
                subjectKey: "scene",
                boundaryMessageId: Number(rowValue(lastEvent, "cursorAfter", "cursor_after") ?? 0),
                sourceGeneration: Number(rowValue(lastEvent, "groupSourceGeneration", "group_source_generation") ?? 0),
              }, { client });
              resolved += 1;
            }
            active = null;
          }
        }

        const nextEventId = events.length ? Number(rowValue(events.at(-1), "id")) : processedEventId;
        await repositories.diagnosticProjection.advanceCheckpoint(userId, presetId, PROJECTION_KEY, nextEventId, { client });
        return { status: "synced", processedEvents: events.length, processedEventId: nextEventId, opened, resolved };
      });
    } catch (error) {
      await recordFailure(userId, presetId, error);
      throw error;
    }
  }

  return Object.freeze({ syncScope });
}

module.exports = { createDiagnosticProjection, PROJECTION_KEY, DIAGNOSTIC_TYPE };
