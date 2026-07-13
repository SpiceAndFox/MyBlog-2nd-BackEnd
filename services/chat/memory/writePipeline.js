const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatMemoryConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { catchUpRollingSummaryOnce } = require("./pipeline/rollingSummary/catchUp");
const { catchUpCoreMemoryOnce } = require("./pipeline/coreMemory/catchUp");
const { computeCoreMemoryTarget } = require("./pipeline/targets");
const { runWithWorkerSlot } = require("./pipeline/workerSlot");
const { createTickScheduler } = require("./pipeline/tickScheduler");
const { createMemoryAdminOps } = require("./pipeline/admin");
const { buildKey, normalizeMessageId } = require("./pipeline/utils");

async function resolveCoreTargetMessageId({ userId, presetId, needsMemory } = {}) {
  if (!needsMemory || !chatMemoryConfig.coreMemoryEnabled) return null;

  try {
    const coreTarget = await computeCoreMemoryTarget({ userId, presetId });
    return normalizeMessageId(coreTarget.targetMessageId);
  } catch (error) {
    logger.error("chat_memory_core_target_compute_failed", {
      error,
      userId,
      presetId,
    });
    return null;
  }
}

async function updateCoreMemoryOnce({
  userId,
  presetId,
  needsMemory,
  targetMessageId,
  boundaryId,
  deadline,
  force = false,
  allowDuringRollingSummaryRebuild = false,
} = {}) {
  return await catchUpCoreMemoryOnce({
    userId,
    presetId,
    needsMemory,
    targetMessageId,
    boundaryId,
    deadline,
    force,
    allowDuringRollingSummaryRebuild,
    runWithWorkerSlot,
  });
}

async function processMemoryTick({ userId, presetId } = {}) {
  if (!chatMemoryConfig.legacyEnabled) return { updated: false, reason: "legacy_memory_disabled" };

  let summaryResult = null;
  try {
    summaryResult = await catchUpRollingSummaryOnce({
      userId,
      presetId,
      runWithWorkerSlot,
      updateCoreMemoryOnce,
    });
  } catch (error) {
    logger.error("chat_memory_rolling_summary_update_failed", {
      error,
      userId,
      presetId,
      providerId: chatMemoryConfig.workerProviderId,
      modelId: chatMemoryConfig.workerModelId,
    });
  }

  if (summaryResult?.updated) {
    logger.info("chat_memory_rolling_summary_updated", {
      userId,
      presetId,
      processedBatches: summaryResult.processedBatches,
      processedMessages: summaryResult.processedMessages,
    });
  }

  const needsMemory = summaryResult ? Boolean(summaryResult.needsMemory) : true;

  let coreResult = null;
  try {
    const coreTargetMessageId = await resolveCoreTargetMessageId({ userId, presetId, needsMemory });

    coreResult = await updateCoreMemoryOnce({
      userId,
      presetId,
      needsMemory,
      targetMessageId: coreTargetMessageId,
      boundaryId: summaryResult?.targetUntilMessageId,
    });
  } catch (error) {
    logger.error("chat_memory_core_update_failed", {
      error,
      userId,
      presetId,
      providerId: chatMemoryConfig.workerProviderId,
      modelId: chatMemoryConfig.workerModelId,
    });
  }

  if (coreResult?.updated) {
    logger.info("chat_memory_core_updated", {
      userId,
      presetId,
      coreMemoryChars: coreResult.coreMemoryChars,
      durationMs: coreResult.durationMs,
      coveredUntilMessageId: coreResult.coveredUntilMessageId,
      targetMessageId: coreResult.targetMessageId,
      boundaryId: coreResult.boundaryId,
      strictSyncEnabled: coreResult.strictSyncEnabled,
      usedFallback: coreResult.usedFallback,
      processedBatches: coreResult.processedBatches,
      processedMessages: coreResult.processedMessages,
      reason: coreResult.reason,
      summarizedUntilMessageId: coreResult.summarizedUntilMessageId,
      rollingSummaryUsed: coreResult.rollingSummaryUsed,
      rollingSummaryUsedBootstrap: coreResult.rollingSummaryUsedBootstrap,
      rollingSummaryUsedDelta: coreResult.rollingSummaryUsedDelta,
      rollingSummaryCheckpointMessageIdUsed: coreResult.rollingSummaryCheckpointMessageIdUsed,
      rollingSummarySkipReason: coreResult.rollingSummarySkipReason,
    });
  } else if (coreResult) {
    logger.debug("chat_memory_core_skipped", {
      userId,
      presetId,
      reason: coreResult.reason,
      invalidReason: coreResult.invalidReason,
      pendingMessages: coreResult.pendingMessages,
      thresholdMessages: coreResult.thresholdMessages,
      targetMessageId: coreResult.targetMessageId,
      boundaryId: coreResult.boundaryId,
      strictSyncEnabled: coreResult.strictSyncEnabled,
      summarizedUntilMessageId: coreResult.summarizedUntilMessageId,
      rollingSummaryUsed: coreResult.rollingSummaryUsed,
      rollingSummaryUsedBootstrap: coreResult.rollingSummaryUsedBootstrap,
      rollingSummaryUsedDelta: coreResult.rollingSummaryUsedDelta,
      rollingSummaryCheckpointMessageIdUsed: coreResult.rollingSummaryCheckpointMessageIdUsed,
      rollingSummarySkipReason: coreResult.rollingSummarySkipReason,
    });
  }
}

const tickScheduler = createTickScheduler({
  buildKey,
  processTick: processMemoryTick,
  onTickFailed: async ({ error, userId, presetId }) => {
    logger.error("chat_memory_tick_failed", {
      error,
      userId,
      presetId,
    });
  },
});

function requestMemoryTick({ userId, presetId } = {}) {
  if (!chatMemoryConfig.legacyEnabled) return false;
  tickScheduler.requestTick({ userId, presetId });
  return true;
}

function requestRollingSummaryCatchUp(args = {}) {
  requestMemoryTick(args);
}

async function rebuildRollingSummarySync({ userId, presetId } = {}) {
  if (!chatMemoryConfig.legacyEnabled) return { updated: false, reason: "legacy_memory_disabled" };

  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const key = buildKey(normalizedUserId, normalizedPresetId);
  const totalTimeoutMs = Number(chatMemoryConfig.syncRebuildTotalTimeoutMs) || 0;
  const deadline = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : null;

  return await tickScheduler.enqueueByKey(key, async () => {
    const result = await catchUpRollingSummaryOnce({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      deadline,
      force: true,
      keepRebuildLock: true,
      interleaveCoreMemory: true,
      runWithWorkerSlot,
      updateCoreMemoryOnce,
    });
    if (result?.updated) {
      logger.info("chat_memory_rolling_summary_rebuilt_sync", {
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        processedBatches: result.processedBatches,
        processedMessages: result.processedMessages,
      });
    }

    let coreResult = null;
    if (result?.needsMemory) {
      try {
        const coreTargetMessageId = await resolveCoreTargetMessageId({
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          needsMemory: true,
        });

        coreResult = await updateCoreMemoryOnce({
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          needsMemory: true,
          targetMessageId: coreTargetMessageId,
          boundaryId: result?.targetUntilMessageId,
          deadline,
          force: true,
          allowDuringRollingSummaryRebuild: true,
        });
      } catch (error) {
        logger.error("chat_memory_core_rebuild_sync_failed", {
          error,
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          providerId: chatMemoryConfig.workerProviderId,
          modelId: chatMemoryConfig.workerModelId,
        });
      }

      if (coreResult?.updated) {
        logger.info("chat_memory_core_rebuilt_sync", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          coreMemoryChars: coreResult.coreMemoryChars,
          durationMs: coreResult.durationMs,
          coveredUntilMessageId: coreResult.coveredUntilMessageId,
          targetMessageId: coreResult.targetMessageId,
          boundaryId: coreResult.boundaryId,
          strictSyncEnabled: coreResult.strictSyncEnabled,
          usedFallback: coreResult.usedFallback,
          processedBatches: coreResult.processedBatches,
          processedMessages: coreResult.processedMessages,
          reason: coreResult.reason,
          summarizedUntilMessageId: coreResult.summarizedUntilMessageId,
          rollingSummaryUsed: coreResult.rollingSummaryUsed,
          rollingSummaryUsedBootstrap: coreResult.rollingSummaryUsedBootstrap,
          rollingSummaryUsedDelta: coreResult.rollingSummaryUsedDelta,
          rollingSummaryCheckpointMessageIdUsed: coreResult.rollingSummaryCheckpointMessageIdUsed,
          rollingSummarySkipReason: coreResult.rollingSummarySkipReason,
        });
      } else if (coreResult) {
        logger.debug("chat_memory_core_rebuild_sync_skipped", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          reason: coreResult.reason,
          invalidReason: coreResult.invalidReason,
          pendingMessages: coreResult.pendingMessages,
          thresholdMessages: coreResult.thresholdMessages,
          processedBatches: coreResult.processedBatches,
          processedMessages: coreResult.processedMessages,
          targetMessageId: coreResult.targetMessageId,
          boundaryId: coreResult.boundaryId,
          strictSyncEnabled: coreResult.strictSyncEnabled,
          summarizedUntilMessageId: coreResult.summarizedUntilMessageId,
          rollingSummaryUsed: coreResult.rollingSummaryUsed,
          rollingSummaryUsedBootstrap: coreResult.rollingSummaryUsedBootstrap,
          rollingSummaryUsedDelta: coreResult.rollingSummaryUsedDelta,
          rollingSummaryCheckpointMessageIdUsed: coreResult.rollingSummaryCheckpointMessageIdUsed,
          rollingSummarySkipReason: coreResult.rollingSummarySkipReason,
        });
      }
    }

    try {
      await chatPresetMemoryModel.setRebuildRequired(normalizedUserId, normalizedPresetId, false);
    } catch (unlockError) {
      logger.error("chat_memory_rebuild_unlock_failed", { error: unlockError, userId: normalizedUserId, presetId: normalizedPresetId });
      throw unlockError;
    }

    return { ...result, coreResult };
  });
}

const {
  getPresetMemoryStatus,
  markPresetMemoryDirty,
  releasePresetMemoryRebuildLock,
  clearPresetCoreMemory,
} = createMemoryAdminOps({
  buildKey,
  enqueueByKey: tickScheduler.enqueueByKey,
});

module.exports = {
  requestMemoryTick,
  requestRollingSummaryCatchUp,
  rebuildRollingSummarySync,
  getPresetMemoryStatus,
  markPresetMemoryDirty,
  releasePresetMemoryRebuildLock,
  clearPresetCoreMemory,
};
