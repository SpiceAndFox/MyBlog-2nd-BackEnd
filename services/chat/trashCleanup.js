const { logger } = require("../../logger");
const chatModel = require("../../models/chatModel");
const memoryRuntime = require("./memoryRuntime");

const REQUIRED_ENV_KEYS = ["CHAT_TRASH_RETENTION_DAYS", "CHAT_TRASH_CLEAN_INTERVAL_MS", "CHAT_TRASH_PURGE_BATCH_SIZE"];

function isFiniteInteger(value) {
  return Number.isFinite(value) && Number.isInteger(value);
}

function daysToMs(days) {
  return days * 24 * 60 * 60 * 1000;
}

function computeCutoffDate({ now, retentionDays }) {
  const base = now instanceof Date ? now : new Date();
  return new Date(base.getTime() - daysToMs(retentionDays));
}

async function purgeExpiredTrashedSessions({ now = new Date(), retentionDays, batchSize } = {}) {
  if (!isFiniteInteger(retentionDays)) {
    throw new Error(`Invalid trash retentionDays (set CHAT_TRASH_RETENTION_DAYS). Got: ${String(retentionDays)}`);
  }

  if (retentionDays <= 0) return { purged: 0, disabled: true };

  if (!isFiniteInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid trash batchSize (set CHAT_TRASH_PURGE_BATCH_SIZE). Got: ${String(batchSize)}`);
  }

  const cutoff = computeCutoffDate({ now, retentionDays });
  const candidates = await chatModel.listTrashedSessionPurgeCandidates(cutoff, { limit: batchSize });
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.userId}:${candidate.presetId}`;
    const group = groups.get(key) || { userId: candidate.userId, presetId: candidate.presetId, sessionIds: [] };
    group.sessionIds.push(candidate.id);
    groups.set(key, group);
  }

  let purged = 0;
  for (const group of groups.values()) {
    const mutation = await memoryRuntime.privacyHardDelete(group.userId, group.presetId, {
      deleteRawSource: (client) => chatModel.purgeTrashedSessionIds(group.userId, group.presetId, group.sessionIds, { client }),
    });
    purged += Number(mutation.mutationResult) || 0;
  }

  return { purged, cutoff, retentionDays, batchSize };
}

function startChatTrashCleanup({ retentionDays, intervalMs, batchSize } = {}) {
  if (!isFiniteInteger(retentionDays) || !isFiniteInteger(intervalMs) || !isFiniteInteger(batchSize)) {
    logger.warn("chat_trash_cleanup_not_configured", {
      requiredEnv: REQUIRED_ENV_KEYS,
      retentionDays,
      intervalMs,
      batchSize,
    });
    return () => {};
  }

  if (intervalMs <= 0) {
    throw new Error(`Invalid trash cleanup intervalMs (set CHAT_TRASH_CLEAN_INTERVAL_MS). Got: ${String(intervalMs)}`);
  }

  if (retentionDays <= 0) {
    logger.info("chat_trash_cleanup_disabled", { retentionDays });
    return () => {};
  }

  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const result = await purgeExpiredTrashedSessions({ retentionDays, batchSize });
      if (result.disabled) return;
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
    } finally {
      running = false;
    }
  }

  void tick();

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  logger.info("chat_trash_cleanup_started", { retentionDays, intervalMs, batchSize });

  return () => clearInterval(timer);
}

module.exports = {
  startChatTrashCleanup,
  purgeExpiredTrashedSessions,
};
