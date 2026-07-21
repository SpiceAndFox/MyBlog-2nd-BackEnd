const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState, TARGETS } = require("../../modules/memory/contracts");
const { reduceProposal } = require("../../modules/memory/domain");
const { createMemoryTestConfig, sha256: hash, sequence } = require("./support/memory-builders");

const config = createMemoryTestConfig();
function task(targetKey, overrides = {}) {
  return {
    tickId: 1, taskId: "task", userId: 1, presetId: "p", schemaVersion: 2, sourceGeneration: 0, baseRevision: 0,
    targetKey, cursorBefore: 0, targetMessageId: 2, proposer: TARGETS[targetKey].proposer, mode: "normal",
    targetSections: TARGETS[targetKey].sections, observedMessageIds: [2], now: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}
function message(id, role, content, createdAt = "2026-01-01T00:00:00.000Z") {
  return { id, userId: 1, presetId: "p", role, createdAt, contentHash: hash(content), content };
}
function observed(database) { const { userId, presetId, content, ...value } = database; return { ...value, contentKind: "raw", content }; }
function item(id, text, messageId = 1, todo = false, evidenceKind = null) {
  const inferredKind = evidenceKind || (todo ? "user_commitment"
    : id.startsWith("agreement:") || id.startsWith("standingAgreements:") ? "standing_agreement"
      : id.startsWith("milestones:") ? "relationship_milestone" : "long_term_fact");
  const value = { id, text, evidenceGroups: [{ evidenceKind: inferredKind, refs: [{ messageId, contentHash: hash(text), quote: text }] }], createdAtMessageId: messageId, updatedAtMessageId: messageId };
  return todo ? { ...value, actor: "user", requester: "user", status: "active", becameOverdueAt: null, dueAt: null } : value;
}
function profileProposal(userProfile) {
  return { sectionResults: {
    userProfile,
    assistantProfile: { status: "noop" },
    relationship: { status: "noop" },
  } };
}

test("ordinary rejected and noop proposals still yield a cursor-only revision", () => {
  const database = message(2, "user", "只是普通的一天，没有里程碑");
  const state = createInitialMemoryState();
  const rejectedResult = reduceProposal({
    state, task: task("episodes"), observedMessages: [observed(database)], databaseMessages: [database], config,
    proposal: { sectionResults: {
      recentEpisodes: { status: "noop" },
      milestones: { status: "patches", patches: [{ op: "addItem", value: { text: "普通一天" }, evidenceKind: "recent_episode", evidenceRefs: [{ messageId: 2, quote: "普通的一天" }] }] },
    } }, idFactory: sequence("patch"),
  });
  assert.deepEqual(rejectedResult.events.map((event) => event.decision), ["noop", "rejected"]);
  assert.equal(rejectedResult.events[1].rejectReason, "policy_not_allowed");
  assert.equal(rejectedResult.state.meta.revision, 1);
  assert.equal(rejectedResult.state.meta.targetCursors.episodes, 2);
});

test("role mismatches are rejected before policy application", () => {
  const database = message(2, "assistant", "请忘记我的旧名字");
  const state = createInitialMemoryState();
  state.longTerm.worldFacts.push(item("worldFact:old", "旧名字"));
  const result = reduceProposal({ state, task: task("worldFacts"), observedMessages: [observed(database)], databaseMessages: [database], config,
    proposal: { sectionResults: { worldFacts: { status: "patches", patches: [{ op: "forgetItem", itemId: "worldFact:old", evidenceKind: "user_forget", evidenceRefs: [{ messageId: 2, quote: "忘记我的旧名字" }] }] } } }, idFactory: sequence("patch") });
  assert.equal(result.events[0].rejectReason, "evidence_role_mismatch");
  assert.equal(result.state.longTerm.worldFacts.length, 1);
});

test("scene patches that exceed the semantic character budget are rejected without maintenance", () => {
  const database = message(2, "user", "我们现在位于非常非常遥远的屋顶");
  const state = createInitialMemoryState();
  const tight = { ...config, scene: { ...config.scene, maxRenderedChars: 4 } };
  const result = reduceProposal({
    state,
    task: task("scene"),
    observedMessages: [observed(database)],
    databaseMessages: [database],
    config: tight,
    proposal: { sectionResults: { scene: { status: "patches", patches: [
      { op: "setField", path: "location", value: "非常遥远的屋顶", evidenceKind: "scene_change", evidenceRefs: [{ messageId: 2, quote: "非常非常遥远的屋顶" }] },
    ] } } },
    idFactory: sequence("patch"),
  });
  assert.equal(result.outcome, "committable");
  assert.equal(result.events[0].decision, "rejected");
  assert.equal(result.events[0].rejectReason, "capacity_exceeded");
  assert.equal(result.state.current.scene.location.value, null);
  assert.equal(result.state.meta.targetCursors.scene, 2);
});

test("correction preserves item identity and appends evidence without suppression", () => {
  const database = message(2, "user", "更正一下，我住在上海");
  const state = createInitialMemoryState();
  state.longTerm.worldFacts.push(item("worldFact:home", "住在北京"));
  const result = reduceProposal({ state, task: task("worldFacts"), observedMessages: [observed(database)], databaseMessages: [database], config,
    proposal: { sectionResults: { worldFacts: { status: "patches", patches: [{ op: "updateItem", itemId: "worldFact:home", value: { text: "住在上海" }, evidenceKind: "user_correction", evidenceRefs: [{ messageId: 2, quote: "我住在上海" }] }] } } }, idFactory: sequence("patch") });
  const updated = result.state.longTerm.worldFacts[0];
  assert.equal(updated.id, "worldFact:home");
  assert.equal(updated.evidenceGroups.length, 2);
  assert.deepEqual(result.tombstones, []);
});

test("scene correction replaces the active field without suppression", () => {
  const database = message(2, "user", "更正一下，我们在上海");
  const state = createInitialMemoryState();
  state.current.scene.location = { value: "北京", evidenceRef: { messageId: 1, contentHash: hash("我们在北京"), quote: "我们在北京" }, updatedAtMessageId: 1 };
  const result = reduceProposal({
    state, task: task("scene"), observedMessages: [observed(database)], databaseMessages: [database], config,
    proposal: { sectionResults: { scene: { status: "patches", patches: [{
      op: "setField", path: "location", value: "上海", evidenceKind: "user_correction",
      evidenceRefs: [{ messageId: 2, quote: "我们在上海" }],
    }] } } }, idFactory: sequence("patch"),
  });
  assert.equal(result.state.current.scene.location.value, "上海");
  assert.deepEqual(result.tombstones, []);
});

test("capacity violation atomically defers the triggering patch", () => {
  const database = message(2, "user", "我们约定以后不冷战");
  const state = createInitialMemoryState();
  state.working.standingAgreements.push(item("agreement:1", "先说明情绪"));
  const tight = { ...config, sectionBudgets: { ...config.sectionBudgets, standingAgreements: { maxItems: 1, maxRenderedChars: 2000 } } };
  const result = reduceProposal({ state, task: task("standingAgreements"), observedMessages: [observed(database)], databaseMessages: [database], config: tight,
    proposal: { sectionResults: { standingAgreements: { status: "patches", patches: [{ op: "addItem", value: { text: "不冷战" }, evidenceKind: "standing_agreement", evidenceRefs: [{ messageId: 2, quote: "约定以后不冷战" }] }] } } }, idFactory: sequence("patch", "2") });
  assert.equal(result.outcome, "deferred");
  assert.equal(result.events[0].decision, "deferred");
  assert.equal(result.capacityViolation.dimension, "maxItems");
  assert.deepEqual(result.state, state);
  assert.equal(result.snapshot, null);
});

test("overdue todo can only revive through a future set dueChange", () => {
  const database = message(2, "user", "改到明天再去赴约");
  const state = createInitialMemoryState();
  state.working.todos.push({ ...item("todo:1", "赴约", 1, true), status: "overdue", becameOverdueAt: "2025-12-31T00:00:00.000Z", dueAt: "2025-12-31T00:00:00.000Z" });
  const patch = { op: "updateItem", itemId: "todo:1", value: { dueChange: { mode: "set", dueAt: { mode: "relative", days: 1 } } }, evidenceKind: "user_correction", evidenceRefs: [{ messageId: 2, quote: "明天再去赴约" }] };
  const result = reduceProposal({ state, task: task("todos"), observedMessages: [observed(database)], databaseMessages: [database], config, proposal: { sectionResults: { todos: { status: "patches", patches: [patch] } } }, idFactory: sequence("patch") });
  assert.equal(result.state.working.todos[0].status, "active");
  assert.equal(result.state.working.todos[0].becameOverdueAt, null);
  assert.equal(result.cleanupEvents[0].cleanupKind, "todo_revived_from_overdue");
  assert.equal(result.cleanupEvents[0].decision, "system_cleanup");
});

test("every terminal todo operation can resolve an overdue item", () => {
  for (const [op, evidenceKind] of [
    ["completeTodo", "todo_completion"],
    ["cancelTodo", "todo_cancel"],
    ["expireTodo", "todo_expiration"],
  ]) {
    const content = `处理逾期待办 ${op}`;
    const database = message(2, "user", content);
    const state = createInitialMemoryState();
    state.working.todos.push({
      ...item(`todo:${op}`, "逾期待办", 1, true),
      status: "overdue",
      dueAt: "2025-12-31T00:00:00.000Z",
      becameOverdueAt: "2025-12-31T00:00:00.000Z",
    });
    const result = reduceProposal({
      state,
      task: task("todos"),
      observedMessages: [observed(database)],
      databaseMessages: [database],
      config,
      proposal: { sectionResults: { todos: { status: "patches", patches: [{
        op,
        itemId: `todo:${op}`,
        evidenceKind,
        evidenceRefs: [{ messageId: 2, quote: content }],
      }] } } },
      idFactory: sequence(`patch-${op}`),
    });
    assert.equal(result.events[0].decision, "accepted", op);
    assert.equal(result.state.working.todos.length, 0, op);
  }
});

test("terminal field, todo, and agreement operations are applied, not merely schema-accepted", () => {
  const cases = [
    { targetKey: "scene", section: "scene", op: "clearField", evidenceKind: "user_correction", path: "location", seed(state) {
      state.current.scene.location = { value: "旧地点", evidenceRef: { messageId: 1, contentHash: hash("旧地点"), quote: "旧地点" }, updatedAtMessageId: 1 };
    }, assertState(state) { assert.equal(state.current.scene.location.value, null); } },
    { targetKey: "todos", section: "todos", op: "completeTodo", evidenceKind: "todo_completion", itemId: "todo:complete", seed(state) { state.working.todos.push(item("todo:complete", "已完成", 1, true)); }, assertState(state) { assert.equal(state.working.todos.length, 0); } },
    { targetKey: "todos", section: "todos", op: "cancelTodo", evidenceKind: "todo_cancel", itemId: "todo:cancel", seed(state) { state.working.todos.push(item("todo:cancel", "已取消", 1, true)); }, assertState(state) { assert.equal(state.working.todos.length, 0); } },
    { targetKey: "todos", section: "todos", op: "expireTodo", evidenceKind: "todo_expiration", itemId: "todo:expire", seed(state) { state.working.todos.push({ ...item("todo:expire", "已失效", 1, true), dueAt: "2026-02-01T00:00:00.000Z" }); }, assertState(state) { assert.equal(state.working.todos.length, 0); } },
    { targetKey: "standingAgreements", section: "standingAgreements", op: "cancelAgreement", evidenceKind: "agreement_cancel", itemId: "agreement:cancel", seed(state) { state.working.standingAgreements.push(item("agreement:cancel", "旧约定", 1)); }, assertState(state) { assert.equal(state.working.standingAgreements.length, 0); } },
  ];
  for (const entry of cases) {
    const content = `执行 ${entry.op}`;
    const database = message(2, "user", content);
    const state = createInitialMemoryState();
    entry.seed(state);
    const patch = {
      op: entry.op,
      ...(entry.path ? { path: entry.path } : { itemId: entry.itemId }),
      evidenceKind: entry.evidenceKind,
      evidenceRefs: [{ messageId: 2, quote: content }],
    };
    const result = reduceProposal({
      state, task: task(entry.targetKey), observedMessages: [observed(database)], databaseMessages: [database], config,
      proposal: { sectionResults: { [entry.section]: { status: "patches", patches: [patch] } } },
      idFactory: sequence(`patch-${entry.op}`),
    });
    assert.equal(result.events[0].decision, "accepted", entry.op);
    assert.equal(result.events[0].op, entry.op);
    entry.assertState(result.state);
  }
});

test("maintenance merge is accepted for every compactable item section", () => {
  for (const section of ["todos", "standingAgreements", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"]) {
    const state = createInitialMemoryState();
    const targetKey = Object.entries(TARGETS).find(([, target]) => target.sections.includes(section))[0];
    section === "todos" || section === "standingAgreements" ? state.working[section].push(item(`${section}:1`, "甲", 1, section === "todos"), item(`${section}:2`, "乙", 2, section === "todos")) : state.longTerm[section].push(item(`${section}:1`, "甲", 1), item(`${section}:2`, "乙", 2));
    const maintenanceTask = task(targetKey, { mode: "maintenance", proposer: "compactionProposer", targetSections: [section], observedMessageIds: [], cursorBefore: undefined, targetMessageId: 2 });
    const result = reduceProposal({ state, task: maintenanceTask, observedMessages: [], databaseMessages: [], config,
      proposal: { sectionResults: { [section]: { status: "patches", patches: [{ op: "mergeItems", itemIds: [`${section}:1`, `${section}:2`], value: { text: "甲乙" }, evidenceKind: "memory_compaction" }] } } }, idFactory: sequence("patch", "merged") });
    assert.equal(result.events[0].decision, "accepted", section);
    assert.deepEqual(result.events[0].mergedFromItemIds, [`${section}:1`, `${section}:2`]);
    assert.equal(result.events[0].resultItemId.endsWith(":merged"), true);
  }
});

test("profile compaction preserves compatible typed metadata deterministically", () => {
  const state = createInitialMemoryState();
  state.longTerm.userProfile.push(
    { ...item("userProfile:1", "边界: 避免连续追问", 1), facet: "communicationBoundary", canonicalKey: "open", factBasis: "observedPattern" },
    { ...item("userProfile:2", "偏好: 不要连续追问", 2), facet: "communicationBoundary", canonicalKey: "open", factBasis: "explicit" },
  );
  const maintenanceTask = task("profileRelationship", {
    mode: "maintenance", proposer: "compactionProposer", targetSections: ["userProfile"],
    observedMessageIds: [], cursorBefore: undefined,
  });
  const result = reduceProposal({
    state, task: maintenanceTask, observedMessages: [], databaseMessages: [], config,
    proposal: { sectionResults: { userProfile: { status: "patches", patches: [{
      op: "mergeItems", itemIds: ["userProfile:1", "userProfile:2"],
      value: { text: "沟通边界: 避免连续追问" }, evidenceKind: "memory_compaction",
    }] } } }, idFactory: sequence("patch", "merged"),
  });
  assert.equal(result.events[0].decision, "accepted");
  assert.deepEqual(
    (({ facet, canonicalKey, factBasis }) => ({ facet, canonicalKey, factBasis }))(result.state.longTerm.userProfile[0]),
    { facet: "communicationBoundary", canonicalKey: "open", factBasis: "explicit" },
  );
});

test("normal patches cannot be justified only by overlap context", () => {
  const oldMessage = message(1, "user", "请不要使用列表");
  const newMessage = message(2, "user", "继续刚才的话题");
  const result = reduceProposal({
    state: createInitialMemoryState(),
    task: task("profileRelationship", { cursorBefore: 1, observedMessageIds: [1, 2] }),
    observedMessages: [observed(oldMessage), observed(newMessage)], databaseMessages: [oldMessage, newMessage], config,
    proposal: profileProposal({ status: "patches", patches: [{
      op: "addItem",
      value: { text: "边界: 禁止列表格式回复", facet: "communicationBoundary", canonicalKey: "responseFormat", factBasis: "explicit" },
      evidenceKind: "long_term_fact", evidenceRefs: [{ messageId: 1, quote: "不要使用列表" }],
    }] }),
    idFactory: sequence("patch"),
  });
  assert.equal(result.events[0].decision, "rejected");
  assert.equal(result.events[0].rejectReason, "overlap_only_evidence");
  assert.equal(result.state.longTerm.userProfile.length, 0);
});

test("typed profile add rejects exact text and canonical-key duplicates", () => {
  const database = message(2, "user", "再次强调，请绝对不要用列表格式回复");
  for (const [value, expected] of [
    [{ text: "边界: 禁止列表格式回复", facet: "communicationBoundary", canonicalKey: "open", factBasis: "explicit" }, "duplicate_item"],
    [{ text: "偏好纯文本段落回复", facet: "communicationBoundary", canonicalKey: "responseFormat", factBasis: "explicit" }, "duplicate_profile_key"],
  ]) {
    const state = createInitialMemoryState();
    state.longTerm.userProfile.push({
      ...item("userProfile:format", "边界: 禁止列表格式回复"),
      facet: "communicationBoundary", canonicalKey: "responseFormat", factBasis: "explicit",
    });
    const result = reduceProposal({
      state, task: task("profileRelationship"), observedMessages: [observed(database)], databaseMessages: [database], config,
      proposal: profileProposal({ status: "patches", patches: [{
        op: "addItem", value, evidenceKind: "long_term_fact", evidenceRefs: [{ messageId: 2, quote: "不要用列表格式回复" }],
      }] }), idFactory: sequence("patch"),
    });
    assert.equal(result.events[0].rejectReason, expected);
    assert.equal(result.state.longTerm.userProfile.length, 1);
  }
});

test("observed profile patterns require three messages and persist typed metadata", () => {
  const first = message(1, "user", "这个问题请认真回答");
  const second = message(2, "user", "我希望技术问题保持严肃");
  const third = message(3, "user", "技术细节还是请严谨一点");
  const patch = {
    op: "addItem",
    value: { text: "偏好: 技术讨论保持严肃", facet: "communicationBoundary", canonicalKey: "topicSeriousness", factBasis: "observedPattern" },
    evidenceKind: "long_term_fact",
  };
  const run = (evidenceRefs) => reduceProposal({
    state: createInitialMemoryState(),
    task: task("profileRelationship", { cursorBefore: 2, targetMessageId: 3, observedMessageIds: [1, 2, 3] }),
    observedMessages: [observed(first), observed(second), observed(third)], databaseMessages: [first, second, third], config,
    proposal: profileProposal({ status: "patches", patches: [{ ...patch, evidenceRefs }] }),
    idFactory: sequence("patch", "item"),
  });
  const rejected = run([
    { messageId: 1, quote: "问题请认真回答" },
    { messageId: 3, quote: "技术细节还是请严谨一点" },
  ]);
  assert.equal(rejected.events[0].rejectReason, "insufficient_pattern_evidence");
  const accepted = run([
    { messageId: 1, quote: "问题请认真回答" },
    { messageId: 2, quote: "技术问题保持严肃" },
    { messageId: 3, quote: "技术细节还是请严谨一点" },
  ]);
  assert.equal(accepted.events[0].decision, "accepted");
  assert.deepEqual(
    (({ facet, canonicalKey, factBasis }) => ({ facet, canonicalKey, factBasis }))(accepted.state.longTerm.userProfile[0]),
    { facet: "communicationBoundary", canonicalKey: "topicSeriousness", factBasis: "observedPattern" },
  );
});
