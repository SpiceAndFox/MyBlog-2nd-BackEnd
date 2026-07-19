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

test("each prompt contains at least one compact decision-boundary example", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(
      prompt,
      /判断示例|泛化校准|正例|反例|✅|❌|应当 noop|应当 unable_to_decide/,
      `${proposer} must contain a decision-boundary example`,
    );
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
  assert.match(prompt, /同一句话.*行动承诺.*提醒请求.*两个 todo/s, "todoProposer must preserve independent todos expressed together");
});

test("agreement prompt distinguishes explicit long-term commitments from emotional rhetoric", async () => {
  const prompt = await loadProposerPrompt("agreementProposer");
  assert.match(prompt, /明确承诺语义.*长期承诺|长期承诺.*明确承诺语义/s);
  assert.match(prompt, /单纯抒情|情绪化宣誓/);
});

test("episode prompt clusters coherent interaction arcs instead of producing a turn log", async () => {
  const prompt = await loadProposerPrompt("episodeProposer");
  assert.match(prompt, /不是逐轮摘要器.*聊天日志.*动作时间线/s);
  assert.match(prompt, /一个完整互动弧最多形成一个 recentEpisodes item/);
  assert.match(prompt, /同一互动弧有新进展.*updateItem \+ recent_episode/s);
  assert.match(prompt, /recentEpisodes.*硬上限为 3 个/s);
  assert.match(prompt, /连续消息聚合为互动弧|按场景、主题、目标与因果连续性聚合/);
  assert.match(prompt, /不默认双写/);
  assert.match(prompt, /没有.*稳定结果.*重要未决问题.*noop/s);
});

test("profile prompt requires durable facts and cross-episode pattern evidence", async () => {
  const prompt = await loadProposerPrompt("profileRelationshipProposer");
  assert.match(prompt, /至少三条不同消息.*至少两个独立互动片段/s);
  assert.match(prompt, /explicit.*当下动作.*不是 explicit 长期事实/s);
  assert.match(prompt, /一次行为不能推出技能、人格、动机或关系模式/);
  assert.match(prompt, /相邻.*提议→回应.*一个互动片段/s);
  assert.match(prompt, /证据不足.*输出.*noop.*不要输出.*unable_to_decide/s);
  assert.match(prompt, /User 与 Assistant.*三个 section.*不按消息 role/s);
  assert.match(prompt, /模型错误.*坏习惯.*不能固化.*assistant 人格/s);
});

test("world fact prompt keeps role-neutral canon authority", async () => {
  const prompt = await loadProposerPrompt("worldFactProposer");
  assert.match(prompt, /User 与 Assistant.*新增.*修正.*遗忘/s);
});

test("reflective prompts stay compact and contain no Alice-session fixture details", async () => {
  const budgets = {
    episodeProposer: 4_000,
    profileRelationshipProposer: 5_000,
  };
  const fixtureTerms = /草莓大福|西湖|饼干盒|三明治|爱心煎蛋|滑板|怕虫|摩托车|门口道别|深夜回家/;
  for (const [proposer, maxChars] of Object.entries(budgets)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.ok(prompt.length <= maxChars, `${proposer} exceeds compact prompt budget (${prompt.length} > ${maxChars})`);
    assert.doesNotMatch(prompt, fixtureTerms, `${proposer} must not contain production-session examples`);
  }
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

test("each prompt names the schema-owned output container", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /sectionResults/, `${proposer} must name sectionResults`);
    assert.match(prompt, /proposer/i, `${proposer} must name proposer`);
  }
});

test("compactionProposer has maintenance-specific rules", async () => {
  const prompt = await loadProposerPrompt("compactionProposer");
  assert.match(prompt, /unable_to_compact/, "compactionProposer must mention unable_to_compact status");
  assert.match(prompt, /mergeItems/, "compactionProposer must mention mergeItems op");
  assert.match(prompt, /recentEpisodes.*unable_to_compact|recentEpisodes.*不/, "compactionProposer must exclude recentEpisodes from compaction");
});
