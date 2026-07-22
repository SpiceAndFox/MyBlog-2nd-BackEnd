const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createNormalWritePipeline } = require("../../modules/memory/application/normalWritePipeline");
const { createMemoryProviderAdapter } = require("../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { contracts } = require("../../modules/memory");
const { replayEventGroups } = require("../../modules/memory/domain/eventReplay");

function hash(content) {
  return `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function message(id, role, content) {
  return {
    id,
    role,
    content,
    contentHash: hash(content),
    contentKind: "raw",
    createdAt: `2026-07-22T0${id}:00:00.000Z`,
  };
}

function item(id, text, sourceMessage) {
  return {
    id,
    text,
    sourceRefs: [{ messageId: sourceMessage.id, contentHash: sourceMessage.contentHash }],
    createdAtMessageId: sourceMessage.id,
    updatedAtMessageId: sourceMessage.id,
  };
}

const config = {
  targets: { episodes: { lagThreshold: 1, contextWindow: 4 } },
  overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
  scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
  sectionBudgets: Object.fromEntries(contracts.ITEM_SECTIONS.map((section) => [section, {
    maxItems: section === "recentEpisodes" ? 1 : 20,
    maxRenderedChars: 2000,
  }])),
  providerRecovery: { retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 10, backoffMaxMs: 100, haltAfterConsecutiveErrors: 3 },
  compaction: { retryMax: 1 },
};

function storeFixture({ state, messages }) {
  let currentState = structuredClone(state);
  const tasks = new Map();
  const groups = new Map();
  const events = [];
  const snapshots = [];
  const statuses = [];
  const ops = [];
  const repositories = {
    withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
    state: {
      getState: async () => structuredClone(currentState),
      writeState: async (_userId, _presetId, value) => { currentState = structuredClone(value); },
    },
    source: {
      getObservedWindow: async () => structuredClone(messages),
      getByIds: async (_userId, _presetId, ids) => messages
        .filter((entry) => ids.includes(entry.id))
        .map((entry) => ({ ...structuredClone(entry), userId: 1, presetId: "default" })),
    },
    users: { getTimeZone: async () => "Asia/Shanghai" },
    runtime: {
      createTask: async (row) => { tasks.set(row.task_id, structuredClone(row)); return tasks.get(row.task_id); },
      getTask: async (id) => tasks.get(id) || null,
      getTaskForUpdate: async (id) => tasks.get(id) || null,
      updateTask: async (id, changes) => Object.assign(tasks.get(id), structuredClone(changes)),
      getTargetStatus: async () => ({ target_key: "episodes", status: "healthy", consecutive_errors: 0 }),
      upsertTargetStatus: async (_userId, _presetId, value) => statuses.push(structuredClone(value)),
      appendOpsLog: async (value) => ops.push(structuredClone(value)),
      listTasksForTarget: async () => [...tasks.values()],
    },
    audit: {
      getEventGroup: async (id) => groups.get(id) || null,
      insertEventGroup: async (value) => groups.set(value.event_group_id, structuredClone(value)),
      insertEvents: async (values) => events.push(...structuredClone(values)),
      insertSnapshot: async (_userId, _presetId, value) => snapshots.push(structuredClone(value)),
    },
  };
  return {
    repositories,
    inspect: {
      get state() { return currentState; },
      tasks,
      groups,
      events,
      snapshots,
      statuses,
      ops,
    },
  };
}

function episodeIntent() {
  return {
    targetKey: "episodes",
    proposer: "episodeProposer",
    targetSections: ["recentEpisodes", "milestones"],
    trigger: { type: "lagThreshold" },
  };
}

test("Episode vertical slice sends only readable public input and commits compiled Semantic changes", async () => {
  const old = message(1, "user", "争执后我们先暂停一下。");
  const latest = message(2, "assistant", "冷静下来后，我们重新说开了。");
  const state = contracts.createInitialMemoryStateV201();
  state.working.recentEpisodes.push(item("episode:old", "双方争执后暂停了交流。", old));
  state.meta.targetCursors.episodes = 1;
  const store = storeFixture({ state, messages: [old, latest] });
  let providerRequest;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "episode prompt",
    invokeStructured: async (request) => {
      providerRequest = request;
      return { output: {
        tickId: request.userPayload.task.tickId,
        proposer: "episodeProposer",
        sectionResults: {
          recentEpisodes: { status: "changes", changes: [{
            action: "correct",
            ref: "E1",
            text: "双方暂停冷静后重新沟通，并澄清了分歧。",
            evidenceMessageIds: [2],
          }] },
          milestones: { status: "noop" },
        },
      } };
    },
  });
  const pipeline = createNormalWritePipeline({
    observer: {},
    providerAdapter: adapter,
    repositories: store.repositories,
    config,
    now: () => new Date("2026-07-22T03:00:00.000Z"),
    idFactory: () => "patch-1",
  });

  const result = await pipeline.processIntent(1, "default", episodeIntent());

  assert.equal(result.status, "committed");
  assert.deepEqual(Object.keys(providerRequest.userPayload).sort(), ["memoryText", "messages", "task"]);
  assert.equal(JSON.stringify(providerRequest.userPayload).includes("episode:old"), false);
  assert.equal(JSON.stringify(providerRequest.userPayload).includes("contentHash"), false);
  assert.equal(JSON.stringify(providerRequest.userPayload).includes("evidenceKind"), false);
  assert.match(providerRequest.userPayload.memoryText, /E1 \| 双方争执后暂停了交流/);
  assert.equal(store.inspect.state.working.recentEpisodes[0].id, "episode:old");
  assert.equal(store.inspect.state.working.recentEpisodes[0].text, "双方暂停冷静后重新沟通，并澄清了分歧。");
  assert.deepEqual(store.inspect.state.working.recentEpisodes[0].sourceRefs.map((ref) => ref.messageId), [1, 2]);
  assert.equal(store.inspect.state.meta.targetCursors.episodes, 2);
  assert.equal(store.inspect.state.meta.revision, 1);
  assert.equal(store.inspect.events.every((event) => event.evidence_kind === undefined), true);
  const task = [...store.inspect.tasks.values()][0];
  assert.equal(task.schema_version, "2.01");
  assert.equal(task.stage, "committed");
  assert.equal(task.stage_payload.semanticResult.sectionResults.recentEpisodes.status, "changes");
  assert.equal(task.stage_payload.compiledProposal.sectionResults.recentEpisodes.patches[0].op, "updateItem");
  const replayed = replayEventGroups(state, [...store.inspect.groups.values()], store.inspect.events, { userId: 1, presetId: "default" });
  assert.deepEqual(replayed, store.inspect.state);
});

test("Episode recovery compiles a durable Semantic result without calling Provider again", async () => {
  const latest = message(1, "user", "我们认真道歉后和好了。");
  const state = contracts.createInitialMemoryStateV201();
  const store = storeFixture({ state, messages: [latest] });
  let providerCalls = 0;
  const pipeline = createNormalWritePipeline({
    observer: {},
    providerAdapter: { async propose() { providerCalls += 1; throw new Error("Provider must not be called"); } },
    repositories: store.repositories,
    config,
    now: () => new Date("2026-07-22T03:00:00.000Z"),
    idFactory: (() => { let value = 0; return () => `id-${++value}`; })(),
  });
  const envelope = await pipeline.createTask(1, "default", episodeIntent());
  const semanticResult = {
    tickId: envelope.task.tickId,
    proposer: "episodeProposer",
    sectionResults: {
      recentEpisodes: { status: "changes", changes: [{ action: "add", text: "双方认真道歉后完成和解。", evidenceMessageIds: [1] }] },
      milestones: { status: "noop" },
    },
  };
  await pipeline.persistProposal(envelope, semanticResult);

  const result = await pipeline.processEnvelope(envelope);

  assert.equal(result.status, "committed");
  assert.equal(providerCalls, 0);
  assert.equal(store.inspect.state.working.recentEpisodes[0].text, "双方认真道歉后完成和解。");
  assert.equal([...store.inspect.tasks.values()][0].stage_payload.compiledProposal.sectionResults.recentEpisodes.patches[0].op, "addItem");
});

test("Episode unable retry expands messages while preserving the original refs and Memory text", async () => {
  const source = message(1, "user", "互动尚未结束。");
  const overlap = message(2, "assistant", "我需要再想一下。");
  const latest = message(3, "user", "现在仍无法确认结果。");
  const state = contracts.createInitialMemoryStateV201();
  state.working.recentEpisodes.push(item("episode:open", "双方仍在处理一项未决分歧。", source));
  state.meta.targetCursors.episodes = 2;
  const store = storeFixture({ state, messages: [latest] });
  store.repositories.source.getForceDrainWindow = async () => [overlap, latest];
  const artifacts = [];
  const pipeline = createNormalWritePipeline({
    observer: {},
    providerAdapter: { propose: async (envelope) => {
      artifacts.push(structuredClone(envelope.artifact));
      return { status: "ok", output: {
        tickId: envelope.task.tickId,
        proposer: "episodeProposer",
        sectionResults: {
          recentEpisodes: { status: "unable_to_decide" },
          milestones: { status: "noop" },
        },
      } };
    } },
    repositories: store.repositories,
    config,
    now: () => new Date("2026-07-22T04:00:00.000Z"),
  });

  const first = await pipeline.processIntent(1, "default", episodeIntent());
  const task = [...store.inspect.tasks.values()][0];
  const second = await pipeline.processEnvelope(task.task_payload);

  assert.equal(first.status, "context_expansion_required");
  assert.equal(second.status, "committed");
  assert.equal(second.cursorOnly, true);
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts[1].refMap, artifacts[0].refMap);
  assert.equal(artifacts[1].publicInput.memoryText, artifacts[0].publicInput.memoryText);
  assert.deepEqual(artifacts.map((artifact) => artifact.publicInput.messages.map((entry) => entry.id)), [[3], [2, 3]]);
  assert.equal(store.inspect.state.meta.targetCursors.episodes, 3);
  assert.equal(store.inspect.state.meta.revision, 1);
});

test("recentEpisodes capacity evicts the oldest arc while the joint target advances one shared cursor", async () => {
  const old = message(1, "user", "旧互动已经结束。");
  const latest = message(2, "user", "新分歧得到了解决。");
  const state = contracts.createInitialMemoryStateV201();
  state.working.recentEpisodes.push(item("episode:old", "旧互动已经结束。", old));
  state.meta.targetCursors.episodes = 1;
  const store = storeFixture({ state, messages: [old, latest] });
  const pipeline = createNormalWritePipeline({
    observer: {},
    providerAdapter: { propose: async (envelope) => ({ status: "ok", output: {
      tickId: envelope.task.tickId,
      proposer: "episodeProposer",
      sectionResults: {
        recentEpisodes: { status: "changes", changes: [{ action: "add", text: "新分歧得到了解决。", evidenceMessageIds: [2] }] },
        milestones: { status: "noop" },
      },
    } }) },
    repositories: store.repositories,
    config,
    now: () => new Date("2026-07-22T03:00:00.000Z"),
    idFactory: (() => { let value = 0; return () => `id-${++value}`; })(),
  });

  const result = await pipeline.processIntent(1, "default", episodeIntent());

  assert.equal(result.status, "committed");
  assert.equal(store.inspect.state.working.recentEpisodes.length, 1);
  assert.equal(store.inspect.state.working.recentEpisodes[0].text, "新分歧得到了解决。");
  assert.equal(store.inspect.events.some((event) => event.cleanup_type === "recent_episode_evicted" && event.item_id === "episode:old"), true);
  assert.equal(store.inspect.state.meta.targetCursors.episodes, 2);
  assert.equal(store.inspect.groups.size, 1);
  assert.equal(store.inspect.snapshots.length, 1);
});

test("deterministic Episode compile failure halts only the target without advancing state", async () => {
  const latest = message(1, "user", "新的互动。");
  const state = contracts.createInitialMemoryStateV201();
  const store = storeFixture({ state, messages: [latest] });
  store.repositories.source.getByIds = async () => [];
  const pipeline = createNormalWritePipeline({
    observer: {},
    providerAdapter: { propose: async (envelope) => ({ status: "ok", output: {
      tickId: envelope.task.tickId,
      proposer: "episodeProposer",
      sectionResults: {
        recentEpisodes: { status: "changes", changes: [{ action: "add", text: "新的互动。", evidenceMessageIds: [1] }] },
        milestones: { status: "noop" },
      },
    } }) },
    repositories: store.repositories,
    config,
    now: () => new Date("2026-07-22T03:00:00.000Z"),
  });

  const result = await pipeline.processIntent(1, "default", episodeIntent());

  assert.equal(result.status, "halted");
  assert.equal(result.outcome, "source_validation_failed");
  assert.equal(store.inspect.state.meta.revision, 0);
  assert.equal(store.inspect.state.meta.targetCursors.episodes, undefined);
  assert.equal(store.inspect.groups.size, 0);
  assert.equal(store.inspect.snapshots.length, 0);
  assert.equal(store.inspect.statuses.at(-1).status, "halted");
});
