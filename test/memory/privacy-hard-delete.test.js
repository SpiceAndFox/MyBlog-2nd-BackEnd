const test = require("node:test");
const assert = require("node:assert/strict");
const { createPrivacyHardDelete } = require("../../modules/memory/application/privacyHardDelete");

test("privacy hard delete does not force-drain while any external store still reports residue", async () => {
  const calls = [];
  const sourceRebuild = {
    async initializeGeneration(_u, _p, options) { await options.mutateSource({}); await options.purgeDerived({}, { sourceGeneration: 3, boundaryMessageId: 20 }); return { sourceGeneration: 3, boundaryMessageId: 20 }; },
    async forceDrainTo() { calls.push("drain"); return { status: "completed" }; },
  };
  let operation;
  const repositories = {
    async withTransaction(work) { return work({}); },
    privacy: {
      async purgeDerivedHistory() { calls.push("memory-purge"); },
      async upsertOperation(_u, _p, value) { operation = { ...value }; return operation; },
      async updateOperation(_u, _p, value) { Object.assign(operation, value); return operation; },
    },
  };
  const stores = [{ name: "rag", async purge() { calls.push("rag-purge"); }, async verifyPurged() { return false; } }];
  const hardDelete = createPrivacyHardDelete({ repositories, sourceRebuild, stores });
  const result = await hardDelete.execute(7, "companion", { async deleteRawSource() { calls.push("raw-delete"); } });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(calls, ["raw-delete", "rag-purge", "memory-purge"]);
  assert.equal(operation.status, "purging");
});

