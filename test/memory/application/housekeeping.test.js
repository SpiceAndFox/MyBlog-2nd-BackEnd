const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createMemoryHousekeeping } = require("../../../modules/memory/application/housekeeping");
const { createMemoryTestConfig } = require("../support/memory-builders");
const { replayEventGroups } = require("../../../modules/memory/domain/eventReplay");

test("capacity housekeeping remains replayable and does not deduplicate later evictions without due dates", async () => {
  let state = createInitialMemoryState();
  state.working.todos = [1, 2, 3].map(id => ({
    id: `todo:${id}`, text: `约定${id}`, sourceRefs: [{ messageId: id, contentHash: `sha256:${"a".repeat(64)}` }],
    createdAtMessageId: id, updatedAtMessageId: id, actor: "user", requester: "user", status: "active", dueAt: null, becameOverdueAt: null,
  }));
  const initial = structuredClone(state);
  const tasks = new Map(); const groups = []; const events = [];
  const config = createMemoryTestConfig({ sectionBudgets: { todos: { maxItems: 2 } } });
  const repositories = {
    withTransaction: async work => work({}),
    state: { getState: async () => structuredClone(state), writeState: async (_u, _p, next) => { state = next; } },
    source: {},
    runtime: { createTask: async row => {
      if (!tasks.has(row.dedupe_key)) tasks.set(row.dedupe_key, row);
      return tasks.get(row.dedupe_key);
    } },
    audit: { insertEventGroup: async row => groups.push(row), insertEvents: async rows => events.push(...rows), insertSnapshot: async () => {} },
  };
  const housekeeping = createMemoryHousekeeping({ repositories, config, now: () => new Date("2026-07-13T00:00:00Z") });
  assert.equal((await housekeeping.runTarget(1, "default", "todos")).status, "committed");
  assert.equal((await housekeeping.runTarget(1, "default", "todos")).status, "noop");
  config.sectionBudgets.todos.maxItems = 1;
  assert.equal((await housekeeping.runTarget(1, "default", "todos")).status, "committed");
  assert.equal(tasks.size, 2);
  assert.deepEqual(events.map(event => event.item_id), ["todo:1", "todo:2"]);
  assert.deepEqual(state.working.todos.map(item => item.id), ["todo:3"]);
  assert.deepEqual(replayEventGroups(initial, groups, events), state);
});

test("background housekeeping commits overdue transition once with a full snapshot", async () => {
  let state = createInitialMemoryState();
  state.working.todos.push({ id: "todo:1", text: "过期事项", sourceRefs: [{ messageId: 1, contentHash: `sha256:${"a".repeat(64)}` }], createdAtMessageId: 1, updatedAtMessageId: 1, actor: "user", requester: "user", status: "active", becameOverdueAt: null, dueAt: "2026-07-12T00:00:00.000Z" });
  const tasks = [];
  const groups = [];
  const events = [];
  const snapshots = [];
  const repositories = {
    withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
    state: { getState: async () => structuredClone(state), writeState: async (_u, _p, value) => { state = structuredClone(value); }, listInitializedScopes: async () => [{ userId: 1, presetId: "default" }] },
    source: { getByIds: async () => [] },
    runtime: { createTask: async (row) => { tasks.push(structuredClone(row)); return row; } },
    audit: { insertEventGroup: async (row) => groups.push(structuredClone(row)), insertEvents: async (rows) => events.push(...structuredClone(rows)), insertSnapshot: async (_u, _p, row) => snapshots.push(structuredClone(row)) },
  };
  const config = { scene: { ttlMs: 1000 }, sectionBudgets: { todos: { maxItems: 10, maxRenderedChars: 1000 }, recentEpisodes: { maxItems: 10, maxRenderedChars: 1000 } } };
  const housekeeping = createMemoryHousekeeping({ repositories, config, now: () => new Date("2026-07-13T00:00:00.000Z"), idFactory: () => "00000000-0000-4000-8000-000000000001" });
  const first = await housekeeping.runTarget(1, "default", "todos");
  const second = await housekeeping.runTarget(1, "default", "todos");
  assert.equal(first.status, "committed");
  assert.equal(second.status, "noop");
  assert.equal(state.working.todos[0].status, "overdue");
  assert.equal(state.meta.revision, 1);
  assert.equal(tasks.length, 1);
  assert.equal(groups.length, 1);
  assert.equal(events[0].cleanup_type, "todo_became_overdue");
  assert.deepEqual(snapshots[0].state, state);
});
