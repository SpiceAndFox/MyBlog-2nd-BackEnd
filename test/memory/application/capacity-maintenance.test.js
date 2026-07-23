const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { createNormalWritePipeline } = require("../../../modules/memory/application/normalWritePipeline");
const { createMemoryMetrics } = require("../../../modules/memory/application/metrics");
const { createMemoryRecovery } = require("../../../modules/memory/application/recovery");
const { reduceCompiledProposal } = require("../../../modules/memory/domain/compiledReducer");

const hash = (value) => `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
const message = { id: 3, role: "user", createdAt: "2026-07-13T00:00:00.000Z", contentKind: "raw", content: "还要记得归还杂志", contentHash: hash("还要记得归还杂志") };
const config = {
  targets: { todos: { lagThreshold: 1, contextWindow: 2 } }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
  scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
  sectionBudgets: Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: section === "todos" ? 2 : 20, maxRenderedChars: 2000 }])),
  providerRecovery: { retryMax: 2, schemaInvalidRetryMax: 1, backoffBaseMs: 1000, backoffMaxMs: 8000, haltAfterConsecutiveErrors: 3 },
  compaction: { retryMax: 1 },
};
const intent = { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], trigger: { type: "lagThreshold" } };

function todo(id, text, messageId) {
  return { id, text, actor: "user", requester: "user", status: "active", becameOverdueAt: null, dueAt: null, sourceRefs: [{ messageId, contentHash: hash(text) }], createdAtMessageId: messageId, updatedAtMessageId: messageId };
}
function normalOutput(envelope) {
  return { tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "changes", changes: [{ action: "add", text: "归还杂志", actor: "user", requester: "user", evidenceMessageIds: [3] }] } } };
}
function compiledNormalOutput(envelope) {
  return { tickId: envelope.task.tickId, proposer: "todoProposer", sectionResults: { todos: { status: "patches", patches: [{ op: "addItem", value: { text: "归还杂志", actor: "user", requester: "user", dueAt: null }, sourceRefs: [{ messageId: 3, contentHash: message.contentHash }] }] } } };
}
function compactionOutput(envelope) {
  return { tickId: envelope.task.tickId, proposer: "compactionProposer", sectionResults: { todos: { status: "changes", changes: [{ action: "merge", refs: ["T1", "T2"], text: "归还借阅物" }] } } };
}

function store() {
  let state = createInitialMemoryState();
  state.working.todos.push(todo("todo:1", "归还图书", 1), todo("todo:2", "把借来的书还回去", 2));
  const tasks = new Map(); const groups = new Map(); const events = []; const snapshots = []; const ops = []; const taskUpdates = [];
  const sourceMessages = [
    { id: 1, role: "user", createdAt: "2026-07-11T00:00:00.000Z", content: "归还图书", contentHash: hash("归还图书"), userId: 1, presetId: "default" },
    { id: 2, role: "user", createdAt: "2026-07-12T00:00:00.000Z", content: "把借来的书还回去", contentHash: hash("把借来的书还回去"), userId: 1, presetId: "default" },
    { ...message, userId: 1, presetId: "default" },
  ];
  const statuses = new Map([["todos", { target_key: "todos", source_generation: 0, status: "healthy", consecutive_errors: 0 }]]);
  const repositories = {
    withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
    state: { getState: async () => structuredClone(state), writeState: async (_u, _p, value) => { state = structuredClone(value); } },
    source: { getObservedWindow: async () => [message], getByIds: async (_u, _p, ids) => sourceMessages.filter((entry) => ids.includes(entry.id)) },
    runtime: {
      createTask: async (row) => { const existing = [...tasks.values()].find((task) => task.dedupe_key === row.dedupe_key); if (existing) return existing; tasks.set(row.task_id, { ...structuredClone(row), created_at: row.created_at ?? "2026-07-13T00:00:00.000Z" }); return tasks.get(row.task_id); },
      getTask: async (id) => tasks.get(id) || null, getTaskForUpdate: async (id) => tasks.get(id) || null,
      updateTask: async (id, changes) => { taskUpdates.push({ id, ...structuredClone(changes) }); return Object.assign(tasks.get(id), structuredClone(changes)); },
      listTasksForTarget: async () => [...tasks.values()].reverse(),
      listRecoverableTasks: async () => [...tasks.values()].filter((task) => ["queued", "running", "retry_wait"].includes(task.status)),
      getTargetStatus: async (_u, _p, key) => statuses.get(key),
      upsertTargetStatus: async (_u, _p, value) => statuses.set(value.targetKey, { target_key: value.targetKey, source_generation: value.sourceGeneration, status: value.status, consecutive_errors: value.consecutiveErrors, last_error_reason: value.lastErrorReason, last_task_id: value.lastTaskId }),
      appendOpsLog: async (entry) => ops.push(structuredClone(entry)),
    },
    audit: { getEventGroup: async (id) => groups.get(id) || null, insertEventGroup: async (group) => groups.set(group.event_group_id, structuredClone(group)), insertEvents: async (rows) => events.push(...structuredClone(rows)), insertSnapshot: async (_u, _p, value) => snapshots.push(structuredClone(value)) },
    sidecars: {},
  };
  return { repositories, inspect: { tasks, groups, events, snapshots, ops, taskUpdates, statuses, sourceMessages, get state() { return state; } } };
}

test("capacity block persists deferred audit, compacts, and replays the original proposal", async () => {
  const data = store();
  const metrics = createMemoryMetrics();
  const ids = ["normal-patch", "normal-item", "compact-patch", "compact-item"];
  let normalCalls = 0;
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, metrics, now: () => new Date("2026-07-13T00:00:10.000Z"), idFactory: () => ids.shift() || "unused", providerAdapter: { propose: async (envelope) => { if (envelope.task.mode === "normal") normalCalls += 1; return { status: "ok", output: envelope.task.mode === "maintenance" ? compactionOutput(envelope) : normalOutput(envelope) }; } } });
  const result = await pipeline.processIntent(1, "default", intent);
  const groups = [...data.inspect.groups.values()].sort((a, b) => (a.result_revision ?? -1) - (b.result_revision ?? -1));
  const tasks = [...data.inspect.tasks.values()];
  const parent = tasks.find((task) => task.task_type === "normal");
  const child = tasks.find((task) => task.task_type === "maintenance");
  assert.equal(result.status, "committed");
  assert.equal(groups[0].result_revision, null);
  assert.deepEqual(groups.slice(1).map((group) => group.result_revision), [1, 2]);
  assert.equal(data.inspect.state.meta.revision, 2);
  assert.equal(data.inspect.state.meta.targetCursors.todos, 3);
  assert.equal(data.inspect.state.working.todos.length, 2);
  assert.equal(data.inspect.events.filter((event) => event.decision === "deferred").length, 1);
  assert.equal(data.inspect.events.find((event) => event.decision === "deferred").maintenance_task_id, child.task_id);
  assert.equal(parent.stage_payload.compiledProposal.proposer, "todoProposer");
  assert.equal(parent.status, "succeeded");
  assert.equal(child.stage, "compaction_applied");
  const childStages = data.inspect.taskUpdates.filter((update) => update.id === child.task_id).map((update) => update.stage);
  assert.ok(childStages.indexOf("semantic_result_persisted") < childStages.indexOf("compiling"));
  assert.ok(childStages.indexOf("compiling") < childStages.indexOf("compiled_proposal_persisted"));
  assert.ok(childStages.indexOf("compiled_proposal_persisted") < childStages.indexOf("compacting"));
  assert.equal(data.inspect.statuses.get("todos").status, "healthy");
  assert.equal(parent.stage_payload.compiledProposal.sectionResults.todos.patches[0].op, "addItem");
  const duplicate = await pipeline.processEnvelope(parent.task_payload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(normalCalls, 1, "recovery must replay persisted output without calling the normal Proposer again");
  assert.equal(data.inspect.state.meta.revision, 2);
  const metricSnapshot = metrics.snapshot();
  assert.equal(metricSnapshot.counters["memory_capacity_deferred_total{section=todos,targetKey=todos}"], 1);
  for (const workflow of ["deferred", "compaction", "replay"]) {
    assert.equal(metricSnapshot.observations[`memory_workflow_age_ms{targetKey=todos,workflow=${workflow}}`].max, 10_000);
  }
});

test("rebuild wave compacts without advancing one parent and then reproposes from the new baseline", async () => {
  const data = store();
  data.inspect.statuses.set("todos", {
    target_key: "todos",
    source_generation: 0,
    status: "rebuilding",
    consecutive_errors: 0,
    rebuild_boundary_message_id: 3,
  });
  let nextId = 0;
  const pipeline = createNormalWritePipeline({
    observer: {},
    repositories: data.repositories,
    config,
    now: () => new Date("2026-07-13T00:00:10.000Z"),
    idFactory: () => `wave-id-${++nextId}`,
    providerAdapter: {
      propose: async (envelope) => ({
        status: "ok",
        output: envelope.task.mode === "maintenance"
          ? compactionOutput(envelope)
          : normalOutput(envelope),
      }),
    },
  });
  const rebuildIntent = {
    ...intent,
    trigger: { type: "forceDrain", sourceWatermark: 3 },
  };
  const firstEnvelope = await pipeline.createTask(1, "default", rebuildIntent, {
    dedupeSuffix: "force-drain:0:3",
  });
  const firstPrepared = await pipeline.prepareEnvelope(firstEnvelope);
  const blocked = await pipeline.commitPreparedWave([firstPrepared]);
  assert.equal(blocked.status, "capacity_deferred");
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.state.meta.targetCursors.todos ?? 0, 0);
  assert.equal(data.inspect.groups.size, 0);

  const deferred = await pipeline.deferPreparedWaveCapacity(firstPrepared);
  assert.equal(deferred.status, "capacity_deferred");
  const compacted = await pipeline.resolvePreparedWaveCapacity(firstEnvelope);
  assert.equal(compacted.status, "compaction_applied");
  assert.equal(data.inspect.state.meta.revision, 1);
  assert.equal(data.inspect.state.meta.targetCursors.todos ?? 0, 0);
  assert.equal(data.inspect.tasks.get(firstEnvelope.task.taskId).stage, "capacity_blocked");

  await pipeline.cancelPreparedWave([firstEnvelope], "wave_capacity_compacted");
  assert.equal(data.inspect.tasks.get(firstEnvelope.task.taskId).status, "cancelled");

  const secondEnvelope = await pipeline.createTask(1, "default", rebuildIntent, {
    dedupeSuffix: `force-drain:0:3:resume:${firstEnvelope.task.taskId}`,
  });
  assert.equal(secondEnvelope.task.baseRevision, 1);
  const secondPrepared = await pipeline.prepareEnvelope(secondEnvelope);
  const committed = await pipeline.commitPreparedWave([secondPrepared]);
  assert.equal(committed.status, "committed");
  assert.equal(data.inspect.state.meta.revision, 2);
  assert.equal(data.inspect.state.meta.targetCursors.todos, 3);
  assert.equal(data.inspect.state.working.todos.length, 2);
});

test("maintenance proposer shares the single durable schema-invalid retry", async () => {
  const data = store();
  const ids = ["normal-patch", "normal-item", "compact-patch", "compact-item"];
  let maintenanceCalls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, idFactory: () => ids.shift() || "unused",
    providerAdapter: { propose: async (envelope) => {
      if (envelope.task.mode === "normal") return { status: "ok", output: normalOutput(envelope) };
      maintenanceCalls += 1;
      if (maintenanceCalls === 1) return { status: "error", reason: "output_schema_invalid", detail: { boundary: "output", errors: [{ path: "$" }] } };
      return { status: "ok", output: compactionOutput(envelope) };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.status, "committed");
  assert.equal(maintenanceCalls, 2);
  assert.equal(data.inspect.ops.some((entry) => entry.outcome === "output_schema_invalid_retry"), true);
});

test("repeated capacity commit preserves the durable maintenance chain", async () => {
  const data = store();
  const ids = ["normal-patch", "normal-item"];
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config,
    idFactory: () => ids.shift() || "unused",
    providerAdapter: { propose: async () => { throw new Error("provider should not be called"); } },
  });
  const envelope = await pipeline.createTask(1, "default", intent);
  const output = compiledNormalOutput(envelope);
  const first = await pipeline.commit(envelope, output);
  const parent = data.inspect.tasks.get(envelope.task.taskId);
  const durablePayload = structuredClone(parent.stage_payload);
  const second = await pipeline.commit(envelope, output);
  assert.equal(first.status, "capacity_deferred");
  assert.equal(second.status, "capacity_deferred");
  assert.equal(second.duplicate, true);
  assert.deepEqual(parent.stage_payload, durablePayload);
  assert.equal([...data.inspect.tasks.values()].filter((task) => task.task_type === "maintenance").length, 1);
  assert.equal(data.inspect.events.filter((event) => event.decision === "deferred").length, 1);
});

test("capacity replay revalidates source hashes before advancing the parent", async () => {
  const data = store();
  const ids = ["normal-patch", "normal-item", "compact-patch", "compact-item"];
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config,
    idFactory: () => ids.shift() || "unused",
    providerAdapter: { propose: async (envelope) => {
      if (envelope.task.mode === "normal") return { status: "ok", output: normalOutput(envelope) };
      data.inspect.sourceMessages.find((entry) => entry.id === message.id).contentHash = hash("消息已被修改");
      return { status: "ok", output: compactionOutput(envelope) };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.status, "halted");
  assert.equal(result.reason, "source_validation_failed");
  assert.equal(data.inspect.state.meta.targetCursors.todos ?? 0, 0);
  assert.equal(data.inspect.statuses.get("todos").status, "halted");
});

test("compaction reducer rejects pending item intersections without changing state", () => {
  const state = createInitialMemoryState();
  state.working.todos.push(todo("todo:1", "A", 1), todo("todo:2", "B", 2));
  const task = { tickId: 1, userId: 1, presetId: "default", schemaVersion: "2.01", targetKey: "todos", targetMessageId: 3, targetSections: ["todos"], proposer: "compactionProposer", mode: "maintenance", now: "2026-07-13T00:00:00Z" };
  const proposal = { tickId: 1, proposer: "compactionProposer", sectionResults: { todos: { status: "patches", patches: [{ op: "mergeItems", itemIds: ["todo:1", "todo:2"], value: { text: "AB" } }] } } };
  const reduction = reduceCompiledProposal({ state, task, proposal, config, protectedItemIds: ["todo:1"], idFactory: () => "patch" });
  assert.equal(reduction.events[0].decision, "rejected");
  assert.equal(reduction.events[0].rejectReason, "item_protected_by_pending_proposal");
  assert.deepEqual(reduction.state.working.todos, state.working.todos);
});

test("unable_to_compact halts only the target and capacity resume creates a new child epoch", async () => {
  const data = store();
  let compactable = false;
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, providerAdapter: { propose: async (envelope) => ({ status: "ok", output: envelope.task.mode === "normal" ? normalOutput(envelope) : compactable ? compactionOutput(envelope) : { tickId: envelope.task.tickId, proposer: "compactionProposer", sectionResults: { todos: { status: "unable_to_compact" } } } }) } });
  const halted = await pipeline.processIntent(1, "default", intent);
  assert.equal(halted.status, "halted");
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.statuses.get("todos").status, "halted");
  const firstChild = [...data.inspect.tasks.values()].find((task) => task.task_type === "maintenance");
  assert.equal(firstChild.stage_payload.semanticResult, undefined);
  assert.equal(firstChild.stage_payload.compiledProposal, undefined);
  assert.equal(firstChild.stage_payload.unableResult.sectionResults.todos.status, "unable_to_compact");
  compactable = true;
  const recovery = createMemoryRecovery({ repositories: data.repositories, pipeline });
  const resumed = await recovery.resumeTarget(1, "default", "todos", { run: true });
  const children = [...data.inspect.tasks.values()].filter((task) => task.task_type === "maintenance").sort((a, b) => a.resume_epoch - b.resume_epoch);
  assert.equal(resumed.status, "committed");
  assert.deepEqual(children.map((task) => task.resume_epoch), [0, 1]);
  assert.notEqual(children[0].task_id, children[1].task_id);
  assert.equal(data.inspect.statuses.get("todos").status, "healthy");
  assert.equal(data.inspect.state.meta.revision, 2);
});

test("maintenance retry_wait preserves capacity blocking and parent recovery honors notBefore", async () => {
  const data = store();
  let maintenanceCalls = 0;
  const clock = new Date("2026-07-13T00:00:00.000Z");
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config, now: () => clock,
    providerAdapter: { propose: async (envelope) => {
      if (envelope.task.mode === "normal") return { status: "ok", output: normalOutput(envelope) };
      maintenanceCalls += 1;
      return { status: "error", reason: "llm_call_failed", detail: {} };
    } },
  });
  const first = await pipeline.processIntent(1, "default", intent);
  const parent = [...data.inspect.tasks.values()].find((task) => task.task_type === "normal");
  const child = [...data.inspect.tasks.values()].find((task) => task.task_type === "maintenance");
  assert.equal(first.halted, false);
  assert.equal(child.status, "retry_wait");
  assert.equal(data.inspect.statuses.get("todos").status, "capacity_blocked");
  const recovered = await pipeline.processEnvelope(parent.task_payload);
  assert.equal(recovered.status, "retry_wait");
  assert.equal(maintenanceCalls, 1, "parent recovery must not bypass the child backoff boundary");
});

test("deterministic exact merge runs before the compaction provider", async () => {
  const data = store();
  data.inspect.state.working.todos[1].text = data.inspect.state.working.todos[0].text;
  let maintenanceCalls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config,
    idFactory: (() => { const ids = ["normal-patch", "normal-item", "compact-patch", "compact-item"]; return () => ids.shift() || "unused"; })(),
    providerAdapter: { propose: async (envelope) => {
      if (envelope.task.mode === "maintenance") {
        maintenanceCalls += 1;
        throw new Error("exact duplicate compaction must not call the provider");
      }
      return { status: "ok", output: normalOutput(envelope) };
    } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  assert.equal(result.status, "committed");
  assert.equal(maintenanceCalls, 0);
  assert.equal(data.inspect.state.working.todos.length, 2);
  assert.equal(data.inspect.ops.some((entry) => entry.outcome === "unable_to_compact"), false);
});

test("high-water hygiene compacts proactively without blocking a committed normal task", async () => {
  const data = store();
  const hygieneConfig = {
    ...config,
    sectionBudgets: { ...config.sectionBudgets, todos: { maxItems: 4, maxRenderedChars: 2000 } },
    hygiene: { highWatermarkPercent: 50, minItemDelta: 1 },
  };
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config: hygieneConfig,
    idFactory: (() => { const ids = ["normal-patch", "normal-item", "compact-patch", "compact-item"]; return () => ids.shift() || "unused"; })(),
    providerAdapter: { propose: async (envelope) => ({
      status: "ok", output: envelope.task.mode === "maintenance" ? compactionOutput(envelope) : normalOutput(envelope),
    }) },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const parent = [...data.inspect.tasks.values()].find((task) => task.task_type === "normal");
  const child = [...data.inspect.tasks.values()].find((task) => task.task_type === "maintenance");
  assert.equal(result.status, "committed");
  assert.equal(result.hygiene[0].status, "hygiene_applied");
  assert.equal(parent.status, "succeeded");
  assert.equal(child.stage, "hygiene_applied");
  assert.equal(child.task_payload.task.trigger.type, "hygiene");
  assert.equal(data.inspect.statuses.get("todos").status, "healthy");
  assert.equal(data.inspect.state.working.todos.length, 2);
  assert.deepEqual(await pipeline.capacity.maybeRunHygiene(parent.task_payload), []);
  assert.equal([...data.inspect.tasks.values()].filter((task) => task.task_type === "maintenance").length, 1);
});

test("failed high-water hygiene remains non-blocking", async () => {
  const data = store();
  const hygieneConfig = {
    ...config,
    sectionBudgets: { ...config.sectionBudgets, todos: { maxItems: 4, maxRenderedChars: 2000 } },
    hygiene: { highWatermarkPercent: 50, minItemDelta: 1 },
  };
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config: hygieneConfig,
    providerAdapter: { propose: async (envelope) => envelope.task.mode === "maintenance"
      ? { status: "error", reason: "llm_call_failed", detail: {} }
      : { status: "ok", output: normalOutput(envelope) } },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const child = [...data.inspect.tasks.values()].find((task) => task.task_type === "maintenance");
  assert.equal(result.status, "committed");
  assert.equal(result.hygiene[0].status, "hygiene_noop");
  assert.equal(child.status, "succeeded");
  assert.equal(child.stage, "hygiene_skipped");
  assert.equal(data.inspect.statuses.get("todos").status, "healthy");
  assert.equal(data.inspect.state.working.todos.length, 3);
});

test("unable high-water hygiene persists unableResult and leaves the target healthy", async () => {
  const data = store();
  const hygieneConfig = {
    ...config,
    sectionBudgets: { ...config.sectionBudgets, todos: { maxItems: 4, maxRenderedChars: 2000 } },
    hygiene: { highWatermarkPercent: 50, minItemDelta: 1 },
  };
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config: hygieneConfig,
    providerAdapter: { propose: async (envelope) => ({
      status: "ok",
      output: envelope.task.mode === "maintenance"
        ? { tickId: envelope.task.tickId, proposer: "compactionProposer", sectionResults: { todos: { status: "unable_to_compact" } } }
        : normalOutput(envelope),
    }) },
  });

  const result = await pipeline.processIntent(1, "default", intent);
  const child = [...data.inspect.tasks.values()].find((task) => task.task_type === "maintenance");
  assert.equal(result.status, "committed");
  assert.equal(result.hygiene[0].status, "hygiene_noop");
  assert.equal(child.status, "succeeded");
  assert.equal(child.stage, "hygiene_noop");
  assert.equal(child.stage_payload.unableResult.sectionResults.todos.status, "unable_to_compact");
  assert.equal(child.stage_payload.semanticResult, undefined);
  assert.equal(data.inspect.statuses.get("todos").status, "healthy");
});
