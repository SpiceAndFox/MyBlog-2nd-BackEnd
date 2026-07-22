function parseTimeMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function buildTimeContextState({ recentCandidates } = {}) {
  const candidates = Array.isArray(recentCandidates) ? recentCandidates : [];
  const current = candidates.length ? candidates[candidates.length - 1] : null;
  const previous = candidates.length > 1 ? candidates[candidates.length - 2] : null;

  const nowMs = parseTimeMs(current?.created_at || current?.createdAt) ?? Date.now();
  const lastMs = parseTimeMs(previous?.created_at || previous?.createdAt);
  const gapMs = lastMs === null ? null : Math.max(0, nowMs - lastMs);

  return {
    nowMs,
    lastMs,
    gapMs,
  };
}

module.exports = {
  buildTimeContextState,
};
