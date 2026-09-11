const { createMemoryTestConfig } = require("../support/memory-builders");
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
const config = createMemoryTestConfig({
  targets: { standingAgreements: { lagThreshold: 1, contextWindow: 2 } }, overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
  scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
  sectionBudgets: Object.fromEntries(["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"].map((section) => [section, { maxItems: section === "standingAgreements" ? 2 : 20, maxRenderedChars: 2000 }])),
  providerRecovery: { retryMax: 2, transportInvalidRetryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 1000, backoffMaxMs: 8000, haltAfterConsecutiveErrors: 3 },
  compaction: { retryMax: 1 },
});
const intent = { targetKey: "standingAgreements", proposer: "agreementProposer", targetSections: ["standingAgreements"], trigger: { type: "lagThreshold" } };

function agreement(id, text, messageId) {
  return { id, text, sourceRefs: [{ messageId, contentHash: hash(text) }], createdAtMessageId: messageId, updatedAtMessageId: messageId };
}
function normalOutput(envelope) {
  return { tickId: envelope.task.tickId, proposer: "agreementProposer", sectionResults: { standingAgreements: { status: "changes", changes: [{ action: "add", text: "归还杂志", evidenceMessageIds: [3] }] } } };
}
function compiledNormalOutput(envelope) {
  return { tickId: envelope.task.tickId, proposer: "agreementProposer", sectionResults: { standingAgreements: { status: "patches", patches: [{ op: "addItem", value: { text: "归还杂志" }, sourceRefs: [{ messageId: 3, contentHash: message.contentHash }] }] } } };
}
function compactionOutput(envelope) {
  return { tickId: envelope.task.tickId, proposer: "compactionProposer", sectionResults: { standingAgreements: { status: "changes", changes: [{ action: "merge", refs: ["A1", "A2"], text: "归还借阅物", supportRefs: ["A1-E1", "A2-E1"] }] } } };
}

function store() {
  let state = createInitialMemoryState();
  state.working.standingAgreements.push(agreement("agreement:1", "归还图书", 1), agreement("agreement:2", "把借来的书还回去", 2));
  const tasks = new Map(); const groups = new Map(); const events = []; const snapshots = []; const ops = []; const taskUpdates = [];
  const sourceMessages = [
    { id: 1, role: "user", createdAt: "2026-07-11T00:00:00.000Z", content: "归还图书", contentHash: hash("归还图书"), userId: 1, presetId: "default" },
    { id: 2, role: "user", createdAt: "2026-07-12T00:00:00.000Z", content: "把借来的书还回去", contentHash: hash("把借来的书还回去"), userId: 1, presetId: "default" },
    { ...message, userId: 1, presetId: "default" },
  ];
  const statuses = new Map([["standingAgreements", { target_key: "standingAgreements", source_generation: 0, status: "healthy", consecutive_errors: 0 }]]);
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
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements, 3);
  assert.equal(data.inspect.state.working.standingAgreements.length, 2);
  assert.equal(data.inspect.events.filter((event) => event.decision === "deferred").length, 1);
  assert.equal(data.inspect.events.find((event) => event.decision === "deferred").maintenance_task_id, child.task_id);
  assert.equal(parent.stage_payload.compiledProposal.proposer, "agreementProposer");
  assert.equal(parent.status, "succeeded");
  assert.equal(child.stage, "compaction_applied");
  const childStages = data.inspect.taskUpdates.filter((update) => update.id === child.task_id).map((update) => update.stage);
  assert.ok(childStages.indexOf("semantic_result_persisted") < childStages.indexOf("compiling"));
  assert.ok(childStages.indexOf("compiling") < childStages.indexOf("compiled_proposal_persisted"));
  assert.ok(childStages.indexOf("compiled_proposal_persisted") < childStages.indexOf("compacting"));
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "healthy");
  assert.equal(parent.stage_payload.compiledProposal.sectionResults.standingAgreements.patches[0].op, "addItem");
  const duplicate = await pipeline.processEnvelope(parent.task_payload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(normalCalls, 1, "recovery must replay persisted output without calling the normal Proposer again");
  assert.equal(data.inspect.state.meta.revision, 2);
  const metricSnapshot = metrics.snapshot();
  assert.equal(metricSnapshot.counters["memory_capacity_deferred_total{section=standingAgreements,targetKey=standingAgreements}"], 1);
  for (const workflow of ["deferred", "compaction", "replay"]) {
    assert.equal(metricSnapshot.observations[`memory_workflow_age_ms{targetKey=standingAgreements,workflow=${workflow}}`].max, 10_000);
  }
});

test("rebuild wave compacts without advancing one parent and then reproposes from the new baseline", async () => {
  const data = store();
  data.inspect.statuses.set("standingAgreements", {
    target_key: "standingAgreements",
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
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements ?? 0, 0);
  assert.equal(data.inspect.groups.size, 0);

  const deferred = await pipeline.deferPreparedWaveCapacity(firstPrepared);
  assert.equal(deferred.status, "capacity_deferred");
  const compacted = await pipeline.resolvePreparedWaveCapacity(firstEnvelope);
  assert.equal(compacted.status, "compaction_applied");
  assert.equal(data.inspect.state.meta.revision, 1);
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements ?? 0, 0);
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
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements, 3);
  assert.equal(data.inspect.state.working.standingAgreements.length, 2);
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
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements ?? 0, 0);
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "halted");
});

test("compaction reducer rejects pending item intersections without changing state", () => {
  const state = createInitialMemoryState();
  state.working.standingAgreements.push(agreement("agreement:1", "A", 1), agreement("agreement:2", "B", 2));
  const task = { tickId: 1, userId: 1, presetId: "default", schemaVersion: "2.01", targetKey: "standingAgreements", targetMessageId: 3, targetSections: ["standingAgreements"], proposer: "compactionProposer", mode: "maintenance", now: "2026-07-13T00:00:00Z" };
  const proposal = { tickId: 1, proposer: "compactionProposer", sectionResults: { standingAgreements: { status: "patches", patches: [{ op: "mergeItems", itemIds: ["agreement:1", "agreement:2"], value: { text: "AB" }, sourceRefs: state.working.standingAgreements.flatMap((item) => item.sourceRefs) }] } } };
  const reduction = reduceCompiledProposal({ state, task, proposal, config, protectedItemIds: ["agreement:1"], idFactory: () => "patch" });
  assert.equal(reduction.events[0].decision, "rejected");
  assert.equal(reduction.events[0].rejectReason, "item_protected_by_pending_proposal");
  assert.deepEqual(reduction.state.working.standingAgreements, state.working.standingAgreements);
});

test("unable_to_compact halts only the target and capacity resume creates a new child epoch", async () => {
  const data = store();
  let compactable = false;
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, providerAdapter: { propose: async (envelope) => ({ status: "ok", output: envelope.task.mode === "normal" ? normalOutput(envelope) : compactable ? compactionOutput(envelope) : { tickId: envelope.task.tickId, proposer: "compactionProposer", sectionResults: { standingAgreements: { status: "unable_to_compact" } } } }) } });
  const halted = await pipeline.processIntent(1, "default", intent);
  assert.equal(halted.status, "halted");
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "halted");
  const firstChild = [...data.inspect.tasks.values()].find((task) => task.task_type === "maintenance");
  assert.equal(firstChild.stage_payload.semanticResult, undefined);
  assert.equal(firstChild.stage_payload.compiledProposal, undefined);
  assert.equal(firstChild.stage_payload.unableResult.sectionResults.standingAgreements.status, "unable_to_compact");
  compactable = true;
  const recovery = createMemoryRecovery({ repositories: data.repositories, pipeline });
  const resumed = await recovery.resumeTarget(1, "default", "standingAgreements", { run: true });
  const children = [...data.inspect.tasks.values()].filter((task) => task.task_type === "maintenance").sort((a, b) => a.resume_epoch - b.resume_epoch);
  assert.equal(resumed.status, "committed");
  assert.deepEqual(children.map((task) => task.resume_epoch), [0, 1]);
  assert.notEqual(children[0].task_id, children[1].task_id);
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "healthy");
  assert.equal(data.inspect.state.meta.revision, 2);
});

test("capacity resume replays the blocked parent without compaction after the budget expands", async () => {
  const data = store();
  let maintenanceCalls = 0;
  const initialPipeline = createNormalWritePipeline({
    observer: {},
    repositories: data.repositories,
    config,
    providerAdapter: {
      propose: async (envelope) => {
        if (envelope.task.mode === "normal") return { status: "ok", output: normalOutput(envelope) };
        maintenanceCalls += 1;
        return {
          status: "ok",
          output: {
            tickId: envelope.task.tickId,
            proposer: "compactionProposer",
            sectionResults: { standingAgreements: { status: "unable_to_compact" } },
          },
        };
      },
    },
  });
  const halted = await initialPipeline.processIntent(1, "default", intent);
  assert.equal(halted.status, "halted");
  assert.equal(maintenanceCalls, 1);

  const expandedConfig = structuredClone(config);
  expandedConfig.sectionBudgets.standingAgreements.maxItems = 3;
  const resumedPipeline = createNormalWritePipeline({
    observer: {},
    repositories: data.repositories,
    config: expandedConfig,
    providerAdapter: {
      propose: async () => {
        throw new Error("expanded budget recovery must not call the Provider");
      },
    },
  });
  const recovery = createMemoryRecovery({ repositories: data.repositories, pipeline: resumedPipeline });
  const resumed = await recovery.resumeTarget(1, "default", "standingAgreements", { run: true });
  const children = [...data.inspect.tasks.values()].filter((task) => task.task_type === "maintenance");
  const parent = [...data.inspect.tasks.values()].find((task) => task.task_type === "normal");

  assert.equal(resumed.status, "committed");
  assert.equal(resumed.replayed, true);
  assert.equal(children.length, 1, "the obsolete violation must not create another maintenance child");
  assert.equal(maintenanceCalls, 1);
  assert.equal(parent.status, "succeeded");
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "healthy");
  assert.equal(data.inspect.state.working.standingAgreements.length, 3);
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements, 3);
});

test("capacity resume creates a new child from the current violation when the parent is still over budget", async () => {
  const data = store();
  const initialPipeline = createNormalWritePipeline({
    observer: {},
    repositories: data.repositories,
    config,
    providerAdapter: {
      propose: async (envelope) => ({
        status: "ok",
        output: envelope.task.mode === "normal"
          ? normalOutput(envelope)
          : {
            tickId: envelope.task.tickId,
            proposer: "compactionProposer",
            sectionResults: { standingAgreements: { status: "unable_to_compact" } },
          },
      }),
    },
  });
  const halted = await initialPipeline.processIntent(1, "default", intent);
  assert.equal(halted.status, "halted");
  const firstChild = [...data.inspect.tasks.values()].find((task) => task.task_type === "maintenance");
  assert.equal(firstChild.task_payload.task.trigger.limit, 2);

  const tighterConfig = structuredClone(config);
  tighterConfig.sectionBudgets.standingAgreements.maxItems = 1;
  const resumedPipeline = createNormalWritePipeline({
    observer: {},
    repositories: data.repositories,
    config: tighterConfig,
    providerAdapter: {
      propose: async () => {
        throw new Error("queued recovery must not call the Provider");
      },
    },
  });
  const recovery = createMemoryRecovery({ repositories: data.repositories, pipeline: resumedPipeline });
  const resumed = await recovery.resumeTarget(1, "default", "standingAgreements");
  const children = [...data.inspect.tasks.values()]
    .filter((task) => task.task_type === "maintenance")
    .sort((left, right) => left.resume_epoch - right.resume_epoch);

  assert.equal(resumed.status, "queued");
  assert.deepEqual(children.map((task) => task.resume_epoch), [0, 1]);
  assert.equal(children[1].task_payload.task.trigger.limit, 1);
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "capacity_blocked");
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
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "capacity_blocked");
  const recovered = await pipeline.processEnvelope(parent.task_payload);
  assert.equal(recovered.status, "retry_wait");
  assert.equal(maintenanceCalls, 1, "parent recovery must not bypass the child backoff boundary");
});

test("deterministic exact merge runs before the compaction provider", async () => {
  const data = store();
  data.inspect.state.working.standingAgreements[1].text = data.inspect.state.working.standingAgreements[0].text;
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
  assert.equal(data.inspect.state.working.standingAgreements.length, 2);
  assert.equal(data.inspect.ops.some((entry) => entry.outcome === "unable_to_compact"), false);
});

test("normal commits no longer schedule proactive high-water hygiene", async () => {
  const data = store();
  const capacityConfig = {
    ...config,
    sectionBudgets: { ...config.sectionBudgets, standingAgreements: { ...config.sectionBudgets.standingAgreements, maxItems: 4, maxRenderedChars: 2000 } },
  };
  const pipeline = createNormalWritePipeline({
    observer: {}, repositories: data.repositories, config: capacityConfig,
    idFactory: (() => { const ids = ["normal-patch", "normal-item", "compact-patch", "compact-item"]; return () => ids.shift() || "unused"; })(),
    providerAdapter: { propose: async (envelope) => ({
      status: "ok", output: envelope.task.mode === "maintenance" ? compactionOutput(envelope) : normalOutput(envelope),
    }) },
  });
  const result = await pipeline.processIntent(1, "default", intent);
  const parent = [...data.inspect.tasks.values()].find((task) => task.task_type === "normal");
  assert.equal(result.status, "committed");
  assert.equal(result.hygiene, undefined);
  assert.equal(parent.status, "succeeded");
  assert.equal(data.inspect.statuses.get("standingAgreements").status, "healthy");
  assert.equal(data.inspect.state.working.standingAgreements.length, 3);
  assert.equal([...data.inspect.tasks.values()].filter((task) => task.task_type === "maintenance").length, 0);
});

test("capacity child survives provider outage beyond compaction budget and resumes the same parent", async () => {
  const data = store(); let time = Date.parse("2026-07-13T00:00:00Z"); let calls = 0;
  const make = () => createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => new Date(time),
    providerAdapter: { async propose(envelope) {
      if (envelope.task.mode === "normal") return { status: "ok", output: normalOutput(envelope) };
      return ++calls <= 4 ? { status: "error", reason: "llm_call_failed", detail: { status: 503 } }
        : { status: "ok", output: compactionOutput(envelope) };
    } } });
  let result = await make().processIntent(1, "default", intent);
  const parent = [...data.inspect.tasks.values()].find(task => task.task_type === "normal");
  const child = [...data.inspect.tasks.values()].find(task => task.task_type === "maintenance");
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal(result.halted, false); assert.equal(child.status, "retry_wait");
    assert.equal(data.inspect.statuses.get("standingAgreements").status, "capacity_blocked");
    assert.equal(data.inspect.state.meta.targetCursors.standingAgreements ?? 0, 0);
    assert.equal((await make().processEnvelope(parent.task_payload)).status, "retry_wait");
    assert.equal(calls, attempt);
    time = Date.parse(result.notBefore);
    result = await make().processEnvelope(parent.task_payload);
  }
  assert.equal(result.status, "committed"); assert.equal(child.status, "succeeded");
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements, 3);
});

test("manual retry after maintenance budget exhaustion preserves the blocked parent and proposal", async () => {
  const { createRetryBudget } = require("../../../modules/memory/application/retryBudget");
  const { beginManualRetrySession } = require("../../../modules/memory/application/manualRetrySession");
  const data = store(); const retryBudget = createRetryBudget();
  const settings = { ...config, providerRecovery: { ...config.providerRecovery, transientRetryMax: 1 } };
  let time = Date.parse("2026-07-13T00:00:00Z"); let normalCalls = 0; let maintenanceCalls = 0; let recovered = false;
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config: settings, retryBudget,
    now: () => new Date(time), providerAdapter: { async propose(envelope) {
      if (envelope.task.mode === "normal") { normalCalls++; return { status: "ok", output: normalOutput(envelope) }; }
      maintenanceCalls++;
      return recovered ? { status: "ok", output: compactionOutput(envelope) }
        : { status: "error", reason: "llm_call_failed", detail: { status: 503 } };
    } } });
  const first = await pipeline.processIntent(1, "default", intent);
  const parent = [...data.inspect.tasks.values()].find(task => task.task_type === "normal");
  const child = [...data.inspect.tasks.values()].find(task => task.task_type === "maintenance");
  const proposal = structuredClone(parent.stage_payload.compiledProposal);
  time = Date.parse(first.notBefore);
  assert.equal((await pipeline.processEnvelope(parent.task_payload)).halted, true);
  assert.equal(child.stage, "retry_budget_exhausted");
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements ?? 0, 0);
  await beginManualRetrySession(data.repositories, retryBudget, 1, "default", 0);
  assert.equal(parent.stage, "capacity_blocked");
  assert.deepEqual(parent.stage_payload.compiledProposal, proposal);
  recovered = true;
  assert.equal((await pipeline.processEnvelope(parent.task_payload)).status, "committed");
  assert.equal(normalCalls, 1);
  assert.equal(maintenanceCalls, 3);
  assert.equal(data.inspect.tasks.size, 2);
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements, 3);
});

test("cancellation after a normal response stops the subsequent maintenance provider call", async () => {
  const data = store(); const controller = new AbortController(); let maintenanceCalls = 0;
  const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => new Date("2026-07-13T00:00:00Z"),
    providerAdapter: { async propose(envelope) {
      if (envelope.task.mode === "normal") {
        controller.abort();
        return { status: "ok", output: normalOutput(envelope) };
      }
      maintenanceCalls++;
      return { status: "ok", output: compactionOutput(envelope) };
    } } });
  const envelope = await pipeline.createTask(1, "default", intent);
  const result = await pipeline.processEnvelope(envelope, { signal: controller.signal });
  assert.equal(result.status, "interrupted");
  assert.equal(maintenanceCalls, 0);
  assert.equal(data.inspect.state.meta.targetCursors.standingAgreements ?? 0, 0);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).stage, "capacity_blocked");
});

test("capacity admission deferral preserves the child and parent until the next check", async () => {
  {
    const data = store(); let calls = 0;
    const nextRetryAt = "2026-07-13T00:00:01.000Z";
    const pipeline = createNormalWritePipeline({ observer: {}, repositories: data.repositories, config, now: () => new Date("2026-07-13T00:00:00Z"),
      providerAdapter: { async propose(envelope) {
        if (envelope.task.mode === "normal") return { status: "ok", output: normalOutput(envelope) };
        calls++; return { status: "deferred", reason: "provider_queue_full" };
      } } });
    const result = await pipeline.processIntent(1, "default", intent);
    const child = [...data.inspect.tasks.values()].find(task => task.task_type === "maintenance");
    assert.equal(result.status, "retry_wait");
    assert.equal(child.not_before, nextRetryAt);
    assert.equal(data.inspect.state.meta.targetCursors.standingAgreements ?? 0, 0);
    assert.equal(calls, 1);
    const parent = [...data.inspect.tasks.values()].find(task => task.task_type === "normal");
    assert.equal((await pipeline.processEnvelope(parent.task_payload)).status, "retry_wait");
    assert.equal(calls, 1, "automatic recovery must not advance a failed maintenance child");
  }
});
