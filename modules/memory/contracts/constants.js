const SCHEMA_VERSION = 2;

const SECTIONS = Object.freeze([
  "scene",
  "todos",
  "standingAgreements",
  "recentEpisodes",
  "milestones",
  "worldFacts",
  "userProfile",
  "assistantProfile",
  "relationship",
]);

const TARGETS = Object.freeze({
  scene: { proposer: "currentStateProposer", sections: ["scene"] },
  todos: { proposer: "todoProposer", sections: ["todos"] },
  standingAgreements: { proposer: "agreementProposer", sections: ["standingAgreements"] },
  episodes: { proposer: "episodeProposer", sections: ["recentEpisodes", "milestones"] },
  profileRelationship: {
    proposer: "profileRelationshipProposer",
    sections: ["userProfile", "assistantProfile", "relationship"],
  },
  worldFacts: { proposer: "worldFactProposer", sections: ["worldFacts"] },
});

const TARGET_KEYS = Object.freeze(Object.keys(TARGETS));
const SEMANTIC_NORMAL_PROPOSERS = Object.freeze([
  "episodeProposer",
  "profileRelationshipProposer",
]);
const SCENE_FIELDS = Object.freeze(["location", "time", "mood", "note"]);
const ITEM_SECTIONS = Object.freeze(SECTIONS.filter((section) => section !== "scene"));
const TYPED_PROFILE_SECTIONS = Object.freeze(["userProfile", "assistantProfile", "relationship"]);
const PROFILE_FACT_BASES = Object.freeze(["explicit", "observedPattern"]);
const PROFILE_PATTERN_MIN_DISTINCT_MESSAGES = 3;
const PROFILE_FACETS = Object.freeze({
  userProfile: Object.freeze(["identity", "background", "preference", "communicationBoundary", "communicationStyle", "interactionPattern", "interest"]),
  assistantProfile: Object.freeze(["identity", "personaTrait", "communicationStyle", "behavioralTendency", "value", "limitation"]),
  relationship: Object.freeze(["status", "address", "trust", "interactionPattern", "sharedBoundary"]),
});
const PROFILE_CANONICAL_KEYS = Object.freeze({
  userProfile: Object.freeze(["identity", "background", "location", "expertise", "communicationTone", "responseFormat", "responseLength", "followUpQuestions", "roleplay", "serviceTreatment", "topicSeriousness", "correctionStyle", "emotionalExpression", "humorStyle", "interest", "open"]),
  assistantProfile: Object.freeze(["identity", "persona", "communicationTone", "responseFormat", "followUpQuestions", "roleplayIdentity", "emotionalStance", "value", "limitation", "open"]),
  relationship: Object.freeze(["relationshipStatus", "userToAssistantAddress", "assistantToUserAddress", "trust", "roleStructure", "interactionPattern", "sharedBoundary", "open"]),
});
const MULTI_VALUE_PROFILE_KEYS = Object.freeze({
  userProfile: Object.freeze(["background", "expertise", "interest", "open"]),
  assistantProfile: Object.freeze(["persona", "value", "open"]),
  relationship: Object.freeze(["interactionPattern", "open"]),
});

const EVIDENCE_KINDS = Object.freeze([
  "user_request",
  "user_commitment",
  "assistant_request",
  "assistant_commitment",
  "todo_completion",
  "todo_cancel",
  "todo_expiration",
  "scene_change",
  "standing_agreement",
  "agreement_cancel",
  "recent_episode",
  "relationship_milestone",
  "user_correction",
  "assistant_correction",
  "user_forget",
  "assistant_forget",
  "long_term_fact",
  "memory_compaction",
]);

const PATCH_OPS = Object.freeze([
  "setField",
  "clearField",
  "addItem",
  "updateItem",
  "forgetItem",
  "mergeItems",
  "completeTodo",
  "cancelTodo",
  "expireTodo",
  "cancelAgreement",
]);

const PROPOSER_EVIDENCE_KINDS = Object.freeze({
  currentStateProposer: ["scene_change", "user_correction", "assistant_correction"],
  todoProposer: ["user_request", "user_commitment", "assistant_request", "assistant_commitment", "todo_completion", "todo_cancel", "todo_expiration", "user_correction", "assistant_correction"],
  agreementProposer: ["standing_agreement", "agreement_cancel", "user_correction", "assistant_correction"],
  episodeProposer: ["recent_episode", "relationship_milestone", "user_correction", "assistant_correction"],
  profileRelationshipProposer: ["long_term_fact", "user_correction", "assistant_correction", "user_forget", "assistant_forget"],
  worldFactProposer: ["long_term_fact", "user_correction", "assistant_correction", "user_forget", "assistant_forget"],
  compactionProposer: ["memory_compaction"],
});

const SECTION_EVIDENCE_KINDS = Object.freeze({
  todos: ["user_request", "user_commitment", "assistant_request", "assistant_commitment", "user_correction", "assistant_correction"],
  standingAgreements: ["standing_agreement", "user_correction", "assistant_correction"],
  recentEpisodes: ["recent_episode", "user_correction", "assistant_correction"],
  milestones: ["relationship_milestone", "user_correction", "assistant_correction"],
  worldFacts: ["long_term_fact", "user_correction", "assistant_correction"],
  userProfile: ["long_term_fact", "user_correction", "assistant_correction"],
  assistantProfile: ["long_term_fact", "user_correction", "assistant_correction"],
  relationship: ["long_term_fact", "user_correction", "assistant_correction"],
});

const READ_ONLY_CONTEXT_PATHS = Object.freeze({
  currentStateProposer: ["working.recentEpisodes"],
  todoProposer: ["current.scene", "working.standingAgreements", "working.recentEpisodes", "longTerm.userProfile", "longTerm.assistantProfile"],
  agreementProposer: ["current.scene", "working.todos", "working.recentEpisodes", "longTerm.relationship", "longTerm.userProfile", "longTerm.assistantProfile"],
  episodeProposer: ["current.scene", "working.todos", "working.standingAgreements", "longTerm.relationship", "longTerm.userProfile", "longTerm.assistantProfile"],
  profileRelationshipProposer: ["current.scene", "working.recentEpisodes", "working.standingAgreements", "longTerm.milestones", "longTerm.worldFacts"],
  worldFactProposer: ["current.scene", "working.recentEpisodes", "working.standingAgreements", "longTerm.milestones", "longTerm.userProfile", "longTerm.assistantProfile", "longTerm.relationship"],
  compactionProposer: [],
});

const TARGET_STATUSES = Object.freeze(["healthy", "retry_wait", "capacity_blocked", "halted", "rebuilding"]);
const TASK_STATUSES = Object.freeze(["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"]);
const TASK_TYPES = Object.freeze(["normal", "maintenance", "system_cleanup"]);
const PROPOSER_RESULT_STATUSES = Object.freeze(["patches", "noop", "unable_to_decide"]);
const COMPACTION_RESULT_STATUSES = Object.freeze(["patches", "unable_to_compact"]);
const QUOTE_MAX_CODE_POINTS = 200;
const QUOTE_IGNORABLE_PUNCTUATION = Object.freeze([
  ",", ".", "!", "?", ";", ":", "\"", "'", "(", ")", "[", "]", "-",
  "，", "。", "！", "？", "；", "：", "“", "”", "‘", "’", "（", "）",
  "【", "】", "《", "》", "〈", "〉", "、", "…", "—",
]);

module.exports = {
  SCHEMA_VERSION,
  SECTIONS,
  TARGETS,
  TARGET_KEYS,
  SEMANTIC_NORMAL_PROPOSERS,
  SCENE_FIELDS,
  ITEM_SECTIONS,
  TYPED_PROFILE_SECTIONS,
  PROFILE_FACT_BASES,
  PROFILE_PATTERN_MIN_DISTINCT_MESSAGES,
  PROFILE_FACETS,
  PROFILE_CANONICAL_KEYS,
  MULTI_VALUE_PROFILE_KEYS,
  EVIDENCE_KINDS,
  PATCH_OPS,
  PROPOSER_EVIDENCE_KINDS,
  SECTION_EVIDENCE_KINDS,
  READ_ONLY_CONTEXT_PATHS,
  TARGET_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
  PROPOSER_RESULT_STATUSES,
  COMPACTION_RESULT_STATUSES,
  QUOTE_MAX_CODE_POINTS,
  QUOTE_IGNORABLE_PUNCTUATION,
};
