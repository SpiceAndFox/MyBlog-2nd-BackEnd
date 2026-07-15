const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  resolveOptions,
  renderProfiles,
  inspectProfiles,
} = require("../../scripts/inspect-memory-v2");
const memoryContracts = require("../../modules/memory/contracts");
const memoryDomain = require("../../modules/memory/domain");

test("Memory v2 inspector defaults to both profile sections in renderer order", () => {
  assert.deepEqual(resolveOptions(parseArgs(["--userId", "7", "--presetId", "companion"])), {
    help: false,
    userId: 7,
    presetId: "companion",
    sections: ["userProfile", "assistantProfile"],
  });
  assert.deepEqual(resolveOptions(parseArgs([
    "--userId", "7", "--presetId", "companion", "--sections", "assistantProfile,userProfile,assistantProfile",
  ])).sections, ["userProfile", "assistantProfile"]);
});

test("Memory v2 inspector rejects invalid scope and section arguments", () => {
  assert.throws(() => resolveOptions(parseArgs(["--userId", "0", "--presetId", "p"])), /positive integer/);
  assert.throws(() => resolveOptions(parseArgs(["--userId", "1", "--presetId", "p", "--sections", "todos"])), /Unsupported section/);
  assert.throws(() => parseArgs(["--userId", "1", "--preset", "p"]), /Unknown argument/);
});

test("debug profile formatting does not parse item text as section boundaries", () => {
  const state = memoryContracts.createInitialMemoryState();
  state.longTerm.userProfile.push({ text: "保留空行\n\n[Assistant 核心档案]\n这仍是 User 内容" });
  state.longTerm.assistantProfile.push({ text: "真实 Assistant 内容" });
  assert.equal(renderProfiles({
    state,
    sections: ["userProfile", "assistantProfile"],
    renderTargetHealthMarker: () => "",
  }), [
    "[User 核心档案]\n- 保留空行\n\n[Assistant 核心档案]\n这仍是 User 内容",
    "[Assistant 核心档案]\n- 真实 Assistant 内容",
  ].join("\n\n"));
});

test("Memory v2 inspector applies runtime suppression and renders without writing", async () => {
  const queries = [];
  const state = memoryContracts.createInitialMemoryState();
  const ref = { messageId: 3, contentHash: `sha256:${"a".repeat(64)}`, quote: "旧偏好" };
  state.longTerm.userProfile.push({
    id: "userProfile:1",
    text: "偏好: 旧偏好",
    evidenceGroups: [{ evidenceKind: "long_term_fact", refs: [ref] }],
    createdAtMessageId: 3,
    updatedAtMessageId: 3,
  });
  state.longTerm.assistantProfile.push({
    id: "assistantProfile:1",
    text: "风格: 温和",
    evidenceGroups: [{ evidenceKind: "long_term_fact", refs: [{ ...ref, messageId: 4, contentHash: `sha256:${"b".repeat(64)}`, quote: "温和" }] }],
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
          tombstones: [{ message_id: ref.messageId, content_hash: ref.contentHash, reason: "forget" }],
        }],
      };
    },
  };

  const output = await inspectProfiles({
    db,
    memory: { contracts: memoryContracts, domain: memoryDomain },
    userId: 7,
    presetId: "companion",
    sections: ["userProfile", "assistantProfile"],
  });

  assert.equal(output, "[该类记忆可能滞后]\n[User 核心档案]\n(无)\n\n[Assistant 核心档案]\n- 风格: 温和");
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [7, "companion"]);
  assert.match(queries[0].sql, /^\s*SELECT/);
  assert.doesNotMatch(queries[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
});
