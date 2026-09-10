const {
  LIBRARIAN_BARRIER_TARGETS,
} = require("../contracts");

function nextLibrarianPeriodicOrdinal(completedOrdinal, lagThreshold) {
  const completed = Number(completedOrdinal);
  if (!Number.isSafeInteger(completed) || completed < 0) {
    throw new Error("Completed Librarian turn ordinal must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(lagThreshold) || lagThreshold < 1) {
    throw new Error("Librarian lag threshold must be a positive safe integer");
  }
  return (Math.floor(completed / lagThreshold) + 1) * lagThreshold;
}

function furthestLibrarianBarrierCursor(state) {
  return Math.max(
    ...LIBRARIAN_BARRIER_TARGETS.map(
      (targetKey) => Number(state?.meta?.targetCursors?.[targetKey] ?? 0),
    ),
  );
}

function findAlignedLibrarianBoundary(turns, {
  minimumOrdinal,
  minimumBoundaryMessageId = 0,
} = {}) {
  if (!Array.isArray(turns)) throw new Error("Complete turn boundaries must be an array");
  if (!Number.isSafeInteger(minimumOrdinal) || minimumOrdinal < 1) {
    throw new Error("Minimum Librarian turn ordinal must be a positive safe integer");
  }
  if (!Number.isSafeInteger(minimumBoundaryMessageId) || minimumBoundaryMessageId < 0) {
    throw new Error("Minimum Librarian boundary must be a non-negative safe integer");
  }
  let low = minimumOrdinal - 1;
  let high = turns.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (Number(turns[middle]?.boundaryMessageId) >= minimumBoundaryMessageId) {
      match = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (match < 0) return null;
  return {
    watermarkOrdinal: match + 1,
    boundaryMessageId: Number(turns[match].boundaryMessageId),
  };
}

module.exports = {
  nextLibrarianPeriodicOrdinal,
  furthestLibrarianBarrierCursor,
  findAlignedLibrarianBoundary,
  buildRebuildLibrarianSchedule,
  validateRebuildLibrarianSchedule,
};

function validateRebuildLibrarianSchedule(schedule, sourceBoundary) {
  if (!Number.isSafeInteger(sourceBoundary) || sourceBoundary < 0
    || !schedule || schedule.sourceBoundary !== sourceBoundary
    || !Number.isSafeInteger(schedule.messageBatchSize) || schedule.messageBatchSize < 1
    || (schedule.watermarkKind === "message_batch" && schedule.interval !== 1)
    || !["complete_turn", "message_batch"].includes(schedule.watermarkKind)
    || !Number.isSafeInteger(schedule.interval) || schedule.interval < 1
    || !Array.isArray(schedule.boundaries)) throw new Error("Invalid persisted Librarian rebuild schedule");
  let previous = 0;
  for (const entry of schedule.boundaries) {
    if (!Number.isSafeInteger(entry.boundaryMessageId) || entry.boundaryMessageId <= previous
      || entry.boundaryMessageId > sourceBoundary) throw new Error("Invalid Librarian schedule boundary");
    previous = entry.boundaryMessageId;
  }
  return schedule;
}

function buildRebuildLibrarianSchedule({ messages, turns, sourceBoundary, lagThreshold, messageBatchSize }) {
  if (!Number.isSafeInteger(messageBatchSize) || messageBatchSize < 1) throw new Error("Invalid Librarian message batch size");
  let previous = 0;
  for (const message of messages) {
    if (!Number.isSafeInteger(message.id) || message.id <= previous || message.id > sourceBoundary) throw new Error("Scheduling messages must be ordered inside the source boundary");
    previous = message.id;
  }
  const useTurns = turns.length > 0 && messages.length > 0 && messages.every((message) => message.hasTurnMetadata);
  const boundaries = useTurns
    ? turns.map(({ boundaryMessageId }) => ({ boundaryMessageId }))
    : messages.filter((_, index) => (index + 1) % messageBatchSize === 0).map(({ id }) => ({ boundaryMessageId: id }));
  return validateRebuildLibrarianSchedule({
    watermarkKind: useTurns ? "complete_turn" : "message_batch",
    sourceBoundary, interval: useTurns ? lagThreshold : 1, messageBatchSize, boundaries,
  }, sourceBoundary);
}
