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

test("each normal Proposer prompt distinguishes noop from unable_to_decide", async () => {
  for (const proposer of NORMAL_PROPOSERS) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /noop/, `${proposer} must define noop`);
    assert.match(prompt, /确认.*无需|确认无变更/s, `${proposer} must define noop as a confirmed no-change result`);
    assert.match(prompt, /unable_to_decide/, `${proposer} must define unable_to_decide`);
    assert.match(prompt, /信息不足|指代不明|无法.*判断/s, `${proposer} must reserve unable_to_decide for insufficient information`);
    assert.match(prompt, /不要把.*无法判断.*noop|不要把.*不确定.*noop/s, `${proposer} must not disguise uncertainty as noop`);
  }
});

test("todo prompt covers overdue visibility and rescheduling", async () => {
  const prompt = await loadProposerPrompt("todoProposer");
  assert.match(prompt, /overdue items 只提供最近 N 条/, "todoProposer must disclose the partial overdue view");
  assert.match(prompt, /overdue todo.*updateItem.*dueChange\.mode=set/s, "todoProposer must reschedule overdue todos through updateItem + set");
  assert.match(prompt, /未出现在 writableState.*unable_to_decide/s, "todoProposer must not guess hidden overdue item ids");
  assert.match(prompt, /status.*becameOverdueAt.*Reducer 管理.*不得输出或修改/s, "todoProposer must treat lifecycle fields as reducer-owned");
  assert.match(prompt, /今天.*days.*0/s, "todoProposer must represent today as relative days=0");
  assert.match(prompt, /relative.*必须且只能包含一个时长字段/s, "todoProposer must require one canonical relative unit");
  assert.match(prompt, /active 和 overdue todo 都可以.*completeTodo.*cancelTodo.*expireTodo/s, "todoProposer must allow every semantic terminal operation for overdue todos");
  assert.match(prompt, /鸡蛋炒好.*快尝尝.*好吃.*completeTodo/s, "todoProposer must recognize implicit completion through action and acceptance");
  assert.match(prompt, /明天.*我给你做.*days.*1.*不得输出 days=0/s, "todoProposer must inherit relative dates from adjacent context");
});

test("agreement prompt distinguishes explicit long-term commitments from emotional rhetoric", async () => {
  const prompt = await loadProposerPrompt("agreementProposer");
  assert.match(prompt, /明确承诺语义.*长期承诺|长期承诺.*明确承诺语义/s);
  assert.match(prompt, /单纯抒情|情绪化宣誓/);
});

test("single-section prompts express exclusions only as local noop decisions", async () => {
  const todo = await loadProposerPrompt("todoProposer");
  const agreement = await loadProposerPrompt("agreementProposer");
  const worldFact = await loadProposerPrompt("worldFactProposer");
  assert.doesNotMatch(todo, /归 standingAgreements|由 agreementProposer 处理/);
  assert.doesNotMatch(agreement, /归 relationship|归 todos|归 userProfile|归 relationship\/milestones|由 todoProposer 处理/);
  assert.doesNotMatch(worldFact, /归 userProfile|归 assistantProfile|归 standingAgreements|scene\.note|scene\.mood|recentEpisode/);
  for (const prompt of [todo, agreement, worldFact]) {
    assert.match(prompt, /输出 noop/, "out-of-scope examples must resolve to the current section's noop");
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
