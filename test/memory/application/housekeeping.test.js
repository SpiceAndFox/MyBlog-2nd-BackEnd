const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createMemoryHousekeeping } = require("../../../modules/memory/application/housekeeping");

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
  const config = { scene: { ttlMs: 1000 }, sectionBudgets: { recentEpisodes: { maxItems: 10, maxRenderedChars: 1000 } } };
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
