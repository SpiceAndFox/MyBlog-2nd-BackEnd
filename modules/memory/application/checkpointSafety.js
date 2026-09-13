const { validateMemoryState, SCHEMA_VERSION, TARGET_KEYS } = require("../contracts");

function collectSourceRefs(value, refs = new Map()) {
  if (!value || typeof value !== "object") return refs;
  if (Array.isArray(value)) {
    for (const entry of value) if (!collectSourceRefs(entry, refs)) return null;
    return refs;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "sourceRefs") {
      if (!collectSourceRefs(entry, refs)) return null;
      continue;
    }
    for (const ref of entry) {
      const previous = refs.get(ref.messageId);
      if (previous && previous !== ref.contentHash) return null;
      refs.set(ref.messageId, ref.contentHash);
    }
  }
  return refs;
}

// Call under the source mutation transaction. A valid JSON shape alone is not
// evidence that a checkpoint belongs to the current, unchanged source history.
async function isSafeRecoveryCheckpoint(row, { sourceGeneration, maxRevision, boundaryMessageId,
  source, userId, presetId, client }) {
  const state = row?.state;
  const revision = Number(row?.revision);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > maxRevision
    || Number(row.source_generation ?? row.sourceGeneration) !== sourceGeneration
    || (row.schema_version ?? row.schemaVersion) !== SCHEMA_VERSION
    || !validateMemoryState(state).ok
    || state.meta.revision !== revision || state.meta.sourceGeneration !== sourceGeneration) return false;
  const cursors = TARGET_KEYS.map(key => state.meta.targetCursors[key] ?? 0);
  if (cursors.some(cursor => cursor > boundaryMessageId)) return false;
  const refs = collectSourceRefs(state);
  if (!refs) return false;
  const ids = [...new Set([...refs.keys(), ...cursors.filter(cursor => cursor > 0)])];
  if (!ids.length) return true;
  const messages = await source.getByIds(userId, presetId, ids, { client });
  const byId = new Map(messages.map(message => [message.id, message]));
  return ids.every(id => byId.has(id))
    && [...refs].every(([id, hash]) => byId.get(id)?.contentHash === hash);
}

async function* recoverySnapshots(audit, userId, presetId, { client, sourceGeneration }) {
  const limit = 32;
  let beforeRevision = null;
  for (;;) {
    const rows = await audit.listSnapshotsForRecovery(userId, presetId, { client, sourceGeneration, beforeRevision, limit });
    if (!rows.length) return;
    const ordered = rows.slice().sort((a, b) => Number(b.revision) - Number(a.revision));
    const next = Number(ordered.at(-1).revision);
    if (!Number.isSafeInteger(next) || next < 0 || (beforeRevision !== null && next >= beforeRevision)) {
      throw new Error("Recovery snapshot reader did not advance its revision cursor");
    }
    for (const row of ordered) yield row;
    if (rows.length < limit) return;
    beforeRevision = next;
  }
}

module.exports = { collectSourceRefs, isSafeRecoveryCheckpoint, recoverySnapshots };
