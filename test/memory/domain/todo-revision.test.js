const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { captureWriteLimits } = require("../../../modules/memory/contracts/sectionPolicy");
const { reduceCompiledProposal } = require("../../../modules/memory/domain/compiledReducer");
const { replayEventGroups } = require("../../../modules/memory/domain/eventReplay");
const { mapEventToRow } = require("../../../modules/memory/application/eventMapper");
const { normalizeLifecycle } = require("../../../modules/memory/domain/lifecycle");
const { createMemoryTestConfig, sha256 } = require("../support/memory-builders");

const config = createMemoryTestConfig();
const source = id => ({ messageId: id, contentHash: sha256(`message-${id}`) });
const PAST = "2026-01-02T00:00:00.000Z";
const FUTURE = "2026-09-12T00:00:00.000Z";
const NOW = "2026-09-10T00:00:00.000Z";
function fixture(status = "overdue") {
  const state = createInitialMemoryState();
  state.meta.targetCursors.todos = 2;
  state.working.todos.push({ id: "todo:1", text: "做三明治", actor: "assistant", requester: "assistant",
    dueAt: status === "overdue" ? PAST : FUTURE, status, becameOverdueAt: status === "overdue" ? PAST : null,
    createdAtMessageId: 1, updatedAtMessageId: 2, sourceRefs: [source(1), source(2)] });
  const task = { taskId: "task", tickId: 1, userId: 1, presetId: "test", proposer: "todoProposer", targetKey: "todos",
    targetSections: ["todos"], mode: "normal", sourceGeneration: 0, baseRevision: 0, cursorBefore: 2, targetMessageId: 4,
    now: NOW, writeLimits: captureWriteLimits(config) };
  return { state, task };
}
function patch(value = {}, refs = [source(1), source(2)]) {
  return { op: "reviseItem", itemId: "todo:1", value: { dueChange: { mode: "keep" }, ...value }, sourceRefs: refs };
}
function reduce(f, patches, reductionConfig = config) {
  let id = 0;
  return reduceCompiledProposal({ ...f, config: reductionConfig, idFactory: () => `id-${++id}`, proposal: {
    tickId: 1, proposer: "todoProposer", sectionResults: { todos: { status: "patches", patches } },
  } });
}
function replay(f, result) {
  const group = { event_group_id: "group", user_id: 1, preset_id: "test", task_id: "task", target_key: "todos",
    source_generation: 0, schema_version: f.state.version, base_revision: 0, result_revision: 1,
    cursor_before: 2, cursor_after: 4, group_kind: "proposal" };
  const rows = result.events.map((entry, i) => mapEventToRow(entry, f, "group", i));
  assert.deepEqual(replayEventGroups(f.state, [group], rows, { userId: 1, presetId: "test" }), result.state);
}

test("rescheduling an old Todo at capacity records its classified update before FIFO eviction", () => {
  const f = fixture();
  f.state.working.todos.push({ ...structuredClone(f.state.working.todos[0]), id: "todo:newer", text: "新约定",
    createdAtMessageId: 2, status: "active", dueAt: FUTURE, becameOverdueAt: null });
  const capacityConfig = createMemoryTestConfig({ sectionBudgets: { todos: { maxItems: 1 } } });
  const result = reduce(f, [patch({ dueChange: { mode: "set", dueAt: FUTURE } })], capacityConfig);
  assert.equal(result.outcome, "committable");
  assert.deepEqual(result.state.working.todos.map(item => item.id), ["todo:newer"]);
  assert.equal(result.events[0].normalizedOperation.value.status, "active");
  assert.deepEqual(result.cleanupEvents.map(event => event.cleanupKind), ["todo_capacity_evicted"]);
  replay(f, result);
});

test("legacy revival cleanup events remain replayable after deadline classification changes", () => {
  const f = fixture();
  const result = reduce(f, [patch({ dueChange: { mode: "set", dueAt: FUTURE } })]);
  const legacy = { eventKind: "system_cleanup", section: "todos", targetKey: "todos", decision: "system_cleanup",
    cleanupKind: "todo_revived_from_overdue",
    normalizedOperation: { cleanupKind: "todo_revived_from_overdue", itemId: "todo:1", dueAt: FUTURE } };
  replay(f, { ...result, events: [...result.events, legacy] });
});

test("exact Todo revisions are auditable noops with cursor progress and unchanged item metadata", () => {
  for (const status of ["active", "overdue"]) for (const op of ["reviseItem", "correctItem"]) {
    const f = fixture(status);
    const item = f.state.working.todos[0];
    for (const dueChange of [{ mode: "keep" }, { mode: "set", dueAt: item.dueAt }]) {
      const result = reduce(f, [{ ...patch({ text: item.text, actor: item.actor, requester: item.requester, dueChange }), op }]);
      assert.deepEqual(result.state.working.todos[0], item);
      assert.equal(result.events[0].decision, "noop");
      assert.equal(result.events[0].patchSummary.noopReason, "unchanged_todo");
      assert.equal(result.events[0].normalizedOperation, null);
      assert.equal(result.state.meta.targetCursors.todos, 4);
      assert.equal(result.state.meta.revision, 1);
      assert.equal(result.cleanupEvents.length, 0);
      replay(f, result);
    }
  }
});

test("evidence-only Todo revisions replace sources without reviving or changing overdue timestamps", () => {
  for (const status of ["active", "overdue"]) for (const op of ["reviseItem", "correctItem"]) {
    const f = fixture(status);
    const item = f.state.working.todos[0];
    const result = reduce(f, [{ ...patch({ dueChange: { mode: "set", dueAt: item.dueAt } }, [source(3), source(4)]), op }]);
    assert.deepEqual(result.state.working.todos[0], { ...item, sourceRefs: [source(3), source(4)], updatedAtMessageId: 4 });
    assert.equal(result.events[0].decision, "accepted");
    assert.equal(result.cleanupEvents.length, 0);
    assert.deepEqual(f.state.working.todos[0], item);
    replay(f, result);
  }
});

test("Todo edits classify deadlines independently of prior status and revise/correct semantics", () => {
  for (const status of ["active", "overdue"]) for (const op of ["reviseItem", "correctItem"]) {
    for (const [dueChange, deadline, expected] of [
      [{ mode: "keep" }, status === "active" ? FUTURE : PAST, status],
      [{ mode: "clear" }, null, "active"],
      [{ mode: "set", dueAt: "2026-01-03T00:00:00.000Z" }, "2026-01-03T00:00:00.000Z", "overdue"],
      [{ mode: "set", dueAt: NOW }, NOW, "overdue"],
      [{ mode: "set", dueAt: FUTURE }, FUTURE, "active"],
    ]) {
      const f = fixture(status);
      const result = reduce(f, [{ ...patch({ text: "修改了行动内容", actor: "both", dueChange }, [source(3)]), op }]);
      const item = result.state.working.todos[0];
      assert.equal(item.text, "修改了行动内容");
      assert.equal(item.actor, "both");
      assert.equal(item.requester, "assistant");
      assert.equal(item.dueAt, deadline);
      assert.equal(item.status, expected);
      assert.equal(item.becameOverdueAt, expected === "overdue" ? deadline : null);
      assert.equal(result.events[0].op, op);
      assert.equal(result.cleanupEvents.length, 0, "the accepted edit contains its classified post-state, not a new commitment event");
      replay(f, result);
      assert.equal(normalizeLifecycle(result.state, {}, NOW, config).changed, false);
    }
  }
});

test("requester is immutable under revise in either status but can be corrected", () => {
  for (const status of ["active", "overdue"]) {
    const f = fixture(status);
    assert.throws(() => reduce(f, [patch({ requester: "user" })]), error => {
      assert.equal(error.validationErrors[0].code, "TODO_REQUESTER_CHANGE_REQUIRES_CORRECTION");
      assert.equal(error.validationErrors[0].path, "$.sectionResults.todos.changes[0].requester");
      return true;
    });
    const result = reduce(f, [{ ...patch({ requester: "user" }), op: "correctItem" }]);
    assert.equal(result.state.working.todos[0].requester, "user");
    assert.equal(result.state.working.todos[0].status, status);
    replay(f, result);
  }
});

test("identical facts remain writable after delayed processing and agree at the same observation time", () => {
  for (const dueChange of [{ mode: "keep" }, { mode: "clear" }, { mode: "set", dueAt: "2026-01-03T00:00:00.000Z" }]) {
    const onTime = fixture("active");
    onTime.state.working.todos[0].dueAt = PAST;
    onTime.task.now = "2026-01-01T00:00:00.000Z";
    const delayed = fixture("overdue");
    const edits = [patch({ text: "重新准备早餐", actor: "both", dueChange })];
    const early = reduce(onTime, edits);
    const late = reduce(delayed, edits);
    assert.deepEqual(normalizeLifecycle(early.state, {}, NOW, config).state, late.state);
    replay(onTime, early);
    replay(delayed, late);
  }
});

test("terminal actions can close overdue items without fabricating a future deadline", () => {
  for (const status of ["active", "overdue"]) for (const op of ["completeTodo", "cancelTodo", "expireTodo", "forgetItem"]) {
    const f = fixture(status);
    const result = reduce(f, [{ op, itemId: "todo:1", sourceRefs: [source(3)] }]);
    assert.equal(result.state.working.todos.length, 0);
    replay(f, result);
  }
});

test("same due date does not suppress actual text or participant changes on active Todos", () => {
  const f = fixture("active");
  const result = reduce(f, [patch({ text: "做素食三明治", actor: "both", dueChange: { mode: "set", dueAt: FUTURE } })]);
  assert.equal(result.state.working.todos[0].text, "做素食三明治");
  assert.equal(result.state.working.todos[0].actor, "both");
  assert.equal(result.state.working.todos[0].requester, "assistant");
  assert.equal(result.events[0].decision, "accepted");
  replay(f, result);
});

test("noop and evidence-only Todo updates cannot bypass contract, limits or target checks", () => {
  const f = fixture();
  for (const invalid of [patch({}, []), patch({}, [source(1), source(1)]), patch({ actor: "unknown" })]) {
    assert.throws(() => reduce(f, [invalid]), error => error.code === "MEMORY_COMPILED_PROPOSAL_INVALID");
  }
  assert.throws(() => reduce(f, [{ ...patch(), itemId: "missing" }]), error => error.reason === "item_not_found");
  f.task.writeLimits.todos.maxSourceRefs = 1;
  assert.throws(() => reduce(f, [patch()]), error => error.validationErrors[0].code === "SOURCE_LIMIT_EXCEEDED");
  assert.throws(() => reduce(f, [patch({}, [source(3), source(4)])]), error => error.reason === "source_limit_exceeded");
  f.task.writeLimits.todos.maxSourceRefs = 16;
  f.task.writeLimits.todos.maxItemChars = 2;
  assert.throws(() => reduce(f, [patch()]), error => error.reason === "text_length_exceeded");
});

test("redundant Todo edits still participate in conflict checks; failures never partially mutate state", () => {
  const f = fixture();
  const before = structuredClone(f.state);
  assert.throws(() => reduce(f, [patch(), { op: "completeTodo", itemId: "todo:1", sourceRefs: [source(3)] }]), error => error.reason === "invalid_state_transition");
  assert.throws(() => reduce(f, [patch({}, [source(3)]), { op: "cancelTodo", itemId: "missing", sourceRefs: [source(4)] }]), error => error.reason === "item_not_found");
  assert.deepEqual(f.state, before);
});

test("Todo validation aggregates limits and requester errors before any mutation", () => {
  const f = fixture();
  f.task.writeLimits.todos.maxItemChars = 3;
  f.task.writeLimits.todos.maxSourceRefs = 1;
  const before = structuredClone(f.state);
  assert.throws(() => reduce(f, [patch({ text: "必须完整保留的任务内容", actor: "user", requester: "user",
    dueChange: { mode: "set", dueAt: NOW } })]), error => {
    assert.deepEqual(error.validationErrors.map(issue => issue.code), [
      "TEXT_LENGTH_EXCEEDED", "SOURCE_LIMIT_EXCEEDED", "TODO_REQUESTER_CHANGE_REQUIRES_CORRECTION",
    ]);
    assert.deepEqual(error.validationErrors.map(issue => issue.path.split("].")[1]), [
      "text", "evidenceMessageIds", "requester",
    ]);
    return true;
  });
  assert.deepEqual(f.state, before);
});

test("independent Todo changes report together while dependent changes identify their original conflict", () => {
  const f = fixture();
  f.state.working.todos.push({ ...structuredClone(f.state.working.todos[0]), id: "todo:2", text: "另一项任务" });
  const before = structuredClone(f.state);
  assert.throws(() => reduce(f, [
    patch({ requester: "user" }),
    { ...patch({ requester: "user" }), itemId: "todo:2" },
    { op: "completeTodo", itemId: "todo:1", sourceRefs: [source(3)] },
  ]), error => {
    assert.deepEqual(error.validationErrors.map(issue => issue.code), [
      "TODO_REQUESTER_CHANGE_REQUIRES_CORRECTION", "TODO_REQUESTER_CHANGE_REQUIRES_CORRECTION", "CHANGE_TARGET_CONFLICT",
    ]);
    assert.equal(error.validationErrors[2].path, "$.sectionResults.todos.changes[2]");
    assert.equal(error.validationErrors[2].meta.relatedPath, "$.sectionResults.todos.changes[0]");
    return true;
  });
  assert.deepEqual(f.state, before);
});

test("business diagnostics stay bounded and later failures do not commit earlier valid changes", () => {
  const f = fixture();
  const before = structuredClone(f.state);
  const invalid = Array.from({ length: 12 }, (_, index) => ({ ...patch(), itemId: `missing:${index}` }));
  assert.throws(() => reduce(f, [patch({ dueChange: { mode: "set", dueAt: FUTURE } }), ...invalid]), error => {
    assert.equal(error.validationErrors.length, 8);
    assert.equal(error.validationErrors[0].path, "$.sectionResults.todos.changes[1].ref");
    assert.equal(error.validationErrors.at(-1).path, "$.sectionResults.todos.changes[8].ref");
    return true;
  });
  assert.deepEqual(f.state, before);
});
