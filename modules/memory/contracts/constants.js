const SCHEMA_VERSION = "2.01";

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
  "worldFactProposer",
  "agreementProposer",
  "todoProposer",
  "currentStateProposer",
]);
const SCENE_FIELDS = Object.freeze(["location", "time", "mood", "note"]);
const ITEM_SECTIONS = Object.freeze(SECTIONS.filter((section) => section !== "scene"));
const PROFILE_TEXT_MAX_CHARS = Object.freeze({
  userProfile: 180,
  assistantProfile: 180,
  relationship: 240,
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
module.exports = {
  SCHEMA_VERSION,
  SECTIONS,
  TARGETS,
  TARGET_KEYS,
  SEMANTIC_NORMAL_PROPOSERS,
  SCENE_FIELDS,
  ITEM_SECTIONS,
  PROFILE_TEXT_MAX_CHARS,
  READ_ONLY_CONTEXT_PATHS,
  TARGET_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
};
