const {
  TYPED_PROFILE_SECTIONS,
  MULTI_VALUE_PROFILE_KEYS,
} = require("../contracts/constants");

const EXACT_TEXT_DEDUPE_SECTIONS = new Set([
  "standingAgreements",
  "worldFacts",
  ...TYPED_PROFILE_SECTIONS,
]);

function normalizeItemText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function hasTypedProfileMetadata(value) {
  return Boolean(value
    && typeof value.facet === "string"
    && typeof value.canonicalKey === "string"
    && typeof value.factBasis === "string");
}

function copyTypedProfileMetadata(value) {
  return hasTypedProfileMetadata(value)
    ? { facet: value.facet, canonicalKey: value.canonicalKey, factBasis: value.factBasis }
    : {};
}

function findDeterministicDuplicate(items, section, value, { excludeItemId = null } = {}) {
  const candidates = items.filter((item) => item.id !== excludeItemId);
  if (EXACT_TEXT_DEDUPE_SECTIONS.has(section)) {
    const text = normalizeItemText(value.text);
    if (text && candidates.some((item) => normalizeItemText(item.text) === text)) return "duplicate_item";
  }
  if (TYPED_PROFILE_SECTIONS.includes(section) && hasTypedProfileMetadata(value)
      && !MULTI_VALUE_PROFILE_KEYS[section].includes(value.canonicalKey)
      && candidates.some((item) => item.canonicalKey === value.canonicalKey)) {
    return "duplicate_profile_key";
  }
  return null;
}

function evidenceFingerprint(item) {
  return (item.evidenceGroups || [])
    .flatMap((group) => (group.refs || []).map((ref) => `${ref.messageId}:${ref.contentHash}`))
    .sort()
    .join("|");
}

function exactMergeGroupKey(section, item) {
  const text = normalizeItemText(item.text);
  if (!text) return null;
  if (EXACT_TEXT_DEDUPE_SECTIONS.has(section)) return `text:${text}`;
  if (section === "todos") return item.status === "active"
    ? `todo:${text}:${item.actor}:${item.requester}:${item.dueAt ?? ""}`
    : null;
  const evidence = evidenceFingerprint(item);
  return evidence ? `source:${text}:${evidence}` : null;
}

function sectionItems(state, section) {
  return ["todos", "standingAgreements", "recentEpisodes"].includes(section)
    ? state.working[section]
    : state.longTerm[section];
}

function buildDeterministicExactMergeOutput(state, task) {
  const section = task.targetSections[0];
  if (section === "recentEpisodes") return null;
  const groups = new Map();
  for (const item of sectionItems(state, section)) {
    const key = exactMergeGroupKey(section, item);
    if (!key) continue;
    const values = groups.get(key) || [];
    values.push(item);
    groups.set(key, values);
  }
  const patches = [...groups.values()]
    .filter((items) => items.length >= 2 && mergedProfileMetadata(section, items).ok)
    .map((items) => ({
      op: "mergeItems",
      itemIds: items.map((item) => item.id),
      value: { text: items[0].text },
      evidenceKind: "memory_compaction",
    }));
  if (!patches.length) return null;
  return {
    tickId: task.tickId,
    proposer: "compactionProposer",
    sectionResults: { [section]: { status: "patches", patches } },
  };
}

function mergedProfileMetadata(section, sources) {
  if (!TYPED_PROFILE_SECTIONS.includes(section)) return { ok: true, value: {} };
  const typed = sources.filter(hasTypedProfileMetadata);
  if (!typed.length) return { ok: true, value: {} };
  const facets = new Set(typed.map((item) => item.facet));
  const canonicalKeys = new Set(typed.map((item) => item.canonicalKey));
  if (facets.size !== 1 || canonicalKeys.size !== 1) return { ok: false, value: {} };
  return {
    ok: true,
    value: {
      facet: typed[0].facet,
      canonicalKey: typed[0].canonicalKey,
      factBasis: typed.some((item) => item.factBasis === "explicit") ? "explicit" : "observedPattern",
    },
  };
}

module.exports = {
  normalizeItemText,
  hasTypedProfileMetadata,
  copyTypedProfileMetadata,
  findDeterministicDuplicate,
  sectionItems,
  buildDeterministicExactMergeOutput,
  mergedProfileMetadata,
};
