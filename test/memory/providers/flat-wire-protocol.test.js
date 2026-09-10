const test = require("node:test");
const assert = require("node:assert/strict");
const {
  flatWireRepairErrors,
  flatWireToSemanticOutput,
  semanticOutputToFlatWire,
} = require("../../../modules/memory/infrastructure/providers/flatWireProtocol");

const PROFILE_TASK = Object.freeze({
  tickId: 42,
  proposer: "userProfileProposer",
  targetSections: ["userProfile"],
});
const PROFILE_WIRE = {
  sectionStatuses: { userProfile: "changes" },
  changes: [
    { section: "userProfile", action: "add", text: "喜欢读书", sources: ["message:101", "memory:WF1"] },
    { section: "userProfile", action: "correct", target: "U1", text: "喜欢科幻小说", sources: ["message:102"] },
  ],
};
const PROFILE_SEMANTIC = {
  tickId: 42,
  proposer: "userProfileProposer",
  sectionResults: { userProfile: { status: "changes", changes: [
    { action: "add", text: "喜欢读书", evidenceMessageIds: [101], supportRefs: ["WF1"] },
    { action: "correct", ref: "U1", text: "喜欢科幻小说", evidenceMessageIds: [102] },
  ] } },
};

test("flat Profile wire deterministically maps targets and source tokens into SemanticResult", () => {
  assert.deepEqual(flatWireToSemanticOutput(PROFILE_WIRE, PROFILE_TASK), PROFILE_SEMANTIC);
});

test("SemanticResult converts to the same flat shape used by provider preflight", () => {
  assert.deepEqual(semanticOutputToFlatWire(PROFILE_SEMANTIC, PROFILE_TASK), PROFILE_WIRE);
});

test("schema repair diagnostics are translated back to flat wire paths", () => {
  const output = {
    sectionStatuses: { recentEpisodes: "changes", milestones: "changes" },
    changes: [
      { section: "milestones", action: "add", sources: ["message:1"] },
      { section: "recentEpisodes", action: "add", sources: ["message:2"] },
    ],
  };
  const errors = flatWireRepairErrors([
    { path: "$.sectionResults.recentEpisodes.changes[0].supportRefs[0]", message: "invalid source" },
    { path: "$.sectionResults.milestones.changes", message: "must not be empty" },
    { path: "$.sectionResults.milestones.status", message: "invalid status" },
  ], output, {
    proposer: "episodeProposer",
    targetSections: ["recentEpisodes", "milestones"],
  });
  assert.deepEqual(errors.map((error) => error.path), [
    "$.changes[1].sources[0]",
    "$.changes",
    "$.sectionStatuses.milestones",
  ]);
});
