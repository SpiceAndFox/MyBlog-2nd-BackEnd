const test = require("node:test");
const assert = require("node:assert/strict");
const { createInitialMemoryState } = require("../../modules/memory/contracts");
const { createMemoryStateRecovery } = require("../../modules/memory/application/stateRecovery");

test("invalid authority is restored only from a schema-valid snapshot at the audit head", async () => {
  let authority = { version: 2, broken: true };
  const old = createInitialMemoryState();
  old.meta.revision = 2;
  const head = createInitialMemoryState();
  head.meta.revision = 3;
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: {
      async getRawState() { return structuredClone(authority); },
      async writeState(_u, _p, state) { authority = structuredClone(state); },
    },
    audit: {
      async getRecoveryHead() { return { revision: 3, sourceGeneration: 0 }; },
      async listSnapshotsForRecovery() { return [{ revision: 2, source_generation: 0, state: old }, { revision: 3, source_generation: 0, state: head }]; },
    },
  };
  const recovery = createMemoryStateRecovery({ repositories, sourceRebuild: { initializeRecoveryGeneration() {} } });
  const result = await recovery.restoreLatestCompleteSnapshot(1, "default");
  assert.equal(result.status, "snapshot_restored");
  assert.equal(authority.meta.revision, 3);
});

test("invalid authority requests raw rebuild when the newest valid snapshot lags the audit head", async () => {
  const old = createInitialMemoryState();
  old.meta.revision = 2;
  const repositories = {
    async withTransaction(work) { return work({}); },
    state: { async getRawState() { return { version: 2, broken: true }; }, async writeState() { throw new Error("must not restore stale snapshot"); } },
    audit: { async getRecoveryHead() { return { revision: 3, sourceGeneration: 0 }; }, async listSnapshotsForRecovery() { return [{ revision: 2, source_generation: 0, state: old }]; } },
  };
  const recovery = createMemoryStateRecovery({ repositories, sourceRebuild: { initializeRecoveryGeneration() {} } });
  assert.deepEqual(await recovery.restoreLatestCompleteSnapshot(1, "default"), { status: "rebuild_required" });
});
