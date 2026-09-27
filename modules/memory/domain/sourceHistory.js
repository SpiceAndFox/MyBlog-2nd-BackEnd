// Bounds are exclusive. Missing transitions and unknown source changes stop
// traversal: matching the surviving references alone cannot prove an old state
// was never influenced by an edited, deleted, or subsequently forgotten source.
function snapshotRecoveryBounds(sourceGeneration, affectedFromMessageId, history = []) {
  const bounds = new Map([[sourceGeneration, affectedFromMessageId]]);
  const transitions = new Map(history.map(row => [Number(row.source_generation), row]));
  let bound = affectedFromMessageId;
  for (let generation = sourceGeneration; generation > 0; generation -= 1) {
    const transition = transitions.get(generation);
    if (!transition) break;
    if (transition.source_unchanged !== true) {
      const affected = Number(transition.affected_from_message_id);
      if (!Number.isSafeInteger(affected) || affected <= 0) break;
      bound = Math.min(bound, affected);
    }
    bounds.set(generation - 1, bound);
  }
  return bounds;
}

module.exports = { snapshotRecoveryBounds };
