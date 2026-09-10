const {
  LIBRARIAN_BARRIER_TARGETS,
} = require("../contracts");
const {
  createLibrarianTaskExecutor,
  librarianTaskRow,
} = require("./librarianTaskExecutor");
const {
  nextLibrarianPeriodicOrdinal,
  furthestLibrarianBarrierCursor,
  findAlignedLibrarianBoundary,
} = require("../domain/librarianSchedule");

const MAX_REVISION_REBASE_ATTEMPTS = 4;
const TERMINAL_RUN_STATUSES = new Set(["committed", "noop", "completed"]);

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function createMemoryLibrarian({
  repositories,
  providerAdapter,
  config,
  drainBarrier,
  now,
  idFactory,
  metrics,
} = {}) {
  if (typeof repositories?.state?.getState !== "function"
    || typeof repositories?.source?.getBoundary !== "function"
    || typeof repositories?.source?.listCompleteTurnBoundaries !== "function"
    || typeof repositories?.runtime?.getLibrarianCheckpoint !== "function") {
    throw new Error("Memory Librarian scheduling repositories are required");
  }
  const taskExecutor = createLibrarianTaskExecutor({
    repositories,
    providerAdapter,
    config,
    now,
    idFactory,
    metrics,
  });

  async function ensureBarrier(userId, presetId, sourceGeneration, boundaryMessageId, skipBarrier) {
    let result = { status: "completed" };
    if (!skipBarrier) {
      if (typeof drainBarrier !== "function") throw new Error("Memory Librarian boundary barrier is unavailable");
      result = await drainBarrier(userId, presetId, {
        sourceGeneration,
        boundaryMessageId,
        targetKeys: LIBRARIAN_BARRIER_TARGETS,
      });
      if (result?.status !== "completed") {
        return { status: "incomplete", reason: "barrier_incomplete", barrier: result };
      }
    }
    const state = await repositories.state.getState(userId, presetId);
    if (!state || state.meta.sourceGeneration !== sourceGeneration) {
      return { status: "stale", reason: "generation_mismatch" };
    }
    const misaligned = LIBRARIAN_BARRIER_TARGETS.filter(
      (targetKey) => Number(state.meta.targetCursors[targetKey] ?? 0) !== boundaryMessageId,
    );
    if (misaligned.length) {
      return {
        status: "incomplete",
        reason: "barrier_misaligned",
        targetKeys: misaligned,
        boundaryMessageId,
      };
    }
    return result;
  }

  async function runAt(userId, presetId, {
    sourceGeneration,
    boundaryMessageId,
    watermarkOrdinal,
    watermarkKind = "complete_turn",
    triggerType,
    skipBarrier = false,
  } = {}) {
    const barrier = await ensureBarrier(userId, presetId, sourceGeneration, boundaryMessageId, skipBarrier);
    if (barrier.status !== "completed") return barrier;
    for (let staleAttempt = 0; staleAttempt < MAX_REVISION_REBASE_ATTEMPTS; staleAttempt += 1) {
      const state = await repositories.state.getState(userId, presetId);
      if (!state || state.meta.sourceGeneration !== sourceGeneration) {
        return { status: "stale", reason: "generation_mismatch" };
      }
      const envelope = await taskExecutor.createTask(userId, presetId, {
        boundaryMessageId,
        watermarkOrdinal,
        watermarkKind,
        triggerType,
      });
      const result = await taskExecutor.processEnvelope(envelope);
      if (result.status !== "stale") return result;
    }
    return { status: "incomplete", reason: "revision_churn" };
  }

  async function scheduleForBoundary(
    userId,
    presetId,
    boundaryMessageId,
    { triggerType = "periodic", skipBarrier = false } = {},
  ) {
    const state = await repositories.state.getState(userId, presetId);
    if (!state) return { status: "skipped", reason: "state_missing" };
    const turns = await repositories.source.listCompleteTurnBoundaries(userId, presetId, boundaryMessageId);
    const checkpoint = await repositories.runtime.getLibrarianCheckpoint(
      userId,
      presetId,
      state.meta.sourceGeneration,
    );
    let completedOrdinal = Number(rowValue(
      checkpoint,
      "completed_ordinal",
      "completedOrdinal",
    ) ?? 0);
    if ((rowValue(checkpoint, "watermark_kind", "watermarkKind") ?? "complete_turn") !== "complete_turn") {
      const completedBoundary = Number(rowValue(checkpoint, "boundary_message_id", "boundaryMessageId") ?? 0);
      completedOrdinal = turns.filter((entry) => entry.boundaryMessageId <= completedBoundary).length;
    }
    const results = [];
    let nextOrdinal = nextLibrarianPeriodicOrdinal(
      completedOrdinal,
      config.librarian.lagThreshold,
    );
    while (nextOrdinal <= turns.length) {
      const current = await repositories.state.getState(userId, presetId);
      if (!current || current.meta.sourceGeneration !== state.meta.sourceGeneration) {
        return { status: "stale", reason: "generation_mismatch", results };
      }
      const aligned = findAlignedLibrarianBoundary(turns, {
        minimumOrdinal: nextOrdinal,
        minimumBoundaryMessageId: furthestLibrarianBarrierCursor(current),
      });
      if (!aligned) {
        return {
          status: "completed",
          results,
          completeTurnCount: turns.length,
          awaitingAlignedCompleteTurn: true,
        };
      }
      const result = await runAt(userId, presetId, {
        sourceGeneration: state.meta.sourceGeneration,
        boundaryMessageId: aligned.boundaryMessageId,
        watermarkOrdinal: aligned.watermarkOrdinal,
        triggerType,
        skipBarrier,
      });
      results.push(result);
      if (!TERMINAL_RUN_STATUSES.has(result.status)) {
        return { status: "incomplete", reason: "librarian_not_terminal", results };
      }
      completedOrdinal = aligned.watermarkOrdinal;
      nextOrdinal = nextLibrarianPeriodicOrdinal(
        completedOrdinal,
        config.librarian.lagThreshold,
      );
    }
    return { status: "completed", results, completeTurnCount: turns.length };
  }

  async function runFinal(userId, presetId, boundaryMessageId, {
    triggerType = "rebuild_final",
    skipBarrier = false,
    schedule = null,
  } = {}) {
    const state = await repositories.state.getState(userId, presetId);
    if (!state) return { status: "skipped", reason: "state_missing" };
    const turns = schedule?.boundaries || await repositories.source.listCompleteTurnBoundaries(userId, presetId, boundaryMessageId);
    const watermarkKind = schedule?.watermarkKind || "complete_turn";
    const ordinal = turns.length;
    const checkpoint = await repositories.runtime.getLibrarianCheckpoint(
      userId,
      presetId,
      state.meta.sourceGeneration,
    );
    const checkpointBoundary = Number(rowValue(
      checkpoint,
      "boundary_message_id",
      "boundaryMessageId",
    ) ?? -1);
    const checkpointOrdinal = Number(rowValue(
      checkpoint,
      "completed_ordinal",
      "completedOrdinal",
    ) ?? -1);
    if (checkpointBoundary === boundaryMessageId && checkpointOrdinal === ordinal
      && (rowValue(checkpoint, "watermark_kind", "watermarkKind") ?? "complete_turn") === watermarkKind) {
      return { status: "completed", deduplicated: true, results: [] };
    }
    const result = await runAt(userId, presetId, {
      sourceGeneration: state.meta.sourceGeneration,
      boundaryMessageId,
      watermarkOrdinal: ordinal,
      watermarkKind,
      triggerType,
      skipBarrier,
    });
    return {
      status: TERMINAL_RUN_STATUSES.has(result.status) ? "completed" : "incomplete",
      results: [result],
    };
  }

  async function runScheduled(userId, presetId) {
    const boundary = await repositories.source.getBoundary(userId, presetId);
    return scheduleForBoundary(userId, presetId, boundary, { triggerType: "periodic" });
  }

  async function runManual(userId, presetId) {
    const boundary = await repositories.source.getBoundary(userId, presetId);
    return runFinal(userId, presetId, boundary, { triggerType: "manual" });
  }

  return Object.freeze({
    ...taskExecutor,
    runAt,
    runScheduled,
    scheduleForBoundary,
    runFinal,
    runManual,
  });
}

module.exports = { createMemoryLibrarian, librarianTaskRow };
