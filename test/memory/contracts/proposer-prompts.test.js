const test = require("node:test");
const assert = require("node:assert/strict");
const { FILES, loadProposerPrompt } = require("../../../modules/memory/prompts");

const NORMAL_PROPOSERS = [
  "currentStateProposer",
  "todoProposer",
  "agreementProposer",
  "episodeProposer",
  "profileRelationshipProposer",
  "userProfileProposer",
  "assistantProfileProposer",
  "relationshipProposer",
  "worldFactProposer",
];

const SEMANTIC_PROPOSERS = NORMAL_PROPOSERS;

test("all registered Proposer prompts exist and load", async () => {
  assert.ok(Object.keys(FILES).length > 0);
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.ok(prompt.trim().length > 0, `${proposer} prompt must not be empty`);
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

test("profile and agreement prompts keep writable refs out of support sources", async () => {
  for (const proposer of ["profileRelationshipProposer", "agreementProposer"]) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /可修改.*绝不能放入 `supportRefs`/s);
    assert.match(prompt, /`add` 不引用可修改条目/);
    assert.match(prompt, /`ref` 必须逐字复制实际显示的可修改短引用/);
    assert.match(prompt, /没有可修改.*不能输出/s);
  }
});

test("profile specialists own one semantic section without an example bank", async () => {
  const specialists = {
    userProfileProposer: "userProfile",
    assistantProfileProposer: "assistantProfile",
    relationshipProposer: "relationship",
  };
  for (const [proposer, section] of Object.entries(specialists)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, new RegExp(`只维护 .*${section}`));
    assert.match(prompt, new RegExp(`sectionResults.*只包含 .*${section}`, "s"));
    assert.match(prompt, /可修改引用绝不能放入 `supportRefs`/);
    assert.match(prompt, /没有可修改条目时不能使用/);
    assert.doesNotMatch(prompt, /## 判断示例|```/);
    assert.ok(prompt.length < 1800, `${proposer} should stay compact, got ${prompt.length} characters`);
  }
  assert.match(await loadProposerPrompt("userProfileProposer"), /回复语言、语气、长度、结构、主动性、追问和幽默/);
  assert.match(await loadProposerPrompt("assistantProfileProposer"), /用户希望怎样被回应通常是 `userProfile` 或 standingAgreements/);
  assert.match(await loadProposerPrompt("relationshipProposer"), /过去阶段—关键转折—当前模式/);
});

test("todo prompt covers overdue visibility and rescheduling", async () => {
  const prompt = await loadProposerPrompt("todoProposer");
  assert.match(prompt, /overdue items 只提供最近 N 条/, "todoProposer must disclose the partial overdue view");
  assert.match(prompt, /overdue.*update.*dueChange\.mode=set/s, "todoProposer must reschedule overdue todos through Semantic update + set");
  assert.match(prompt, /目标未显示.*unable_to_decide/s, "todoProposer must not guess hidden overdue refs");
  assert.match(prompt, /不生成.*status.*becameOverdueAt/s, "todoProposer must treat lifecycle fields as reducer-owned");
  assert.match(prompt, /今天.*days.*0/s, "todoProposer must represent today as relative days=0");
  assert.match(prompt, /相对(?:日期|时长)必须且只能有一个|relative.*必须且只能包含一个时长字段/s, "todoProposer must require one canonical relative unit");
  assert.match(prompt, /dayOfMonth.*day.*1\.\.31/s, "todoProposer must represent an incomplete day-of-month without guessing a full date");
  assert.match(prompt, /dayOfMonth.*anchorMessageId/s, "todoProposer must anchor day-of-month dates to direct message time");
  assert.match(prompt, /overdue 可完成、取消/s, "todoProposer must allow overdue completion and cancellation");
  assert.match(prompt, /overdue.*不能再次 expire/s, "todoProposer must not expire an already-overdue todo");
  assert.match(prompt, /产出、交付、使用或验收.*complete/s, "todoProposer must recognize implicit completion");
  assert.match(prompt, /承接回答.*继承相邻消息.*日期/s, "todoProposer must inherit relative dates from adjacent context");
  assert.match(prompt, /同一句话.*两个可独立行动.*两个 todo/s, "todoProposer must preserve independent todos expressed together");
});

test("agreement prompt distinguishes durable commitments and cancels context-dependent rules", async () => {
  const prompt = await loadProposerPrompt("agreementProposer");
  assert.match(prompt, /明确承诺语义.*长期承诺|长期承诺.*明确承诺语义/s);
  assert.match(prompt, /单纯抒情|情绪化宣誓/);
  assert.match(prompt, /结束某个关系、角色、角色扮演或互动模式.*扫描全部可修改约定.*cancel/s);
  assert.match(prompt, /只取消依赖关系明确.*不波及.*独立成立/s);
  assert.match(prompt, /覆盖所有明确依赖.*不能在找到第一个 cancel 后停止/s);
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
  assert.match(prompt, /不要只给旧 milestone 追加免责声明.*correct.*当前意义.*forget/s);
});

test("profile prompt performs compact coverage-first semantic calibration", async () => {
  const prompt = await loadProposerPrompt("profileRelationshipProposer");
  assert.match(prompt, /静默语义扫描/);
  assert.match(prompt, /分别检查三个 section.*全部可见消息.*任何一个 section.*不能替代.*不只看最后一条.*记住\/以后/s);
  assert.match(prompt, /身份与称呼.*背景与所在地.*工作\/项目\/能力.*长期目标与价值.*沟通语言\/语气\/长度\/格式\/主动性\/追问\/幽默偏好/s);
  assert.match(prompt, /用户希望怎样被回应通常属于 userProfile 或 standingAgreements/);
  assert.match(prompt, /不要求包含.*永远、以后、记住/s);
  assert.match(prompt, /用户对未来回复方式的直接要求、反复纠正和明确身份事实优先于.*角色历史/s);
  assert.match(prompt, /当前偏好或自我描述.*不夸大的范围和条件/s);
  assert.match(prompt, /多个独立片段.*可观察的互动倾向.*不推断心理动机、诊断或敏感属性/s);
  assert.match(prompt, /明确说明\/否认.*优先决定当前含义/s);
  assert.match(prompt, /玩笑、称呼、回忆或短暂重现.*不会自动恢复旧状态/s);
  assert.match(prompt, /结束某个身份、关系、角色扮演或互动模式.*检查依赖.*条目/s);
  assert.match(prompt, /过去阶段、伪装\/误解、真相揭示或关系转变.*解释当前状态.*共同经历连续性.*避免未来误读/s);
  assert.match(prompt, /明确区分.*当时\/曾经.*当前/s);
  assert.match(prompt, /过去阶段.*当前状态.*一个演化事实/s);
  assert.match(prompt, /确曾成立.*关系身份\/结构.*不得仅因已结束而 forget.*必须 update\/correct.*带时态的演化事实/s);
  assert.match(prompt, /不要保留未标明时态的自我抵消描述/s);
  assert.match(prompt, /不把互不相关的事实塞进同一 text/);
  assert.match(prompt, /已有条目表达相同事实或已包含候选时禁止 add/);
  assert.match(prompt, /项目或测试.*抽象掉本轮阶段、操作步骤和触发频率/s);
  assert.match(prompt, /虚构身世、能力或职位不能写成 Assistant (?:的)?现实履历/);
  assert.match(prompt, /用户已拒绝或要求改掉的 Assistant 行为不是当前人格/);
  assert.match(prompt, /历史演化只保留过去阶段、转折与当前模式.*不列场景名、任务清单、协议条款、消息编号或系统诊断/s);
  assert.match(prompt, /不(?:要)?生成.*facet.*canonicalKey.*factBasis/s);
  assert.doesNotMatch(prompt, /## 判断示例|```/, "semantic coverage must not grow through an embedded example bank");
  assert.ok(prompt.length < 3000, `profile prompt should stay compact, got ${prompt.length} characters`);
});

test("current state prompt rejects clock inference and figurative scene reactivation", async () => {
  const prompt = await loadProposerPrompt("currentStateProposer");
  assert.match(prompt, /不得从消息 createdAt、task\.now 或日历时钟推导 time/);
  assert.match(prompt, /比喻性地点.*旧场景的回忆.*不代表.*重新启动角色扮演/s);
});

test("world fact prompt keeps role-neutral canon authority", async () => {
  const prompt = await loadProposerPrompt("worldFactProposer");
  assert.match(prompt, /User 与 Assistant.*新增.*修正.*遗忘/s);
  assert.match(prompt, /不保存用户\/Assistant 的偏好、能力、人格、关系或事件履历/);
  assert.match(prompt, /只是测试、临时角色扮演.*角色世界已经结束.*不再是当前 canon/s);
  assert.match(prompt, /玩笑、称呼、回忆或短暂重现.*不会自动恢复 canon/s);
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
