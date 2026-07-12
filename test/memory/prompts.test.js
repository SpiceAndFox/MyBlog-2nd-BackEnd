const test = require("node:test");
const assert = require("node:assert/strict");
const { FILES, loadProposerPrompt } = require("../../modules/memory/prompts");

test("all normal and maintenance Proposers load independent prompts with positive and negative guidance", async () => {
  assert.equal(Object.keys(FILES).length, 7);
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, new RegExp(proposer));
    assert.match(prompt, /正例/);
    assert.match(prompt, /反例/);
    assert.match(prompt, /observedMessages|维护/);
  }
});
