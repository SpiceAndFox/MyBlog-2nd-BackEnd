const { TYPED_PROFILE_SECTIONS } = require("../contracts/constants");

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
  hasTypedProfileMetadata,
  copyTypedProfileMetadata,
  mergedProfileMetadata,
};
