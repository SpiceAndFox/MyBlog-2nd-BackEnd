const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const contracts = require("../../../modules/memory/contracts");
const domain = require("../../../modules/memory/domain");
const {
  buildProposerTaskArtifact,
  expandProposerTaskArtifact,
} = require("../../../modules/memory/application/proposerTaskRenderer");
const { createSemanticCompiler } = require("../../../modules/memory/application/semanticCompiler");

function hash(content) {
  return `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function source(messageId, content) { return { messageId, contentHash: hash(content) }; }
function item(id, text, refs) {
  return {
    id,
    text,
    sourceRefs: refs,
    createdAtMessageId: refs[0].messageId,
    updatedAtMessageId: refs.at(-1).messageId,
  };
}

function message(id, role, content, createdAt) {
  return { id, role, content, contentHash: hash(content), createdAt, contentKind: "raw" };
}

function fixture() {
  const oldMessage = message(1, "user", "我们遇到分歧后通常会复盘。", "2026-07-20T10:00:00.000Z");
  const overlapMessage = message(2, "assistant", "你需要安静一下，我会等你。", "2026-07-21T10:00:00.000Z");
  const newMessage = message(3, "user", "我不是讨厌你，只是想先安静一会儿。", "2026-07-22T10:00:00.000Z");
  const state = contracts.createInitialMemoryState();
  state.working.recentEpisodes.push(item("episode:1", "用户因连续追问感到压力，双方暂停了交流。", [source(2, overlapMessage.content)]));
  state.longTerm.relationship.push(item("relationship:1", "双方遇到分歧后通常愿意复盘。", [source(1, oldMessage.content)]));
  state.meta.revision = 7;
  state.meta.targetCursors.episodes = 2;
  const artifact = buildProposerTaskArtifact({
    state,
    intent: { targetKey: "episodes", proposer: "episodeProposer", cursorBefore: 2 },
    messages: [overlapMessage, newMessage],
    now: "2026-07-22T10:01:00.000Z",
    taskId: "task-episode-1",
    tickId: 101,
    userTimeZone: "Asia/Shanghai",
  });
  return { state, artifact, oldMessage, overlapMessage, newMessage };
}

test("2.01 state stores flat sourceRefs and rejects legacy evidence metadata", () => {
  const state = contracts.createInitialMemoryState();
  assert.equal(state.version, "2.01");
  assert.deepEqual(state.current.scene.location, { value: null, sourceRefs: [], updatedAtMessageId: null });
  assert.equal(contracts.validateMemoryState(state).ok, true);

  state.longTerm.userProfile.push({
    ...item("profile:1", "用户偏好简短回答。", [source(1, "请简短回答")]),
    facet: "preference",
  });
  const invalid = contracts.validateMemoryState(state);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.path.endsWith(".facet") && error.message === "is not allowed"));
});

test("Renderer artifact exposes readable refs but keeps ids, hashes and provenance private", () => {
  const { artifact } = fixture();
  assert.equal(contracts.validateRendererArtifact(artifact).ok, true);
  assert.match(artifact.publicInput.memoryText, /E1 \| 用户因连续追问感到压力/);
  assert.match(artifact.publicInput.memoryText, /R1 \| 双方遇到分歧后通常愿意复盘/);
  assert.equal(JSON.stringify(artifact.publicInput).includes("episode:1"), false);
  assert.equal(JSON.stringify(artifact.publicInput).includes("contentHash"), false);
  assert.equal(JSON.stringify(artifact.publicInput).includes("sourceRefs"), false);
  assert.deepEqual(artifact.refMap.writable.E1, { section: "recentEpisodes", itemId: "episode:1" });
  assert.deepEqual(artifact.refMap.readOnly.R1.sourceRefs.map((ref) => ref.messageId), [1]);
});

test("context expansion preserves the original Memory text and ref map byte-for-byte", () => {
  const { artifact, oldMessage, overlapMessage, newMessage } = fixture();
  const expanded = expandProposerTaskArtifact(artifact, [oldMessage, overlapMessage, newMessage]);
  assert.deepEqual(expanded.refMap, artifact.refMap);
  assert.equal(expanded.publicInput.memoryText, artifact.publicInput.memoryText);
  assert.deepEqual(expanded.publicInput.task, artifact.publicInput.task);
  assert.deepEqual(expanded.publicInput.messages.map((entry) => entry.id), [1, 2, 3]);
});

test("Semantic contract accepts support-only changes and rejects persistent protocol fields", () => {
  const { artifact } = fixture();
  const supportOnly = {
    tickId: 101,
    proposer: "episodeProposer",
    sectionResults: {
      recentEpisodes: { status: "changes", changes: [{ action: "update", ref: "E1", text: "双方暂停后恢复了沟通。", supportRefs: ["R1"] }] },
      milestones: { status: "noop" },
    },
  };
  assert.equal(contracts.validateSemanticResult(supportOnly, artifact).ok, true);

  supportOnly.sectionResults.recentEpisodes.changes[0].evidenceKind = "recent_episode";
  const invalid = contracts.validateSemanticResult(supportOnly, artifact);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.path.endsWith(".evidenceKind") && error.message === "is not allowed"));
});

test("Compiler expands historical support sources, merges direct sources and maps correct to updateItem", async () => {
  const { state, artifact, oldMessage, newMessage } = fixture();
  const rows = [oldMessage, newMessage].map((entry) => ({ ...entry, userId: 9, presetId: "default" }));
  const compiler = createSemanticCompiler({
    sourceReader: {
      async getByIds(_userId, _presetId, ids) { return rows.filter((entry) => ids.includes(entry.id)); },
    },
  });
  const semanticResult = {
    tickId: 101,
    proposer: "episodeProposer",
    sectionResults: {
      recentEpisodes: {
        status: "changes",
        changes: [{
          action: "correct",
          ref: "E1",
          text: "暂停并不代表拒绝关系；双方冷静后恢复了沟通。",
          evidenceMessageIds: [3],
          supportRefs: ["R1"],
        }],
      },
      milestones: { status: "noop" },
    },
  };
  const compiled = await compiler.compile({ artifact, semanticResult, baseState: state, userId: 9, presetId: "default" });
  assert.deepEqual(compiled.sectionResults.recentEpisodes.patches[0], {
    op: "updateItem",
    itemId: "episode:1",
    value: { text: "暂停并不代表拒绝关系；双方冷静后恢复了沟通。" },
    sourceRefs: [source(1, oldMessage.content), source(3, newMessage.content)],
  });
  assert.equal(JSON.stringify(compiled).includes("correct"), false);
  assert.equal(JSON.stringify(compiled).includes("evidenceKind"), false);
});

test("2.01 Reducer applies compiled patches with flat provenance and no tombstone side effects", async () => {
  const { state, artifact, oldMessage, newMessage } = fixture();
  const compiler = createSemanticCompiler({
    sourceReader: {
      async getByIds(_userId, _presetId, ids) {
        return [oldMessage, newMessage].filter((entry) => ids.includes(entry.id)).map((entry) => ({ ...entry, userId: 9, presetId: "default" }));
      },
    },
  });
  const semanticResult = {
    tickId: 101,
    proposer: "episodeProposer",
    sectionResults: {
      recentEpisodes: { status: "changes", changes: [{ action: "correct", ref: "E1", text: "双方冷静后恢复了沟通。", evidenceMessageIds: [3], supportRefs: ["R1"] }] },
      milestones: { status: "noop" },
    },
  };
  const proposal = await compiler.compile({ artifact, semanticResult, baseState: state, userId: 9, presetId: "default" });
  const reduced = domain.reduceCompiledProposal({
    state,
    task: { ...artifact.publicInput.task, mode: "normal" },
    proposal,
    now: artifact.publicInput.task.now,
    config: {
      scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
      sectionBudgets: Object.fromEntries(contracts.ITEM_SECTIONS.map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }])),
    },
    idFactory: (() => { let value = 0; return () => `id-${++value}`; })(),
  });
  assert.equal(reduced.outcome, "committable");
  assert.equal(reduced.state.working.recentEpisodes[0].id, "episode:1");
  assert.deepEqual(reduced.state.working.recentEpisodes[0].sourceRefs.map((ref) => ref.messageId), [1, 2, 3]);
  assert.equal(reduced.events.some((event) => Object.prototype.hasOwnProperty.call(event, "evidenceKind")), false);
  assert.equal(Object.prototype.hasOwnProperty.call(reduced, "tombstones"), false);
});

test("Compiler fails closed for stale support provenance and never guesses a target", async () => {
  const { state, artifact, oldMessage } = fixture();
  state.longTerm.relationship[0].sourceRefs = [source(4, "changed")];
  const compiler = createSemanticCompiler({ sourceReader: { async getByIds() { return [oldMessage]; } } });
  const semanticResult = {
    tickId: 101,
    proposer: "episodeProposer",
    sectionResults: {
      recentEpisodes: { status: "changes", changes: [{ action: "forget", ref: "E1", supportRefs: ["R1"] }] },
      milestones: { status: "noop" },
    },
  };
  await assert.rejects(
    compiler.compile({ artifact, semanticResult, baseState: state, userId: 9, presetId: "default" }),
    (error) => error.code === "ref_resolution_failed" && error.detail.reason === "support_changed",
  );
});

test("Compiler resolves relative Todo dates from the explicit direct-message anchor", async () => {
  const state = contracts.createInitialMemoryState();
  state.meta.targetCursors.todos = 9;
  const anchor = message(10, "user", "明天提醒我交报告。", "2026-07-22T16:30:00.000Z");
  const artifact = buildProposerTaskArtifact({
    state,
    intent: { targetKey: "todos", proposer: "todoProposer", cursorBefore: 9 },
    messages: [anchor],
    now: "2026-07-22T16:31:00.000Z",
    taskId: "task-todo-1",
    tickId: 202,
    userTimeZone: "Asia/Shanghai",
  });
  const compiler = createSemanticCompiler({
    sourceReader: { async getByIds() { return [{ ...anchor, userId: 9, presetId: "default" }]; } },
  });
  const semanticResult = {
    tickId: 202,
    proposer: "todoProposer",
    sectionResults: {
      todos: { status: "changes", changes: [{
        action: "add",
        text: "交报告",
        actor: "user",
        requester: "user",
        dueAt: { mode: "relative", days: 1 },
        anchorMessageId: 10,
        evidenceMessageIds: [10],
      }] },
    },
  };
  const compiled = await compiler.compile({ artifact, semanticResult, baseState: state, userId: 9, presetId: "default" });
  assert.equal(compiled.sectionResults.todos.patches[0].value.dueAt, "2026-07-24T16:00:00.000Z");

  delete semanticResult.sectionResults.todos.changes[0].evidenceMessageIds;
  semanticResult.sectionResults.todos.changes[0].supportRefs = ["UP1"];
  assert.equal(contracts.validateSemanticResult(semanticResult, artifact).ok, false);
});

test("Compiler resolves a Todo day-of-month from message time and the frozen user time zone", async () => {
  const state = contracts.createInitialMemoryState();
  state.meta.targetCursors.todos = 10;
  const anchor = message(11, "user", "咱们9号出去看电影吧。", "2026-07-22T16:30:00.000Z");
  const artifact = buildProposerTaskArtifact({
    state,
    intent: { targetKey: "todos", proposer: "todoProposer", cursorBefore: 10 },
    messages: [anchor],
    now: "2026-08-20T00:00:00.000Z",
    taskId: "task-todo-day-of-month",
    tickId: 203,
    userTimeZone: "Asia/Shanghai",
  });
  const compiler = createSemanticCompiler({
    sourceReader: { async getByIds() { return [{ ...anchor, userId: 9, presetId: "default" }]; } },
  });
  const semanticResult = {
    tickId: 203,
    proposer: "todoProposer",
    sectionResults: {
      todos: { status: "changes", changes: [{
        action: "add",
        text: "出去看电影",
        actor: "both",
        requester: "user",
        dueAt: { mode: "dayOfMonth", day: 9 },
        anchorMessageId: 11,
        evidenceMessageIds: [11],
      }] },
    },
  };
  assert.equal(contracts.validateSemanticResult(semanticResult, artifact).ok, true);
  const compiled = await compiler.compile({ artifact, semanticResult, baseState: state, userId: 9, presetId: "default" });
  assert.equal(compiled.sectionResults.todos.patches[0].value.dueAt, "2026-08-09T16:00:00.000Z");

  delete semanticResult.sectionResults.todos.changes[0].anchorMessageId;
  assert.equal(contracts.validateSemanticResult(semanticResult, artifact).ok, false);
});

test("Compiled Patch uses sourceRefs and permits forget for every item section", () => {
  const ref = source(7, "忘记这条");
  for (const section of contracts.ITEM_SECTIONS) {
    const result = contracts.validateCompiledPatch({ op: "forgetItem", itemId: `${section}:1`, sourceRefs: [ref] }, section);
    assert.equal(result.ok, true, `${section}: ${JSON.stringify(result.errors)}`);
  }
  const legacy = contracts.validateCompiledPatch({
    op: "forgetItem",
    itemId: "worldFact:1",
    sourceRefs: [ref],
    evidenceKind: "user_forget",
  }, "worldFacts");
  assert.equal(legacy.ok, false);
  assert.ok(legacy.errors.some((error) => error.path === "$.evidenceKind"));
});
