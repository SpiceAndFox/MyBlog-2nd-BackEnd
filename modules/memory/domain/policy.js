const POLICY = Object.freeze({
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
  worldFacts: {}, userProfile: {}, assistantProfile: {}, relationship: {},
});

for (const section of ["worldFacts", "userProfile", "assistantProfile", "relationship"]) {
  POLICY[section].addItem = ["long_term_fact"];
  POLICY[section].updateItem = ["user_correction", "assistant_correction"];
  POLICY[section].forgetItem = ["user_forget", "assistant_forget"];
  POLICY[section].mergeItems = ["memory_compaction"];
  Object.freeze(POLICY[section]);
}
Object.values(POLICY).forEach((sectionPolicy) => {
  Object.values(sectionPolicy).forEach(Object.freeze);
  Object.freeze(sectionPolicy);
});

function isPolicyAllowed(section, op, evidenceKind) {
  return POLICY[section]?.[op]?.includes(evidenceKind) === true;
}

module.exports = { POLICY, isPolicyAllowed };
