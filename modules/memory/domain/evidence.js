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

function boundedLevenshteinDistance(left, right, maxDistance) {
  const a = Array.isArray(left) ? left : Array.from(left);
  const b = Array.isArray(right) ? right : Array.from(right);
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index <= maxDistance ? index : maxDistance + 1);
  for (let row = 1; row <= a.length; row += 1) {
    const current = Array(b.length + 1).fill(maxDistance + 1);
    if (row <= maxDistance) current[0] = row;
    const start = Math.max(1, row - maxDistance);
    const end = Math.min(b.length, row + maxDistance);
    for (let column = start; column <= end; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] <= maxDistance ? previous[b.length] : maxDistance + 1;
}

function adjustFrequencyDelta(counts, character, delta, currentDelta) {
  const before = counts.get(character) || 0;
  const after = before + delta;
  if (after) counts.set(character, after);
  else counts.delete(character);
  return currentDelta - Math.abs(before) + Math.abs(after);
}

function qGramAt(characters, index, size) {
  return characters.slice(index, index + size).join("");
}

function rejectedSimilarity(threshold) {
  return threshold > 0 ? Math.max(0, threshold - Number.EPSILON) : 0;
}

function bestEqualWindowSimilarity(quote, content, {
  threshold = 0.75,
  fuzzyMaxContentCodePoints = 20_000,
  fuzzyMaxCandidateWindows = 256,
} = {}) {
  const needle = Array.from(normalizeEvidenceText(quote));
  const haystack = Array.from(normalizeEvidenceText(content));
  if (!needle.length || haystack.length < needle.length) return 0;
  const normalizedNeedle = needle.join("");
  if (haystack.join("").includes(normalizedNeedle)) return 1;
  if (haystack.length > fuzzyMaxContentCodePoints) return 0;
  const maxDistance = Math.max(0, Math.floor((1 - threshold) * needle.length + Number.EPSILON));
  const gramSize = Math.min(3, needle.length);
  const counts = new Map();
  let gramDelta = 0;
  for (let index = 0; index <= needle.length - gramSize; index += 1) {
    gramDelta = adjustFrequencyDelta(counts, qGramAt(needle, index, gramSize), -1, gramDelta);
    gramDelta = adjustFrequencyDelta(counts, qGramAt(haystack, index, gramSize), 1, gramDelta);
  }
  let comparedWindows = 0;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    // The q-gram profile distance is a safe lower bound: one edit changes at
    // most 2q profile entries. It cheaply rejects most impossible windows.
    if (Math.ceil(gramDelta / (2 * gramSize)) <= maxDistance) {
      if (comparedWindows >= fuzzyMaxCandidateWindows) return rejectedSimilarity(threshold);
      comparedWindows += 1;
      const window = haystack.slice(index, index + needle.length);
      const distance = boundedLevenshteinDistance(needle, window, maxDistance);
      if (distance <= maxDistance) return 1 - distance / needle.length;
    }
    if (index < haystack.length - needle.length) {
      gramDelta = adjustFrequencyDelta(counts, qGramAt(haystack, index, gramSize), -1, gramDelta);
      gramDelta = adjustFrequencyDelta(counts, qGramAt(haystack, index + needle.length - gramSize + 1, gramSize), 1, gramDelta);
    }
  }
  return rejectedSimilarity(threshold);
}

function validateQuote(quote, rawContent, {
  threshold = 0.75,
  maxCodePoints = QUOTE_MAX_CODE_POINTS,
  fuzzyMaxContentCodePoints = 20_000,
  fuzzyMaxCandidateWindows = 256,
} = {}) {
  if (typeof quote !== "string" || !Array.from(quote).some((character) => informationCharacter.test(character))) {
    return { ok: false, reason: "quote_too_short", similarity: 0 };
  }
  if (Array.from(quote).length > maxCodePoints) {
    return { ok: false, reason: "quote_too_long", similarity: 0 };
  }
  const normalized = Array.from(normalizeEvidenceText(quote));
  const informationCount = normalized.filter((character) => informationCharacter.test(character)).length;
  if (informationCount < 3) return { ok: false, reason: "quote_too_short", similarity: 0 };
  const similarity = bestEqualWindowSimilarity(quote, rawContent, { threshold, fuzzyMaxContentCodePoints, fuzzyMaxCandidateWindows });
  if (similarity < threshold) return { ok: false, reason: "quote_not_found", similarity };
  return { ok: true, similarity };
}

function expectedRole(evidenceKind) {
  if (evidenceKind.startsWith("user_")) return "user";
  if (evidenceKind.startsWith("assistant_")) return "assistant";
  return null;
}

function validateEvidenceRefs({ patch, task, observedMessages, databaseMessages, quoteConfig, onQuoteValidated }) {
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
    onQuoteValidated?.(quoteResult);
    if (!quoteResult.ok) return quoteResult;
    persistedRefs.push({ messageId: ref.messageId, contentHash: database.contentHash, quote: ref.quote });
  }
  return { ok: true, refs: persistedRefs };
}

module.exports = {
  normalizeEvidenceText,
  levenshteinDistance,
  boundedLevenshteinDistance,
  bestEqualWindowSimilarity,
  validateQuote,
  validateEvidenceRefs,
};
