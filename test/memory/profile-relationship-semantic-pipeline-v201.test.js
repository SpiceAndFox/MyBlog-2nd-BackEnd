const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createNormalWritePipeline } = require("../../modules/memory/application/normalWritePipeline");
const { createMemoryProviderAdapter } = require("../../modules/memory/infrastructure/providers/memoryProviderAdapter");
const { contracts } = require("../../modules/memory");

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
    createdAt: `2026-07-${String(10 + id).padStart(2, "0")}T08:00:00.000Z`,
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
  targets: { profileRelationship: { lagThreshold: 1, contextWindow: 4 } },
  overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
  scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
  sectionBudgets: Object.fromEntries(contracts.ITEM_SECTIONS.map((section) => [section, {
    maxItems: 20,
    maxRenderedChars: 2000,
  }])),
  providerRecovery: { retryMax: 1, schemaInvalidRetryMax: 1, backoffBaseMs: 10, backoffMaxMs: 100, haltAfterConsecutiveErrors: 3 },
  compaction: { retryMax: 1 },
};

function storeFixture({ state, observedMessages, databaseMessages }) {
  let currentState = structuredClone(state);
  const tasks = new Map();
  const groups = new Map();
  const events = [];
  const snapshots = [];
  const statuses = [];
  const repositories = {
    withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
    state: {
      getState: async () => structuredClone(currentState),
      writeState: async (_userId, _presetId, value) => { currentState = structuredClone(value); },
    },
    source: {
      getObservedWindow: async () => structuredClone(observedMessages),
      getByIds: async (_userId, _presetId, ids) => databaseMessages
        .filter((entry) => ids.includes(entry.id))
        .map((entry) => ({ ...structuredClone(entry), userId: 1, presetId: "default" })),
    },
    users: { getTimeZone: async () => "Asia/Shanghai" },
    runtime: {
      createTask: async (row) => { tasks.set(row.task_id, structuredClone(row)); return tasks.get(row.task_id); },
      getTask: async (id) => tasks.get(id) || null,
      getTaskForUpdate: async (id) => tasks.get(id) || null,
      updateTask: async (id, changes) => Object.assign(tasks.get(id), structuredClone(changes)),
      getTargetStatus: async () => ({ target_key: "profileRelationship", status: "healthy", consecutive_errors: 0 }),
      upsertTargetStatus: async (_userId, _presetId, value) => statuses.push(structuredClone(value)),
      appendOpsLog: async () => {},
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
    },
  };
}

function profileIntent() {
  return {
    targetKey: "profileRelationship",
    proposer: "profileRelationshipProposer",
    targetSections: ["userProfile", "assistantProfile", "relationship"],
    trigger: { type: "lagThreshold" },
  };
}

test("Profile/Relationship uses readable Semantic input and can derive long-term memory from one historical support ref", async () => {
  const historical = message(1, "user", "当对话压力太大时，我需要先暂停交流，之后再继续。");
  const trigger = message(2, "assistant", "我记得了。");
  const state = contracts.createInitialMemoryState();
  state.working.recentEpisodes.push(item("episode:pause", "用户在交流压力过大时需要先暂停，冷静后再继续沟通。", historical));
  state.meta.targetCursors.profileRelationship = 1;
  const store = storeFixture({ state, observedMessages: [trigger], databaseMessages: [historical, trigger] });
  let providerRequest;
  const adapter = createMemoryProviderAdapter({
    promptLoader: async () => "profile prompt",
    invokeStructured: async (request) => {
      providerRequest = request;
      return { output: {
        tickId: request.userPayload.task.tickId,
        proposer: "profileRelationshipProposer",
        sectionResults: {
          userProfile: { status: "changes", changes: [{
            action: "add",
            text: "用户在交流压力过大时需要先暂停，冷静后再继续沟通。",
            supportRefs: ["E1"],
          }] },
          assistantProfile: { status: "noop" },
          relationship: { status: "noop" },
        },
      } };
    },
  });
  let id = 0;
  const pipeline = createNormalWritePipeline({
    observer: {},
    providerAdapter: adapter,
    repositories: store.repositories,
    config,
    now: () => new Date("2026-07-22T03:00:00.000Z"),
    idFactory: () => `id-${++id}`,
  });

  const result = await pipeline.processIntent(1, "default", profileIntent());

  assert.equal(result.status, "committed");
  assert.deepEqual(Object.keys(providerRequest.userPayload).sort(), ["memoryText", "messages", "task"]);
  assert.match(providerRequest.userPayload.memoryText, /E1 \| 用户在交流压力过大时需要先暂停/);
  assert.equal(JSON.stringify(providerRequest.userPayload).includes("episode:pause"), false);
  assert.equal(JSON.stringify(providerRequest.responseSchema).includes("facet"), false);
  assert.equal(JSON.stringify(providerRequest.responseSchema).includes("canonicalKey"), false);
  assert.equal(JSON.stringify(providerRequest.responseSchema).includes("factBasis"), false);
  assert.deepEqual(store.inspect.state.longTerm.userProfile.map((entry) => ({
    text: entry.text,
    sourceMessageIds: entry.sourceRefs.map((ref) => ref.messageId),
  })), [{
    text: "用户在交流压力过大时需要先暂停，冷静后再继续沟通。",
    sourceMessageIds: [1],
  }]);
  assert.equal(store.inspect.state.meta.targetCursors.profileRelationship, 2);
  const task = [...store.inspect.tasks.values()][0];
  assert.equal(task.schema_version, "2.01");
  assert.equal(task.stage_payload.compiledProposal.sectionResults.userProfile.patches[0].op, "addItem");
});

test("Profile/Relationship support-only correct, update and forget compile without typed metadata or evidence-count gates", async () => {
  const support = message(1, "user", "这些长期档案需要按现在的共识调整。");
  const userSource = message(2, "user", "我以前说过自己喜欢长篇回复。");
  const assistantSource = message(3, "assistant", "我曾把爱开玩笑写成固定人格。");
  const relationshipSource = message(4, "user", "我们以前用旧称呼。");
  const trigger = message(5, "user", "请按刚才复盘的结论处理。");
  const state = contracts.createInitialMemoryState();
  state.working.recentEpisodes.push(item("episode:review", "复盘确认：用户偏好简短回应，旧 Assistant 人格记录应删除，双方改用新称呼。", support));
  state.longTerm.userProfile.push(item("userProfile:reply", "用户偏好长篇回复。", userSource));
  state.longTerm.assistantProfile.push(item("assistantProfile:joke", "Assistant 总是喜欢开玩笑。", assistantSource));
  state.longTerm.relationship.push(item("relationship:name", "双方使用旧称呼。", relationshipSource));
  state.meta.targetCursors.profileRelationship = 4;
  const store = storeFixture({
    state,
    observedMessages: [trigger],
    databaseMessages: [support, userSource, assistantSource, relationshipSource, trigger],
  });
  let id = 0;
  const pipeline = createNormalWritePipeline({
    observer: {},
    providerAdapter: { propose: async (envelope) => ({ status: "ok", output: {
      tickId: envelope.task.tickId,
      proposer: "profileRelationshipProposer",
      sectionResults: {
        userProfile: { status: "changes", changes: [{ action: "correct", ref: "UP1", text: "用户偏好简短回应。", supportRefs: ["E1"] }] },
        assistantProfile: { status: "changes", changes: [{ action: "forget", ref: "AP1", supportRefs: ["E1"] }] },
        relationship: { status: "changes", changes: [{ action: "update", ref: "R1", text: "双方使用新称呼。", supportRefs: ["E1"] }] },
      },
    } }) },
    repositories: store.repositories,
    config,
    now: () => new Date("2026-07-22T03:00:00.000Z"),
    idFactory: () => `id-${++id}`,
  });

  const result = await pipeline.processIntent(1, "default", profileIntent());

  assert.equal(result.status, "committed");
  assert.equal(store.inspect.state.longTerm.userProfile[0].id, "userProfile:reply");
  assert.equal(store.inspect.state.longTerm.userProfile[0].text, "用户偏好简短回应。");
  assert.deepEqual(store.inspect.state.longTerm.userProfile[0].sourceRefs.map((ref) => ref.messageId), [1, 2]);
  assert.deepEqual(store.inspect.state.longTerm.assistantProfile, []);
  assert.equal(store.inspect.state.longTerm.relationship[0].id, "relationship:name");
  assert.equal(store.inspect.state.longTerm.relationship[0].text, "双方使用新称呼。");
  assert.deepEqual(store.inspect.state.longTerm.relationship[0].sourceRefs.map((ref) => ref.messageId), [1, 4]);
  const compiled = [...store.inspect.tasks.values()][0].stage_payload.compiledProposal;
  assert.deepEqual([
    compiled.sectionResults.userProfile.patches[0].op,
    compiled.sectionResults.assistantProfile.patches[0].op,
    compiled.sectionResults.relationship.patches[0].op,
  ], ["updateItem", "forgetItem", "updateItem"]);
  assert.equal(JSON.stringify(store.inspect.state).includes("factBasis"), false);
  assert.equal(JSON.stringify(store.inspect.events).includes("evidence_kind"), false);
});
