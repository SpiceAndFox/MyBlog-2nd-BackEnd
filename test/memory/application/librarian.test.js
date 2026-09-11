const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInitialMemoryState,
  LIBRARIAN_BARRIER_TARGETS,
} = require("../../../modules/memory/contracts");
const { createMemoryLibrarian } = require("../../../modules/memory/application/librarian");
const { createMemoryTestConfig, sha256, sequence } = require("../support/memory-builders");

const LIBRARIAN_INTERVAL_TURNS = 96;

function item(id, text, messageId) {
  return {
    id,
    text,
    sourceRefs: [{ messageId, contentHash: sha256(`${id}:${messageId}`) }],
    createdAtMessageId: messageId,
    updatedAtMessageId: messageId,
  };
}

const PERIODIC_BOUNDARY_MESSAGE_ID = LIBRARIAN_INTERVAL_TURNS * 2;

function store({ completeTurnCount = LIBRARIAN_INTERVAL_TURNS } = {}) {
  let state = createInitialMemoryState();
  state.longTerm.worldFacts.push(item("worldFact:1", "用户偏好简洁回答。", 1));
  state.longTerm.userProfile.push(item("userProfile:1", "用户偏好简洁回答。", 2));
  const tasks = new Map();
  const snapshots = [];
  const groups = [];
  const events = [];
  const ops = [];
  let checkpoint = null;
  const runtime = {
    async listTasksForTarget(_u, _p, targetKey) { return [...tasks.values()].filter(task => task.target_key === targetKey); },
    async getTargetStatus() { return null; },
    async getLatestTaskForDedupeKey(_u, _p, key) {
      return [...tasks.values()].reverse().find(task => task.dedupe_key === key || task.dedupe_key.startsWith(`${key}:retry:`)) || null;
    },
    async createTask(row) {
      const duplicate = [...tasks.values()].find((task) => task.dedupe_key === row.dedupe_key);
      if (duplicate) return duplicate;
      tasks.set(row.task_id, structuredClone(row));
      return tasks.get(row.task_id);
    },
    async getTask(id) { return tasks.get(id) || null; },
    async getTaskForUpdate(id) { return tasks.get(id) || null; },
    async updateTask(id, changes) {
      Object.assign(tasks.get(id), structuredClone(changes));
      return tasks.get(id);
    },
    async appendOpsLog(entry) { ops.push(structuredClone(entry)); return entry; },
    async getLibrarianCheckpoint() { return checkpoint; },
    async upsertLibrarianCheckpoint(_u, _p, value) {
      checkpoint = {
        source_generation: value.sourceGeneration,
        completed_ordinal: value.completedOrdinal,
        boundary_message_id: value.boundaryMessageId,
        last_task_id: value.lastTaskId,
      };
      return checkpoint;
    },
  };
  return {
    repositories: {
      withTransaction: async (work) => {
        const before = structuredClone({ state, tasks: [...tasks], snapshots, groups, events, ops, checkpoint });
        try { return await work({}); } catch (error) {
          state = before.state; checkpoint = before.checkpoint;
          tasks.clear(); for (const [key, row] of before.tasks) tasks.set(key, row);
          for (const [list, previous] of [[snapshots, before.snapshots], [groups, before.groups], [events, before.events], [ops, before.ops]]) list.splice(0, list.length, ...previous);
          throw error;
        }
      },
      state: {
        async getState() { return structuredClone(state); },
        async writeState(_u, _p, next) { state = structuredClone(next); },
      },
      runtime,
      audit: {
        async insertSnapshot(_u, _p, row) { snapshots.push(structuredClone(row)); },
        async insertEventGroup(row) { groups.push(structuredClone(row)); },
        async insertEvents(rows) { events.push(...structuredClone(rows)); },
      },
      source: {
        async getByIds(_u, _p, ids) { return ids.map(id => ({ id, role: "user", content: "用户偏好简洁回答。", contentHash: sha256((id === 1 ? "worldFact:1" : "userProfile:1") + ":" + id) })); },
        async getBoundary() { return completeTurnCount * 2; },
        async listCompleteTurnBoundaries() {
          return Array.from({ length: completeTurnCount }, (_, index) => ({
            watermarkOrdinal: index + 1,
            boundaryMessageId: (index + 1) * 2,
          }));
        },
      },
      userTimeZones: { async getTimeZone() { return "Asia/Shanghai"; } },
    },
    inspect: {
      get state() { return state; },
      get checkpoint() { return checkpoint; },
      tasks,
      snapshots,
      groups,
      events,
      ops,
    },
  };
}

async function alignBarrier(data, boundaryMessageId) {
  const state = await data.repositories.state.getState();
  for (const targetKey of LIBRARIAN_BARRIER_TARGETS) {
    state.meta.targetCursors[targetKey] = boundaryMessageId;
  }
  await data.repositories.state.writeState(1, "default", state);
}

function config() {
  return {
    ...createMemoryTestConfig(),
    providerRecovery: {
      retryMax: 1,
      transientRetryMax: 5,
      transportInvalidRetryMax: 1,
      schemaInvalidRetryMax: 1,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
    },
  };
}

test("Librarian fails fast when required config or time-zone access is missing", () => {
  const data = store();
  const providerAdapter = { async propose() { return { status: "ok" }; } };
  const missingRecovery = config();
  delete missingRecovery.providerRecovery;
  assert.throws(
    () => createMemoryLibrarian({
      repositories: data.repositories,
      providerAdapter,
      config: missingRecovery,
    }),
    /providerRecovery config is required/,
  );
  const missingTransportRetry = config();
  delete missingTransportRetry.providerRecovery.transportInvalidRetryMax;
  assert.throws(
    () => createMemoryLibrarian({
      repositories: data.repositories,
      providerAdapter,
      config: missingTransportRetry,
    }),
    /providerRecovery\.transportInvalidRetryMax/,
  );
  assert.throws(
    () => createMemoryLibrarian({
      repositories: { ...data.repositories, userTimeZones: undefined },
      providerAdapter,
      config: config(),
    }),
    /userTimeZones\.getTimeZone/,
  );
});

test("Librarian commits state, global event group, snapshot, task, and checkpoint atomically", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    idFactory: sequence("merged", "group"),
    providerAdapter: {
      async propose(envelope) {
        return {
          status: "ok",
          output: {
            tickId: envelope.task.tickId,
            proposer: "librarianProposer",
            status: "changes",
            operations: [{
              action: "merge",
              refs: ["W1", "UP1"], supportRefs: ["UP1-E1"],
              toSection: "userProfile",
              text: "用户偏好简洁回答。",
            }],
          },
        };
      },
    },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
    skipBarrier: true,
  });

  assert.equal(result.status, "committed");
  assert.equal(data.inspect.state.meta.revision, 1);
  assert.equal(data.inspect.state.longTerm.worldFacts.length, 0);
  assert.equal(data.inspect.state.longTerm.userProfile[0].id, "userProfile:merged");
  assert.equal(data.inspect.groups[0].target_key, "librarian");
  assert.equal(data.inspect.groups[0].group_kind, "maintenance");
  assert.equal(data.inspect.events.length, 1);
  assert.equal(data.inspect.snapshots.length, 1);
  assert.equal(data.inspect.checkpoint.completed_ordinal, LIBRARIAN_INTERVAL_TURNS);
  assert.equal([...data.inspect.tasks.values()][0].status, "succeeded");
});

test("periodic scheduling uses only complete-turn ordinals and noop advances no state revision", async () => {
  const data = store();
  let calls = 0;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope) {
        calls += 1;
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
    drainBarrier: async (_u, _p, options) => {
      assert.deepEqual(options.targetKeys, LIBRARIAN_BARRIER_TARGETS);
      const state = await data.repositories.state.getState();
      for (const targetKey of options.targetKeys) state.meta.targetCursors[targetKey] = options.boundaryMessageId;
      await data.repositories.state.writeState(1, "default", state);
      return { status: "completed" };
    },
  });
  const result = await librarian.runScheduled(1, "default");
  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.snapshots.length, 0);
  assert.equal(data.inspect.groups.length, 0);
  assert.equal(data.inspect.checkpoint.completed_ordinal, LIBRARIAN_INTERVAL_TURNS);
  assert.equal(data.inspect.checkpoint.boundary_message_id, PERIODIC_BOUNDARY_MESSAGE_ID);
});

test("periodic scheduling uses the configured Librarian lag threshold", async () => {
  const data = store({ completeTurnCount: 7 });
  const observedOrdinals = [];
  const customConfig = {
    ...config(),
    librarian: { lagThreshold: 3 },
  };
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: customConfig,
    providerAdapter: {
      async propose(envelope) {
        observedOrdinals.push(envelope.task.watermarkOrdinal);
        return {
          status: "ok",
          output: {
            tickId: envelope.task.tickId,
            proposer: "librarianProposer",
            status: "noop",
            operations: [],
          },
        };
      },
    },
    drainBarrier: async (_u, _p, options) => {
      await alignBarrier(data, options.boundaryMessageId);
      return { status: "completed" };
    },
  });

  const result = await librarian.runScheduled(1, "default");

  assert.equal(result.status, "completed");
  assert.deepEqual(observedOrdinals, [3, 6]);
  assert.equal(data.inspect.checkpoint.completed_ordinal, 6);
});

test("periodic scheduling rebases an empty checkpoint beyond already-processed target cursors", async () => {
  const completeTurnCount = LIBRARIAN_INTERVAL_TURNS + 24;
  const data = store({ completeTurnCount });
  const alreadyProcessedBoundary = PERIODIC_BOUNDARY_MESSAGE_ID + 8;
  await alignBarrier(data, alreadyProcessedBoundary);
  let observedTask = null;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope) {
        observedTask = envelope.task;
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
    drainBarrier: async (_u, _p, options) => {
      await alignBarrier(data, options.boundaryMessageId);
      return { status: "completed" };
    },
  });

  const result = await librarian.runScheduled(1, "default");

  assert.equal(result.status, "completed");
  assert.equal(observedTask.watermarkOrdinal, LIBRARIAN_INTERVAL_TURNS + 4);
  assert.equal(observedTask.boundaryMessageId, alreadyProcessedBoundary);
  assert.equal(data.inspect.checkpoint.completed_ordinal, LIBRARIAN_INTERVAL_TURNS + 4);
});

test("skipBarrier skips draining but still rejects misaligned Librarian input", async () => {
  const data = store();
  let calls = 0;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: { async propose() { calls += 1; throw new Error("must not be called"); } },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "rebuild",
    skipBarrier: true,
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "barrier_misaligned");
  assert.equal(calls, 0);
});

test("schema repair feedback is persisted before the Librarian retry", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const repairFeedback = [];
  const rejectedOutputs = [];
  const rejectedOutput = { tickId: "invalid", proposer: "librarianProposer", operations: "invalid" };
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope, options) {
        repairFeedback.push(options?.repairFeedback ?? null);
        rejectedOutputs.push(options?.rejectedOutput);
        if (repairFeedback.length === 1) {
          return {
            status: "error",
            reason: "output_schema_invalid",
            rejectedOutput,
            detail: {
              boundary: "output",
              errors: [{ path: "$.operations", message: "must be an array" }],
            },
          };
        }
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
    skipBarrier: true,
  });

  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "noop");
  assert.equal(repairFeedback.length, 2);
  assert.equal(repairFeedback[0], null);
  assert.equal(repairFeedback[1].attempt, 1);
  assert.deepEqual(rejectedOutputs[1], rejectedOutput);
  assert.equal(task.stage_payload.schemaInvalidAttempts, undefined);
  assert.deepEqual(task.stage_payload.schemaRejectedOutputs[0].output, rejectedOutput);
  assert.doesNotMatch(JSON.stringify(data.inspect.ops), /"operations":"invalid"/);
  assert.equal(task.attempt, 1);
  assert.equal(data.inspect.ops.some((entry) => entry.outcome === "output_schema_invalid_retry"), true);
});

test("schema repair feedback survives an interrupted Librarian call", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const repairFeedback = [];
  const rejectedOutputs = [];
  const rejectedOutput = { malformed: "restart-safe" };
  let calls = 0;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope, options) {
          calls += 1;
          repairFeedback.push(options?.repairFeedback ?? null);
          rejectedOutputs.push(options?.rejectedOutput);
          if (calls === 1) {
            return {
              status: "error",
              reason: "output_schema_invalid",
              rejectedOutput,
            detail: {
              boundary: "output",
              errors: [{ path: "$.operations", message: "must be an array" }],
            },
          };
        }
        if (calls === 2) throw new Error("simulated process interruption");
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
  });
  const envelope = await librarian.createTask(1, "default", {
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
  });

  await assert.rejects(
    librarian.processEnvelope(envelope),
    /simulated process interruption/,
  );
  const interrupted = data.inspect.tasks.get(envelope.task.taskId);
  assert.equal(interrupted.stage, "schema_invalid_retry");
  assert.equal(interrupted.stage_payload.schemaInvalidAttempts, undefined);

  const result = await librarian.processEnvelope(envelope);

  assert.equal(result.status, "noop");
  assert.equal(repairFeedback[2].attempt, 1);
  assert.deepEqual(rejectedOutputs[1], rejectedOutput);
  assert.deepEqual(rejectedOutputs[2], rejectedOutput);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).attempt, 1);
});

test("a full admission queue defers Librarian work without charging a retry", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const retryAt = new Date("2026-07-26T00:01:00.000Z");
  const fixedTime = new Date(retryAt.getTime() - config().providerRecovery.backoffBaseMs);
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    now: () => fixedTime,
    providerAdapter: {
      async propose() {
        return {
          status: "deferred",
          reason: "provider_queue_full",
        };
      },
    },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
    skipBarrier: true,
  });

  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "retry_wait");
  assert.equal(task.status, "retry_wait");
  assert.equal(task.stage, "provider_queue_full");
  assert.equal(new Date(task.not_before).getTime(), retryAt.getTime());
});


test("Librarian reducer failures enter bounded repair before semantic persistence", async () => {
  const data = store(); await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const state = await data.repositories.state.getState();
  state.longTerm.worldFacts[0].text = "长".repeat(201);
  await data.repositories.state.writeState(1, "default", state);
  let calls = 0;
  const librarian = createMemoryLibrarian({ repositories: data.repositories, config: config(), providerAdapter: { async propose(envelope, options) {
    calls++;
    if (calls === 2) assert.match(JSON.stringify(options.repairFeedback), /TEXT_LENGTH_EXCEEDED/);
    return { status: "ok", output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "changes", operations: [{ action: "move", ref: "W1", toSection: "userProfile" }] } };
  } } });
  const result = await librarian.runAt(1, "default", { sourceGeneration: 0, boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID, watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS, triggerType: "periodic", skipBarrier: true });
  assert.equal(result.status, "failed");
  assert.equal(calls, 2);
  assert.deepEqual(data.inspect.state, state);
  assert.equal(data.inspect.groups.length, 0);
  assert.equal(data.inspect.checkpoint, null);
  const task = [...data.inspect.tasks.values()][0];
  assert.equal(task.stage_payload.schemaInvalidAttempts, undefined);
  assert.equal(task.stage_payload.semanticResult, undefined);
});

test("Librarian commit rejects evidence edited after proposing", async () => {
  const data = store(); await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const before = structuredClone(data.inspect.state);
  const librarian = createMemoryLibrarian({ repositories: data.repositories, config: config(), providerAdapter: { async propose(envelope) {
    data.repositories.source.getByIds = async () => [];
    return { status: "ok", output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "changes", operations: [{ action: "move", ref: "W1", toSection: "userProfile" }] } };
  } } });
  const result = await librarian.runAt(1, "default", { sourceGeneration: 0, boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID, watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS, triggerType: "periodic", skipBarrier: true });
  assert.equal(result.reason, "source_validation_failed");
  assert.deepEqual(data.inspect.state, before);
  assert.equal(data.inspect.events.length, 0);
  assert.equal(data.inspect.checkpoint, null);
});


test("Librarian rolls back every commit write boundary and resumes its persisted proposal exactly once", async () => {
  for (const [owner, method] of [["state", "writeState"], ["audit", "insertSnapshot"], ["audit", "insertEventGroup"], ["audit", "insertEvents"], ["runtime", "upsertLibrarianCheckpoint"], ["runtime", "updateTask"]]) {
    const data = store(); await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
    const before = structuredClone(data.inspect.state);
    let calls = 0;
    const dependencies = { repositories: data.repositories, config: config(), providerAdapter: { async propose(envelope) {
      calls++;
      return { status: "ok", output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "changes", operations: [{ action: "move", ref: "W1", toSection: "userProfile" }] } };
    } } };
    const librarian = createMemoryLibrarian(dependencies);
    const envelope = await librarian.createTask(1, "default", { boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID, watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS, triggerType: "periodic" });
    const original = data.repositories[owner][method];
    let inject = true;
    data.repositories[owner][method] = async (...args) => {
      const result = await original(...args);
      if (inject && (method !== "updateTask" || args[1].stage === "committed")) { inject = false; throw new Error("injected commit failure"); }
      return result;
    };
    await assert.rejects(librarian.processEnvelope(envelope), /injected commit failure/);
    assert.deepEqual(data.inspect.state, before, method);
    assert.equal(data.inspect.events.length, 0, method);
    assert.equal(data.inspect.checkpoint, null, method);
    const recovered = createMemoryLibrarian(dependencies);
    const result = await recovered.processEnvelope(envelope);
    assert.equal(result.status, "committed", method);
    assert.equal(calls, 1, method);
    assert.equal(data.inspect.groups.length, 1, method);
    await recovered.processEnvelope(envelope);
    assert.equal(data.inspect.groups.length, 1, method);
    assert.equal(calls, 1, method);
  }
});

test("Librarian outages reuse one task and preserve deadlines after executor restart", async () => {
  const data = store(); await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  let time = Date.parse("2026-09-11T00:00:00Z"); let calls = 0;
  const settings = config(); settings.providerRecovery.backoffBaseMs = 30_000; settings.providerRecovery.backoffMaxMs = 120_000;
  const make = () => createMemoryLibrarian({ repositories: data.repositories, config: settings, now: () => new Date(time),
    providerAdapter: { async propose(envelope) {
      if (++calls <= 4) return { status: "error", reason: "llm_call_failed", detail: { code: "MEMORY_PROVIDER_TIMEOUT" } };
      return { status: "ok", output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] } };
    } } });
  const options = { sourceGeneration: 0, boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID, watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS, triggerType: "rebuild", skipBarrier: true };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await make().runAt(1, "default", options);
    assert.equal(result.status, "retry_wait");
    assert.equal((await make().runAt(1, "default", options)).taskId, result.taskId);
    assert.equal(calls, attempt); assert.equal(data.inspect.tasks.size, 1);
    assert.equal(data.inspect.checkpoint, null);
    time = Date.parse(result.notBefore);
  }
  assert.equal((await make().runAt(1, "default", options)).status, "noop");
  assert.equal(data.inspect.checkpoint.completed_ordinal, LIBRARIAN_INTERVAL_TURNS);
});

test("Librarian terminal schema failure is not automatically replaced; an explicit successor is reused", async () => {
  const data = store(); await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  let calls = 0; let outage = false;
  const librarian = createMemoryLibrarian({ repositories: data.repositories, config: config(), now: () => new Date("2026-09-11T00:00:00Z"),
    providerAdapter: { async propose() { calls++; return outage
      ? { status: "error", reason: "llm_call_failed", detail: { status: 503 } }
      : { status: "error", reason: "output_schema_invalid", detail: { boundary: "input" } }; } } });
  const options = { sourceGeneration: 0, boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID, watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS, triggerType: "rebuild", skipBarrier: true };
  const failed = await librarian.runAt(1, "default", options);
  assert.equal(failed.status, "failed");
  await librarian.runAt(1, "default", options);
  assert.equal(calls, 1); assert.equal(data.inspect.tasks.size, 1);
  outage = true;
  const successor = await librarian.runAt(1, "default", { ...options, resumeFailed: true });
  assert.equal(successor.status, "retry_wait"); assert.notEqual(successor.taskId, failed.taskId);
  assert.equal(data.inspect.tasks.get(successor.taskId).predecessor_task_id, failed.taskId);
  for (let n = 0; n < 3; n++) assert.equal((await librarian.runAt(1, "default", options)).taskId, successor.taskId);
  assert.equal(calls, 2); assert.equal(data.inspect.tasks.size, 2);
});

test("foreground manual Librarian waits on a frozen boundary while background manual run stays single-pass", async () => {
  const { createOperationRunner } = require("../../../modules/memory/application/operationRunner");
  const data = store(); await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  let time = Date.parse("2026-09-11T00:00:00Z"); let calls = 0;
  const librarian = createMemoryLibrarian({ repositories: data.repositories, config: config(), now: () => new Date(time),
    operationRunner: createOperationRunner({ now: () => time, sleepUntilNext: async ms => { time += ms; } }),
    drainBarrier: async () => ({ status: "completed" }),
    providerAdapter: { async propose(envelope) { return ++calls === 1
      ? { status: "error", reason: "llm_call_failed", detail: { status: 503 } }
      : { status: "ok", output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] } }; } } });
  assert.equal((await librarian.runManual(1, "default")).status, "incomplete"); assert.equal(calls, 1);
  assert.equal((await librarian.runManualAndWait(1, "default")).status, "completed"); assert.equal(calls, 2);
  assert.equal(data.inspect.tasks.size, 1);
  data.repositories.privacy = { hasIncompleteOperation: async () => true };
  await assert.rejects(librarian.runManualAndWait(1, "default"), { code: "MEMORY_PRIVACY_OPERATION_PENDING" });
  assert.equal(calls, 2);
});

test("a new foreground Librarian invocation reopens only budget exhaustion and retains its checkpoint", async () => {
  const { createOperationRunner } = require("../../../modules/memory/application/operationRunner");
  const data = store(); await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  let time = Date.parse("2026-09-11T00:00:00Z"); let calls = 0; let recovered = false;
  const settings = config(); settings.providerRecovery.transientRetryMax = 1;
  const librarian = createMemoryLibrarian({ repositories: data.repositories, config: settings, now: () => new Date(time),
    operationRunner: createOperationRunner({ now: () => time, sleepUntilNext: async ms => { time += ms; } }),
    drainBarrier: async () => ({ status: "completed" }), providerAdapter: { async propose(envelope) {
      calls++;
      return recovered ? { status: "ok", output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] } }
        : { status: "error", reason: "llm_call_failed", detail: { status: 503 } };
    } } });
  assert.equal((await librarian.runManualAndWait(1, "default")).status, "incomplete");
  assert.equal(calls, 2);
  const task = [...data.inspect.tasks.values()][0];
  assert.equal(task.stage, "retry_budget_exhausted");
  assert.equal(data.inspect.checkpoint, null);
  recovered = true;
  assert.equal((await librarian.runManualAndWait(1, "default")).status, "completed");
  assert.equal(calls, 3);
  assert.equal(data.inspect.tasks.size, 1);
  assert.equal(task.attempt, 2);
  assert.ok(data.inspect.checkpoint);
});
