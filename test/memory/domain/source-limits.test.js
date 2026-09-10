const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryExampleEnv, sha256 } = require("../support/memory-builders");
const { loadMemoryV2Config } = require("../../../modules/memory/config/loadConfig");
const { captureWriteLimits, sectionLimits, validateWriteLimits } = require("../../../modules/memory/contracts/sectionPolicy");
const { createInitialMemoryState, validateRendererArtifact, validateMemoryState } = require("../../../modules/memory/contracts");
const { buildNormalEnvelope } = require("../../../modules/memory/application/envelope");
const { compileSemanticResult } = require("../../../modules/memory/domain/semanticCompiler");
const { reduceCompiledProposal } = require("../../../modules/memory/domain/compiledReducer");
const { buildDeterministicExactMergeOutput } = require("../../../modules/memory/domain/itemDeduplication");
const { buildOutputSchema } = require("../../../modules/memory/infrastructure/providers/outputSchema");
const { bindOutputSchema } = require("../../../modules/memory/infrastructure/providers/bindOutputSchema");
const { validateProviderWireOutput } = require("../../../modules/memory/infrastructure/providers/validateProviderWireOutput");

const NOW = "2026-09-10T00:00:00.000Z";
const source = messageId => ({ messageId, contentHash: sha256(`message-${messageId}`) });
const sources = Array.from({ length: 17 }, (_, index) => source(index + 1));
const messages = sources.map(ref => ({ id: ref.messageId, role: "user", content: `message-${ref.messageId}`, createdAt: NOW, contentHash: ref.contentHash }));
const item = (id, refs) => ({ id, text: "曾担任助理。", sourceRefs: refs, createdAtMessageId: 1, updatedAtMessageId: 15 });
function config(enabled) {
  return loadMemoryV2Config({ ...memoryExampleEnv(), CHAT_MEMORY_V2_PROVIDER_API_KEY: "test-key",
    CHAT_MEMORY_V2_SOURCE_REFS_LIMIT_ENABLED: String(enabled) });
}

test("unlimited source caps survive task JSON snapshots; invalid or missing limits still reject", () => {
  const task = JSON.parse(JSON.stringify({ writeLimits: captureWriteLimits(config(false)) }));
  assert.deepEqual(validateWriteLimits(task.writeLimits), []);
  assert.equal(sectionLimits("assistantProfile", task).maxSourceRefs, null);
  const newLimits = captureWriteLimits(config(true));
  assert.equal(newLimits.assistantProfile.maxSourceRefs, 16);
  assert.equal(task.writeLimits.assistantProfile.maxSourceRefs, null);
  for (const invalid of [undefined, 0, -1, "unlimited", Infinity]) {
    const changed = structuredClone(task);
    changed.writeLimits.assistantProfile.maxSourceRefs = invalid;
    assert.ok(validateWriteLimits(changed.writeLimits).length);
    assert.throws(() => sectionLimits("assistantProfile", changed), /invalid task.writeLimits/);
  }
  task.writeLimits.assistantProfile.maxItemChars = null;
  assert.ok(validateWriteLimits(task.writeLimits).length);
});

test("15 historical sources plus 2 new messages commit only with the source cap disabled", () => {
  for (const enabled of [true, false]) {
    const selectedConfig = config(enabled);
    const state = createInitialMemoryState();
    state.meta.targetCursors.profileRelationship = 15;
    state.longTerm.assistantProfile = [item("profile", [sources[0]])];
    state.working.recentEpisodes = [item("episode", sources.slice(0, 15))];
    const envelope = buildNormalEnvelope({ userId: 1, presetId: "default", state,
      intent: { targetKey: "profileRelationship", proposer: "profileRelationshipProposer", cursorBefore: 15 },
      messages: messages.slice(15), now: NOW, config: selectedConfig });
    assert.deepEqual(validateRendererArtifact(envelope.artifact), { ok: true, errors: [] });
    const semanticResult = { tickId: envelope.task.tickId, proposer: envelope.task.proposer, sectionResults: {
      userProfile: { status: "noop" }, relationship: { status: "noop" },
      assistantProfile: { status: "changes", changes: [{ action: "revise", ref: "AP1", text: "曾担任助理，后来调任顾问。",
        supportRefs: ["E1"], evidenceMessageIds: [16, 17] }] },
    } };
    const compile = result => compileSemanticResult({ artifact: envelope.artifact, semanticResult: result,
      baseState: state, sourceMessages: messages, userId: 1, presetId: "default" });
    const proposal = compile(semanticResult);
    const reduce = () => reduceCompiledProposal({ state, task: envelope.task, config: selectedConfig, proposal });
    if (enabled) {
      assert.throws(reduce, error => error.reason === "source_limit_exceeded");
    } else {
      const result = reduce();
      assert.deepEqual(result.state.longTerm.assistantProfile[0].sourceRefs, sources);
      assert.equal(validateMemoryState(result.state).ok, true);
      const invalid = structuredClone(semanticResult);
      invalid.sectionResults.assistantProfile.changes[0].supportRefs = ["E999"];
      assert.throws(() => compile(invalid), /Semantic compile failed/);
      proposal.sectionResults.assistantProfile.patches[0].value.text = "字".repeat(201);
      assert.throws(reduce, error => error.reason === "text_length_exceeded");
    }
    assert.deepEqual(state.longTerm.assistantProfile[0].sourceRefs, [sources[0]]);
  }
});

test("flat, Todo, compaction and Librarian schemas omit only source-count caps when disabled", () => {
  const artifact = { publicInput: { task: { writeLimits: captureWriteLimits(config(false)) } },
    refMap: { writable: { W1: { section: "worldFacts" }, W2: { section: "worldFacts" }, T1: { section: "todos" } },
      readOnly: Object.fromEntries(sources.map((ref, index) => [`W1-E${index + 1}`, { section: "worldFacts", itemId: "w1", sourceRefs: [ref] }])) },
    messageMeta: Object.fromEntries(messages.map(message => [message.id, message])) };
  const sourceTokens = messages.map(message => `message:${message.id}`);
  const entries = [
    ["worldFactProposer", ["worldFacts"], { sectionStatuses: { worldFacts: "changes" }, changes: [{ section: "worldFacts", action: "add", text: "事实", sources: sourceTokens }] }],
    ["todoProposer", ["todos"], { results: { todos: { status: "changes", changes: [{ action: "add", text: "待办", actor: "user", requester: "user", due: { mode: "none" }, sources: sourceTokens }] } } }],
    ["compactionProposer", ["worldFacts"], { tickId: 1, proposer: "compactionProposer", sectionResults: { worldFacts: { status: "changes", changes: [{ action: "merge", refs: ["W1", "W2"], text: "事实", supportRefs: Object.keys(artifact.refMap.readOnly) }] } } }],
    ["librarianProposer", [], null],
  ];
  for (const [proposer, sections, output] of entries) {
    const schema = bindOutputSchema(buildOutputSchema(proposer, sections), artifact, sections);
    let sourceFields = 0;
    function check(node) {
      if (!node || typeof node !== "object") return;
      for (const key of ["sources", "supportRefs", "evidenceMessageIds"]) {
        const field = node.properties?.[key];
        if (!field) continue;
        sourceFields++;
        assert.equal(Object.hasOwn(field, "maxItems"), false, `${proposer}.${key}`);
        assert.equal(field.minItems, 1);
      }
      for (const child of Object.values(node)) check(child);
    }
    check(schema.schema);
    assert.ok(sourceFields > 0, proposer);
    if (output) assert.equal(validateProviderWireOutput(schema, output).ok, true, proposer);
  }
  // Disabling the cap never authorizes unknown or empty evidence selections.
  const schema = bindOutputSchema(buildOutputSchema("worldFactProposer", ["worldFacts"]), artifact);
  const output = entries[0][2];
  for (const invalid of [[], ["message:999"]]) {
    output.changes[0].sources = invalid;
    assert.equal(validateProviderWireOutput(schema, output).ok, false);
  }
});

test("deterministic compaction can retain more than 16 evidence aliases when uncapped", () => {
  const state = createInitialMemoryState();
  state.longTerm.worldFacts = [item("w1", sources), item("w2", sources)];
  const artifact = { refMap: { writable: { W1: { itemId: "w1" }, W2: { itemId: "w2" } },
    readOnly: Object.fromEntries(sources.map((ref, index) => [`W1-E${index + 1}`, { itemId: "w1", sourceRefs: [ref] }])) } };
  const task = { targetSections: ["worldFacts"], tickId: 1, writeLimits: captureWriteLimits(config(true)) };
  assert.equal(buildDeterministicExactMergeOutput(state, task, artifact), null);
  task.writeLimits = captureWriteLimits(config(false));
  assert.equal(buildDeterministicExactMergeOutput(state, task, artifact).sectionResults.worldFacts.changes[0].supportRefs.length, 17);
});
