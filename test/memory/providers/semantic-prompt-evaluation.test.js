const { createMemoryTestConfig } = require("../support/memory-builders");
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCases, evaluate } = require("../../../scripts/evaluate-memory-v2-semantic-prompts");

function outputFor(fixtureId) {
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
  assert.equal(results.every((result) => result.passed), true);
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
