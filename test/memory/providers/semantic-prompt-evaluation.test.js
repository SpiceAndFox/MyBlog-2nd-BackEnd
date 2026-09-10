const { createMemoryTestConfig } = require("../support/memory-builders");
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCases, evaluate } = require("../../../scripts/evaluate-memory-v2-semantic-prompts");
const { contracts, createSemanticCompiler, domain } = require("../../../modules/memory/admin");

function outputFor(fixtureId) {
  if (fixtureId.startsWith("world-facts-")) {
    const cases = {
      "world-facts-trip-details-remain-noop": [20, { status: "noop" }],
      "world-facts-repeated-trip-across-batches-remains-noop": [21, { status: "noop" }],
      "world-facts-explicit-local-worldview-is-admitted": [22, { status: "changes", changes: [
        { action: "add", text: "镇上的土地只能由居民共同持有，不能私人买卖。", evidenceMessageIds: [10] },
      ] }],
      "world-facts-assistant-reality-boundary-is-admitted": [23, { status: "changes", changes: [
        { action: "add", text: "现实世界与数字空间只能通过文字通信，无法直接触碰。", evidenceMessageIds: [10] },
      ] }],
      "world-facts-old-trip-facts-forgotten-with-unrelated-new-chat": [24, { status: "changes", changes: [
        { action: "forget", ref: "W1", supportRefs: ["W1-E1"] },
        { action: "forget", ref: "W2", supportRefs: ["W2-E1"] },
        { action: "forget", ref: "W3", supportRefs: ["W3-E1"] },
      ] }],
      "world-facts-ambiguous-old-fact-with-missing-evidence-is-not-forgotten": [25, { status: "unable_to_decide" }],
    };
    assert.ok(cases[fixtureId], fixtureId);
    const [tickId, result] = cases[fixtureId];
    return { tickId, proposer: "worldFactProposer", sectionResults: { worldFacts: result } };
  }
  if (fixtureId.startsWith("todo-requester-")) {
    const correction = fixtureId === "todo-requester-incorrect-origin";
    return { tickId: correction ? 8 : fixtureId === "todo-requester-active-confirmation" ? 6 : 7,
      proposer: "todoProposer", sectionResults: { todos: correction
        ? { status: "changes", changes: [{ action: "correct", ref: "T1", requester: "assistant", dueChange: { mode: "keep" }, evidenceMessageIds: [8] }] }
        : { status: "noop" } } };
  }
  if (fixtureId === "profile-reusable-preference-without-permanence-marker") {
    return {
      tickId: 1,
      proposer: "profileRelationshipProposer",
      sectionResults: {
        userProfile: { status: "changes", changes: [{ action: "add", text: "用户偏好自然衔接对话，避免无必要的结尾追问。", evidenceMessageIds: [10] }] },
        assistantProfile: { status: "noop" },
        relationship: { status: "noop" },
      },
    };
  }
  if (fixtureId === "profile-one-off-test-remains-noop") {
    return {
      tickId: 2,
      proposer: "profileRelationshipProposer",
      sectionResults: {
        userProfile: { status: "noop" },
        assistantProfile: { status: "noop" },
        relationship: { status: "noop" },
      },
    };
  }
  if (fixtureId === "profile-explicit-role-end-invalidates-dependent-memory") {
    return {
      tickId: 3,
      proposer: "profileRelationshipProposer",
      sectionResults: {
        userProfile: { status: "changes", changes: [{ action: "correct", ref: "UP1", text: "用户曾以航海船长角色进行 API 测试，但这并非其稳定角色扮演偏好。", evidenceMessageIds: [10] }] },
        assistantProfile: { status: "noop" },
        relationship: { status: "changes", changes: [{ action: "update", ref: "R1", text: "双方曾以船长与大副身份进行测试；当前采用普通对话模式。", evidenceMessageIds: [10] }] },
      },
    };
  }
  if (fixtureId === "profile-long-window-preserves-explicit-style-boundaries") {
    return {
      tickId: 5,
      proposer: "profileRelationshipProposer",
      sectionResults: {
        userProfile: { status: "changes", changes: [{ action: "add", text: "用户偏好简洁自然、不使用模式声明或列表的回复，也不希望结尾主动追问。", evidenceMessageIds: [112, 132, 150] }] },
        assistantProfile: { status: "noop" },
        relationship: { status: "noop" },
      },
    };
  }
  return {
    tickId: 4,
    proposer: "agreementProposer",
    sectionResults: {
      standingAgreements: {
        status: "changes",
        changes: [
          { action: "cancel", ref: "A1", evidenceMessageIds: [10] },
          { action: "cancel", ref: "A2", evidenceMessageIds: [10] },
        ],
      },
    },
  };
}

test("semantic prompt evaluation fixtures are synthetic, valid envelopes with stable expected refs", () => {
  const cases = buildCases(createMemoryTestConfig());
  const byId = new Map(cases.map((fixture) => [fixture.id, fixture]));
  assert.equal(byId.size, cases.length, "fixture ids must be unique");

  for (const fixture of cases.filter(entry => entry.id.startsWith("world-facts-"))) {
    assert.equal(contracts.validateMemoryState(fixture.baseState).ok, true, fixture.id);
    assert.equal(contracts.validateRendererArtifact(fixture.envelope.artifact).ok, true, fixture.id);
    for (const entry of fixture.baseState.longTerm.worldFacts) {
      assert.ok(entry.updatedAtMessageId <= fixture.envelope.task.cursorBefore, "seeded facts must predate the new batch");
    }
  }

  const roleEnd = byId.get("profile-explicit-role-end-invalidates-dependent-memory");
  assert.ok(roleEnd);
  assert.deepEqual(Object.keys(roleEnd.envelope.artifact.refMap.writable), ["UP1", "R1"]);

  const longWindow = byId.get("profile-long-window-preserves-explicit-style-boundaries");
  assert.ok(longWindow);
  assert.deepEqual(Object.keys(longWindow.envelope.artifact.refMap.writable), ["R1"]);
  assert.equal(longWindow.envelope.artifact.publicInput.messages.length, 64);

  const scopedCancellation = byId.get("agreement-role-end-cancels-only-dependent-rules");
  assert.ok(scopedCancellation);
  assert.deepEqual(Object.keys(scopedCancellation.envelope.artifact.refMap.writable), ["A1", "A2", "A3"]);
});

test("semantic prompt evaluator scores capture, noop, invalidation, and scoped cancellation", async () => {
  const cases = buildCases(createMemoryTestConfig());
  let index = 0;
  const adapter = {
    async propose() {
      const fixture = cases[index++];
      return { status: "ok", output: outputFor(fixture.id) };
    },
  };
  const results = await evaluate({ adapter, cases });
  assert.equal(results.every((result) => result.passed), true, JSON.stringify(results.filter(result => !result.passed)));
});

test("semantic prompt evaluator reports over-broad cancellation", async () => {
  const [fixture] = buildCases(createMemoryTestConfig()).slice(-1);
  const output = outputFor(fixture.id);
  output.sectionResults.standingAgreements.changes.push({ action: "cancel", ref: "A3", evidenceMessageIds: [10] });
  const [result] = await evaluate({ adapter: { propose: async () => ({ status: "ok", output }) }, cases: [fixture] });
  assert.equal(result.passed, false);
  assert.match(result.errors.join("\n"), /A3 should remain/);
});

test("requester evaluation rejects swapped origins and fabricated changes while allowing confirmation evidence", () => {
  const cases = buildCases(createMemoryTestConfig()).filter(fixture => fixture.id.startsWith("todo-requester-"));
  assert.equal(cases.length, 3);
  for (const fixture of cases) {
    const valid = outputFor(fixture.id);
    assert.deepEqual(fixture.score(valid), []);
    const correction = fixture.id.endsWith("incorrect-origin");
    const evidence = { ...valid, sectionResults: { todos: { status: "changes", changes: [{
      action: correction ? "correct" : "revise", ref: "T1", requester: "assistant", dueChange: { mode: "keep" }, evidenceMessageIds: [8, 10],
    }] } } };
    assert.deepEqual(fixture.score(evidence), []);
    const wrongOrigin = structuredClone(evidence);
    wrongOrigin.sectionResults.todos.changes[0].requester = "user";
    assert.ok(fixture.score(wrongOrigin).some(error => error.includes("requester")));
    const inventedDate = structuredClone(evidence);
    inventedDate.sectionResults.todos.changes[0].dueChange = { mode: "clear" };
    assert.ok(fixture.score(inventedDate).some(error => error.includes("deadline")));
    assert.ok(fixture.score({ ...valid, sectionResults: { todos: { status: "unable_to_decide" } } }).length);
    if (correction) assert.ok(fixture.score({ ...valid, sectionResults: { todos: { status: "noop" } } }).length);
  }
});

test("worldview cleanup evaluation rejects missed items, over-deletion and unrelated evidence", async () => {
  const fixture = buildCases(createMemoryTestConfig()).find(entry => entry.id === "world-facts-old-trip-facts-forgotten-with-unrelated-new-chat");
  const valid = outputFor(fixture.id);
  const [result] = await evaluate({ adapter: { propose: async () => ({ status: "ok", output: valid }) }, cases: [fixture] });
  assert.equal(result.passed, true);
  assert.deepEqual(fixture.envelope.artifact.publicInput.messages.map(row => row.id), [10, 11]);
  assert.match(fixture.envelope.artifact.publicInput.evidenceText, /W1-E1.*assistant.*message:1/);
  assert.match(fixture.envelope.artifact.publicInput.evidenceText, /W4-E1.*user.*message:4/);

  const missed = structuredClone(valid);
  missed.sectionResults.worldFacts.changes.pop();
  assert.ok(fixture.score(missed).some(error => /W3 should be forgotten/.test(error)));
  const broad = structuredClone(valid);
  broad.sectionResults.worldFacts.changes.push({ action: "forget", ref: "W4", supportRefs: ["W4-E1"] });
  assert.ok(fixture.score(broad).some(error => /W4 should remain/.test(error)));
  const unrelated = structuredClone(valid);
  unrelated.sectionResults.worldFacts.changes[0] = { action: "forget", ref: "W1", evidenceMessageIds: [10] };
  assert.ok(fixture.score(unrelated).some(error => /own historical evidence/.test(error)));
  const wrongHistory = structuredClone(valid);
  wrongHistory.sectionResults.worldFacts.changes[0].supportRefs = ["W2-E1"];
  assert.ok(fixture.score(wrongHistory).some(error => /own historical evidence/.test(error)));
});

test("historical-only worldview forget compiles and removes only rejected items through the real Reducer", async () => {
  const config = createMemoryTestConfig();
  const fixture = buildCases(config).find(entry => entry.id === "world-facts-old-trip-facts-forgotten-with-unrelated-new-chat");
  const semanticResult = outputFor(fixture.id);
  await evaluate({ adapter: { propose: async () => ({ status: "ok", output: semanticResult }) }, cases: [fixture] });
  const before = structuredClone(fixture.baseState);
  const rows = [...fixture.sourceMessages, ...fixture.envelope.artifact.publicInput.messages];
  const compiler = createSemanticCompiler({ sourceReader: {
    async getByIds(_userId, _presetId, ids) { return rows.filter(row => ids.includes(row.id)); },
  } });
  const proposal = await compiler.compile({ artifact: fixture.envelope.artifact, semanticResult, baseState: before,
    userId: 1, presetId: "semantic-prompt-evaluation" });
  assert.deepEqual(proposal.sectionResults.worldFacts.patches.map(patch => [patch.op, patch.itemId, patch.sourceRefs[0].messageId]), [
    ["forgetItem", "world:trip-1", 1], ["forgetItem", "world:trip-2", 2], ["forgetItem", "world:trip-3", 3],
  ]);
  const reduced = domain.reduceCompiledProposal({ state: before, task: fixture.envelope.task, proposal, config });
  assert.equal(reduced.outcome, "committable");
  assert.deepEqual(reduced.state.longTerm.worldFacts, [before.longTerm.worldFacts[3]]);
  assert.deepEqual(before, fixture.baseState, "the input snapshot must not be mutated");
  assert.equal(reduced.state.meta.targetCursors.worldFacts, 11);
  assert.equal(contracts.validateMemoryState(reduced.state).ok, true);
});

test("worldview evaluation rejects new scene facts and deletion based on unavailable history", async () => {
  const fixtures = buildCases(createMemoryTestConfig()).filter(entry => entry.id.startsWith("world-facts-"));
  for (const fixture of fixtures.filter(entry => entry.id.includes("remain"))) {
    const output = outputFor(fixture.id);
    output.sectionResults.worldFacts = { status: "changes", changes: [
      { action: "add", text: "海域有海胆。", evidenceMessageIds: [fixture.envelope.task.targetMessageId] },
    ] };
    assert.ok(fixture.score(output).length);
  }
  const missing = fixtures.find(entry => entry.id.includes("missing-evidence"));
  const [result] = await evaluate({ adapter: { propose: async () => ({ status: "ok", output: outputFor(missing.id) }) }, cases: [missing] });
  assert.equal(result.passed, true);
  assert.equal(missing.envelope.artifact.refMap.readOnly["W1-E1"], undefined);
  const deletion = outputFor(missing.id);
  deletion.sectionResults.worldFacts = { status: "changes", changes: [{ action: "forget", ref: "W1", evidenceMessageIds: [10] }] };
  assert.ok(missing.score(deletion).length);
});

test("worldview admission scoring accepts supported atomic splits but rejects unrelated additions", () => {
  const fixture = buildCases(createMemoryTestConfig()).find(entry => entry.id === "world-facts-assistant-reality-boundary-is-admitted");
  const output = outputFor(fixture.id);
  output.sectionResults.worldFacts.changes.unshift({ action: "add", text: "用户处于现实世界，助手处于数字空间，两者分属不同的现实层级。", evidenceMessageIds: [10] });
  assert.deepEqual(fixture.score(output), []);
  output.sectionResults.worldFacts.changes[0].text = "用户喜欢煮面。";
  assert.ok(fixture.score(output).length);
});
