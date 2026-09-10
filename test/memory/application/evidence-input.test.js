const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLibrarianEnvelope } = require("../../../modules/memory/application/librarianRenderer");
const { hydrateEvidenceInput, EVIDENCE_INPUT_LIMITS } = require("../../../modules/memory/application/evidenceInput");
const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { sha256 } = require("../support/memory-builders");

function fixture(count = 1, chars = 20) {
  const state = createInitialMemoryState();
  const messages = Array.from({ length: count }, (_, i) => ({ id: i + 1, role: "user", content: "字".repeat(chars), contentHash: sha256("message" + i) }));
  state.longTerm.userProfile = messages.map(message => ({ id: "profile-" + message.id, text: "条目" + message.id, sourceRefs: [{ messageId: message.id, contentHash: message.contentHash }], createdAtMessageId: message.id, updatedAtMessageId: message.id }));
  const envelope = buildLibrarianEnvelope({ userId: 1, presetId: "test", state, boundaryMessageId: count, watermarkOrdinal: 1, triggerType: "manual", userTimeZone: "UTC" });
  return { state, messages, envelope };
}

test("historical evidence has a strict total input budget and never truncates authority", async () => {
  const f = fixture(70, 2000);
  const before = structuredClone(f.state);
  let requested;
  await hydrateEvidenceInput(f.envelope, { async getByIds(_u, _p, ids) { requested = ids; return f.messages.filter(m => ids.includes(m.id)); } });
  assert.equal(requested.length, EVIDENCE_INPUT_LIMITS.maxRefs);
  assert.ok(Array.from(f.envelope.artifact.publicInput.evidenceText).length <= EVIDENCE_INPUT_LIMITS.maxChars);
  assert.match(f.envelope.artifact.publicInput.evidenceText, /摘录不完整/);
  assert.match(f.envelope.artifact.publicInput.evidenceText, /不授权选择/);
  assert.ok(Object.keys(f.envelope.artifact.refMap.readOnly).length < 48);
  assert.deepEqual(f.state, before);
});

for (const reason of ["missing", "hash", "scope"]) {
  test("unavailable historical evidence is not selectable: " + reason, async () => {
    const f = fixture();
    const row = { ...f.messages[0] };
    if (reason === "hash") row.contentHash = sha256("edited");
    if (reason === "scope") row.userId = 9;
    await hydrateEvidenceInput(f.envelope, { async getByIds() { return reason === "missing" ? [] : [row]; } });
    assert.deepEqual(f.envelope.artifact.refMap.readOnly, {});
    assert.match(f.envelope.artifact.publicInput.evidenceText, /不授权选择/);
  });
}
