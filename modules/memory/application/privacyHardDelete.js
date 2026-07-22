const crypto = require("node:crypto");

function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function createPrivacyHardDelete({ repositories, sourceRebuild, stores = [], enqueueByKey = (_key, work) => work(), idFactory = () => crypto.randomUUID(), onBackgroundError } = {}) {
  const privacy = repositories?.privacy;
  if (!privacy?.purgeDerivedHistory || !privacy?.upsertOperation || !privacy?.updateOperation) throw new Error("Privacy hard delete repository is required");
  if (stores.some((store) => typeof store?.purge !== "function" || typeof store?.verifyPurged !== "function")) throw new Error("Every privacy store requires purge and verifyPurged");
  const backgroundOperations = new Set();

  async function purgeStores(userId, presetId, operation, client) {
    for (const store of stores) await store.purge({ userId, presetId, operation, client });
  }

  async function verifyStores(userId, presetId, operation) {
    for (const store of stores) {
      const clean = await store.verifyPurged({ userId, presetId, operation });
      if (!clean) return store.name || "external_store";
    }
    return null;
  }

  async function continueOperation(userId, presetId, operation, { repurge = false } = {}) {
    const mode = rowValue(operation, "operation_mode", "operationMode");
    if (repurge) await repositories.withTransaction((client) => purgeStores(userId, presetId, operation, client));
    const residue = await verifyStores(userId, presetId, operation);
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

  function dispatch(userId, presetId, operation) {
    const key = `${userId}:${presetId}`;
    const promise = new Promise((resolve) => setImmediate(resolve)).then(() => enqueueByKey(key, async () => {
      const latest = typeof privacy.getOperation === "function"
        ? await privacy.getOperation(userId, presetId)
        : operation;
      if (!latest || rowValue(latest, "status", "status") === "completed") return latest;
      return continueOperation(userId, presetId, latest, { repurge: true });
    }));
    backgroundOperations.add(promise);
    void promise.finally(() => backgroundOperations.delete(promise)).catch(() => {});
    promise.catch(async (error) => {
      try {
        const latest = typeof privacy.getOperation === "function"
          ? await privacy.getOperation(userId, presetId)
          : operation;
        const status = rowValue(latest, "status", "status") || "purging";
        if (status !== "completed") {
          await privacy.updateOperation(userId, presetId, {
            status,
            lastErrorReason: `background:${String(error?.code || error?.message || error).slice(0, 180)}`,
          });
        }
      } catch {
        // The durable operation remains incomplete and startup reconciliation retries it.
      }
      onBackgroundError?.(error);
    });
  }

  async function waitForIdle() {
    while (backgroundOperations.size) {
      await Promise.allSettled([...backgroundOperations]);
    }
  }

  async function execute(userId, presetId, {
    deleteRawSource,
    deleteScope = false,
    resetAuthority = false,
    operationPayload = {},
    afterGenerationInitialized,
  } = {}) {
    if (typeof deleteRawSource !== "function") throw new Error("deleteRawSource transaction callback is required");
    if (deleteScope && resetAuthority) throw new Error("Privacy delete cannot both delete and reset a scope");
    const started = await enqueueByKey(`${userId}:${presetId}`, async () => {
      const active = typeof privacy.getOperation === "function"
        ? await privacy.getOperation(userId, presetId)
        : null;
      if (active && rowValue(active, "status", "status") !== "completed") {
        return {
          status: rowValue(active, "status", "status"),
          operationId: rowValue(active, "operation_id", "operationId"),
          operationMode: rowValue(active, "operation_mode", "operationMode"),
          operationPayload: rowValue(active, "operation_payload", "operationPayload") || {},
          mutationResult: null,
          rawMutationCommitted: true,
          alreadyActive: true,
        };
      }
      const operationId = idFactory();
      if (deleteScope || resetAuthority) {
        const operationMode = deleteScope ? "delete_scope" : "reset_authority";
        let mutationResult;
        let resolvedOperationPayload = operationPayload;
        await repositories.withTransaction(async (client) => {
          mutationResult = await deleteRawSource(client);
          if (!mutationResult) return;
          resolvedOperationPayload = typeof operationPayload === "function"
            ? await operationPayload(mutationResult, client)
            : operationPayload;
          await privacy.purgeDerivedHistory(userId, presetId, { client });
          if (resetAuthority) await privacy.purgeAuthorityState(userId, presetId, { client });
          await privacy.upsertOperation(userId, presetId, {
            operationId, operationMode, sourceGeneration: null, boundaryMessageId: null,
            operationPayload: resolvedOperationPayload, status: "purging", lastErrorReason: null,
          }, { client });
        });
        if (!mutationResult) return { status: "not_found", mutationResult: null, rawMutationCommitted: false };
        return {
          status: "purging", operationId, operationMode, operationPayload: resolvedOperationPayload,
          mutationResult, rawMutationCommitted: true,
        };
      }

      if (!sourceRebuild?.initializeGeneration || !sourceRebuild?.forceDrainTo) throw new Error("Privacy hard delete requires source rebuild");
      const initialized = await sourceRebuild.initializeGeneration(userId, presetId, {
        reason: "privacy_hard_delete",
        mutateSource: deleteRawSource,
        purgeDerived: async (client, metadata) => {
          if (typeof afterGenerationInitialized === "function") {
            await afterGenerationInitialized(client, metadata);
          }
          await privacy.purgeDerivedHistory(userId, presetId, { client });
          await privacy.upsertOperation(userId, presetId, {
            operationId, operationMode: "rebuild", sourceGeneration: metadata.sourceGeneration,
            boundaryMessageId: metadata.boundaryMessageId, operationPayload,
            status: "purging", lastErrorReason: null,
          }, { client });
        },
      });
      return {
        ...initialized, status: "purging", operationId, operationMode: "rebuild",
        operationPayload, rawMutationCommitted: true,
      };
    });
    if (started.rawMutationCommitted) dispatch(userId, presetId, started);
    return started;
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

  return Object.freeze({ execute, continueOperation, reconcilePending, waitForIdle });
}

module.exports = { createPrivacyHardDelete };
