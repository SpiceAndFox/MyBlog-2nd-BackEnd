const FLAT_WIRE_STATUSES = Object.freeze(["changes", "noop", "unable_to_decide"]);

const FLAT_WIRE_PROPOSER_SECTIONS = Object.freeze({
  currentStateProposer: Object.freeze(["scene"]),
  agreementProposer: Object.freeze(["standingAgreements"]),
  episodeProposer: Object.freeze(["recentEpisodes", "milestones"]),
  profileRelationshipProposer: Object.freeze(["userProfile", "assistantProfile", "relationship"]),
  userProfileProposer: Object.freeze(["userProfile"]),
  assistantProfileProposer: Object.freeze(["assistantProfile"]),
  relationshipProposer: Object.freeze(["relationship"]),
  worldFactProposer: Object.freeze(["worldFacts"]),
});

function isFlatWireProposer(proposer) {
  return Object.prototype.hasOwnProperty.call(FLAT_WIRE_PROPOSER_SECTIONS, proposer);
}

function flatWireSections(proposer, targetSections) {
  const configured = FLAT_WIRE_PROPOSER_SECTIONS[proposer];
  if (!configured) throw new Error(`Flat Memory wire protocol is not implemented for proposer: ${proposer}`);
  const selected = Array.isArray(targetSections) && targetSections.length
    ? targetSections.map(String)
    : configured.slice();
  if (!selected.length || selected.some((section) => !configured.includes(section))) {
    throw new Error(`Invalid flat Memory wire sections for proposer: ${proposer}`);
  }
  return selected;
}

module.exports = {
  FLAT_WIRE_PROPOSER_SECTIONS,
  FLAT_WIRE_STATUSES,
  flatWireSections,
  isFlatWireProposer,
};
