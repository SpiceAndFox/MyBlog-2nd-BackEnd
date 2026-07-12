const {
  QUOTE_IGNORABLE_PUNCTUATION,
  QUOTE_MAX_CODE_POINTS,
} = require("../contracts/constants");

const ignorablePunctuation = new Set(QUOTE_IGNORABLE_PUNCTUATION);
const informationCharacter = /[^\p{White_Space}\p{Punctuation}\p{Symbol}]/u;

function normalizeEvidenceText(value) {
  return Array.from(String(value).toLowerCase())
    .filter((character) => !/\p{White_Space}/u.test(character) && !ignorablePunctuation.has(character))
    .join("");
}

function levenshteinDistance(left, right) {
  const a = Array.isArray(left) ? left : Array.from(left);
  const b = Array.isArray(right) ? right : Array.from(right);
  if (a.length > b.length) return levenshteinDistance(b, a);
  let previous = Array.from({ length: a.length + 1 }, (_, index) => index);
  for (let row = 1; row <= b.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= a.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[column - 1] === b[row - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[a.length];
}

function bestEqualWindowSimilarity(quote, content) {
  const needle = Array.from(normalizeEvidenceText(quote));
  const haystack = Array.from(normalizeEvidenceText(content));
  if (!needle.length || haystack.length < needle.length) return 0;
  let best = 0;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    const window = haystack.slice(index, index + needle.length);
    const distance = levenshteinDistance(needle, window);
    if (distance === 0) return 1;
    best = Math.max(best, 1 - distance / needle.length);
  }
  return best;
}

function validateQuote(quote, rawContent, { threshold = 0.75, maxCodePoints = QUOTE_MAX_CODE_POINTS } = {}) {
  if (typeof quote !== "string" || !Array.from(quote).some((character) => informationCharacter.test(character))) {
    return { ok: false, reason: "quote_too_short", similarity: 0 };
  }
  if (Array.from(quote).length > maxCodePoints) {
    return { ok: false, reason: "quote_too_long", similarity: 0 };
  }
  const normalized = Array.from(normalizeEvidenceText(quote));
  const informationCount = normalized.filter((character) => informationCharacter.test(character)).length;
  if (informationCount < 3) return { ok: false, reason: "quote_too_short", similarity: 0 };
  const similarity = bestEqualWindowSimilarity(quote, rawContent);
  if (similarity < threshold) return { ok: false, reason: "quote_not_found", similarity };
  return { ok: true, similarity };
}

function expectedRole(evidenceKind) {
  if (evidenceKind.startsWith("user_")) return "user";
  if (evidenceKind.startsWith("assistant_")) return "assistant";
  return null;
}

function validateEvidenceRefs({ patch, task, observedMessages, databaseMessages, quoteConfig }) {
  const observedById = new Map(observedMessages.map((message) => [message.id, message]));
  const databaseById = new Map(databaseMessages.map((message) => [message.id, message]));
  const validated = [];
  for (const ref of patch.evidenceRefs) {
    const observed = observedById.get(ref.messageId);
    const database = databaseById.get(ref.messageId);
    if (!task.observedMessageIds.includes(ref.messageId) || !observed || !database) {
      return { ok: false, reason: "message_id_not_found" };
    }
    if (
      database.userId !== task.userId || database.presetId !== task.presetId ||
      database.role !== observed.role || database.createdAt !== observed.createdAt ||
      database.contentHash !== observed.contentHash
    ) return { ok: false, reason: "evidence_source_mismatch" };
    validated.push({ ref, database });
  }
  const role = expectedRole(patch.evidenceKind);
  if (role && validated.some(({ database }) => database.role !== role)) {
    return { ok: false, reason: "evidence_role_mismatch" };
  }
  const persistedRefs = [];
  for (const { ref, database } of validated) {
    const quoteResult = validateQuote(ref.quote, database.content, quoteConfig);
    if (!quoteResult.ok) return quoteResult;
    persistedRefs.push({ messageId: ref.messageId, contentHash: database.contentHash, quote: ref.quote });
  }
  return { ok: true, refs: persistedRefs };
}

module.exports = {
  normalizeEvidenceText,
  levenshteinDistance,
  bestEqualWindowSimilarity,
  validateQuote,
  validateEvidenceRefs,
};
