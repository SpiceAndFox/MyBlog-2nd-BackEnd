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
const SEMANTIC_PROPOSERS = NORMAL_PROPOSERS;

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

test("each normal Proposer prompt documents the new-batch source boundary", async () => {
  for (const proposer of NORMAL_PROPOSERS) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /new.?batch|new batch/i, `${proposer} must mention the new-batch boundary`);
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

test("each normal Proposer treats payload text as data and documents its source selector contract", async () => {
  for (const proposer of NORMAL_PROPOSERS) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /待分析数据/, `${proposer} must treat payload text as untrusted data`);
    if (SEMANTIC_PROPOSERS.includes(proposer)) {
      assert.match(prompt, /不要生成.*quote|不输出.*quote|不生成.*quote/s, `${proposer} must select message ids instead of generating quotes`);
      assert.doesNotMatch(prompt, /至少 3 个信息字符/, `${proposer} must not carry the legacy quote floor`);
    } else assert.match(prompt, /至少 3 个信息字符/, `${proposer} must disclose the Reducer quote floor`);
  }
});

test("todo prompt covers overdue visibility and rescheduling", async () => {
  const prompt = await loadProposerPrompt("todoProposer");
  assert.match(prompt, /overdue items 只提供最近 N 条/, "todoProposer must disclose the partial overdue view");
  assert.match(prompt, /overdue.*update.*dueChange\.mode=set/s, "todoProposer must reschedule overdue todos through Semantic update + set");
  assert.match(prompt, /目标未显示.*unable_to_decide/s, "todoProposer must not guess hidden overdue refs");
  assert.match(prompt, /不生成.*status.*becameOverdueAt/s, "todoProposer must treat lifecycle fields as reducer-owned");
  assert.match(prompt, /今天.*days.*0/s, "todoProposer must represent today as relative days=0");
  assert.match(prompt, /相对日期必须且只能有一个|relative.*必须且只能包含一个时长字段/s, "todoProposer must require one canonical relative unit");
  assert.match(prompt, /overdue 可完成、取消/s, "todoProposer must allow overdue completion and cancellation");
  assert.match(prompt, /overdue.*不能再次 expire/s, "todoProposer must not expire an already-overdue todo");
  assert.match(prompt, /产出、交付、使用或验收.*complete/s, "todoProposer must recognize implicit completion");
  assert.match(prompt, /承接回答.*继承相邻消息.*日期/s, "todoProposer must inherit relative dates from adjacent context");
  assert.match(prompt, /同一句话.*两个可独立行动.*两个 todo/s, "todoProposer must preserve independent todos expressed together");
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
  assert.match(prompt, /同一互动弧有新进展.*update.*原 ref/s);
  assert.match(prompt, /recentEpisodes.*硬上限为 3 个/s);
  assert.match(prompt, /连续消息聚合为互动弧|按场景、主题、目标与因果连续性聚合/);
  assert.match(prompt, /不默认双写/);
  assert.match(prompt, /没有.*稳定结果.*重要未决问题.*noop/s);
});

test("profile prompt keeps durable admission while allowing support-only long-term derivation", async () => {
  const prompt = await loadProposerPrompt("profileRelationshipProposer");
  assert.match(prompt, /不要求固定消息数量、独立互动片段数量或 new-batch evidence/);
  assert.match(prompt, /单次 Episode 或一个 support ref.*长程归纳/s);
  assert.match(prompt, /可仅用该 Episode 的 `supportRefs`/);
  assert.match(prompt, /一次行为或单次 Episode.*不能仅凭一次动作猜测技能、人格、心理动机/s);
  assert.match(prompt, /User 与 Assistant.*三个 section.*不按消息 role/s);
  assert.match(prompt, /模型错误.*坏习惯.*不能固化.*assistant 人格/s);
  assert.match(prompt, /不要生成.*facet.*canonicalKey.*factBasis/s);
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
    assert.match(prompt, /输出 noop|应当 noop/, "out-of-scope examples must resolve to the current section's noop");
  }
});

test("normal prompts prohibit persistence metadata while maintenance keeps its storage protocol", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    const isCompaction = proposer === "compactionProposer";
    const isSemantic = SEMANTIC_PROPOSERS.includes(proposer);
    assert.match(prompt, /evidenceKind/, `${proposer} must mention evidenceKind`);
    if (isSemantic) {
      assert.match(prompt, /不要生成.*evidenceKind|不输出.*evidenceKind|不生成.*evidenceKind/s, `${proposer} must prohibit persistence metadata`);
      assert.doesNotMatch(prompt, /合法 evidenceKind/, `${proposer} must not carry the legacy evidence matrix`);
      continue;
    }
    if (isCompaction) assert.match(prompt, /不输出.*evidenceKind/s, `${proposer} must prohibit persistence metadata`);
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
  assert.match(prompt, /语义动作.*merge/s, "compactionProposer must emit the merge Semantic action");
  assert.match(prompt, /recentEpisodes.*unable_to_compact|recentEpisodes.*不/, "compactionProposer must exclude recentEpisodes from compaction");
  assert.match(prompt, /refs.*不相交/s, "compactionProposer must emit disjoint merge groups");
  assert.match(prompt, /短于 source texts.*字符总和/s, "compactionProposer must actually reduce text capacity");
});
