function createPrivacyHardDelete({ repositories, sourceRebuild, stores = [], enqueueByKey = (_key, work) => work() } = {}) {
  if (!repositories?.privacy?.purgeDerivedHistory) throw new Error("Privacy hard delete repository is required");
  if (!sourceRebuild?.initializeGeneration || !sourceRebuild?.forceDrainTo) throw new Error("Privacy hard delete requires source rebuild");
  if (stores.some((store) => typeof store?.purge !== "function" || typeof store?.verifyPurged !== "function")) throw new Error("Every privacy store requires purge and verifyPurged");

  function execute(userId, presetId, { deleteRawSource }) {
    if (typeof deleteRawSource !== "function") throw new Error("deleteRawSource transaction callback is required");
    return enqueueByKey(`${userId}:${presetId}`, async () => {
      const initialized = await sourceRebuild.initializeGeneration(userId, presetId, {
        reason: "privacy_hard_delete",
        mutateSource: deleteRawSource,
        purgeDerived: async (client) => {
          for (const store of stores) await store.purge({ userId, presetId, client });
          await repositories.privacy.purgeDerivedHistory(userId, presetId, { client });
        },
      });
      for (const store of stores) {
        const clean = await store.verifyPurged({ userId, presetId });
        if (!clean) return { status: "incomplete", reason: `residue:${store.name || "external_store"}`, ...initialized };
      }
      const drained = await sourceRebuild.forceDrainTo(userId, presetId, initialized);
      return { ...initialized, ...drained };
    });
  }
  return Object.freeze({ execute });
}

module.exports = { createPrivacyHardDelete };
