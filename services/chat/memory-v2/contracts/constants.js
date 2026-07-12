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
const SCENE_FIELDS = Object.freeze(["location", "time", "mood", "note"]);
const ITEM_SECTIONS = Object.freeze(SECTIONS.filter((section) => section !== "scene"));

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
  SCENE_FIELDS,
  ITEM_SECTIONS,
  EVIDENCE_KINDS,
  PATCH_OPS,
  PROPOSER_EVIDENCE_KINDS,
  TARGET_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
  PROPOSER_RESULT_STATUSES,
  COMPACTION_RESULT_STATUSES,
  QUOTE_MAX_CODE_POINTS,
  QUOTE_IGNORABLE_PUNCTUATION,
};
