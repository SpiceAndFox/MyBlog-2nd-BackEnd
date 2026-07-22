const REQUIRED_CONFIG_KEYS = ["trashRetentionDays", "trashCleanupIntervalMs", "trashPurgeBatchSize"];

function createChatTrashCleanup({ config, chatRepository, memory, logger } = {}) {
  if (!config || typeof config !== "object") throw new Error("Chat trash cleanup config is required");
  if (!chatRepository?.listTrashedSessionPurgeCandidates || !chatRepository?.purgeTrashedSessionIds) {
    throw new Error("Chat repository is required");
  }
  if (typeof memory?.privacyHardDelete !== "function") throw new Error("Chat Memory privacy port is required");
  if (!logger?.info || !logger?.warn || !logger?.error) throw new Error("Chat trash cleanup logger is required");

  function isInteger(value) {
    return Number.isFinite(value) && Number.isInteger(value);
  }

  async function purge({ now = new Date(), retentionDays = config.trashRetentionDays, batchSize = config.trashPurgeBatchSize } = {}) {
    if (!isInteger(retentionDays)) throw new Error(`Invalid trash retentionDays. Got: ${String(retentionDays)}`);
    if (retentionDays <= 0) return { purged: 0, disabled: true };
    if (!isInteger(batchSize) || batchSize <= 0) throw new Error(`Invalid trash batchSize. Got: ${String(batchSize)}`);
    const cutoff = new Date((now instanceof Date ? now : new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const candidates = await chatRepository.listTrashedSessionPurgeCandidates(cutoff, { limit: batchSize });
    const groups = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.userId}:${candidate.presetId}`;
      const group = groups.get(key) || {
        userId: candidate.userId,
        presetId: candidate.presetId,
        sessionIds: [],
        affectedFromMessageId: null,
      };
      group.sessionIds.push(candidate.id);
      if (Number.isSafeInteger(candidate.firstMessageId) && candidate.firstMessageId > 0) {
        group.affectedFromMessageId = group.affectedFromMessageId === null
          ? candidate.firstMessageId
          : Math.min(group.affectedFromMessageId, candidate.firstMessageId);
      }
      groups.set(key, group);
    }
    let purged = 0;
    for (const group of groups.values()) {
      const mutation = await memory.privacyHardDelete(group.userId, group.presetId, {
        affectedFromMessageId: group.affectedFromMessageId,
        deleteRawSource: (client) => chatRepository.purgeTrashedSessionIds(
          group.userId,
          group.presetId,
          group.sessionIds,
          { client },
        ),
      });
      purged += Number(mutation.mutationResult) || 0;
    }
    return { purged, cutoff, retentionDays, batchSize };
  }

  function start() {
    const retentionDays = config.trashRetentionDays;
    const intervalMs = config.trashCleanupIntervalMs;
    const batchSize = config.trashPurgeBatchSize;
    if (![retentionDays, intervalMs, batchSize].every(isInteger)) {
      logger.warn("chat_trash_cleanup_not_configured", { requiredConfig: REQUIRED_CONFIG_KEYS, retentionDays, intervalMs, batchSize });
      return () => {};
    }
    if (intervalMs <= 0) throw new Error(`Invalid trash cleanup intervalMs. Got: ${String(intervalMs)}`);
    if (retentionDays <= 0) {
      logger.info("chat_trash_cleanup_disabled", { retentionDays });
      return () => {};
    }
    let activeTick = null;
    async function tick() {
      try {
        const result = await purge();
        if (result.purged > 0) {
          logger.info("chat_trash_cleanup_purged", {
            purged: result.purged,
            cutoff: result.cutoff.toISOString(),
            retentionDays: result.retentionDays,
            batchSize: result.batchSize,
          });
        }
      } catch (error) {
        logger.error("chat_trash_cleanup_failed", { error });
      }
    }
    function runTick() {
      if (activeTick) return;
      activeTick = tick();
      void activeTick.finally(() => { activeTick = null; });
    }
    runTick();
    const timer = setInterval(runTick, intervalMs);
    timer.unref?.();
    logger.info("chat_trash_cleanup_started", { retentionDays, intervalMs, batchSize });
    return async () => {
      clearInterval(timer);
      if (activeTick) await activeTick;
    };
  }

  return Object.freeze({ purge, start });
}

module.exports = { createChatTrashCleanup };
