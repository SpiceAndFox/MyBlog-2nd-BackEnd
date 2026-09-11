#!/usr/bin/env node
// Synthetic, database-free evaluation. Running this script explicitly calls the configured provider.
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const {
  contracts, domain, buildNormalEnvelope, buildMaintenanceEnvelope, buildLibrarianEnvelope,
  hydrateEvidenceInput, createMemoryProviderAdapter, createStructuredTransport,
  createSemanticCompiler, loadMemoryV2Config, loadProposerPrompt, createRepairFeedback,
} = require("../modules/memory/admin");

const hash = text => `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
const message = (id, content) => ({ id, content, role: "user", contentKind: "raw", contentHash: hash(content), createdAt: new Date(Date.UTC(2026, 8, 9, 0, id)).toISOString() });
const item = (id, text, messages) => ({ id, text, sourceRefs: messages.map(m => ({ messageId: m.id, contentHash: m.contentHash })), createdAtMessageId: messages[0].id, updatedAtMessageId: messages.at(-1).id });
const items = (state, section) => ["standingAgreements", "recentEpisodes", "todos"].includes(section) ? state.working[section] : state.longTerm[section];

function cases(config) {
  const definitions = [
    { name: "thinking-repair", kind: "normal", section: "worldFacts", history: [], next: "我们设定的港城只有两座桥，这是一条固定世界设定。", repair: true, check: s => s.longTerm.worldFacts.length === 1 },
    { name: "worldfact-boundary", kind: "normal", section: "worldFacts", history: [], next: "我们看完日落，你陪着我坐了一会儿，我觉得很温暖。", check: (s, r) => s.longTerm.worldFacts.length === 0 && r.sectionResults.worldFacts.status === "noop" },
    { name: "episode-append", kind: "normal", section: "recentEpisodes", history: ["我们开始修理那台旧收音机，发现电池没电。"], texts: ["两人开始修理旧收音机，发现电池没电。"], next: "接着我们给同一台收音机换好了电池，终于听到了广播，我们为这次修理成功一起笑了。", check: (s, r) => s.working.recentEpisodes[0]?.text.includes(" → ") && r.sectionResults.recentEpisodes.changes?.some(c => c.action === "append") },
    { name: "worldfact-correct", kind: "normal", section: "worldFacts", history: ["港城的钟楼每天九点敲钟。"], texts: ["港城的钟楼每天九点敲钟。"], next: "更正一下刚才的信息：港城钟楼从来都是十点敲钟，九点是我记错了。", check: (s, r) => /十点|10点/.test(s.longTerm.worldFacts[0]?.text) && r.sectionResults.worldFacts.changes?.some(c => c.action === "correct") && s.longTerm.worldFacts[0].sourceRefs.every(ref => ref.messageId === 2) },
    { name: "compaction-duplicate", kind: "compaction", section: "worldFacts", history: ["港城位于海边。", "港城是一座海滨城市。"], texts: ["港城位于海边。", "港城是一座海滨城市。"], check: s => s.longTerm.worldFacts.length === 1 },
    { name: "compaction-conflict", kind: "compaction", section: "worldFacts", history: ["港城只有一座桥。", "港城有三座桥。"], texts: ["港城只有一座桥。", "港城有三座桥。"], check: (s, r) => r.sectionResults.worldFacts.status === "unable_to_compact" && s.longTerm.worldFacts.length === 2 },
    { name: "librarian-move", kind: "librarian", section: "worldFacts", history: ["我长期偏好简洁的回答。"], texts: ["用户长期偏好简洁的回答。"], check: s => s.longTerm.worldFacts.length === 0 && s.longTerm.userProfile.length === 1 },
    { name: "librarian-same-section-split", kind: "librarian", section: "userProfile", history: ["我的职业是牙医，目前住在杭州。", "我多年来一直喜欢绘画。"], composite: "用户是住在杭州的牙医；用户长期喜欢绘画。", check: s => s.longTerm.userProfile.length === 2 && s.longTerm.userProfile.every(i => i.sourceRefs.length === 1) },
    { name: "librarian-correct", kind: "librarian", section: "worldFacts", history: ["这个架空世界有两个太阳。"], texts: ["这个架空世界有三个太阳。"], check: s => /两个|2个/.test(s.longTerm.worldFacts[0]?.text) },
    { name: "librarian-remove", kind: "librarian", section: "userProfile", history: ["我长期喜欢绘画。", "我长期喜欢绘画。"], texts: ["用户长期喜欢绘画。", "用户长期喜欢绘画。"], check: (s, r) => s.longTerm.userProfile.length === 1 && r.operations.some(op => op.action === "remove") },
  ];
  return definitions.map((definition, index) => {
    const state = contracts.createInitialMemoryState();
    const history = definition.history.map((text, i) => message(i + 1, text));
    if (definition.composite) items(state, definition.section).push(item("composite", definition.composite, history));
    else for (const [i, text] of (definition.texts || []).entries()) items(state, definition.section).push(item("existing-" + i, text, [history[i]]));
    const messages = definition.next ? [...history, message(history.length + 1, definition.next)] : history;
    const common = { state, userId: 1, presetId: "synthetic-integrity", now: "2026-09-09T01:00:00.000Z", userTimeZone: "UTC", tickId: index + 1, taskId: "eval-" + definition.name, config };
    const targetKey = definition.section === "recentEpisodes" ? "episodes" : definition.section;
    const targetSections = targetKey === "episodes" ? ["recentEpisodes", "milestones"] : [definition.section];
    const proposer = targetKey === "episodes" ? "episodeProposer" : "worldFactProposer";
    let envelope;
    if (definition.kind === "librarian") envelope = buildLibrarianEnvelope({ ...common, boundaryMessageId: messages.at(-1).id, watermarkOrdinal: 1, triggerType: "manual" });
    else {
      state.meta.targetCursors[targetKey] = definition.kind === "normal" ? history.length : 0;
      const parentEnvelope = buildNormalEnvelope({ ...common, messages, intent: { targetKey, proposer, targetSections, cursorBefore: state.meta.targetCursors[targetKey], trigger: { type: "evaluation" } } });
      envelope = definition.kind === "compaction" ? buildMaintenanceEnvelope({ parentEnvelope, state, section: definition.section, violation: { dimension: "items", limit: 1 }, config, tickId: index + 1 }) : parentEnvelope;
    }
    return { ...definition, state, messages, envelope };
  });
}

async function main() {
  require("dotenv").config({ quiet: true });
  const config = loadMemoryV2Config({ ...process.env, CHAT_MEMORY_V2_ENABLED: "true" });
  const provider = config.provider;
  const adapter = createMemoryProviderAdapter({ invokeStructured: createStructuredTransport(provider), promptLoader: loadProposerPrompt });
  const results = [];
  const filter = process.argv[2] || "";
  for (const sample of cases(config).filter(sample => sample.name.includes(filter))) {
    const sourceReader = { async getByIds(_u, _p, ids) { return sample.messages.filter(m => ids.includes(m.id)); } };
    await hydrateEvidenceInput(sample.envelope, sourceReader);
    const started = Date.now();
    const attempts = [];
    let repairFeedback = sample.repair ? createRepairFeedback({ boundary: "output", errors: [{ path: "$", message: "must contain sectionStatuses and changes" }] }, 1, sample.envelope.task) : null;
    let rejectedOutput = sample.repair ? { bad: true } : undefined;
    let entry = { name: sample.name, before: sample.state };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await adapter.propose(sample.envelope, { repairFeedback, rejectedOutput });
      attempts.push({ status: result.status, reason: result.reason || null, usage: result.usage || null });
      try {
        if (result.status !== "ok") throw Object.assign(new Error(result.reason), { validationErrors: result.detail?.errors });
        let reduction = { state: sample.state, events: [], outcome: "noop" };
        const unable = Object.values(result.output.sectionResults || {}).some(r => r.status === "unable_to_compact" || r.status === "unable_to_decide");
        if (!unable) {
          const proposal = sample.kind === "librarian" ? domain.compileLibrarianProposal({ artifact: sample.envelope.artifact, semanticResult: result.output, baseState: sample.state }) : await createSemanticCompiler({ sourceReader }).compile({ artifact: sample.envelope.artifact, semanticResult: result.output, baseState: sample.state, userId: 1, presetId: "synthetic-integrity" });
          reduction = (sample.kind === "librarian" ? domain.reduceLibrarianProposal : domain.reduceCompiledProposal)({ state: sample.state, task: sample.envelope.task, proposal, config });
        }
        entry = { ...entry, mechanical: "passed", quality: sample.check(reduction.state, result.output) ? "passed" : "review", output: result.output, after: reduction.state, writes: domain.summarizeWriteEvents(reduction.events), items: domain.summarizeMemoryItems(reduction.state) };
        break;
      } catch (error) {
        entry = { ...entry, mechanical: "failed", reason: error.reason || error.message };
        rejectedOutput = result.output || result.rejectedOutput;
        repairFeedback = createRepairFeedback({ boundary: "output", errors: error.validationErrors || [{ path: "$", message: error.reason || error.message }] }, attempt + 1, sample.envelope.task);
      }
    }
    results.push({ ...entry, attempts, durationMs: Date.now() - started });
    process.stdout.write(JSON.stringify({ name: entry.name, mechanical: entry.mechanical, quality: entry.quality, attempts: attempts.length }) + "\n");
  }
  const report = { at: new Date().toISOString(), adapter: provider.adapter, profile: provider.profile,
    policy: provider.policy, modelRules: provider.modelRules, proposerModels: provider.proposerModels,
    model: provider.model, thinkingMode: provider.thinkingMode, reasoningEffort: provider.reasoningEffort, sampleKind: "synthetic", results };
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile("reports/memory-integrity-live.json", JSON.stringify(report, null, 2));
  if (results.some(r => r.mechanical !== "passed" || r.quality !== "passed")) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
module.exports = { cases };
