const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { applySemanticEvent, replayEventGroups } = require("../../modules/memory/domain/eventReplay");

const contentHash = `sha256:${"a".repeat(64)}`;
const ref = { messageId: 1, contentHash, quote: "答应归还书" };

function proposalGroup(overrides = {}) {
  return {
    event_group_id: "group-1", user_id: 1, preset_id: "default", task_id: "task-1", target_key: "todos",
    source_generation: 0, schema_version: 2, base_revision: 0, result_revision: 1,
    cursor_before: 0, cursor_after: 1, group_kind: "proposal", ...overrides,
  };
}

function addEvent(overrides = {}) {
  const value = {
    id: "todo:1", text: "归还书", evidenceGroups: [{ evidenceKind: "user_commitment", refs: [ref] }],
    createdAtMessageId: 1, updatedAtMessageId: 1, actor: "user", requester: "user",
    status: "active", becameOverdueAt: null, dueAt: "2026-07-13T00:00:00.000Z",
  };
  return {
    event_group_id: "group-1", event_index: 0, user_id: 1, preset_id: "default", task_id: "task-1",
    target_key: "todos", section: "todos", event_kind: "proposal_decision", decision: "accepted",
    op: "addItem", item_id: null, result_item_id: "todo:1", merged_from_item_ids: null,
    evidence_kind: "user_commitment", cleanup_type: null,
    normalized_operation: { op: "addItem", value, evidenceKind: "user_commitment", evidenceRefs: [ref] },
    ...overrides,
  };
}

function overdueEvent(overrides = {}) {
  return {
    event_group_id: "group-1", event_index: 1, user_id: 1, preset_id: "default", task_id: "task-1",
    target_key: "todos", section: "todos", event_kind: "system_cleanup", decision: "system_cleanup",
    op: null, item_id: "todo:1", result_item_id: null, merged_from_item_ids: null,
    evidence_kind: null, cleanup_type: "todo_became_overdue",
    normalized_operation: { cleanupKind: "todo_became_overdue", itemId: "todo:1", becameOverdueAt: "2026-07-13T00:00:00.000Z" },
    ...overrides,
  };
}

test("event replay applies validated accepted and cleanup operations", () => {
  const replayed = replayEventGroups(createInitialMemoryState(), [proposalGroup()], [addEvent(), overdueEvent()], { userId: 1, presetId: "default" });
  assert.equal(replayed.meta.revision, 1);
  assert.equal(replayed.meta.targetCursors.todos, 1);
  assert.equal(replayed.working.todos[0].status, "overdue");
  assert.equal(replayed.working.todos[0].becameOverdueAt, replayed.working.todos[0].dueAt);
});

test("event replay permits a validated zero-event cursor-only proposal revision", () => {
  const replayed = replayEventGroups(createInitialMemoryState(), [proposalGroup()], [], { userId: 1, presetId: "default" });
  assert.equal(replayed.meta.revision, 1);
  assert.equal(replayed.meta.targetCursors.todos, 1);
});

test("event replay rejects audit-only groups", () => {
  assert.throws(
    () => replayEventGroups(createInitialMemoryState(), [proposalGroup({ result_revision: null, cursor_after: 0 })], []),
    /Audit-only group cannot be replayed/
  );
});

for (const [name, mutate, pattern] of [
  ["schema mismatch", ({ group }) => { group.schema_version = 3; }, /schema version mismatch/],
  ["revision gap", ({ group }) => { group.base_revision = 2; group.result_revision = 3; }, /revision gap/],
  ["source generation mismatch", ({ group }) => { group.source_generation = 1; }, /source generation mismatch/],
  ["cursor discontinuity", ({ group }) => { group.cursor_before = 1; group.cursor_after = 2; }, /Cursor discontinuity/],
  ["missing normalized operation", ({ events }) => { events[0].normalized_operation = null; }, /missing normalized operation/],
  ["unknown accepted operation", ({ events }) => { events[0].op = "futureOp"; events[0].normalized_operation = { op: "futureOp" }; }, /Unknown accepted operation/],
  ["unknown cleanup kind", ({ events }) => { events[1].cleanup_type = "future_cleanup"; events[1].normalized_operation = { cleanupKind: "future_cleanup" }; }, /Unknown cleanup kind/],
  ["event index gap", ({ events }) => { events[0].event_index = 2; }, /event indexes.*not contiguous/],
  ["task mismatch", ({ events }) => { events[0].task_id = "wrong-task"; }, /event task does not match group/],
  ["cleanup item mismatch", ({ events }) => { events[1].item_id = "todo:wrong"; }, /item_id does not match/],
]) {
  test(`event replay fails closed on ${name}`, () => {
    const fixture = { group: proposalGroup(), events: [addEvent(), overdueEvent()] };
    mutate(fixture);
    assert.throws(
      () => replayEventGroups(createInitialMemoryState(), [fixture.group], fixture.events, { userId: 1, presetId: "default" }),
      pattern
    );
  });
}

test("applySemanticEvent fails closed without a known replay operation", () => {
  assert.throws(() => applySemanticEvent(createInitialMemoryState(), { decision: "accepted", section: "todos" }), /missing normalized operation/);
  assert.throws(() => applySemanticEvent(createInitialMemoryState(), { decision: "accepted", section: "todos", normalizedOperation: { op: "futureOp" } }), /Unknown accepted operation/);
  assert.throws(() => applySemanticEvent(createInitialMemoryState(), { decision: "system_cleanup", section: "todos", normalizedOperation: { cleanupKind: "future_cleanup" } }), /Unknown cleanup kind/);
});
