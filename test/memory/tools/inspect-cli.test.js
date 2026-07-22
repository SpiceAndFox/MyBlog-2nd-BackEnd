const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  resolveOptions,
  renderMemorySections,
  inspectMemory,
} = require("../../../scripts/inspect-memory-v2");
const memoryContracts = require("../../../modules/memory/contracts");
const memoryDomain = require("../../../modules/memory/domain");

test("Memory v2 inspector defaults to all memory sections in renderer order", () => {
  assert.deepEqual(resolveOptions(parseArgs(["--userId", "7", "--presetId", "companion"])), {
    help: false,
    userId: 7,
    presetId: "companion",
    sections: [
      "worldFacts", "userProfile", "assistantProfile", "relationship", "milestones",
      "standingAgreements", "todos", "recentEpisodes", "scene",
    ],
  });
  assert.deepEqual(resolveOptions(parseArgs([
    "--userId", "7", "--presetId", "companion", "--sections", "scene,todos,userProfile,todos",
  ])).sections, ["userProfile", "todos", "scene"]);
});

test("Memory v2 inspector rejects invalid scope and section arguments", () => {
  assert.throws(() => resolveOptions(parseArgs(["--userId", "0", "--presetId", "p"])), /positive integer/);
  assert.throws(() => resolveOptions(parseArgs(["--userId", "1", "--presetId", "p", "--sections", "unknown"])), /Unsupported section/);
  assert.throws(() => parseArgs(["--userId", "1", "--preset", "p"]), /Unknown argument/);
});

test("debug profile formatting does not parse item text as section boundaries", () => {
  const state = memoryContracts.createInitialMemoryState();
  state.longTerm.userProfile.push({ text: "保留空行\n\n[Assistant 核心档案]\n这仍是 User 内容" });
  state.longTerm.assistantProfile.push({ text: "真实 Assistant 内容" });
  assert.equal(renderMemorySections({
    state,
    sections: ["userProfile", "assistantProfile"],
    renderTargetHealthMarker: () => "",
  }), [
    "[User 核心档案]\n- 保留空行\n\n[Assistant 核心档案]\n这仍是 User 内容",
    "[Assistant 核心档案]\n- 真实 Assistant 内容",
  ].join("\n\n"));
});

test("Memory v2 inspector renders non-profile sections with target health markers", () => {
  const state = memoryContracts.createInitialMemoryState();
  state.working.todos.push(
    { text: "整理测试", actor: "assistant", requester: "user", status: "active", dueAt: null },
    { text: "提交报告", actor: "user", requester: "assistant", status: "overdue", dueAt: "2026-07-14T00:00:00Z" },
  );
  state.longTerm.worldFacts.push({ text: "项目使用 Node.js" });
  state.current.scene.location.value = "书房";

  assert.equal(renderMemorySections({
    state,
    sections: ["worldFacts", "todos", "scene"],
    renderTargetHealthMarker: (target) => target === "todos" ? "[该类记忆可能滞后]" : "",
    renderTodo: memoryDomain.renderTodo,
    renderScene: memoryDomain.renderScene,
  }), [
    "[长期事实]\n- 项目使用 Node.js",
    "[该类记忆可能滞后]\n[待办]\n- 整理测试（执行者: assistant；提出者: user）\n\n[已逾期待办]\n- 提交报告（执行者: user；提出者: assistant；期限: 2026-07-14T00:00:00Z）",
    "[当前状态]\n- 地点: 书房\n- 时间: 未知\n- 氛围: 未知\n- 备注: \n\n[已过期场景 / 上次已知场景]\n(无)",
  ].join("\n\n"));
});

test("Memory v2 inspector renders 2.01 flat provenance without writing", async () => {
  const queries = [];
  const state = memoryContracts.createInitialMemoryState();
  const ref = { messageId: 3, contentHash: `sha256:${"a".repeat(64)}` };
  state.longTerm.userProfile.push({
    id: "userProfile:1",
    text: "偏好: 旧偏好",
    sourceRefs: [ref],
    createdAtMessageId: 3,
    updatedAtMessageId: 3,
  });
  state.longTerm.assistantProfile.push({
    id: "assistantProfile:1",
    text: "风格: 温和",
    sourceRefs: [{ ...ref, messageId: 4, contentHash: `sha256:${"b".repeat(64)}` }],
    createdAtMessageId: 4,
    updatedAtMessageId: 4,
  });
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [{
          memory_state: state,
          target_statuses: [{ target_key: "profileRelationship", status: "halted" }],
          diagnostics: [],
        }],
      };
    },
  };

  const output = await inspectMemory({
    db,
    memory: { contracts: memoryContracts, domain: memoryDomain },
    userId: 7,
    presetId: "companion",
    sections: ["userProfile", "assistantProfile"],
  });

  assert.equal(output, "[该类记忆可能滞后]\n[User 核心档案]\n- 偏好: 旧偏好\n\n[Assistant 核心档案]\n- 风格: 温和");
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [7, "companion"]);
  assert.match(queries[0].sql, /^\s*SELECT/);
  assert.doesNotMatch(queries[0].sql, /suppression_tombstones/i);
  assert.doesNotMatch(queries[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
});
