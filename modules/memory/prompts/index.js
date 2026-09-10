const fs = require("node:fs/promises");
const path = require("node:path");
const { LIBRARIAN_PROPOSER } = require("../contracts");
const { usesTodoV2 } = require("../contracts/outputProtocol");

const FILES = Object.freeze({
  currentStateProposer: "current-state-proposer.md",
  todoProposer: "todo-proposer.md",
  agreementProposer: "agreement-proposer.md",
  episodeProposer: "episode-proposer.md",
  userProfileProposer: "user-profile-proposer.md",
  assistantProfileProposer: "assistant-profile-proposer.md",
  relationshipProposer: "relationship-proposer.md",
  worldFactProposer: "world-fact-proposer.md",
  compactionProposer: "compaction-proposer.md",
  [LIBRARIAN_PROPOSER]: "librarian-proposer.md",
});
async function loadProposerPrompt(proposer, protocol = {}) {
  const file = usesTodoV2({ ...protocol, proposer }) ? "todo-proposer-v2.md" : FILES[proposer];
  if (!file) throw new Error(`Unknown Memory proposer prompt: ${proposer}`);
  const content = await fs.readFile(path.join(__dirname, file), "utf8");
  if (!content.trim()) throw new Error(`Memory proposer prompt is empty: ${file}`);
  return content;
}
module.exports = { FILES, loadProposerPrompt };
