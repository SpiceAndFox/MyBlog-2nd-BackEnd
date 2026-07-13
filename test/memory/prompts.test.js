const test = require("node:test");
const assert = require("node:assert/strict");
const { FILES, loadProposerPrompt } = require("../../modules/memory/prompts");

const NORMAL_PROPOSERS = [
  "currentStateProposer",
  "todoProposer",
  "agreementProposer",
  "episodeProposer",
  "profileRelationshipProposer",
  "worldFactProposer",
];

const MAINTENANCE_PROPOSERS = ["compactionProposer"];

test("all 7 Proposer prompts exist and load", async () => {
  assert.equal(Object.keys(FILES).length, 7);
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.ok(prompt.trim().length > 0, `${proposer} prompt must not be empty`);
  }
});

test("each prompt self-identifies its Proposer name", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, new RegExp(proposer), `${proposer} prompt must contain its own name`);
  }
});

test("each normal Proposer prompt contains new-batch/overlap awareness", async () => {
  for (const proposer of NORMAL_PROPOSERS) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /new batch/, `${proposer} must mention "new batch"`);
    assert.match(prompt, /cursorBefore/, `${proposer} must mention cursorBefore`);
  }
});

test("each prompt requires tickId copy", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /tickId/, `${proposer} must mention tickId`);
    assert.match(prompt, /原样复制|逐值复制/, `${proposer} must instruct tickId copy`);
  }
});

test("each prompt contains golden examples (正例) and negative examples (反例)", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    const isCurrentState = proposer === "currentStateProposer";
    // currentStateProposer uses "判断示例" section with narrative style that predates the 正例/反例 convention
    if (isCurrentState) {
      assert.match(prompt, /判断示例|应当 noop|应当 unable_to_decide/, `${proposer} must contain judgment examples`);
    } else {
      // New prompts use ✅/❌, old prompts use 正例/反例 — accept either
      const hasGolden = /正例/.test(prompt) || /✅/.test(prompt);
      const hasNegative = /反例/.test(prompt) || /❌/.test(prompt);
      assert.ok(hasGolden, `${proposer} must contain golden examples (正例 or ✅)`);
      assert.ok(hasNegative, `${proposer} must contain negative examples (反例 or ❌)`);
      const positiveMatches = (prompt.match(/✅/g) || []).length;
      const negativeMatches = (prompt.match(/❌/g) || []).length;
      assert.ok(positiveMatches >= 3, `${proposer} must have at least 3 positive examples (found ${positiveMatches})`);
      assert.ok(negativeMatches >= 5, `${proposer} must have at least 5 negative examples (found ${negativeMatches})`);
    }
  }
});

test("each normal Proposer prompt contains self-check (最终自检) section", async () => {
  for (const proposer of NORMAL_PROPOSERS) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /最终自检|提交.*自检|提交前/, `${proposer} must contain self-check section`);
  }
});

test("each prompt has section × op × evidenceKind mapping", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    const isCurrentState = proposer === "currentStateProposer";
    const isCompaction = proposer === "compactionProposer";
    assert.match(prompt, /evidenceKind/, `${proposer} must mention evidenceKind`);
    if (isCurrentState) {
      // currentStateProposer lists evidenceKind in a bullet section
      assert.match(prompt, /scene_change.*user_correction.*assistant_correction/s, `${proposer} must list all its legal evidenceKind values`);
    } else if (isCompaction) {
      // compactionProposer lists "evidenceKind 必须是 memory_compaction" or has a labeled table
      assert.match(prompt, /memory_compaction/, `${proposer} must list its legal evidenceKind (memory_compaction)`);
    } else {
      assert.match(prompt, /合法 evidenceKind/, `${proposer} must have a labeled '合法 evidenceKind' section`);
    }
  }
});

test("each prompt has output shape examples", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    // Should contain JSON output examples with sectionResults
    assert.match(prompt, /"sectionResults"/, `${proposer} must show output shape with sectionResults`);
    assert.match(prompt, /"proposer"/, `${proposer} must show output shape with proposer field`);
  }
});

test("compactionProposer has maintenance-specific rules", async () => {
  const prompt = await loadProposerPrompt("compactionProposer");
  assert.match(prompt, /unable_to_compact/, "compactionProposer must mention unable_to_compact status");
  assert.match(prompt, /mergeItems/, "compactionProposer must mention mergeItems op");
  assert.match(prompt, /recentEpisodes.*unable_to_compact|recentEpisodes.*不/, "compactionProposer must exclude recentEpisodes from compaction");
});
