const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createNormalWritePipeline, taskRow } = require("../../modules/memory/application/normalWritePipeline");
const { loadFixtureCatalog, loadFixtures, runReducerFixture, assertTickExpected, validateFixture } = require("../../modules/memory/harness/runner");
const { createMemoryTestConfig } = require("./support/memory-builders");

const config = createMemoryTestConfig();

test("fixture catalog routes each scenario kind and runs reducer fixtures", () => {
  const root = path.join(__dirname, "../../modules/memory/harness/fixtures");
  const catalog = loadFixtureCatalog(root);
  assert.deepEqual(catalog.map((entry) => entry.fixtureKind).sort(), ["context", "pipeline", "reducer", "reducer"]);
  const recoveryCatalog = loadFixtureCatalog(path.join(__dirname, "../../modules/memory/harness/recovery-fixtures"));
  assert.equal(recoveryCatalog.length, 4);
  assert.equal(recoveryCatalog.every((entry) => entry.fixtureKind === "recovery"), true);
  const entries = loadFixtures(root);
  for (const { fixture, filePath } of entries) runReducerFixture(fixture, { config, idFactory: (() => { let id = 0; return () => `fixture-${++id}`; })() }, { filePath });
  const multiTick = entries.find((entry) => entry.fixture.name === "todo-add-with-valid-evidence").fixture;
  assert.equal(multiTick.ticks.length, 4);
});

function pipelineStore(fixture, tick) {
  let state = structuredClone(fixture.initialState);
  const tasks = new Map();
  const groups = new Map();
  const events = [];
  const snapshots = [];
  const statuses = Object.fromEntries(Object.entries(fixture.initialTargetStatuses).map(([key, value]) => [key, { targetKey: key, ...structuredClone(value) }]));
  const opsLog = [];
  return {
    inspect: { get state() { return state; }, tasks, groups, events, snapshots, statuses, opsLog },
    repositories: {
      async withTransaction(work) { return work({}); },
      state: {
        async getState() { return structuredClone(state); },
        async writeState(_userId, _presetId, next) { state = structuredClone(next); },
      },
      source: {
        async getByIds() { return structuredClone(tick.databaseMessages || []); },
      },
      runtime: {
        async createTask(row) { tasks.set(row.task_id, structuredClone(row)); return row; },
        async getTask(id) { return tasks.get(id) || null; },
        async getTaskForUpdate(id) { return tasks.get(id) || null; },
        async updateTask(id, changes) { Object.assign(tasks.get(id), structuredClone(changes)); return tasks.get(id); },
        async getTargetStatus(_userId, _presetId, targetKey) { return statuses[targetKey]; },
        async upsertTargetStatus(_userId, _presetId, next) { statuses[next.targetKey] = { ...statuses[next.targetKey], ...structuredClone(next) }; return statuses[next.targetKey]; },
        async appendOpsLog(row) { opsLog.push(structuredClone(row)); return row; },
      },
      audit: {
        async getEventGroup(id) { return groups.get(id) || null; },
        async insertEventGroup(group) { groups.set(group.event_group_id, structuredClone(group)); },
        async insertEvents(rows) { events.push(...structuredClone(rows)); },
        async insertSnapshot(_userId, _presetId, snapshot) { snapshots.push(structuredClone(snapshot)); },
      },
      sidecars: { async insertTombstone() {}, async listTombstones() { return []; } },
    },
  };
}

test("pipeline fixture asserts the complete durable commit contract", async () => {
  const filePath = path.join(__dirname, "../../modules/memory/harness/fixtures/pipeline/normal-todo-noop.json");
  const fixture = validateFixture(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath);
  const tick = fixture.ticks[0];
  const store = pipelineStore(fixture, tick);
  await store.repositories.runtime.createTask(taskRow(tick.input));
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: store.repositories, config,
    providerAdapter: { async propose() { return structuredClone(tick.adapterMock); } },
  });
  const result = await pipeline.processEnvelope(tick.input);
  const task = store.inspect.tasks.get(tick.input.task.taskId);
  const actual = {
    outcome: result.status === "committed" ? "committable" : result.status,
    state: store.inspect.state,
    events: store.inspect.events,
    eventGroup: [...store.inspect.groups.values()][0],
    snapshot: store.inspect.snapshots[0],
    task,
    targetStatus: store.inspect.statuses.todos,
    opsLog: store.inspect.opsLog,
    cursor: { todos: store.inspect.state.meta.targetCursors.todos },
    meta: store.inspect.state.meta,
    adapterError: null,
  };
  assertTickExpected(actual, tick, { fixture, filePath, config });
  assert.equal(store.inspect.groups.size, 1);
  assert.equal(store.inspect.snapshots.length, 1);
  assert.deepEqual(store.inspect.snapshots[0].state, store.inspect.state);
});
