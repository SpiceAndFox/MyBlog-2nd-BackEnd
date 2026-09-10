const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInitialMemoryState,
  validateLibrarianSemanticResult,
} = require("../../../modules/memory/contracts");
const {
  compileLibrarianProposal,
  reduceLibrarianProposal,
} = require("../../../modules/memory/domain/librarian");
const { buildLibrarianEnvelope } = require("../../../modules/memory/application/librarianRenderer");
const { mapEventToRow } = require("../../../modules/memory/application/eventMapper");
const { replayEventGroups } = require("../../../modules/memory/domain/eventReplay");
const { createMemoryTestConfig, sha256, sequence } = require("../support/memory-builders");

const LIBRARIAN_INTERVAL_TURNS = 96;

function item(id, text, messageIds) {
  return {
    id,
    text,
    sourceRefs: messageIds.map((messageId) => ({ messageId, contentHash: sha256(`${id}:${messageId}`) })),
    createdAtMessageId: Math.min(...messageIds),
    updatedAtMessageId: Math.max(...messageIds),
  };
}

function fixture() {
  const state = createInitialMemoryState();
  state.meta.revision = 4;
  state.working.standingAgreements.push(item("agreement:1", "以后回答保持简洁。", [1]));
  state.longTerm.worldFacts.push(item("worldFact:1", "用户偏好简洁回答。", [2]));
  state.longTerm.userProfile.push(item("userProfile:1", "用户偏好简洁回答。", [3]));
  state.longTerm.assistantProfile.push(item("assistantProfile:1", "助手保持直接而温和。", [4]));
  state.longTerm.relationship.push(item("relationship:1", "双方是长期写作搭档。", [4]));
  const envelope = buildLibrarianEnvelope({ config: createMemoryTestConfig(),
    userId: 1,
    presetId: "default",
    state,
    boundaryMessageId: 4,
    watermarkOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
    now: "2026-07-26T00:00:00.000Z",
    userTimeZone: "Asia/Shanghai",
    taskId: "librarian-task",
    tickId: 7,
  });
  return { state, envelope };
}

test("Librarian Renderer exposes every allowed section as writable without persistence metadata", () => {
  const { envelope } = fixture();
  assert.deepEqual(envelope.artifact.publicInput.messages, []);
  assert.equal(envelope.artifact.publicInput.memoryText.includes("agreement:1"), false);
  assert.equal(envelope.artifact.publicInput.memoryText.includes("sha256:"), false);
  assert.equal(Object.keys(envelope.artifact.refMap.readOnly).length, 5);
  assert.equal(Object.keys(envelope.artifact.refMap.writable).length, 5);
  for (const ref of ["A1", "W1", "UP1", "AP1", "R1"]) {
    assert.match(envelope.artifact.publicInput.memoryText, new RegExp(`${ref} \\|`));
    assert.ok(envelope.artifact.refMap.writable[ref]);
  }
  assert.equal(envelope.task.cursorBefore, undefined);
  assert.equal(envelope.task.targetMessageId, undefined);
});

test("Librarian validates conflicts before compilation", () => {
  const { envelope } = fixture();
  const result = {
    tickId: 7,
    proposer: "librarianProposer",
    status: "changes",
    operations: [
      { action: "move", ref: "W1", toSection: "userProfile" },
      { action: "merge", refs: ["W1", "UP1"], supportRefs: ["UP1-E1"], toSection: "userProfile", text: "用户偏好简洁回答。" },
    ],
  };
  const validation = validateLibrarianSemanticResult(result, envelope.artifact);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.map((entry) => entry.message).join(" "), /more than one/);
});

test("Librarian validates target-specific text limits before compilation", () => {
  const { envelope } = fixture();
  const result = {
    tickId: 7,
    proposer: "librarianProposer",
    status: "changes",
    operations: [{
      action: "merge",
      refs: ["W1", "UP1"], supportRefs: ["UP1-E1"],
      toSection: "userProfile",
      text: "长".repeat(201),
    }],
  };
  const validation = validateLibrarianSemanticResult(result, envelope.artifact);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, [{
    path: "$.operations[0].text",
    message: "must contain at most 200 Unicode characters",
  }]);
});

test("Librarian merge is cross-section, provenance preserving, and revision atomic", () => {
  const { state, envelope } = fixture();
  const semanticResult = {
    tickId: 7,
    proposer: "librarianProposer",
    status: "changes",
    operations: [
      { action: "merge", refs: ["W1", "UP1"], supportRefs: ["UP1-E1"], toSection: "userProfile", text: "用户偏好简洁回答。" },
    ],
  };
  const proposal = compileLibrarianProposal({ artifact: envelope.artifact, semanticResult, baseState: state });
  const reduction = reduceLibrarianProposal({
    state,
    task: envelope.task,
    proposal,
    config: createMemoryTestConfig(),
    idFactory: sequence("merged"),
  });
  assert.equal(reduction.outcome, "committable");
  assert.equal(state.meta.revision, 4);
  assert.equal(reduction.state.meta.revision, 5);
  assert.equal(reduction.state.longTerm.worldFacts.length, 0);
  assert.equal(reduction.state.longTerm.userProfile.length, 1);
  assert.equal(reduction.state.longTerm.userProfile[0].id, "userProfile:merged");
  assert.deepEqual(reduction.state.longTerm.userProfile[0].sourceRefs.map((ref) => ref.messageId), [3]);
  assert.equal(reduction.events[0].normalizedOperation.sources.length, 2);
});

test("Librarian dropDuplicate preserves keeper identity/text/creation and evidence unchanged", () => {
  const { state, envelope } = fixture();
  const semanticResult = {
    tickId: 7,
    proposer: "librarianProposer",
    status: "changes",
    operations: [
      { action: "remove", ref: "W1", keeperRef: "UP1", reason: "duplicate" },
    ],
  };
  const proposal = compileLibrarianProposal({ artifact: envelope.artifact, semanticResult, baseState: state });
  const reduction = reduceLibrarianProposal({ state, task: envelope.task, proposal, config: createMemoryTestConfig() });
  const keeper = reduction.state.longTerm.userProfile[0];
  assert.equal(keeper.id, "userProfile:1");
  assert.equal(keeper.text, "用户偏好简洁回答。");
  assert.equal(keeper.createdAtMessageId, 3);
  assert.equal(keeper.updatedAtMessageId, 3);
  assert.deepEqual(keeper.sourceRefs.map((ref) => ref.messageId), [3]);
});

test("Librarian rejects the whole proposal when a target section exceeds capacity", () => {
  const { state, envelope } = fixture();
  const semanticResult = {
    tickId: 7,
    proposer: "librarianProposer",
    status: "changes",
    operations: [{ action: "move", ref: "W1", toSection: "userProfile" }],
  };
  const proposal = compileLibrarianProposal({ artifact: envelope.artifact, semanticResult, baseState: state });
  const config = createMemoryTestConfig();
  config.sectionBudgets.userProfile = { maxItems: 1, maxRenderedChars: 2000 };
  assert.throws(
    () => reduceLibrarianProposal({ state, task: envelope.task, proposal, config }),
    (error) => error.code === "MEMORY_LIBRARIAN_PROPOSAL_INVALID" && error.reason === "capacity_exceeded",
  );
  assert.equal(state.longTerm.worldFacts.length, 1);
  assert.equal(state.longTerm.userProfile.length, 1);
  assert.equal(state.meta.revision, 4);
});

test("Librarian normalized events deterministically replay a cross-section revision", () => {
  const { state, envelope } = fixture();
  const semanticResult = {
    tickId: 7,
    proposer: "librarianProposer",
    status: "changes",
    operations: [{ action: "move", ref: "W1", toSection: "userProfile" }],
  };
  const proposal = compileLibrarianProposal({ artifact: envelope.artifact, semanticResult, baseState: state });
  const reduction = reduceLibrarianProposal({ state, task: envelope.task, proposal, config: createMemoryTestConfig() });
  const group = {
    event_group_id: "group-1",
    user_id: 1,
    preset_id: "default",
    task_id: "librarian-task",
    target_key: "librarian",
    source_generation: 0,
    schema_version: "2.01",
    base_revision: 4,
    result_revision: 5,
    cursor_before: null,
    cursor_after: null,
    group_kind: "maintenance",
  };
  const events = reduction.events.map((event, index) => mapEventToRow(event, envelope, "group-1", index));
  assert.deepEqual(replayEventGroups(state, [group], events, { userId: 1, presetId: "default" }), reduction.state);
});

function runOperation(f, operations) {
  const semanticResult = { tickId: f.envelope.task.tickId, proposer: "librarianProposer", status: "changes", operations };
  const proposal = compileLibrarianProposal({ artifact: f.envelope.artifact, semanticResult, baseState: f.state });
  return reduceLibrarianProposal({ state: f.state, task: f.envelope.task, proposal, config: createMemoryTestConfig(), idFactory: sequence("one", "two", "three") });
}
function verifyReplay(f, reduction) {
  const group = { event_group_id: "group", user_id: 1, preset_id: "default", task_id: "librarian-task", target_key: "librarian", source_generation: 0, schema_version: "2.01", base_revision: 4, result_revision: 5, cursor_before: null, cursor_after: null, group_kind: "maintenance" };
  assert.deepEqual(replayEventGroups(f.state, [group], reduction.events.map((event, i) => mapEventToRow(event, f.envelope, "group", i)), { userId: 1, presetId: "default" }), reduction.state);
}
for (const action of ["revise", "correct"]) {
  test("Librarian " + action + " replaces evidence and replays without changing identity", () => {
    const f = fixture();
    const reduction = runOperation(f, [{ action, ref: "W1", text: "用户当前偏好短回答。", supportRefs: ["UP1-E1"] }]);
    const item = reduction.state.longTerm.worldFacts[0];
    assert.deepEqual(item.sourceRefs, f.state.longTerm.userProfile[0].sourceRefs);
    assert.equal(item.createdAtMessageId, 2);
    assert.equal(item.updatedAtMessageId, 4);
    assert.equal(item.id, "worldFact:1");
    verifyReplay(f, reduction);
  });
}
test("same-section split selects evidence independently and records new creation boundaries", () => {
  const f = fixture();
  const original = f.state.longTerm.userProfile[0];
  original.text = "用户在杭州工作；用户喜欢绘画。";
  original.sourceRefs = [original.sourceRefs[0], { messageId: 4, contentHash: sha256("painting") }];
  original.updatedAtMessageId = 4;
  f.envelope = buildLibrarianEnvelope({ config: createMemoryTestConfig(), ...f.envelope.task, state: f.state });
  const reduction = runOperation(f, [{ action: "split", ref: "UP1", parts: [
    { toSection: "userProfile", text: "用户在杭州工作。", supportRefs: ["UP1-E1"] },
    { toSection: "userProfile", text: "用户喜欢绘画。", supportRefs: ["UP1-E2"] },
  ] }]);
  assert.deepEqual(reduction.state.longTerm.userProfile.map(item => item.sourceRefs.map(ref => ref.messageId)), [[3], [4]]);
  assert.ok(reduction.state.longTerm.userProfile.every(item => item.createdAtMessageId === 4 && item.updatedAtMessageId === 4));
  assert.equal(f.state.longTerm.userProfile.length, 1);
  verifyReplay(f, reduction);
});
test("merge and duplicate removal replay with bounded explicit evidence", () => {
  for (const operation of [
    { action: "merge", refs: ["W1", "UP1"], toSection: "userProfile", text: "用户偏好简洁回答。", supportRefs: ["UP1-E1"] },
    { action: "remove", ref: "W1", keeperRef: "UP1", reason: "duplicate" },
  ]) {
    const f = fixture(); const reduction = runOperation(f, [operation]);
    assert.equal(reduction.state.longTerm.userProfile[0].sourceRefs.length, 1);
    if (operation.action === "remove") assert.deepEqual(reduction.state.longTerm.userProfile[0], f.state.longTerm.userProfile[0]);
    verifyReplay(f, reduction);
  }
});
test("Librarian rejects foreign evidence, unsupported removal and overlong move atomically", () => {
  const f = fixture(); const before = structuredClone(f.state);
  assert.throws(() => runOperation(f, [{ action: "merge", refs: ["W1", "UP1"], toSection: "userProfile", text: "合并", supportRefs: ["AP1-E1"] }]), /evidence_owner_invalid/);
  assert.throws(() => runOperation(f, [{ action: "remove", ref: "W1", keeperRef: "UP1", reason: "unsupported_section" }]), /semantic_schema_invalid/);
  f.state.longTerm.worldFacts[0].text = "长".repeat(201);
  const invalidBefore = structuredClone(f.state);
  assert.throws(() => runOperation(f, [{ action: "move", ref: "W1", toSection: "userProfile" }]), /text_length_exceeded/);
  assert.deepEqual(f.state, invalidBefore);
  f.state.longTerm.worldFacts[0].text = before.longTerm.worldFacts[0].text;
  assert.deepEqual(f.state, before);
});
test("Librarian reports do not mutate memory and stale revision cannot commit", () => {
  const f = fixture();
  const semanticResult = { tickId: 7, proposer: "librarianProposer", status: "noop", operations: [], reports: [{ ref: "W1", reason: "unsupported_section" }] };
  const proposal = compileLibrarianProposal({ artifact: f.envelope.artifact, semanticResult, baseState: f.state });
  assert.deepEqual(reduceLibrarianProposal({ state: f.state, task: f.envelope.task, proposal, config: createMemoryTestConfig() }).state, f.state);
  f.state.meta.revision++;
  assert.throws(() => runOperation(f, [{ action: "move", ref: "W1", toSection: "userProfile" }]), /revision_mismatch/);
});
