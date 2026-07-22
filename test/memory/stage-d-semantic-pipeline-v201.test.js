const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  contracts, buildProposerTaskArtifact, createSemanticCompiler,
} = require("../../modules/memory");
const { buildOutputSchema } = require("../../modules/memory/infrastructure/providers/outputSchema");

function hash(content) { return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`; }
function message(id, content) {
  return { id, role: "user", content, contentHash: hash(content), createdAt: "2026-07-22T02:00:00.000Z", userId: 7, presetId: "default" };
}
function item(id, text, source) {
  return { id, text, sourceRefs: [{ messageId: source.id, contentHash: source.contentHash }], createdAtMessageId: source.id, updatedAtMessageId: source.id };
}

test("stage D Provider schemas expose domain actions instead of persistent patches", () => {
  for (const proposer of ["worldFactProposer", "agreementProposer", "todoProposer", "currentStateProposer"]) {
    const schema = JSON.stringify(buildOutputSchema(proposer));
    assert.match(schema, /"changes"/);
    assert.doesNotMatch(schema, /evidenceKind|evidenceRef|contentHash|itemId|setField|addItem/);
  }
});

test("stage D Semantic IR compiles world fact, agreement, todo and scene domain actions", async () => {
  const old = message(1, "旧的记忆来源");
  const current = message(2, "其实规则改了；约定取消；明天还书；已经到屋顶了");
  const rows = [old, current];
  const compiler = createSemanticCompiler({ sourceRepository: { async getByIds(_u, _p, ids) { return rows.filter((row) => ids.includes(row.id)); } } });
  const cases = [
    {
      targetKey: "worldFacts", proposer: "worldFactProposer", section: "worldFacts",
      seed(state) { state.longTerm.worldFacts.push(item("world:1", "旧规则", old)); },
      change: { action: "correct", ref: "W1", text: "新规则", evidenceMessageIds: [2] },
      expected: { op: "updateItem", itemId: "world:1" },
    },
    {
      targetKey: "standingAgreements", proposer: "agreementProposer", section: "standingAgreements",
      seed(state) { state.working.standingAgreements.push(item("agreement:1", "每天道晚安", old)); },
      change: { action: "cancel", ref: "A1", evidenceMessageIds: [2] },
      expected: { op: "cancelAgreement", itemId: "agreement:1" },
    },
    {
      targetKey: "todos", proposer: "todoProposer", section: "todos",
      seed() {},
      change: { action: "add", text: "还书", actor: "user", requester: "user", dueAt: { mode: "relative", days: 1 }, anchorMessageId: 2, evidenceMessageIds: [2] },
      expected: { op: "addItem" },
    },
    {
      targetKey: "scene", proposer: "currentStateProposer", section: "scene",
      seed() {},
      change: { action: "set", ref: "S-LOCATION", text: "屋顶", evidenceMessageIds: [2] },
      expected: { op: "setField", path: "location" },
    },
  ];

  for (const entry of cases) {
    const state = contracts.createInitialMemoryState();
    entry.seed(state);
    const artifact = buildProposerTaskArtifact({
      state, intent: { targetKey: entry.targetKey, proposer: entry.proposer, cursorBefore: 1 }, messages: [old, current],
      now: "2026-07-22T02:01:00.000Z", userTimeZone: "Asia/Shanghai", taskId: `task-${entry.targetKey}`, tickId: 10,
    });
    const semanticResult = { tickId: 10, proposer: entry.proposer, sectionResults: { [entry.section]: { status: "changes", changes: [entry.change] } } };
    assert.equal(contracts.validateSemanticResult(semanticResult, artifact).ok, true, entry.proposer);
    const compiled = await compiler.compile({ artifact, semanticResult, baseState: state, userId: 7, presetId: "default" });
    const patch = compiled.sectionResults[entry.section].patches[0];
    for (const [key, value] of Object.entries(entry.expected)) assert.equal(patch[key], value, `${entry.proposer}.${key}`);
    assert.deepEqual(patch.sourceRefs, [{ messageId: 2, contentHash: current.contentHash }]);
    if (entry.proposer === "todoProposer") assert.equal(patch.value.dueAt, "2026-07-23T16:00:00.000Z");
  }
});
