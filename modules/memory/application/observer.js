const { TARGETS, TARGET_KEYS } = require("../contracts");

function statusByTarget(rows) {
  return new Map(rows.map((row) => [row.target_key ?? row.targetKey, row]));
}

function canScheduleNormal(status, now) {
  if (!status || status.status === "healthy") return true;
  if (status.status !== "retry_wait") return false;
  const nextRetryAt = status.next_retry_at ?? status.nextRetryAt;
  return nextRetryAt !== null && nextRetryAt !== undefined && new Date(nextRetryAt).getTime() <= now.getTime();
}

function createObserver({ sourceRepository, stateRepository, runtimeRepository, config, now = () => new Date() } = {}) {
  if (!sourceRepository || !stateRepository || !runtimeRepository) throw new Error("Observer repositories are required");
  if (!config?.targets) throw new Error("Memory target config is required");

  async function observe(userId, presetId) {
    const [state, statuses] = await Promise.all([
      stateRepository.getState(userId, presetId),
      runtimeRepository.getTargetStatuses(userId, presetId),
    ]);
    if (!state) return { state: null, eligibleTasks: [] };
    const byTarget = statusByTarget(statuses);
    const currentTime = now();
    const eligibleTasks = [];
    for (const targetKey of TARGET_KEYS) {
      if (!canScheduleNormal(byTarget.get(targetKey), currentTime)) continue;
      const cursorBefore = state.meta.targetCursors[targetKey] ?? 0;
      const targetConfig = config.targets[targetKey];
      const lag = await sourceRepository.countAfter(userId, presetId, cursorBefore);
      if (lag < targetConfig.lagThreshold) continue;
      eligibleTasks.push({
        targetKey,
        proposer: TARGETS[targetKey].proposer,
        targetSections: TARGETS[targetKey].sections.slice(),
        cursorBefore,
        lag,
        trigger: { type: "lagThreshold" },
      });
    }
    return { state, eligibleTasks };
  }

  return Object.freeze({ observe });
}

module.exports = { createObserver, canScheduleNormal };
