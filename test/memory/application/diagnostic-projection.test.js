const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiagnosticProjection, PROJECTION_KEY } = require("../../../modules/memory/application/diagnosticProjection");

function makeStore() {
  const data = { checkpoint: { processed_event_id: 0, last_error_reason: null }, events: [], diagnostics: [], notifications: [], nextId: 1 };
  const repositories = {
    async withTransaction(work) { return work({}); },
    diagnosticProjection: {
      async lockCheckpoint() { return data.checkpoint; },
      async listCommittedEventsAfter(_user, _preset, boundary) { return data.events.filter((event) => event.id > boundary); },
      async advanceCheckpoint(_user, _preset, key, boundary) {
        assert.equal(key, PROJECTION_KEY);
        data.checkpoint.processed_event_id = Math.max(data.checkpoint.processed_event_id, boundary);
        data.checkpoint.last_error_reason = null;
        return data.checkpoint;
      },
      async recordProjectionError(_user, _preset, _key, reason) { data.checkpoint.last_error_reason = reason; },
    },
    sidecars: {
      async listActiveDiagnostics() { return data.diagnostics.filter((row) => !row.resolved); },
      async upsertActiveDiagnostic(_user, _preset, diagnostic) {
        let row = data.diagnostics.find((entry) => !entry.resolved && entry.subjectKey === diagnostic.subjectKey && entry.diagnosticType === diagnostic.diagnosticType);
        if (!row) {
          row = { id: data.nextId++, resolved: false, ...structuredClone(diagnostic) };
          data.diagnostics.push(row);
        } else Object.assign(row, structuredClone(diagnostic));
        return row;
      },
      async resolveDiagnostic(id) {
        const row = data.diagnostics.find((entry) => entry.id === id && !entry.resolved);
        if (row) row.resolved = true;
        return row || null;
      },
      async createRecoveryNotification(_user, _preset, notification) {
        data.notifications.push(structuredClone(notification));
        return notification;
      },
    },
  };
  return { data, repositories };
}

function sceneEvent(id, groupId, decision, path, rejectReason = null, cursorAfter = id) {
  return {
    id,
    event_group_id: groupId,
    group_kind: "proposal",
    target_key: "scene",
    section: "scene",
    decision,
    reject_reason: rejectReason,
    patch_summary: { op: "setField", path, value: `${path}-${id}` },
    cursor_after: cursorAfter,
    group_source_generation: 0,
    result_revision: id,
  };
}

test("scene capacity diagnostics are an idempotent event projection with per-field recovery", async () => {
  const { data, repositories } = makeStore();
  const projection = createDiagnosticProjection({ repositories });
  data.events.push(
    sceneEvent(1, "group-1", "rejected", "note", "capacity_exceeded", 10),
    sceneEvent(2, "group-1", "accepted", "mood", null, 10),
  );

  const opened = await projection.syncScope(1, "default");
  assert.equal(opened.status, "synced");
  assert.equal(data.checkpoint.processed_event_id, 2);
  assert.deepEqual(data.diagnostics[0].detail.rejectedPaths, ["note"]);
  assert.equal(data.diagnostics[0].resolved, false);

  const duplicate = await projection.syncScope(1, "default");
  assert.equal(duplicate.processedEvents, 0);
  assert.equal(data.diagnostics.length, 1);

  data.events.push(sceneEvent(3, "group-2", "accepted", "location", null, 11));
  await projection.syncScope(1, "default");
  assert.equal(data.diagnostics[0].resolved, false, "an unrelated scene field must not clear the warning");

  data.events.push(sceneEvent(4, "group-3", "accepted", "note", null, 12));
  const recovered = await projection.syncScope(1, "default");
  assert.equal(recovered.resolved, 1);
  assert.equal(data.diagnostics[0].resolved, true);
  assert.deepEqual(data.notifications[0], { subjectKind: "target", subjectKey: "scene", boundaryMessageId: 12, sourceGeneration: 0 });
});

test("projection failures are recorded without advancing the durable checkpoint", async () => {
  const { data, repositories } = makeStore();
  repositories.diagnosticProjection.listCommittedEventsAfter = async () => { throw Object.assign(new Error("read failed"), { code: "READ_FAILED" }); };
  const projection = createDiagnosticProjection({ repositories });
  await assert.rejects(projection.syncScope(1, "default"), /read failed/);
  assert.equal(data.checkpoint.processed_event_id, 0);
  assert.equal(data.checkpoint.last_error_reason, "READ_FAILED");
});
