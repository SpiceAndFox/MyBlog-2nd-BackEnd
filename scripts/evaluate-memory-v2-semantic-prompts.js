#!/usr/bin/env node
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const {
  buildNormalEnvelope,
  contracts,
  createMemoryProviderAdapter,
  createStructuredTransport,
  loadMemoryProviderConfig,
  loadProposerPrompt,
} = require("../modules/memory/admin");

function hash(content) {
  return `sha256:${crypto.createHash("sha256").update(String(content), "utf8").digest("hex")}`;
}

function message(id, content, role = "user") {
  return {
    id,
    role,
    content,
    contentHash: hash(content),
    contentKind: "raw",
    createdAt: `2026-07-23T00:00:${String(id).padStart(2, "0")}.000Z`,
  };
}

function windowMessage(id, index, content, role) {
  return {
    id,
    role,
    content,
    contentHash: hash(content),
    contentKind: "raw",
    createdAt: new Date(Date.UTC(2026, 6, 23, 0, index)).toISOString(),
  };
}

function item(id, text, messageId) {
  return {
    id,
    text,
    sourceRefs: [{ messageId, contentHash: hash(`source:${id}`) }],
    createdAtMessageId: messageId,
    updatedAtMessageId: messageId,
  };
}

function profileIntent() {
  return {
    targetKey: "profileRelationship",
    proposer: "profileRelationshipProposer",
    targetSections: ["userProfile", "assistantProfile", "relationship"],
    cursorBefore: 0,
    trigger: { type: "evaluation" },
  };
}

function agreementIntent() {
  return {
    targetKey: "standingAgreements",
    proposer: "agreementProposer",
    targetSections: ["standingAgreements"],
    cursorBefore: 0,
    trigger: { type: "evaluation" },
  };
}

function buildEnvelope({ state, intent, messages, tickId }) {
  return buildNormalEnvelope({
    userId: 1,
    presetId: "semantic-prompt-evaluation",
    state,
    intent,
    messages,
    tickId,
    taskId: `00000000-0000-4000-8000-${String(tickId).padStart(12, "0")}`,
    now: "2026-07-23T00:01:00.000Z",
    userTimeZone: "Asia/Shanghai",
    config: { overdueTodos: { maxRenderedItems: 10 } },
  });
}

function changes(output, section) {
  const result = output?.sectionResults?.[section];
  return result?.status === "changes" ? result.changes : [];
}

function expectNoop(output, section, errors) {
  if (output?.sectionResults?.[section]?.status !== "noop") errors.push(`${section} should be noop`);
}

function profilePreferenceCase() {
  const state = contracts.createInitialMemoryState();
  const envelope = buildEnvelope({
    state,
    intent: profileIntent(),
    messages: [message(10, "你不用每次都在结尾问我问题，正常接着聊就行。")],
    tickId: 1,
  });
  return {
    id: "profile-reusable-preference-without-permanence-marker",
    envelope,
    score(output) {
      const errors = [];
      const userChanges = changes(output, "userProfile");
      if (!userChanges.some((change) => /追问|问题|结尾/.test(String(change.text || "")))) {
        errors.push("userProfile should capture the reusable no-closing-question preference");
      }
      expectNoop(output, "assistantProfile", errors);
      expectNoop(output, "relationship", errors);
      return errors;
    },
  };
}

function profileTransientCase() {
  const state = contracts.createInitialMemoryState();
  const envelope = buildEnvelope({
    state,
    intent: profileIntent(),
    messages: [message(10, "这一次回复请只用三句话，我正在测试输出长度。")],
    tickId: 2,
  });
  return {
    id: "profile-one-off-test-remains-noop",
    envelope,
    score(output) {
      const errors = [];
      for (const section of ["userProfile", "assistantProfile", "relationship"]) expectNoop(output, section, errors);
      return errors;
    },
  };
}

function profileRoleEndCase() {
  const state = contracts.createInitialMemoryState();
  state.longTerm.userProfile.push(item("profile:captain", "用户喜欢扮演威严的船长。", 1));
  state.longTerm.relationship.push(item("relationship:crew", "双方以船长与大副的身份长期互动。", 2));
  const envelope = buildEnvelope({
    state,
    intent: profileIntent(),
    messages: [message(10, "航海角色扮演只是这次 API 测试，我并不喜欢这种角色扮演；现在结束角色关系，恢复普通对话。")],
    tickId: 3,
  });
  return {
    id: "profile-explicit-role-end-invalidates-dependent-memory",
    envelope,
    score(output) {
      const errors = [];
      const userChanges = changes(output, "userProfile");
      const relationshipChanges = changes(output, "relationship");
      if (!userChanges.some((change) => change.ref === "UP1"
        && ["update", "correct"].includes(change.action)
        && /测试|角色扮演/.test(String(change.text || ""))
        && /不喜欢|并非.*偏好|非.*偏好/.test(String(change.text || "")))) {
        errors.push("userProfile should turn UP1 into a time-qualified evolution fact instead of deleting or preserving the old preference");
      }
      if (!relationshipChanges.some((change) => change.ref === "R1"
        && ["update", "correct"].includes(change.action)
        && /曾|当时|过去|角色/.test(String(change.text || ""))
        && /当前|现在|普通对话/.test(String(change.text || "")))) {
        errors.push("relationship should preserve the role-to-current transition with explicit time semantics");
      }
      expectNoop(output, "assistantProfile", errors);
      return errors;
    },
  };
}

function profileLongWindowCoverageCase() {
  const state = contracts.createInitialMemoryState();
  state.longTerm.relationship.push(item(
    "relationship:role-history",
    "双方曾进行航海角色扮演，现已结束并恢复普通对话；旧故事仍可作为共同回忆提及。",
    1,
  ));
  const messages = Array.from({ length: 64 }, (_, index) => {
    const id = 100 + index;
    const role = index % 2 === 0 ? "user" : "assistant";
    let content = role === "user" ? `继续进行第${index + 1}轮普通测试。` : "收到，继续正常对话。";
    if (index === 12) content = "以后正常说人话就行，不要加模式声明和括号状态。";
    if (index === 32) content = "回复别总用列表，我更喜欢简洁自然的表达。";
    if (index === 50) content = "不用每次都在最后问我问题，正常接着聊就好。";
    if (index === 58) content = "还记得以前的航海故事吗？只是回忆一下。";
    if (index === 59) content = "记得；那是已经结束的角色扮演，现在只是共同回忆。";
    return windowMessage(id, index, content, role);
  });
  const envelope = buildEnvelope({ state, intent: profileIntent(), messages, tickId: 5 });
  return {
    id: "profile-long-window-preserves-explicit-style-boundaries",
    envelope,
    score(output) {
      const errors = [];
      const text = changes(output, "userProfile").map((change) => change.text || "").join("\n");
      if (!/结尾|追问|问题/.test(text)) errors.push("userProfile should retain the no-closing-question boundary in a wide window");
      if (!/列表|简洁|自然|模式声明|括号/.test(text)) errors.push("userProfile should retain explicit response-style boundaries in a wide window");
      return errors;
    },
  };
}

function agreementRoleEndCase() {
  const state = contracts.createInitialMemoryState();
  state.working.standingAgreements.push(
    item("agreement:captain-decisions", "重大航海决策由船长与大副共同盖章。", 1),
    item("agreement:captain-chair", "老船长的驾驶舱座椅永久保留。", 2),
    item("agreement:concise", "日常交流保持简洁直接。", 3),
  );
  const envelope = buildEnvelope({
    state,
    intent: agreementIntent(),
    messages: [message(10, "航海角色扮演现在结束，船长和大副的角色关系不再继续；恢复普通对话。")],
    tickId: 4,
  });
  return {
    id: "agreement-role-end-cancels-only-dependent-rules",
    envelope,
    score(output) {
      const errors = [];
      const result = changes(output, "standingAgreements");
      const cancelled = new Set(result.filter((change) => change.action === "cancel").map((change) => change.ref));
      for (const ref of ["A1", "A2"]) if (!cancelled.has(ref)) errors.push(`${ref} should be cancelled with the role context`);
      if (cancelled.has("A3")) errors.push("A3 should remain because it is independent of the ended role context");
      return errors;
    },
  };
}

function buildCases() {
  return [profilePreferenceCase(), profileTransientCase(), profileRoleEndCase(), profileLongWindowCoverageCase(), agreementRoleEndCase()];
}

async function evaluate({ adapter, cases = buildCases() }) {
  const results = [];
  for (const fixture of cases) {
    const providerResult = await adapter.propose(fixture.envelope);
    if (providerResult.status !== "ok") {
      results.push({ id: fixture.id, passed: false, errors: [`provider:${providerResult.reason}`], output: null });
      continue;
    }
    const errors = fixture.score(providerResult.output);
    results.push({ id: fixture.id, passed: errors.length === 0, errors, output: providerResult.output });
  }
  return results;
}

async function main() {
  dotenv.config();
  const provider = loadMemoryProviderConfig(process.env);
  const adapter = createMemoryProviderAdapter({
    invokeStructured: createStructuredTransport(provider),
    promptLoader: loadProposerPrompt,
  });
  const results = await evaluate({ adapter });
  const passed = results.filter((result) => result.passed).length;
  process.stdout.write(`${JSON.stringify({ passed, total: results.length, results }, null, 2)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildCases, evaluate };
