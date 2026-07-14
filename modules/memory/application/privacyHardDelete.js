const crypto = require("node:crypto");

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function createPrivacyHardDelete({ repositories, sourceRebuild, stores = [], enqueueByKey = (_key, work) => work(), idFactory = () => crypto.randomUUID() } = {}) {
  const privacy = repositories?.privacy;
  if (!privacy?.purgeDerivedHistory || !privacy?.upsertOperation || !privacy?.updateOperation) throw new Error("Privacy hard delete repository is required");
  if (stores.some((store) => typeof store?.purge !== "function" || typeof store?.verifyPurged !== "function")) throw new Error("Every privacy store requires purge and verifyPurged");

  async function purgeStores(userId, presetId, client) {
    for (const store of stores) await store.purge({ userId, presetId, client });
  }

  async function verifyStores(userId, presetId) {
    for (const store of stores) {
      const clean = await store.verifyPurged({ userId, presetId });
      if (!clean) return store.name || "external_store";
    }
    return null;
  }

  async function continueOperation(userId, presetId, operation, { repurge = false } = {}) {
    const mode = rowValue(operation, "operation_mode", "operationMode");
    if (repurge) await repositories.withTransaction((client) => purgeStores(userId, presetId, client));
    const residue = await verifyStores(userId, presetId);
    if (residue) {
      await privacy.updateOperation(userId, presetId, { status: "purging", lastErrorReason: `residue:${residue}` });
      return { status: "incomplete", reason: `residue:${residue}`, operationMode: mode };
    }
    await privacy.updateOperation(userId, presetId, { status: "verified", lastErrorReason: null });
    if (mode !== "rebuild") {
      await privacy.updateOperation(userId, presetId, { status: "completed", lastErrorReason: null });
      return { status: "completed", operationMode: mode };
    }
    if (!sourceRebuild?.forceDrainTo) throw new Error("Privacy rebuild operation requires source rebuild");
    const sourceGeneration = Number(rowValue(operation, "source_generation", "sourceGeneration"));
    const boundaryMessageId = Number(rowValue(operation, "boundary_message_id", "boundaryMessageId"));
    await privacy.updateOperation(userId, presetId, { status: "draining", lastErrorReason: null });
    const drained = await sourceRebuild.forceDrainTo(userId, presetId, { sourceGeneration, boundaryMessageId });
    if (drained.status === "completed") {
      await privacy.updateOperation(userId, presetId, { status: "completed", lastErrorReason: null });
      return { ...drained, operationMode: mode };
    }
    await privacy.updateOperation(userId, presetId, { status: "draining", lastErrorReason: `drain:${drained.status}` });
    return { ...drained, status: "incomplete", reason: `drain:${drained.status}`, operationMode: mode };
  }

  function execute(userId, presetId, { deleteRawSource, deleteScope = false, resetAuthority = false } = {}) {
    if (typeof deleteRawSource !== "function") throw new Error("deleteRawSource transaction callback is required");
    if (deleteScope && resetAuthority) throw new Error("Privacy delete cannot both delete and reset a scope");
    return enqueueByKey(`${userId}:${presetId}`, async () => {
      const operationId = idFactory();
      if (deleteScope || resetAuthority) {
        const operationMode = deleteScope ? "delete_scope" : "reset_authority";
        let mutationResult;
        await repositories.withTransaction(async (client) => {
          mutationResult = await deleteRawSource(client);
          await purgeStores(userId, presetId, client);
          await privacy.purgeDerivedHistory(userId, presetId, { client, preserveTombstones: resetAuthority });
          if (resetAuthority) await privacy.purgeAuthorityState(userId, presetId, { client });
          await privacy.upsertOperation(userId, presetId, {
            operationId, operationMode, sourceGeneration: null, boundaryMessageId: null,
            status: "purging", lastErrorReason: null,
          }, { client });
        });
        const continued = await continueOperation(userId, presetId, { operationMode });
        return { ...continued, mutationResult };
      }

      if (!sourceRebuild?.initializeGeneration || !sourceRebuild?.forceDrainTo) throw new Error("Privacy hard delete requires source rebuild");
      const initialized = await sourceRebuild.initializeGeneration(userId, presetId, {
        reason: "privacy_hard_delete",
        mutateSource: deleteRawSource,
        purgeDerived: async (client, metadata) => {
          await purgeStores(userId, presetId, client);
          await privacy.purgeDerivedHistory(userId, presetId, { client, preserveTombstones: true });
          await privacy.upsertOperation(userId, presetId, {
            operationId, operationMode: "rebuild", sourceGeneration: metadata.sourceGeneration,
            boundaryMessageId: metadata.boundaryMessageId, status: "purging", lastErrorReason: null,
          }, { client });
        },
      });
      const continued = await continueOperation(userId, presetId, {
        operationMode: "rebuild", sourceGeneration: initialized.sourceGeneration,
        boundaryMessageId: initialized.boundaryMessageId,
      });
      return { ...initialized, ...continued };
    });
  }

  async function reconcilePending() {
    if (typeof privacy.listIncompleteOperations !== "function") return {};
    const operations = await privacy.listIncompleteOperations();
    const results = {};
    for (const operation of operations) {
      const userId = Number(rowValue(operation, "user_id", "userId"));
      const presetId = String(rowValue(operation, "preset_id", "presetId") || "").trim();
      if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) continue;
      results[`${userId}:${presetId}`] = await enqueueByKey(
        `${userId}:${presetId}`,
        () => continueOperation(userId, presetId, operation, { repurge: rowValue(operation, "status", "status") === "purging" }),
      );
    }
    return results;
  }

  return Object.freeze({ execute, reconcilePending });
}

module.exports = { createPrivacyHardDelete };
