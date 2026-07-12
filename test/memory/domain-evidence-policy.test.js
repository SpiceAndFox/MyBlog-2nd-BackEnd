const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeEvidenceText, validateQuote, validateEvidenceRefs, isPolicyAllowed,
} = require("../../modules/memory/domain");

test("quote normalization is Unicode-aware and uses the fixed punctuation set", () => {
  assert.equal(normalizeEvidenceText(" 你好，WORLD！— ok… "), "你好worldok");
  assert.equal(normalizeEvidenceText("Ａ"), "ａ", "normalization must not apply NFKC");
});

test("all quote lengths use equal-window Levenshtein matching", () => {
  assert.equal(validateQuote("我明天会把像皮还给她", "她说：我明天会把橡皮还给她。", { threshold: 0.75 }).ok, true);
  assert.deepEqual(validateQuote("！？…", "！？…"), { ok: false, reason: "quote_too_short", similarity: 0 });
  assert.equal(validateQuote("abc", "abx", { threshold: 0.75 }).reason, "quote_not_found");
  assert.equal(validateQuote("a".repeat(201), "a".repeat(201)).reason, "quote_too_long");
});

test("evidence validation rechecks task membership, database metadata, role, and hash", () => {
  const base = {
    patch: { evidenceKind: "user_correction", evidenceRefs: [{ messageId: 4, quote: "名字不是小王" }] },
    task: { userId: 1, presetId: "p", observedMessageIds: [4] },
    observedMessages: [{ id: 4, role: "user", createdAt: "2026-01-01T00:00:00.000Z", contentHash: "sha256:x" }],
    databaseMessages: [{ id: 4, userId: 1, presetId: "p", role: "user", createdAt: "2026-01-01T00:00:00.000Z", contentHash: "sha256:x", content: "我的名字不是小王，是小李" }],
    quoteConfig: { threshold: 0.75, maxCodePoints: 200 },
  };
  assert.equal(validateEvidenceRefs(base).ok, true);
  assert.equal(validateEvidenceRefs({ ...base, patch: { ...base.patch, evidenceKind: "assistant_correction" } }).reason, "evidence_role_mismatch");
  assert.equal(validateEvidenceRefs({ ...base, databaseMessages: [{ ...base.databaseMessages[0], contentHash: "sha256:y" }] }).reason, "evidence_source_mismatch");
  assert.equal(validateEvidenceRefs({ ...base, task: { ...base.task, observedMessageIds: [] } }).reason, "message_id_not_found");
});

test("policy table accepts and rejects the documented combinations", () => {
  assert.equal(isPolicyAllowed("scene", "setField", "scene_change"), true);
  assert.equal(isPolicyAllowed("todos", "addItem", "assistant_commitment"), true);
  assert.equal(isPolicyAllowed("standingAgreements", "cancelAgreement", "agreement_cancel"), true);
  assert.equal(isPolicyAllowed("milestones", "addItem", "recent_episode"), false);
  assert.equal(isPolicyAllowed("milestones", "addItem", "relationship_milestone"), true);
  for (const section of ["worldFacts", "userProfile", "assistantProfile", "relationship"]) {
    assert.equal(isPolicyAllowed(section, "addItem", "long_term_fact"), true);
    assert.equal(isPolicyAllowed(section, "addItem", "scene_change"), false);
    assert.equal(isPolicyAllowed(section, "updateItem", "long_term_fact"), false);
    assert.equal(isPolicyAllowed(section, "updateItem", "user_correction"), true);
    assert.equal(isPolicyAllowed(section, "forgetItem", "assistant_forget"), true);
  }
});
