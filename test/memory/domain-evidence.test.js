const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeEvidenceText, validateQuote, validateEvidenceRefs,
} = require("../../modules/memory/domain");

test("quote normalization is Unicode-aware and uses the fixed punctuation set", () => {
  assert.equal(normalizeEvidenceText(" 你好，WORLD！— ok… "), "你好worldok");
  assert.equal(normalizeEvidenceText("Ａ"), "ａ", "normalization must not apply NFKC");
});

test("all quote lengths use equal-window Levenshtein matching", () => {
  assert.equal(validateQuote("我明天会把像皮还给她", "她说：我明天会把橡皮还给她。", { threshold: 0.75 }).ok, true);
  assert.deepEqual(validateQuote("！？…", "！？…"), { ok: false, reason: "quote_too_short", similarity: 0 });
  assert.equal(validateQuote("甲乙", "甲乙").reason, "quote_too_short");
  assert.equal(validateQuote("甲乙丙", "甲乙丙").ok, true);
  assert.equal(validateQuote("abc", "abx", { threshold: 0.75 }).reason, "quote_not_found");
  assert.equal(validateQuote("abc", "abx", { threshold: 0.66 }).ok, true);
  assert.equal(validateQuote("𠮷".repeat(200), "𠮷".repeat(200)).ok, true);
  assert.equal(validateQuote("𠮷".repeat(201), "𠮷".repeat(201)).reason, "quote_too_long");
});

test("fuzzy quote matching fails closed after its deterministic candidate budget", () => {
  const content = `${"abx".repeat(300)}near matcg`;
  assert.equal(validateQuote("near match", content, {
    threshold: 0.75,
    fuzzyMaxCandidateWindows: 0,
  }).reason, "quote_not_found");
  assert.equal(validateQuote("near match", content, {
    threshold: 0.75,
    fuzzyMaxCandidateWindows: 256,
  }).ok, true);
  assert.equal(validateQuote("exact match", `${"x".repeat(30_000)}exact match`, {
    threshold: 0.75,
    fuzzyMaxContentCodePoints: 20_000,
    fuzzyMaxCandidateWindows: 0,
  }).ok, true, "the linear exact-match path is not subject to fuzzy work limits");
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
