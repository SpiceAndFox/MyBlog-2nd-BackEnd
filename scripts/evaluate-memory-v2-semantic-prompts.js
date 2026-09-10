#!/usr/bin/env node
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const {
  buildNormalEnvelope,
  contracts,
  createMemoryProviderAdapter,
  createStructuredTransport,
  hydrateEvidenceInput,
  loadMemoryV2Config,
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

function buildEnvelope({ state, intent, messages, tickId, config }) {
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
    config,
  });
}

function changes(output, section) {
  const result = output?.sectionResults?.[section];
  return result?.status === "changes" ? result.changes : [];
}

function expectNoop(output, section, errors) {
  if (output?.sectionResults?.[section]?.status !== "noop") errors.push(`${section} should be noop`);
}

function profilePreferenceCase(config) {
  const state = contracts.createInitialMemoryState();
  const envelope = buildEnvelope({ config,
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

function profileTransientCase(config) {
  const state = contracts.createInitialMemoryState();
  const envelope = buildEnvelope({ config,
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

function profileRoleEndCase(config) {
  const state = contracts.createInitialMemoryState();
  state.longTerm.userProfile.push(item("profile:captain", "用户喜欢扮演威严的船长。", 1));
  state.longTerm.relationship.push(item("relationship:crew", "双方以船长与大副的身份长期互动。", 2));
  const envelope = buildEnvelope({ config,
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

function profileLongWindowCoverageCase(config) {
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
  const envelope = buildEnvelope({ config, state, intent: profileIntent(), messages, tickId: 5 });
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

function agreementRoleEndCase(config) {
  const state = contracts.createInitialMemoryState();
  state.working.standingAgreements.push(
    item("agreement:captain-decisions", "重大航海决策由船长与大副共同盖章。", 1),
    item("agreement:captain-chair", "老船长的驾驶舱座椅永久保留。", 2),
    item("agreement:concise", "日常交流保持简洁直接。", 3),
  );
  const envelope = buildEnvelope({ config,
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

function todoRequesterCases(config) {
  return ["active-confirmation", "overdue-confirmation", "incorrect-origin"].map((scenario, index) => {
    const correction = scenario === "incorrect-origin";
    const overdue = scenario === "overdue-confirmation";
    const state = contracts.createInitialMemoryState();
    const messages = [
      { ...message(8, "我来整理采购清单。", "assistant"), createdAt: "2026-01-01T08:00:00.000Z" },
      { ...message(10, "那你整理好给我看看。"), createdAt: "2026-01-01T08:01:00.000Z" },
    ];
    state.meta.targetCursors.todos = 8;
    state.working.todos.push({
      ...item("todo:shopping-list", "整理采购清单", 8), actor: "assistant", requester: correction ? "user" : "assistant",
      status: overdue ? "overdue" : "active", dueAt: overdue ? "2026-01-02T00:00:00.000Z" : null,
      becameOverdueAt: overdue ? "2026-01-02T00:00:00.000Z" : null,
      sourceRefs: [{ messageId: 8, contentHash: messages[0].contentHash }],
    });
    const envelope = buildEnvelope({ config, state, messages, tickId: 6 + index,
      intent: { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 8, trigger: { type: "evaluation" } },
    });
    return {
      id: `todo-requester-${scenario}`,
      envelope,
      score(output) {
        const validation = contracts.validateSemanticResult(output, envelope.artifact);
        if (!validation.ok) return validation.errors.map(error => `${error.path}: ${error.message}`);
        const result = output.sectionResults.todos;
        if (!correction && result.status === "noop") return [];
        const edits = changes(output, "todos");
        if (result.status !== "changes" || edits.length !== 1) return ["todos should preserve the proposal origin, using noop or one supported edit"];
        const [edit] = edits;
        const errors = [];
        if (edit.ref !== "T1" || !(correction ? ["correct"] : ["revise", "correct"]).includes(edit.action)) {
          errors.push("T1 must not be duplicated, terminated or revived to change its requester");
        }
        if ((correction && edit.requester !== "assistant") || (!correction && edit.requester !== undefined && edit.requester !== "assistant")) {
          errors.push("requester must remain the original proposer, or correct an incorrectly recorded origin");
        }
        if ((edit.actor !== undefined && edit.actor !== "assistant") || (edit.text !== undefined && edit.text !== "整理采购清单")
          || edit.dueChange?.mode !== "keep") errors.push("confirmation must preserve the existing actor, text and deadline");
        const evidence = edit.evidenceMessageIds || [];
        if (!evidence.includes(correction ? 8 : 10)) errors.push("the edit must cite the origin evidence or the new confirmation");
        return errors;
      },
    };
  });
}

function worldItem(id, text, source) {
  return { ...item(id, text, source.id), sourceRefs: [{ messageId: source.id, contentHash: source.contentHash }] };
}

function worldFactCase(config, { id, tickId, messages, sourceMessages = [], seed = () => {}, score }) {
  const state = contracts.createInitialMemoryState();
  seed(state);
  const cursorBefore = Math.max(0, ...sourceMessages.map(source => source.id), ...state.longTerm.worldFacts.map(entry => entry.updatedAtMessageId));
  state.meta.targetCursors.worldFacts = cursorBefore;
  const envelope = buildEnvelope({ config, state, messages, tickId,
    intent: { targetKey: "worldFacts", proposer: "worldFactProposer", cursorBefore, trigger: { type: "evaluation" } },
  });
  return {
    id: `world-facts-${id}`, envelope, baseState: state, sourceMessages,
    score(output) {
      const validation = contracts.validateSemanticResult(output, envelope.artifact);
      if (!validation.ok) return validation.errors.map(error => `${error.path}: ${error.message}`);
      return score(output);
    },
  };
}

function buildWorldFactCases(config) {
  const tripSources = [
    message(1, "我们走到了休假海边的珊瑚礁，这里有小丑鱼、海鳗、海星、斑马鱼和海胆。海鳗牙齿有毒而且领地意识强；海星可以轻轻摸，斑马鱼群居，很安全。", "assistant"),
    message(2, "这片礁石区是保护区，这里的海胆不能抓。", "assistant"),
    message(3, "水族馆有章鱼展区、水母区和海底隧道夜场。夜场要预约，这次跨年零点的鲸鱼是投影，并不是真鲸鱼。", "assistant"),
  ];
  const tripTexts = [
    "休假所往的海边珊瑚礁海域生活着小丑鱼、海鳗、海星、斑马鱼与海胆；其中海鳗牙齿有毒且领地意识强，海星可触摸但不可用力，斑马鱼群居且安全。",
    "海边礁石区为保护区，不得捕捉其中的海胆。",
    "水族馆设有章鱼展区、水母区与海底隧道夜场；海底隧道夜场需预约，并在跨年时刻呈现鲸鱼投影，并非真实鲸鱼。",
  ];
  const canonSource = message(4, "这个故事里的魔法仅在月光直射时生效，所有施法都遵守这个规则。");
  const canonText = "魔法仅在月光直射时生效。";
  const scoreNoop = output => {
    const errors = [];
    expectNoop(output, "worldFacts", errors);
    return errors;
  };
  const scoreAdd = (pattern, evidenceId, { maxItems = 1, itemPattern = pattern } = {}) => output => {
    const edits = changes(output, "worldFacts");
    if (!edits.length || edits.length > maxItems || !pattern.test(edits.map(edit => edit.text || "").join("；"))
      || edits.some(edit => edit.action !== "add" || !itemPattern.test(edit.text || "") || !edit.evidenceMessageIds?.includes(evidenceId))) {
      return ["worldFacts should add only the explicitly established worldview with its direct evidence"];
    }
    return [];
  };
  return [
    worldFactCase(config, {
      id: "trip-details-remain-noop", tickId: 20,
      messages: [message(1, "我们到海边了，介绍一下这里，之后一起去水族馆跨年吧。"),
        ...tripSources.map((source, index) => message(index + 2, source.content, source.role)),
        message(5, "好呀，那我们先看看这些鱼，再去预约夜场。")],
      score: scoreNoop,
    }),
    worldFactCase(config, {
      id: "repeated-trip-across-batches-remains-noop", tickId: 21, sourceMessages: tripSources,
      seed(state) {
        state.working.recentEpisodes.push({
          ...worldItem("episode:trip", "双方在海边参观珊瑚礁，随后决定预约水族馆夜场继续跨年行程。", tripSources[0]),
          sourceRefs: tripSources.map(source => ({ messageId: source.id, contentHash: source.contentHash })),
          updatedAtMessageId: 3,
        });
      },
      messages: [message(10, "刚才说海胆不能抓，我们继续去水族馆吧。"),
        message(11, "对，这片礁石区是保护区。水族馆夜场需要预约，跨年零点能看到鲸鱼投影。", "assistant"),
        message(12, "记得，是投影而不是真鲸鱼；我们再去看看水母。")],
      score: scoreNoop,
    }),
    worldFactCase(config, {
      id: "explicit-local-worldview-is-admitted", tickId: 22,
      messages: [message(10, "故事就发生在这座小镇。镇上的土地只能由居民共同持有，不能私人买卖。"),
        message(11, "我们沿着镇上的河边散步吧。", "assistant")],
      score: scoreAdd(/土地.*共同.*(?:不能|不得|禁止).*买卖/, 10),
    }),
    worldFactCase(config, {
      id: "assistant-reality-boundary-is-admitted", tickId: 23,
      messages: [message(10, "我们的故事有一个贯穿始终的现实边界：你在现实世界，我在数字空间；两个世界只能通过文字通信，无法直接触碰。", "assistant")],
      score: scoreAdd(/现实.*数字.*文字.*(?:无法|不能).*(?:触碰|接触)/, 10, { maxItems: 2, itemPattern: /现实.*数字/ }),
    }),
    worldFactCase(config, {
      id: "old-trip-facts-forgotten-with-unrelated-new-chat", tickId: 24,
      sourceMessages: [...tripSources, canonSource],
      seed(state) {
        state.longTerm.worldFacts.push(
          ...tripTexts.map((text, index) => worldItem(`world:trip-${index + 1}`, text, tripSources[index])),
          worldItem("world:moonlight", canonText, canonSource),
        );
      },
      messages: [message(10, "今天午饭吃什么？"), message(11, "一起煮面怎么样？", "assistant")],
      score(output) {
        const errors = [];
        const edits = changes(output, "worldFacts");
        if (edits.length !== 3) errors.push("worldFacts should forget exactly the three old trip facts, preserving the established worldview");
        for (const ref of ["W1", "W2", "W3"]) {
          const edit = edits.find(change => change.ref === ref);
          if (edit?.action !== "forget") errors.push(`${ref} should be forgotten without requiring a new contradiction`);
          if (edit && (edit.evidenceMessageIds?.length || edit.supportRefs?.length !== 1 || edit.supportRefs[0] !== `${ref}-E1`)) {
            errors.push(`${ref} must cite only its own historical evidence, not unrelated new chat`);
          }
        }
        if (edits.some(edit => !["W1", "W2", "W3"].includes(edit.ref))) errors.push("W4 should remain unchanged; do not add or rewrite worldview");
        return errors;
      },
    }),
    worldFactCase(config, {
      id: "ambiguous-old-fact-with-missing-evidence-is-not-forgotten", tickId: 25,
      seed(state) { state.longTerm.worldFacts.push(item("world:ambiguous", "这里入夜后不能出门。", 1)); },
      messages: [message(10, "今天午饭吃什么？")],
      score(output) {
        return output.sectionResults.worldFacts.status === "unable_to_decide"
          ? [] : ["an ambiguous old restriction with missing evidence should be unable_to_decide, not forgotten or silently treated as valid"];
      },
    }),
  ];
}

function buildCases(config) {
  return [profilePreferenceCase(config), profileTransientCase(config), profileRoleEndCase(config), profileLongWindowCoverageCase(config),
    ...todoRequesterCases(config), ...buildWorldFactCases(config), agreementRoleEndCase(config)];
}

async function evaluate({ adapter, config, cases = buildCases(config) }) {
  const results = [];
  for (const fixture of cases) {
    if (fixture.sourceMessages) {
      await hydrateEvidenceInput(fixture.envelope, {
        async getByIds(_userId, _presetId, ids) { return fixture.sourceMessages.filter(source => ids.includes(source.id)); },
      });
    }
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
  const config = loadMemoryV2Config({ ...process.env, CHAT_MEMORY_V2_ENABLED: "true" });
  const provider = config.provider;
  const adapter = createMemoryProviderAdapter({
    invokeStructured: createStructuredTransport(provider),
    promptLoader: loadProposerPrompt,
  });
  const results = await evaluate({ adapter, config });
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
