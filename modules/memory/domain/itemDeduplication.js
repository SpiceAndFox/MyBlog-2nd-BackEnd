const { TYPED_PROFILE_SECTIONS, MULTI_VALUE_PROFILE_KEYS } = require("../contracts/constants");
const { hasTypedProfileMetadata } = require("./profileMetadata");

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

function findDeterministicDuplicate(items, section, value, { excludeItemId = null } = {}) {
  const candidates = items.filter((item) => item.id !== excludeItemId);
  if (EXACT_TEXT_DEDUPE_SECTIONS.has(section)) {
    const text = normalizeItemText(value.text);
    if (text && candidates.some((item) => normalizeItemText(item.text) === text)) return "duplicate_item";
  }
  if (TYPED_PROFILE_SECTIONS.includes(section) && hasTypedProfileMetadata(value)
      && !MULTI_VALUE_PROFILE_KEYS[section].includes(value.canonicalKey)
      && candidates.some((item) => item.canonicalKey === value.canonicalKey)) return "duplicate_profile_key";
  return null;
}

function sourceFingerprint(item) {
  return (item.sourceRefs || [])
    .map((ref) => `${ref.messageId}:${ref.contentHash}`)
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
  const provenance = sourceFingerprint(item);
  return provenance ? `source:${text}:${provenance}` : null;
}

function sectionItems(state, section) {
  return ["todos", "standingAgreements", "recentEpisodes"].includes(section)
    ? state.working[section]
    : state.longTerm[section];
}

function buildDeterministicExactMergeOutput(state, task, artifact) {
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
  if (!artifact) {
    const patches = [...groups.values()].filter((items) => items.length >= 2).map((items) => ({
      op: "mergeItems", itemIds: items.map((item) => item.id), value: { text: items[0].text }, evidenceKind: "memory_compaction",
    }));
    return patches.length ? { tickId: task.tickId, proposer: "compactionProposer", sectionResults: { [section]: { status: "patches", patches } } } : null;
  }
  const refByItemId = new Map(Object.entries(artifact?.refMap?.writable || {}).map(([ref, entry]) => [entry.itemId, ref]));
  const changes = [...groups.values()]
    .filter((items) => items.length >= 2 && items.every((item) => refByItemId.has(item.id)))
    .map((items) => ({
      action: "merge",
      refs: items.map((item) => refByItemId.get(item.id)),
      text: items[0].text,
    }));
  if (!changes.length) return null;
  return {
    tickId: task.tickId,
    proposer: "compactionProposer",
    sectionResults: { [section]: { status: "changes", changes } },
  };
}

module.exports = {
  normalizeItemText,
  findDeterministicDuplicate,
  sectionItems,
  buildDeterministicExactMergeOutput,
};
