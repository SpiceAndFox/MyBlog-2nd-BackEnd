const test = require("node:test");
const assert = require("node:assert/strict");
const { testWriteLimits } = require("../memory/support/memory-builders");
const {
  parseArgs,
  resolveOptions,
  summarizeGenerations,
  hydrateTask,
  createServer,
} = require("../../tools/memory-task-gui/server");
const { OUTPUT_REPAIR_POLICY_VERSION } = require("../../modules/memory/application/outputRepair");

function taskRow(overrides = {}) {
  const envelope = {
    task: {
      writeLimits: testWriteLimits(),
      taskId: "00000000-0000-4000-8000-000000000001",
      tickId: 1,
      proposer: "episodeProposer",
      targetKey: "episodes",
      targetSections: ["recentEpisodes", "milestones"],
      cursorBefore: 0,
      targetMessageId: 1,
      now: "2026-07-19T00:00:01.000Z",
      userTimeZone: "Asia/Shanghai",
    },
    artifact: {
      publicInput: {
        task: {
          writeLimits: testWriteLimits(),
          taskId: "00000000-0000-4000-8000-000000000001",
          tickId: 1,
          proposer: "episodeProposer",
          targetKey: "episodes",
          targetSections: ["recentEpisodes", "milestones"],
          cursorBefore: 0,
          targetMessageId: 1,
          now: "2026-07-19T00:00:01.000Z",
          userTimeZone: "Asia/Shanghai",
        },
        memoryText: "",
        messages: [{ id: 1, role: "user", content: "hello", createdAt: "2026-07-19T00:00:00.000Z" }],
      },
      refMap: { writable: {}, readOnly: {} },
      messageMeta: { "1": { role: "user", createdAt: "2026-07-19T00:00:00.000Z", contentHash: `sha256:${"a".repeat(64)}` } },
    },
  };
  return {
    task_id: envelope.task.taskId,
    user_id: "1",
    preset_id: "Alice",
    source_generation: "4",
    target_key: "episodes",
    task_type: "normal",
    status: "succeeded",
    stage: "committed",
    cursor_before: "0",
    target_message_id: "1",
    base_revision: "0",
    result_revision: "1",
    attempt: 0,
    context_expansion_attempt: 0,
    not_before: null,
    last_error_reason: null,
    task_payload: envelope,
    stage_payload: {
      semanticResult: { tickId: 1, proposer: "episodeProposer", sectionResults: {} },
      semanticInputVariant: "base",
      compiledProposal: { tickId: 1, proposer: "episodeProposer", sectionResults: {} },
    },
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:01.000Z",
    ops: [],
    ...overrides,
  };
}

function providerConfig(overrides = {}) {
  return {
    adapter: "openai-json-schema",
    baseUrl: "https://llm.example.test/v1",
    apiKey: "must-not-be-exposed",
    model: "memory-model",
    proposerModels: {},
    timeoutMs: 1000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

test("Memory task GUI validates local port arguments", () => {
  assert.deepEqual(resolveOptions(parseArgs([])), { help: false, host: "127.0.0.1", port: 4317 });
  assert.equal(resolveOptions(parseArgs(["--port", "4318"])).port, 4318);
  assert.throws(() => resolveOptions(parseArgs(["--port", "0"])), /between 1 and 65535/);
});

test("Memory task GUI summarizes task generations", () => {
  const result = summarizeGenerations([
    { source_generation: "4", status: "succeeded", target_key: "todos", task_count: 2, first_created_at: "a", last_updated_at: "b" },
    { source_generation: "4", status: "failed", target_key: "episodes", task_count: 1, first_created_at: "a", last_updated_at: "c" },
    { source_generation: "3", status: "succeeded", target_key: "scene", task_count: 1, first_created_at: "a", last_updated_at: "b" },
  ]);
  assert.equal(result[0].sourceGeneration, 4);
  assert.equal(result[0].taskCount, 3);
  assert.deepEqual(result[0].statuses, { succeeded: 2, failed: 1 });
});

test("Memory task GUI reconstructs current provider request and persisted output", async () => {
  const task = await hydrateTask(taskRow(), {
    promptLoader: async () => "prompt",
    schemaBuilder: (proposer, sections) => ({ proposer, sections }),
    repairPromptBuilder: (prompt) => `${prompt}:repair`,
    providerConfig: providerConfig(),
  });
  assert.equal(task.input.currentPrompt, "prompt");
  assert.deepEqual(task.input.responseSchema.sections, ["recentEpisodes", "milestones"]);
  assert.equal(task.input.effectiveEnvelope.task.proposer, "episodeProposer");
  assert.equal(task.input.providerUserPayload.task.userTimeZone, "Asia/Shanghai");
  assert.equal(Object.prototype.hasOwnProperty.call(task.input.providerUserPayload.task, "taskId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(task.input.providerUserPayload.task, "now"), false);
  assert.equal(task.output.availability, "persisted");
  assert.equal(task.output.semanticResult.proposer, "episodeProposer");
  assert.equal(task.output.compiledProposal.proposer, "episodeProposer");
  assert.equal(task.input.providerRequests.length, 1);
  const request = task.input.providerRequests[0];
  assert.equal(request.endpoint, "https://llm.example.test/v1/chat/completions");
  assert.equal(request.body.model, "memory-model");
  assert.equal(request.body.max_tokens, 4096);
  assert.equal(request.body.messages[0].content, "prompt");
  assert.deepEqual(JSON.parse(request.body.messages[1].content), task.input.providerUserPayload);
  assert.equal(request.body.response_format.type, "json_schema");
  assert.equal(JSON.stringify(request).includes("must-not-be-exposed"), false);
});

test("Memory task GUI reconstructs persisted rejected output as a multi-turn repair request", async () => {
  const row = taskRow({
    status: "running",
    stage: "schema_invalid_retry",
    last_error_reason: "output_schema_invalid",
    stage_payload: {
      schemaInvalidAttempts: 1,
      schemaRepairFeedback: {
        policyVersion: 4,
        attempt: 1,
        errors: [{ code: "CONTRACT_INVALID", path: "$.changes", message: "must be an array" }],
      },
      schemaRejectedOutputs: [{
        attempt: 0,
        available: true,
        utf8Bytes: 21,
        output: { changes: "invalid" },
      }],
    },
  });
  const task = await hydrateTask(row, {
    promptLoader: async () => "prompt",
    providerConfig: providerConfig(),
  });
  assert.equal(task.output.availability, "rejected_output_persisted");
  assert.deepEqual(task.output.rejectedOutputs[0].output, { changes: "invalid" });
  const messages = task.input.providerRequests[0].body.messages;
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[2].content, '{"changes":"invalid"}');
  assert.match(messages[3].content, new RegExp(`\\[SCHEMA_REPAIR_V${OUTPUT_REPAIR_POLICY_VERSION}\\]`));
});

test("Memory task GUI exposes each Profile specialist API request", async () => {
  const row = taskRow();
  row.task_payload.task.proposer = "profileRelationshipProposer";
  row.task_payload.task.targetKey = "profileRelationship";
  row.task_payload.task.targetSections = ["userProfile", "assistantProfile", "relationship"];
  Object.assign(row.task_payload.artifact.publicInput.task, {
    proposer: "profileRelationshipProposer",
    targetKey: "profileRelationship",
    targetSections: ["userProfile", "assistantProfile", "relationship"],
  });
  const task = await hydrateTask(row, {
    promptLoader: async (proposer) => `prompt:${proposer}`,
    providerConfig: providerConfig({
      proposerModels: {
        userProfileProposer: "user-model",
        assistantProfileProposer: "assistant-model",
        relationshipProposer: "relationship-model",
      },
    }),
  });
  assert.deepEqual(task.input.providerRequests.map((request) => request.proposer), [
    "userProfileProposer",
    "assistantProfileProposer",
    "relationshipProposer",
  ]);
  assert.deepEqual(task.input.providerRequests.map((request) => request.body.model), [
    "user-model",
    "assistant-model",
    "relationship-model",
  ]);
  assert.deepEqual(task.input.providerRequests.map((request) => JSON.parse(request.body.messages[1].content).task.targetSections), [
    ["userProfile"],
    ["assistantProfile"],
    ["relationship"],
  ]);
});

test("Memory task GUI reconstructs expanded input from expandedArtifact and base refMap", async () => {
  const row = taskRow();
  const baseRefMap = structuredClone(row.task_payload.artifact.refMap);
  const expandedMessage = { id: 0, role: "user", content: "older", createdAt: "2026-07-18T23:59:59.000Z" };
  row.context_expansion_attempt = 1;
  row.stage_payload = {
    semanticInputVariant: "expanded",
    expandedArtifact: {
      publicInput: { ...structuredClone(row.task_payload.artifact.publicInput), messages: [expandedMessage, ...row.task_payload.artifact.publicInput.messages] },
      messageMeta: {
        ...structuredClone(row.task_payload.artifact.messageMeta),
        "0": { role: "user", createdAt: expandedMessage.createdAt, contentHash: `sha256:${"b".repeat(64)}` },
      },
    },
    unableResult: { tickId: 1, proposer: "episodeProposer", sectionResults: {} },
  };

  const task = await hydrateTask(row, {
    promptLoader: async () => "prompt",
    schemaBuilder: () => ({ strict: true }),
  });
  assert.equal(task.input.semanticInputVariant, "expanded");
  assert.deepEqual(task.input.effectiveEnvelope.artifact.refMap, baseRefMap);
  assert.deepEqual(task.input.effectiveEnvelope.artifact.publicInput.messages.map((message) => message.id), [0, 1]);
  assert.equal(task.output.semanticResult, null);
  assert.equal(task.output.unableResult.proposer, "episodeProposer");
});

test("Memory task GUI HTTP API performs SELECT-only reads", async (context) => {
  const db = {
    async query(sql) {
      assert.match(sql, /^\s*SELECT/i);
      if (/GROUP BY source_generation/i.test(sql)) {
        return { rows: [{ source_generation: "4", status: "succeeded", target_key: "episodes", task_count: 1, first_created_at: "a", last_updated_at: "b" }] };
      }
      return { rows: [taskRow()] };
    },
  };
  const server = createServer({
    db,
    promptLoader: async () => "prompt",
    schemaBuilder: () => ({ strict: true }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const generations = await fetch(`http://127.0.0.1:${port}/api/generations?userId=1&presetId=Alice`).then((response) => response.json());
  assert.equal(generations.generations[0].taskCount, 1);
  const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks?userId=1&presetId=Alice&generation=4`).then((response) => response.json());
  assert.equal(tasks.tasks[0].proposer, "episodeProposer");
  const rejected = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST" });
  assert.equal(rejected.status, 405);
});
