const test = require("node:test");
const assert = require("node:assert/strict");
const { POLICY, isPolicyAllowed } = require("../../modules/memory/domain/policy");

const expectedPolicy = {
  scene: {
    setField: ["scene_change", "user_correction", "assistant_correction"],
    clearField: ["scene_change", "user_correction", "assistant_correction"],
  },
  todos: {
    addItem: ["user_request", "user_commitment", "assistant_request", "assistant_commitment"],
    updateItem: ["user_request", "user_commitment", "assistant_request", "assistant_commitment", "user_correction", "assistant_correction"],
    mergeItems: ["memory_compaction"],
    completeTodo: ["todo_completion"],
    cancelTodo: ["todo_cancel", "user_correction", "assistant_correction"],
    expireTodo: ["todo_expiration"],
  },
  standingAgreements: {
    addItem: ["standing_agreement"],
    updateItem: ["standing_agreement", "user_correction", "assistant_correction"],
    mergeItems: ["memory_compaction"],
    cancelAgreement: ["agreement_cancel", "user_correction", "assistant_correction"],
  },
  recentEpisodes: {
    addItem: ["recent_episode"],
    updateItem: ["recent_episode", "user_correction", "assistant_correction"],
  },
  milestones: {
    addItem: ["relationship_milestone"],
    updateItem: ["user_correction", "assistant_correction"],
    mergeItems: ["memory_compaction"],
  },
};

for (const section of ["worldFacts", "userProfile", "assistantProfile", "relationship"]) {
  expectedPolicy[section] = {
    addItem: ["long_term_fact"],
    updateItem: ["user_correction", "assistant_correction"],
    forgetItem: ["user_forget", "assistant_forget"],
    mergeItems: ["memory_compaction"],
  };
}

test("policy table exactly matches the documented section × op × evidenceKind matrix", () => {
  assert.deepEqual(POLICY, expectedPolicy);
  for (const [section, operations] of Object.entries(expectedPolicy)) {
    for (const [op, evidenceKinds] of Object.entries(operations)) {
      for (const evidenceKind of evidenceKinds) assert.equal(isPolicyAllowed(section, op, evidenceKind), true, `${section}.${op}.${evidenceKind}`);
    }
  }
});

test("policy lookup rejects unknown combinations by default", () => {
  assert.equal(isPolicyAllowed("milestones", "addItem", "recent_episode"), false);
  assert.equal(isPolicyAllowed("recentEpisodes", "mergeItems", "memory_compaction"), false);
  assert.equal(isPolicyAllowed("todos", "forgetItem", "user_forget"), false);
  assert.equal(isPolicyAllowed("working", "addItem", "long_term_fact"), false);
  assert.equal(isPolicyAllowed("worldFacts", "updateItem", "long_term_fact"), false);
});
