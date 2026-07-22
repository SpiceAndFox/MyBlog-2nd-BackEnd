const fs = require("node:fs/promises");
const path = require("node:path");

const FILES = Object.freeze({
  currentStateProposer: "current-state-proposer.md",
  todoProposer: "todo-proposer.md",
  agreementProposer: "agreement-proposer.md",
  episodeProposer: "episode-proposer.md",
  profileRelationshipProposer: "profile-relationship-proposer.md",
  userProfileProposer: "user-profile-proposer.md",
  assistantProfileProposer: "assistant-profile-proposer.md",
  relationshipProposer: "relationship-proposer.md",
  worldFactProposer: "world-fact-proposer.md",
  compactionProposer: "compaction-proposer.md",
});
async function loadProposerPrompt(proposer) {
  const file = FILES[proposer];
  if (!file) throw new Error(`Unknown Memory proposer prompt: ${proposer}`);
  const content = await fs.readFile(path.join(__dirname, file), "utf8");
  if (!content.trim()) throw new Error(`Memory proposer prompt is empty: ${file}`);
  return content;
}
module.exports = { FILES, loadProposerPrompt };
