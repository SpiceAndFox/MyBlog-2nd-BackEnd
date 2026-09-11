const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState, validateSemanticResult, validateMemoryState } = require("../../../modules/memory/contracts");
const { captureWriteLimits } = require("../../../modules/memory/contracts/sectionPolicy");
const { reduceCompiledProposal } = require("../../../modules/memory/domain/compiledReducer");
const { replayEventGroups } = require("../../../modules/memory/domain/eventReplay");
const { compileSemanticResult } = require("../../../modules/memory/domain/semanticCompiler");
const { buildNormalEnvelope } = require("../../../modules/memory/application/envelope");
const { mapEventToRow } = require("../../../modules/memory/application/eventMapper");
const { createMemoryTestConfig, sha256 } = require("../support/memory-builders");
const { memoryExampleEnv } = require("../support/memory-builders");
const { loadMemoryV2Config } = require("../../../modules/memory/config/loadConfig");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/output/outputSchema");
const { bindOutputSchema } = require("../../../modules/memory/infrastructure/providers/output/bindOutputSchema");

const config = createMemoryTestConfig();
const source = (messageId) => ({ messageId, contentHash: sha256(`message-${messageId}`) });
const initialItem = { id: "existing", text: "旧事实", sourceRefs: [source(1)], createdAtMessageId: 1, updatedAtMessageId: 1 };

for (const sourceLimitEnabled of [false, true]) {
  test(`explicit env limits reach schemas and reducers with source-count limits ${sourceLimitEnabled ? "enabled" : "disabled"}`, () => {
    const env = { ...memoryExampleEnv(), CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
      CHAT_MEMORY_V2_SOURCE_REFS_LIMIT_ENABLED: String(sourceLimitEnabled),
      CHAT_MEMORY_V2_WORLD_FACTS_MAX_ITEM_CHARS: "377", CHAT_MEMORY_V2_WORLD_FACTS_MAX_SOURCE_REFS: "2" };
    const loaded = loadMemoryV2Config(env);
    const f = fixture();
    f.task.writeLimits = captureWriteLimits(loaded);
    const artifact = { publicInput: { task: f.task }, refMap: { writable: {}, readOnly: {} }, messageMeta: { 2: {} } };
    const schema = bindOutputSchema(buildOutputSchema("worldFactProposer", ["worldFacts"]), artifact);
    assert.equal(schema.schema.properties.changes.items.properties.text.maxLength, 377);
    assert.equal(f.task.writeLimits.worldFacts.maxSourceRefs, sourceLimitEnabled ? 2 : null);
    const sourceSchema = schema.schema.properties.changes.items.properties.sources;
    if (sourceLimitEnabled) assert.equal(sourceSchema.maxItems, 2);
    else assert.equal(Object.hasOwn(sourceSchema, "maxItems"), false);
    const sources = [source(2), source(3), source(4)];
    const writeWithThreeSources = () => reduce(f, [{ op: "addItem", value: { text: "有三条来源的事实" }, sourceRefs: sources }]);
    if (sourceLimitEnabled) assert.throws(writeWithThreeSources, error => error.reason === "source_limit_exceeded");
    else assert.deepEqual(writeWithThreeSources().state.longTerm.worldFacts.at(-1).sourceRefs, sources);
    const text = "字".repeat(377);
    const output = { tickId: f.task.tickId, proposer: f.task.proposer, sectionResults: {
      worldFacts: { status: "changes", changes: [{ action: "add", text, evidenceMessageIds: [2] }] },
    } };
    assert.equal(validateSemanticResult(output, f.task).ok, true);
    assert.equal(reduce(f, [{ op: "addItem", value: { text }, sourceRefs: [source(2)] }]).state.longTerm.worldFacts.at(-1).text, text);
    output.sectionResults.worldFacts.changes[0].text += "字";
    assert.equal(validateSemanticResult(output, f.task).ok, false);
    assert.throws(() => reduce(f, [{ op: "addItem", value: { text: text + "字" }, sourceRefs: [source(2)] }]), error => error.reason === "text_length_exceeded");
    env.CHAT_MEMORY_V2_WORLD_FACTS_MAX_ITEM_CHARS = "7";
    assert.equal(captureWriteLimits(loadMemoryV2Config(env)).worldFacts.maxItemChars, 7);
    assert.equal(f.task.writeLimits.worldFacts.maxItemChars, 377);
  });
}

test("tasks and configs without explicit write limits fail instead of using hidden defaults", () => {
  assert.throws(() => captureWriteLimits({}), /Invalid scene.maxItemChars/);
  const f = fixture();
  delete f.task.writeLimits;
  assert.throws(() => reduce(f, [{ op: "addItem", value: { text: "新事实" }, sourceRefs: [source(2)] }]), /task.writeLimits.worldFacts/);
});

function fixture(section = "worldFacts") {
  const state = createInitialMemoryState();
  const working = section === "recentEpisodes";
  (working ? state.working : state.longTerm)[section] = [structuredClone(initialItem)];
  const targetKey = working ? "episodes" : section;
  state.meta.targetCursors[targetKey] = 1;
  const task = {
    taskId: "task", userId: 1, presetId: "default", tickId: 1,
    targetKey, targetSections: working ? [section, "milestones"] : [section],
    proposer: working ? "episodeProposer" : "worldFactProposer",
    mode: "normal", baseRevision: 0, sourceGeneration: 0,
    cursorBefore: 1, targetMessageId: 10, now: "2026-09-09T00:00:00.000Z",
    writeLimits: captureWriteLimits(config),
  };
  return { state, task, section };
}

function reduce(f, patches) {
  const sectionResults = Object.fromEntries(f.task.targetSections.map((s) => [s, { status: "noop" }]));
  sectionResults[f.section] = { status: "patches", patches };
  let id = 0;
  return reduceCompiledProposal({ state: f.state, task: f.task, config,
    idFactory: () => `id-${++id}`,
    proposal: { tickId: f.task.tickId, proposer: f.task.proposer, sectionResults } });
}

function replay(f, result) {
  const group = {
    event_group_id: "group", user_id: 1, preset_id: "default", task_id: "task", target_key: f.task.targetKey,
    source_generation: 0, schema_version: f.state.version, base_revision: 0, result_revision: 1,
    cursor_before: 1, cursor_after: 10, group_kind: "proposal",
  };
  const rows = result.events.map((event, index) => mapEventToRow(event, { task: f.task }, "group", index));
  return replayEventGroups(f.state, [group], rows, { userId: 1, presetId: "default" });
}

for (const op of ["reviseItem", "correctItem"]) {
  test(`${op} replaces evidence, retains creation boundary and replays exactly`, () => {
    const f = fixture();
    const result = reduce(f, [{ op, itemId: "existing", value: { text: "新事实" }, sourceRefs: [source(2)] }]);
    assert.deepEqual(result.state.longTerm.worldFacts[0], { ...initialItem, text: "新事实", sourceRefs: [source(2)], updatedAtMessageId: 10 });
    assert.equal(result.events[0].op, op);
    assert.equal(validateMemoryState(result.state).ok, true);
    assert.deepEqual(replay(f, result), result.state);
    assert.deepEqual(f.state.longTerm.worldFacts[0], initialItem);
  });
}

test("episode append preserves text and old evidence and survives event replay", () => {
  const f = fixture("recentEpisodes");
  const result = reduce(f, [{ op: "appendItem", itemId: "existing", value: { text: "确认了下一步🙂" }, sourceRefs: [source(2)] }]);
  assert.equal(result.state.working.recentEpisodes[0].text, "旧事实 → 确认了下一步🙂");
  assert.deepEqual(result.state.working.recentEpisodes[0].sourceRefs, [source(1), source(2)]);
  assert.deepEqual(replay(f, result), result.state);
});

test("final append length is checked before episode eviction and does not mutate state", () => {
  const f = fixture("recentEpisodes");
  f.task.writeLimits.recentEpisodes = { maxItemChars: 8, maxAppendChars: 5, maxSourceRefs: 3 };
  const before = structuredClone(f.state);
  assert.throws(() => reduce(f, [{ op: "appendItem", itemId: "existing", value: { text: "新进展" }, sourceRefs: [source(2)] }]),
    (error) => {
      assert.equal(error.reason, "append_length_exceeded");
      assert.equal(error.validationErrors[0].code, "TEXT_LENGTH_EXCEEDED");
      assert.deepEqual(error.validationErrors[0].meta, {
        section: "recentEpisodes", reason: "append_length_exceeded", field: "text", action: "append", limit: 2, actual: 3,
        existingChars: 3, separatorChars: 3, maxItemChars: 8,
      });
      const { renderRepairMessage } = require("../../../modules/memory/application/outputRepair");
      const repair = renderRepairMessage({ errors: error.validationErrors }, f.task);
      assert.match(repair, /新增 text 最多 2 个 Unicode 字符/);
      assert.match(repair, /已有 3 字符 \+ 分隔符 3 字符/);
      assert.match(repair, /独立互动弧/);
      return true;
    });
  assert.deepEqual(f.state, before);
  const exact = reduce(f, [{ op: "appendItem", itemId: "existing", value: { text: "🙂好" }, sourceRefs: [source(2)] }]);
  assert.equal(exact.state.working.recentEpisodes[0].text, "旧事实 → 🙂好");
});

test("episode renderer publishes the captured remaining append budget", () => {
  const f = fixture("recentEpisodes");
  const selectedConfig = structuredClone(config);
  selectedConfig.sectionBudgets.recentEpisodes = { ...selectedConfig.sectionBudgets.recentEpisodes, maxItemChars: 8, maxAppendChars: 5 };
  const envelope = buildNormalEnvelope({ userId: 1, presetId: "default", state: f.state,
    intent: { targetKey: "episodes", proposer: "episodeProposer", cursorBefore: 1 },
    messages: [{ id: 10, role: "user", content: "新进展", createdAt: f.task.now, contentHash: source(10).contentHash }],
    now: f.task.now, config: selectedConfig });
  assert.match(envelope.artifact.publicInput.memoryText, /E1 \| 旧事实 \[已有 3 字符；append 新增片段最多 2 字符/);
  assert.equal(envelope.task.writeLimits.recentEpisodes.maxItemChars, 8);
});

test("Unicode code points at the exact limit commit; one more rejects the entire proposal", () => {
  const f = fixture();
  f.task.writeLimits.worldFacts.maxItemChars = 3;
  const valid = { op: "addItem", value: { text: "🙂中🙂" }, sourceRefs: [source(2)] };
  assert.equal(reduce(f, [valid]).state.longTerm.worldFacts.length, 2);
  assert.throws(() => reduce(f, [valid, { ...valid, value: { text: "🙂中🙂文" } }]),
    (error) => error.reason === "text_length_exceeded");
  assert.equal(f.state.longTerm.worldFacts.length, 1);
});

test("repeated revisions cannot accumulate historical evidence", () => {
  const f = fixture();
  for (let boundary = 2; boundary <= 120; boundary++) {
    f.task.targetMessageId = boundary;
    f.task.cursorBefore = boundary - 1;
    f.state = reduce(f, [{ op: "reviseItem", itemId: "existing", value: { text: `当前版本 ${boundary}` }, sourceRefs: [source(boundary)] }]).state;
    assert.deepEqual(f.state.longTerm.worldFacts[0].sourceRefs, [source(boundary)]);
    assert.equal(f.state.longTerm.worldFacts[0].createdAtMessageId, 1);
  }
});

test("source cap rejects a large explicit selection without truncating it", () => {
  const f = fixture();
  f.task.writeLimits.worldFacts.maxSourceRefs = 2;
  assert.throws(() => reduce(f, [{ op: "reviseItem", itemId: "existing", value: { text: "短文本" }, sourceRefs: [source(1), source(2), source(3)] }]),
    (error) => error.reason === "source_limit_exceeded");
  assert.deepEqual(f.state.longTerm.worldFacts[0], initialItem);
});

test("failed revisions leave no preview mutations that create spurious errors in independent changes", () => {
  const f = fixture();
  f.task.writeLimits.worldFacts.maxSourceRefs = 2;
  const before = structuredClone(f.state);
  assert.throws(() => reduce(f, [
    { op: "reviseItem", itemId: "existing", value: { text: "新的事实" }, sourceRefs: [source(1), source(2), source(3)] },
    { op: "addItem", value: { text: "新的事实" }, sourceRefs: [source(2)] },
  ]), error => {
    assert.deepEqual(error.validationErrors.map(issue => issue.code), ["SOURCE_LIMIT_EXCEEDED"]);
    return true;
  });
  assert.deepEqual(f.state, before);
});

test("invalid target and duplicate operations do not partially commit", () => {
  for (const invalid of [
    { op: "correctItem", itemId: "missing", value: { text: "修正" }, sourceRefs: [source(2)] },
    { op: "addItem", value: { text: "旧事实" }, sourceRefs: [source(2)] },
  ]) {
    const f = fixture();
    assert.throws(() => reduce(f, [{ op: "addItem", value: { text: "新条目" }, sourceRefs: [source(2)] }, invalid]),
      (error) => error.code === "MEMORY_WRITE_GUARD_INVALID");
    assert.deepEqual(f.state.longTerm.worldFacts, [initialItem]);
  }
});

test("section actions reject generic update, worldFact append and episode revise", () => {
  for (const [section, action] of [["worldFacts", "append"], ["worldFacts", "update"], ["recentEpisodes", "revise"]]) {
    const f = fixture(section);
    const sectionResults = Object.fromEntries(f.task.targetSections.map((s) => [s, { status: "noop" }]));
    sectionResults[section] = { status: "changes", changes: [{ action, ref: "W1", text: "片段", evidenceMessageIds: [2] }] };
    assert.equal(validateSemanticResult({ tickId: 1, proposer: f.task.proposer, sectionResults }, f.task).ok, false);
  }
});

test("a writable item's single old evidence is selectable independently", () => {
  const f = fixture();
  f.state.longTerm.worldFacts[0].sourceRefs = [source(1), source(2)];
  f.state.longTerm.worldFacts[0].updatedAtMessageId = 2;
  const msg = { id: 10, role: "user", content: "纠正", createdAt: f.task.now, contentHash: source(10).contentHash };
  const envelope = buildNormalEnvelope({ userId: 1, presetId: "default", state: f.state,
    intent: { targetKey: "worldFacts", proposer: "worldFactProposer", cursorBefore: 1 }, messages: [msg], now: f.task.now, config });
  const result = { tickId: envelope.task.tickId, proposer: envelope.task.proposer,
    sectionResults: { worldFacts: { status: "changes", changes: [{ action: "correct", ref: "W1", text: "仅保留第二条证据支持的事实", supportRefs: ["W1-E2"] }] } } };
  assert.equal(validateSemanticResult(result, envelope.artifact).ok, true);
  const compiled = compileSemanticResult({ artifact: envelope.artifact, semanticResult: result, baseState: f.state,
    sourceMessages: [{ id: 2, role: "user", createdAt: f.task.now, contentHash: source(2).contentHash }], userId: 1, presetId: "default" });
  assert.deepEqual(compiled.sectionResults.worldFacts.patches[0].sourceRefs, [source(2)]);
});
