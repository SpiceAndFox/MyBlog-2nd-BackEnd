const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  resolveOptions,
  summarizeGenerations,
  hydrateTask,
  createServer,
} = require("../../evals/gui/server");

function taskRow(overrides = {}) {
  const envelope = {
    task: {
      taskId: "00000000-0000-4000-8000-000000000001",
      proposer: "episodeProposer",
      targetSections: ["recentEpisodes", "milestones"],
    },
    artifact: {
      publicInput: { task: {}, memoryText: "", messages: [{ id: 1, role: "user", content: "hello", createdAt: "2026-07-19T00:00:00.000Z" }] },
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
      compiledProposal: { tickId: 1, proposer: "episodeProposer", sectionResults: {} },
    },
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:01.000Z",
    ops: [],
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
  });
  assert.equal(task.input.currentPrompt, "prompt");
  assert.deepEqual(task.input.responseSchema.sections, ["recentEpisodes", "milestones"]);
  assert.equal(task.input.effectiveEnvelope.task.proposer, "episodeProposer");
  assert.equal(task.output.availability, "persisted");
  assert.equal(task.output.semanticResult.proposer, "episodeProposer");
  assert.equal(task.output.compiledProposal.proposer, "episodeProposer");
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
